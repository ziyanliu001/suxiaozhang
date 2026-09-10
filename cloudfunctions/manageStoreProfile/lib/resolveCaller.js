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

function resolveEffectiveCaller(own, targetStoreId) {
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
  // 再拿这个值去比对 grant.tenantId——曾经因为两次独立读数不一致而漏判）
  const grants = Array.isArray(own.authorizedTenants) ? own.authorizedTenants : [];
  const grant = grants.find((g) => g && Array.isArray(g.stores) && g.stores.includes(targetStoreId));

  // 命中不了任何一条覆盖这家门店的授权——不冒充身份，原样返回调用者本来的
  // 身份。这一条同时覆盖三种表面上不同、但决策逻辑完全一样的场景：
  // - 普通单店角色越权访问别的门店（自始至终没有 authorizedTenants）
  // - platform_admin 从未巡检过这家门店（authorizedTenants 数组为空/不含它）
  // - 巡检凭据已被 platform-admin 后台的"一键回收"撤销（曾经存在过的那条
  //   授权已经从数组里被移除，本仓库目前没有基于时间的过期字段，"撤销"
  //   在数据层面就等价于"数组里已经没有这一条了"）
  if (!grant) return own;

  // 🐛 根因修复（2026-09-10 "您尚未绑定门店"回归）：命中授权后不再额外
  // 检查 grant.tenantId 是否恰好等于 own.tenantId 就放弃漫游——历史上这条
  // "双保险"检查在 own.tenantId 因历史脏数据残留（如账号从 super_admin
  // 提权为 platform_admin 时旧 tenantId 没被清空）而恰好与 grant.tenantId
  // 相同时，会把已经正确命中的漫游身份错误地打回原样，制造出"明明已经
  // 授权成功却还是没权限"的假象。只要命中了 stores 数组包含目标门店的
  // 授权记录，就应该无条件按这条授权的 role/tenantId 生效
  return { ...own, tenantId: grant.tenantId, role: grant.role, storeId: targetStoreId };
}

module.exports = { resolveEffectiveCaller };
