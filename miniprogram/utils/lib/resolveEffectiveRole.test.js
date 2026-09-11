'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveEffectiveRoleDecision } = require('./resolveEffectiveRole');

// ==================== 无覆盖值：原样透传 ====================

test('storageRole 为空字符串时原样返回 persistedRole，不触发任何写回', () => {
  const d = resolveEffectiveRoleDecision('platform_admin', '');
  assert.deepEqual(d, { effectiveRole: 'platform_admin', shouldOverwriteCache: false, shouldClearStaleStorage: false });
});

test('storageRole 为 undefined/null 时同样视为无覆盖', () => {
  assert.equal(resolveEffectiveRoleDecision('store_manager', undefined).effectiveRole, 'store_manager');
  assert.equal(resolveEffectiveRoleDecision('store_manager', null).effectiveRole, 'store_manager');
});

// ==================== platform_admin：绝不被覆盖，自愈清理 ====================

test('persistedRole 为 platform_admin 时，任何 storageRole 残留都不生效，原样保留 platform_admin', () => {
  const d = resolveEffectiveRoleDecision('platform_admin', 'store_manager');
  assert.equal(d.effectiveRole, 'platform_admin');
  assert.equal(d.shouldOverwriteCache, false);
});

test('persistedRole 为 platform_admin 且 storageRole 是残留值时，要求调用方清理陈旧 storage key（自愈）', () => {
  const d = resolveEffectiveRoleDecision('platform_admin', 'volunteer');
  assert.equal(d.shouldClearStaleStorage, true);
});

test('persistedRole 大小写不敏感（PLATFORM_ADMIN 也按同一分支处理）', () => {
  const d = resolveEffectiveRoleDecision('PLATFORM_ADMIN', 'MANAGER');
  assert.equal(d.effectiveRole, 'PLATFORM_ADMIN');
  assert.equal(d.shouldClearStaleStorage, true);
});

test('persistedRole 为 platform_admin 且 storageRole 恰好也是 platform_admin（无实际漂移）时，不触发清理', () => {
  const d = resolveEffectiveRoleDecision('platform_admin', 'platform_admin');
  assert.equal(d.effectiveRole, 'platform_admin');
  assert.equal(d.shouldClearStaleStorage, false);
});

// ==================== 其余角色：既有行为不变（super_admin 视角切换等合法场景） ====================

test('persistedRole 为 super_admin、storageRole 为 store_manager（预览切换）时，storageRole 优先生效', () => {
  const d = resolveEffectiveRoleDecision('super_admin', 'store_manager');
  assert.equal(d.effectiveRole, 'store_manager');
  assert.equal(d.shouldOverwriteCache, true);
  assert.equal(d.roleForCache, 'store_manager');
});

test('storageRole 为 store_family 这个展示态伪角色时，回写缓存前归一化为 volunteer', () => {
  const d = resolveEffectiveRoleDecision('super_admin', 'store_family');
  assert.equal(d.effectiveRole, 'store_family');
  assert.equal(d.roleForCache, 'volunteer');
  assert.equal(d.shouldOverwriteCache, true);
});

test('persistedRole 与 roleForCache 一致时不需要回写缓存', () => {
  const d = resolveEffectiveRoleDecision('store_manager', 'store_manager');
  assert.equal(d.shouldOverwriteCache, false);
});

test('普通角色路径下 shouldClearStaleStorage 恒为 false，不影响既有 storage 生命周期', () => {
  const d = resolveEffectiveRoleDecision('volunteer', 'finance');
  assert.equal(d.shouldClearStaleStorage, false);
});
