// 纯逻辑：方案三（authorizedTenants 轻量租户漫游）授权签发的校验规则与数组
// 合并逻辑，不做 db I/O、不依赖 wx-server-sdk，便于单测；拆成独立文件与
// index.js 共用，是本仓库 wxPayCore/getSettlementSummary/manageVolunteerCheckIn
// 等云函数已有的既定写法（index.js 通过 require('./lib/xxx') 引入，不在
// 两处各写一份）。
//
// index.js 的 handleGrant 负责数据库 I/O（查 targetDoc、反查 stores[0] 的
// tenantId、写回 authorizedTenants），把"这次授权请求该不该被批准"这个纯
// 判断逻辑委托给这里的 validateGrantRequest；"新授权该怎么合并进已有数组"
// 委托给 mergeGrant。
'use strict';

// 🛡️ 可通过本机制漫游授予的角色白名单——故意不包含 super_admin/platform_admin：
// 这两个角色代表"某个租户/平台的最高权威"，不该通过一条轻量数组条目就批量
// 授予，真要让某人成为另一个租户的 super_admin，应该走该租户自己的正常任命
// 流程（如 processRoleAudit 的家长任命申请），不是本函数的适用场景
const GRANTABLE_ROLES = ['store_manager', 'store_patriarch', 'finance', 'volunteer'];

// ⏱️（2026-09-10 巡检面板体验升级）临时授权固定 2 小时有效期——早在本轮
// 「平台巡检」自助授权功能最初设计时就提过"支持设定 2 小时后自动失效"，
// 一直没有落地（此前只有手动"一键撤销"，没有基于时间的过期）。这次配合
// 巡检面板 UI 升级（展示"剩余有效时间"倒计时）一并实现：grantedAt 之外
// 再写一份 expiresAt = grantedAt + GRANT_TTL_MS，manageStoreProfile 的
// resolveEffectiveCaller() 命中一条已过期的授权时按"未命中"处理（等同于
// 已撤销），不需要任何定时任务主动清理——过期的授权记录会一直留在数组里
// 直到管理员再次巡检同一家机构时被 mergeGrant 按 tenantId 覆盖，或被显式
// revoke，纯粹是"读取时判定是否还生效"，不影响其余用法
const GRANT_TTL_MS = 2 * 60 * 60 * 1000;

// 校验一次授权请求是否应该被批准。所有入参都是已经从数据库/事件里取出来的
// 原始值，本函数不发起任何 I/O。返回 { ok: true } 或 { ok: false, error }。
function validateGrantRequest({ targetOpenId, tenantId, role, stores, targetDoc }) {
  if (!targetOpenId) return { ok: false, error: '缺少 targetOpenId 参数' };
  if (!tenantId) return { ok: false, error: '缺少 tenantId 参数（且未能从 stores[0] 反查到）' };
  if (!GRANTABLE_ROLES.includes(role)) {
    return { ok: false, error: `role 必须是以下之一: ${GRANTABLE_ROLES.join('/')}` };
  }
  if (!Array.isArray(stores) || stores.length === 0) {
    // 🛡️ 最小权限原则：不提供"留空即授权该租户全部门店"的隐式默认值——
    // 漫游授权本就是一次精确、罕见的人工操作，要求调用方明确列出门店范围，
    // 而不是图省事留空换来一份比预期宽得多的授权
    return { ok: false, error: '必须显式列出 stores（至少一个 storeId），不支持留空授予整租户' };
  }
  if (!targetDoc) {
    return { ok: false, error: '目标 openId 没有任何 user_roles 记录，本函数不会为其新建文档——请先确认该账号已完成正常登录/建档流程' };
  }

  // 🛡️ 严禁授权给自己已经归属的那个租户——那不叫"漫游"，是数据错乱的信号。
  // 🐛 根因修复（2026-09-10）：这条检查只对 targetDoc.role !== 'platform_admin'
  // 的账号有意义——platform_admin 按设计不归属任何机构，它的 tenantId 字段
  // 本该恒为空；如果某个 platform_admin 账号因历史数据（如从 super_admin
  // 提权时残留旧 tenantId）而 tenantId 恰好等于本次要巡检的目标租户，这只是
  // 一个无意义的字段巧合，不代表这个 platform_admin 真的对这家机构有任何
  // 操作权限，继续拦截只会让「平台巡检」自助授权在这种历史数据下永久失效
  if (targetDoc.role !== 'platform_admin' && tenantId === targetDoc.tenantId) {
    return { ok: false, error: '目标账号本来就归属这个租户，不需要（也不应该）再加一条授权' };
  }

  return { ok: true };
}

// 🐛 根因修复（2026-09-10 "选大家长却拿到义工权限"）：此前只按 tenantId 去重，
// 同一家门店如果因历史数据问题（如该店曾经挂在一个后来被删除/重建的机构下）
// 在数组里遗留了一条 tenantId 不同、但 stores 命中同一个 storeId 的旧授权
// （例如更早巡检时随手选的 volunteer），再次对这家门店授权 store_patriarch
// 时——新旧两条 tenantId 不同，旧版 mergeGrant 认为互不相关，直接追加，旧的
// volunteer 授权继续留在数组里。resolveEffectiveCaller()/store-profile.ts
// 后续按 storeId 匹配时可能先命中这条更早、权限更低的旧记录，导致"明明选的
// 大家长，门店档案却还是只读"。storeId 本身全局唯一（见 resolveCaller.js
// 同类注释），"覆盖同一家店的旧授权"这件事不应该以 tenantId 是否相同为
// 前提——只要新旧两条授权的 stores 有重叠，旧的那条就应该被这次新授权替换掉，
// 不能让一家店同时存在两条"生效中"的授权记录
function mergeGrant(existingGrants, newGrant) {
  const list = Array.isArray(existingGrants) ? existingGrants : [];
  const newStores = new Set(Array.isArray(newGrant.stores) ? newGrant.stores : []);
  const superseded = (g) => {
    if (!g) return true; // 畸形条目一律视为"应被清理"，不保留
    if (g.tenantId === newGrant.tenantId) return true;
    if (Array.isArray(g.stores) && g.stores.some((s) => newStores.has(s))) return true;
    return false;
  };
  return [...list.filter((g) => !superseded(g)), newGrant];
}

module.exports = { GRANTABLE_ROLES, GRANT_TTL_MS, validateGrantRequest, mergeGrant };
