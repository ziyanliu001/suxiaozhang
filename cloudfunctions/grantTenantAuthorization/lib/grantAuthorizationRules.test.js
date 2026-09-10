'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GRANTABLE_ROLES, validateGrantRequest, mergeGrant } = require('./grantAuthorizationRules');

// 🛡️（2026-09-10）多租户巡检授权签发规则回归矩阵——与同仓库
// cloudfunctions/manageStoreProfile/lib/resolveCaller.test.js 是同一次真实
// 故障排查的两端：这份测试盯的是"授权该不该被批准写入"（签发端），
// resolveCaller.test.js 盯的是"已经写入的授权该不该被消费/生效"（消费端），
// 两份测试合起来才是完整的"签发 + 消费"闭环回归覆盖。

function baseArgs(overrides) {
  return Object.assign(
    {
      targetOpenId: 'openid_target',
      tenantId: 'tenant_X',
      role: 'store_patriarch',
      stores: ['store_X'],
      targetDoc: { _id: 'doc_1', role: 'platform_admin', tenantId: '', authorizedTenants: [] }
    },
    overrides
  );
}

test('(未授权/参数缺失) 缺少 targetOpenId 直接拒绝', () => {
  const result = validateGrantRequest(baseArgs({ targetOpenId: '' }));
  assert.equal(result.ok, false);
  assert.match(result.error, /targetOpenId/);
});

test('(未授权/参数缺失) 缺少 tenantId（且未能从 stores[0] 反查到）直接拒绝', () => {
  const result = validateGrantRequest(baseArgs({ tenantId: '' }));
  assert.equal(result.ok, false);
  assert.match(result.error, /tenantId/);
});

test('role 不在白名单（如尝试授予 super_admin/platform_admin）直接拒绝', () => {
  assert.equal(validateGrantRequest(baseArgs({ role: 'super_admin' })).ok, false);
  assert.equal(validateGrantRequest(baseArgs({ role: 'platform_admin' })).ok, false);
  assert.equal(validateGrantRequest(baseArgs({ role: 'not_a_real_role' })).ok, false);
});

test('GRANTABLE_ROLES 白名单内的每个角色都能通过角色校验（用同一份数据源反过来驱动断言，防止改了白名单却忘了同步）', () => {
  GRANTABLE_ROLES.forEach((role) => {
    const result = validateGrantRequest(baseArgs({ role }));
    assert.equal(result.ok, true, `role=${role} 应当通过校验`);
  });
});

test('stores 为空数组时拒绝——不支持留空即授权整租户', () => {
  const result = validateGrantRequest(baseArgs({ stores: [] }));
  assert.equal(result.ok, false);
  assert.match(result.error, /stores/);
});

test('stores 不是数组时拒绝（防御性）', () => {
  const result = validateGrantRequest(baseArgs({ stores: null }));
  assert.equal(result.ok, false);
});

test('目标 openId 没有任何 user_roles 记录（targetDoc 为 null）时拒绝，不会为其新建文档', () => {
  const result = validateGrantRequest(baseArgs({ targetDoc: null }));
  assert.equal(result.ok, false);
  assert.match(result.error, /没有任何 user_roles 记录/);
});

test('跨店越权无关场景：普通角色（非 platform_admin）尝试给自己已归属的租户再加一条授权——拒绝', () => {
  const result = validateGrantRequest(
    baseArgs({
      tenantId: 'tenant_own',
      targetDoc: { _id: 'doc_2', role: 'store_manager', tenantId: 'tenant_own', authorizedTenants: [] }
    })
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /本来就归属这个租户/);
});

test('回归用例——platform_admin 的 tenantId 恰好等于目标 tenantId（历史残留数据）：豁免拦截，允许签发', () => {
  // 对应 2026-09-10 真实复现的 bug：platform_admin 账号历史上是从某机构的
  // super_admin 提权而来，own.tenantId 残留着提权前所属的机构 ID；这次要
  // 巡检的目标租户恰好就是那同一个机构。此前的实现会把这种"字段巧合相等"
  // 误判成"目标账号本来就归属这个租户"而拒绝签发，导致「平台巡检」自助
  // 授权在这类历史数据下永久失效
  const result = validateGrantRequest(
    baseArgs({
      tenantId: 'tenant_legacy_residual',
      targetDoc: { _id: 'doc_3', role: 'platform_admin', tenantId: 'tenant_legacy_residual', authorizedTenants: [] }
    })
  );
  assert.equal(result.ok, true);
});

test('platform_admin 无巡检凭据的场景不由本函数处理——本函数只管"签发"，platform_admin 首次申请巡检某家店时 targetDoc.tenantId 通常为空，同样应当放行签发', () => {
  const result = validateGrantRequest(baseArgs({ targetDoc: { _id: 'doc_4', role: 'platform_admin', tenantId: '', authorizedTenants: [] } }));
  assert.equal(result.ok, true);
});

test('全部条件都合法时通过校验', () => {
  const result = validateGrantRequest(baseArgs());
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
});

test('mergeGrant：已有数组为空时，新授权直接作为唯一元素', () => {
  const merged = mergeGrant([], { tenantId: 'tenant_X', role: 'store_patriarch', stores: ['store_X'] });
  assert.deepEqual(merged, [{ tenantId: 'tenant_X', role: 'store_patriarch', stores: ['store_X'] }]);
});

test('mergeGrant：同一 tenantId 再次授权会覆盖旧的 role/stores，不会重复追加', () => {
  const existing = [{ tenantId: 'tenant_X', role: 'volunteer', stores: ['store_old'] }];
  const merged = mergeGrant(existing, { tenantId: 'tenant_X', role: 'store_patriarch', stores: ['store_new'] });
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], { tenantId: 'tenant_X', role: 'store_patriarch', stores: ['store_new'] });
});

test('mergeGrant：不同 tenantId 的授权互不影响，追加而不是覆盖', () => {
  const existing = [{ tenantId: 'tenant_A', role: 'finance', stores: ['store_A'] }];
  const merged = mergeGrant(existing, { tenantId: 'tenant_B', role: 'store_manager', stores: ['store_B'] });
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], existing[0]);
  assert.deepEqual(merged[1], { tenantId: 'tenant_B', role: 'store_manager', stores: ['store_B'] });
});

test('mergeGrant：已有数组为 undefined/非数组时按空数组处理，不抛异常（对应"撤销后重新授权"这种 authorizedTenants 字段本就缺失的历史账号）', () => {
  const merged = mergeGrant(undefined, { tenantId: 'tenant_X', role: 'store_patriarch', stores: ['store_X'] });
  assert.deepEqual(merged, [{ tenantId: 'tenant_X', role: 'store_patriarch', stores: ['store_X'] }]);
});

test('mergeGrant：已有数组里混入 null/畸形条目不抛异常，正常跳过', () => {
  const existing = [null, { tenantId: 'tenant_A' }];
  const merged = mergeGrant(existing, { tenantId: 'tenant_X', role: 'store_patriarch', stores: ['store_X'] });
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[1], { tenantId: 'tenant_X', role: 'store_patriarch', stores: ['store_X'] });
});

// ⚠️ 未覆盖范围（如实标注）：requirePlatformAdmin()（调用者本人必须是
// platform_admin 才能调用 grant/revoke/list）、handleRevoke/handleList 目前
// 仍直接内联在 index.js 里、内部会发起数据库查询，本文件暂不覆盖。这两个
// action 的逻辑本身很薄（找文档 + filter 数组），历史上也不是这次连环 bug
// 的触发点，如果后续要补，可以参考本文件 mergeGrant 的拆分方式。
