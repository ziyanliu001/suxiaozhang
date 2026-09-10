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

// 按 tenantId 去重覆盖，把新授权合并进已有的 authorizedTenants 数组——
// 同一租户再次 grant 会覆盖旧的 role/stores，不会重复追加
function mergeGrant(existingGrants, newGrant) {
  const list = Array.isArray(existingGrants) ? existingGrants : [];
  return [...list.filter((g) => g && g.tenantId !== newGrant.tenantId), newGrant];
}

module.exports = { GRANTABLE_ROLES, validateGrantRequest, mergeGrant };
