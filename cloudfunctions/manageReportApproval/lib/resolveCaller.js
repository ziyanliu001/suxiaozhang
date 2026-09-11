// 纯逻辑：方案三（authorizedTenants 轻量租户漫游）身份解析核心决策，不做
// db I/O、不依赖 wx-server-sdk，便于单测；拆成独立文件与 index.js 共用，是
// 本仓库 wxPayCore/getSettlementSummary/manageVolunteerCheckIn 等云函数已有
// 的既定写法（index.js 通过 require('./lib/xxx') 引入，不在两处各写一份）。
//
// index.js 里的 resolveCaller(OPENID, opts) 负责"按 OPENID 查 user_roles 拿到
// own 文档"这一步数据库 I/O，查到 own 之后把决策完全委托给这里的
// resolveEffectiveCaller(own, targetStoreId)——这个函数只认两个输入：own
// （调用者自己那唯一一条 user_roles 文档，可能为 null）和 targetStoreId
// （本次请求要访问的门店 ID，可能为空）。
//
// 🐛 2026-09-10 当天连续三轮排查修复的 bug 都源于这个函数内部的匹配逻辑，
// 这里补的单测（同目录 resolveCaller.test.js）就是照着那几轮真实故障写的
// 回归用例，尤其是 grant.tenantId === own.tenantId 这一条——历史上这里
// 曾经因为一条"双保险"检查错误地把已经命中的漫游身份打回原样，导致
// platform_admin 明明已经拿到临时授权、却在 store-profile.ts 报"您尚未
// 绑定门店"。这个函数往后任何改动都必须先跑一遍这份测试。
'use strict';

// ⏱️（2026-09-10 巡检面板体验升级）now 作为显式参数传入（默认 Date.now()），
// 不在函数内部直接调用 Date.now()——保持本函数纯粹、可测试：单测里可以传
// 任意固定的 now 值来验证"刚好过期前一刻/刚好过期那一刻/过期后"这几个边界，
// 不需要真的等 2 小时或者 mock 全局时钟
function isGrantStillValid(grant, now) {
  // 没有 expiresAt 字段——本次升级之前签发的历史授权记录，视为不过期
  // （向后兼容，不能让存量数据因为缺一个新字段就集体失效）
  if (!grant.expiresAt) return true;
  const expiresAtMs = new Date(grant.expiresAt).getTime();
  // 时间格式解析失败（脏数据）时同样按"不过期"兜底，不能让一条格式异常的
  // 记录直接把整个漫游身份判定成"已过期"——这类数据异常应该在写入侧
  // （handleGrant）被拦住，读取侧只做保守降级
  if (Number.isNaN(expiresAtMs)) return true;
  return expiresAtMs > now;
}

// 🐛（2026-09-10）grantedAt 缺失/非法时按最旧（0）兜底，不能让 new Date(undefined)
// 产生的 NaN 参与比较——NaN 在任何比较运算里都是 false，会让 reduce 的
// "谁更新就留谁"逻辑在缺字段时直接失效
function grantedAtMs(grant) {
  if (!grant || !grant.grantedAt) return 0;
  const ms = new Date(grant.grantedAt).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function resolveEffectiveCaller(own, targetStoreId, now) {
  const effectiveNow = typeof now === 'number' ? now : Date.now();

  // (a) 调用者自己都没有 user_roles 记录——上游 exports.main 通常会在更早
  // 的地方直接判定"无权限"，这里原样透传 null，不冒充任何身份
  if (!own) return null;

  // 没有指定目标门店：不涉及跨身份漫游，原样返回调用者本来的身份——这是
  // "查看/编辑自己绑定门店"这条最常见路径的默认情形
  if (!targetStoreId) return own;

  // 🐛 根因加固（2026-09-10）：只按 storeId 是否落在某条 authorizedTenants
  // 记录的 stores 数组里匹配——storeId 本身是全局唯一的 Mongo _id，不会
  // 跨租户重复，"命中这个 storeId"已经是充分且必要的匹配条件，不需要再
  // 绕一层 tenantId 比对（此前的两步匹配法——先查一次门店当前 tenantId、
  // 再拿这个值去比对 grant.tenantId——曾经因为两次独立读数不一致而漏判）。
  // ⏱️ 同时要求这条授权尚未过期（见 isGrantStillValid）——已过期的授权
  // 记录可能还留在数组里（没人手动撤销），但读取时不再认可它
  const grants = Array.isArray(own.authorizedTenants) ? own.authorizedTenants : [];
  const matches = grants.filter((g) => g && Array.isArray(g.stores) && g.stores.includes(targetStoreId) && isGrantStillValid(g, effectiveNow));

  // 命中不了任何一条覆盖这家门店的有效授权——不冒充身份，原样返回调用者
  // 本来的身份。这一条同时覆盖四种表面上不同、但决策逻辑完全一样的场景：
  // - 普通单店角色越权访问别的门店（自始至终没有 authorizedTenants）
  // - platform_admin 从未巡检过这家门店（authorizedTenants 数组为空/不含它）
  // - 巡检凭据已被 platform-admin 后台的"一键回收"撤销（曾经存在过的那条
  //   授权已经从数组里被移除）
  // - 巡检凭据已超过 2 小时有效期（记录还在数组里，但 isGrantStillValid 判定过期）
  if (matches.length === 0) return own;

  // 🐛 根因修复（2026-09-10 "选大家长却拿到义工权限"）：命中多条有效授权时
  // （正常情况下 grantAuthorizationRules.js 的 mergeGrant 会保证同一 storeId
  // 只留一条，但已经写入数据库的历史脏数据不会因为改了签发端代码就自动清理），
  // 此前直接取数组里第一条命中的，如果一条更早、权限更低的旧记录（如
  // volunteer）排在新授权前面，会一直被优先选中，造成"刚选了大家长再进去
  // 还是只读"的假象。改为在全部有效匹配里取 grantedAt 最新的一条——即便
  // 底层数据还没清理干净，读取时也始终以"最近一次巡检授权"为准
  const grant = matches.length === 1 ? matches[0] : matches.reduce((latest, g) => {
    return grantedAtMs(g) >= grantedAtMs(latest) ? g : latest;
  });

  // 🐛 根因修复（2026-09-10 "您尚未绑定门店"回归）：命中授权后不再额外
  // 检查 grant.tenantId 是否恰好等于 own.tenantId 就放弃漫游——历史上这条
  // "双保险"检查在 own.tenantId 因历史脏数据残留（如账号从 super_admin
  // 提权为 platform_admin 时旧 tenantId 没被清空）而恰好与 grant.tenantId
  // 相同时，会把已经正确命中的漫游身份错误地打回原样，制造出"明明已经
  // 授权成功却还是没权限"的假象。只要命中了 stores 数组包含目标门店的
  // 授权记录，就应该无条件按这条授权的 role/tenantId 生效
  return { ...own, tenantId: grant.tenantId, role: grant.role, storeId: targetStoreId };
}

module.exports = { resolveEffectiveCaller, isGrantStillValid };
