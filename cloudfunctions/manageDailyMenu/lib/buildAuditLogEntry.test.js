'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAuditLogEntry, isRoamingConsumed } = require('./buildAuditLogEntry');

const OWN = { tenantId: 'yuhuazhai_national', role: 'platform_admin', storeId: '', storeName: '全国总览' };
const ROAMED = { tenantId: 'tenant_a', role: 'store_manager', storeId: 'store_123', storeName: '全国总览' };

// ==================== isRoamingConsumed ====================

test('isRoamingConsumed：tenantId/role/storeId 任一不同即视为发生了漫游', () => {
  assert.equal(isRoamingConsumed(OWN, ROAMED), true);
  assert.equal(isRoamingConsumed(OWN, { ...OWN }), false);
});

test('isRoamingConsumed：own 或 effectiveCaller 为 null/undefined 时视为未漫游，不抛异常', () => {
  assert.equal(isRoamingConsumed(null, ROAMED), false);
  assert.equal(isRoamingConsumed(OWN, null), false);
  assert.equal(isRoamingConsumed(undefined, undefined), false);
});

// ==================== buildAuditLogEntry ====================

test('buildAuditLogEntry：发生漫游时生成完整的审计日志字段，targetStoreName 取显式传入值', () => {
  const entry = buildAuditLogEntry({
    operatorOpenId: 'op_openid',
    own: OWN,
    effectiveCaller: ROAMED,
    targetStoreId: 'store_123',
    targetStoreName: '漳州白礁保生雨花齋',
    cloudFunctionName: 'manageStoreProfile',
    action: 'update'
  });
  assert.deepEqual(entry, {
    operatorOpenId: 'op_openid',
    targetStoreId: 'store_123',
    targetStoreName: '漳州白礁保生雨花齋',
    targetTenantId: 'tenant_a',
    roamedAsRole: 'store_manager',
    homeRole: 'platform_admin',
    homeTenantId: 'yuhuazhai_national',
    cloudFunctionName: 'manageStoreProfile',
    action: 'update'
  });
});

// 🐛 回归用例：实测发现过的真实 bug——effectiveCaller.storeName 在三处
// resolveCaller 实现里漫游时都不会被替换，仍是调用者自己的本来名称（如
// platform_admin 的"全国总览"）。之前误用 effectiveCaller.storeName 当
// targetStoreName，产出过"漫游去查了一家具体门店，日志却显示全国总览"
// 这种彻底误导人的审计记录。这里显式验证：即使 effectiveCaller.storeName
// 恰好有值，也绝不会被当成 targetStoreName 使用——必须显式传参
test('buildAuditLogEntry：即使 effectiveCaller.storeName 有值，也绝不会被当成 targetStoreName（必须显式传参，不能隐式读取）', () => {
  const entry = buildAuditLogEntry({
    operatorOpenId: 'op_openid',
    own: OWN,
    effectiveCaller: ROAMED, // ROAMED.storeName === '全国总览'，是调用者自己的名字，不是目标门店的
    targetStoreId: 'store_123',
    cloudFunctionName: 'manageStoreProfile'
    // 故意不传 targetStoreName
  });
  assert.notEqual(entry.targetStoreName, '全国总览');
  assert.equal(entry.targetStoreName, '');
});

test('buildAuditLogEntry：未发生漫游（effectiveCaller 与 own 一致）时返回 null，不产生噪声日志', () => {
  const entry = buildAuditLogEntry({
    operatorOpenId: 'op_openid',
    own: OWN,
    effectiveCaller: { ...OWN },
    targetStoreId: 'store_123',
    cloudFunctionName: 'manageStoreProfile'
  });
  assert.equal(entry, null);
});

test('buildAuditLogEntry：缺少 operatorOpenId/targetStoreId/cloudFunctionName 任一项时返回 null', () => {
  const base = { own: OWN, effectiveCaller: ROAMED, targetStoreId: 'store_123', cloudFunctionName: 'manageStoreProfile' };
  assert.equal(buildAuditLogEntry({ ...base, operatorOpenId: '' }), null);
  assert.equal(buildAuditLogEntry({ ...base, targetStoreId: '' }), null);
  assert.equal(buildAuditLogEntry({ ...base, cloudFunctionName: '' }), null);
});

test('buildAuditLogEntry：action 未传时兜底为空字符串，不产生 undefined 字段', () => {
  const entry = buildAuditLogEntry({
    operatorOpenId: 'op_openid',
    own: OWN,
    effectiveCaller: ROAMED,
    targetStoreId: 'store_123',
    cloudFunctionName: 'getPatriarchDashboard'
  });
  assert.equal(entry.action, '');
});

test('buildAuditLogEntry：own 为 null（调用者自己都没有 user_roles 记录）时返回 null，不生成日志——真实调用链路里 own 为 null 时 resolveCaller 早已返回 null，不会走到这里，这里额外做防御性兜底', () => {
  const entry = buildAuditLogEntry({
    operatorOpenId: 'op_openid',
    own: null,
    effectiveCaller: ROAMED,
    targetStoreId: 'store_123',
    cloudFunctionName: 'manageReportApproval'
  });
  assert.equal(entry, null);
});
