'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActiveRoleGrant, isGrantStillValid, grantedAtMs } = require('./resolveActiveRoleGrant');

test('activeStoreId 为空/undefined 时直接返回 null，不涉及漫游判定', () => {
  assert.equal(resolveActiveRoleGrant([{ tenantId: 't', role: 'store_manager', stores: ['s1'] }], ''), null);
  assert.equal(resolveActiveRoleGrant([{ tenantId: 't', role: 'store_manager', stores: ['s1'] }], undefined), null);
});

test('authorizedTenants 为空/缺失时返回 null，不抛异常', () => {
  assert.equal(resolveActiveRoleGrant([], 'store_X'), null);
  assert.equal(resolveActiveRoleGrant(undefined, 'store_X'), null);
  assert.equal(resolveActiveRoleGrant(null, 'store_X'), null);
});

test('authorizedTenants 里有其他门店的授权，但不包含当前活跃店：返回 null，不会跨店泄漏', () => {
  const grants = [{ tenantId: 'tenant_Y', role: 'store_manager', stores: ['store_Y'] }];
  assert.equal(resolveActiveRoleGrant(grants, 'store_X'), null);
});

test('命中覆盖当前活跃店的有效授权：返回该授权的 role/tenantId，storeId 回填为传入的 activeStoreId', () => {
  const grants = [{ tenantId: 'tenant_X', role: 'store_patriarch', stores: ['store_X'] }];
  const result = resolveActiveRoleGrant(grants, 'store_X');
  assert.deepEqual(result, { role: 'store_patriarch', tenantId: 'tenant_X', storeId: 'store_X' });
});

test('多条记录时按 stores 命中正确的一条，不受排列顺序影响', () => {
  const grants = [
    { tenantId: 'tenant_Y', role: 'finance', stores: ['store_Y'] },
    { tenantId: 'tenant_X', role: 'store_manager', stores: ['store_X', 'store_X2'] }
  ];
  const result = resolveActiveRoleGrant(grants, 'store_X2');
  assert.equal(result.role, 'store_manager');
  assert.equal(result.tenantId, 'tenant_X');
});

test('⏱️ 授权已过期：expiresAt 早于 now，视为未命中，返回 null', () => {
  const now = Date.parse('2026-09-12T12:00:00Z');
  const grants = [{ tenantId: 'tenant_X', role: 'store_patriarch', stores: ['store_X'], expiresAt: '2026-09-12T11:59:59Z' }];
  assert.equal(resolveActiveRoleGrant(grants, 'store_X', now), null);
});

test('⏱️ 授权仍在有效期内：正常命中', () => {
  const now = Date.parse('2026-09-12T12:00:00Z');
  const grants = [{ tenantId: 'tenant_X', role: 'store_patriarch', stores: ['store_X'], expiresAt: '2026-09-12T13:00:00Z' }];
  const result = resolveActiveRoleGrant(grants, 'store_X', now);
  assert.equal(result.role, 'store_patriarch');
});

test('⏱️ 历史授权记录缺 expiresAt 字段：按不过期处理', () => {
  const grants = [{ tenantId: 'tenant_X', role: 'store_manager', stores: ['store_X'] }];
  assert.notEqual(resolveActiveRoleGrant(grants, 'store_X', Date.now()), null);
});

test('多条有效授权命中同一 storeId 时取 grantedAt 最新的一条，不取数组第一条', () => {
  const grants = [
    { tenantId: 'tenant_stale', role: 'volunteer', stores: ['store_X'], grantedAt: '2026-09-10T10:00:00Z' },
    { tenantId: 'tenant_fresh', role: 'store_patriarch', stores: ['store_X'], grantedAt: '2026-09-10T11:00:00Z' }
  ];
  const result = resolveActiveRoleGrant(grants, 'store_X');
  assert.equal(result.role, 'store_patriarch');
  assert.equal(result.tenantId, 'tenant_fresh');
});

test('数组顺序反过来（新的排前面）不影响结果，只认 grantedAt', () => {
  const grants = [
    { tenantId: 'tenant_fresh', role: 'store_patriarch', stores: ['store_X'], grantedAt: '2026-09-10T11:00:00Z' },
    { tenantId: 'tenant_stale', role: 'volunteer', stores: ['store_X'], grantedAt: '2026-09-10T10:00:00Z' }
  ];
  assert.equal(resolveActiveRoleGrant(grants, 'store_X').role, 'store_patriarch');
});

test('容错：数组里混入 null/畸形条目不抛异常，正常跳过', () => {
  const grants = [null, { tenantId: 'tenant_bad' }, { tenantId: 'tenant_X', role: 'store_manager', stores: ['store_X'] }];
  const result = resolveActiveRoleGrant(grants, 'store_X');
  assert.equal(result.role, 'store_manager');
});

test('isGrantStillValid：expiresAt 非法日期字符串时兜底按不过期处理', () => {
  assert.equal(isGrantStillValid({ expiresAt: 'not-a-date' }, Date.now()), true);
});

test('isGrantStillValid：expiresAt 恰好等于 now 时判定为已过期（> 而不是 >=）', () => {
  const now = Date.parse('2026-09-12T12:00:00Z');
  assert.equal(isGrantStillValid({ expiresAt: '2026-09-12T12:00:00Z' }, now), false);
});

test('grantedAtMs：缺失/非法 grantedAt 兜底为 0，不产生 NaN 参与比较', () => {
  assert.equal(grantedAtMs(null), 0);
  assert.equal(grantedAtMs({ grantedAt: 'not-a-date' }), 0);
});
