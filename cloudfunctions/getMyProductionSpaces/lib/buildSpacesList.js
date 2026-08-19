// 把 tenant_members 查询结果整理成给前端"多工坊切换"用的空间列表。纯逻辑，
// 不依赖 wx-server-sdk，便于单测。
//
// 🔑 按 tenantId 去重：一个账号理论上可能在同一个租户下有多条 tenant_members
// 记录（例如自己创建的工坊本来是 space_owner，又通过邀请码把自己加成了
// producer——现实中少见但不是不可能），不去重会在切换菜单里出现"同一个
// 工坊出现两次"的诡异 UI；出现重复时保留权限等级更高的那条角色，与
// verifyTenantAccess 系列函数"高权限角色能覆盖低权限操作"的隐含语义一致。
'use strict';

const ROLE_PRIORITY = { space_owner: 3, space_admin: 2, producer: 1 };

/**
 * @param {Array<{tenantId: string, role: string}>} memberships
 * @param {Object<string, string>} tenantNameMap  tenantId -> tenantName
 * @returns {Array<{tenantId: string, tenantName: string, role: string}>}
 */
function buildSpacesList(memberships, tenantNameMap) {
  const byTenant = {};
  (memberships || []).forEach((m) => {
    if (!m || !m.tenantId) return;
    const existing = byTenant[m.tenantId];
    const priority = ROLE_PRIORITY[m.role] || 0;
    if (!existing || priority > (ROLE_PRIORITY[existing.role] || 0)) {
      byTenant[m.tenantId] = { tenantId: m.tenantId, role: m.role };
    }
  });

  const nameMap = tenantNameMap || {};
  return Object.values(byTenant).map((s) => ({
    tenantId: s.tenantId,
    tenantName: nameMap[s.tenantId] || '未命名工坊',
    role: s.role
  }));
}

module.exports = { buildSpacesList, ROLE_PRIORITY };
