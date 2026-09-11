'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLockId,
  isLockExpired,
  computeBackoffDelayMs,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_BACKOFF_BASE_MS
} = require('./distributedLock');

// ==================== buildLockId ====================

test('buildLockId：相同 tenantId+storeFilter 始终生成相同的锁 ID（确定性）', () => {
  const a = buildLockId('tenant_1', '海沧区雨花斋');
  const b = buildLockId('tenant_1', '海沧区雨花斋');
  assert.equal(a, b);
});

test('buildLockId：不同 tenantId 或 storeFilter 生成不同的锁 ID', () => {
  const a = buildLockId('tenant_1', '海沧区雨花斋');
  const b = buildLockId('tenant_2', '海沧区雨花斋');
  const c = buildLockId('tenant_1', '湖里区雨花斋');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
});

test('buildLockId：门店名含特殊字符（如"/"）不会导致异常，仍生成合法字符串', () => {
  const id = buildLockId('tenant_1', '厦门/海沧/三源弘');
  assert.equal(typeof id, 'string');
  assert.ok(id.startsWith('cascade_recalc_'));
  // md5 十六进制摘要固定 32 位
  assert.equal(id.length, 'cascade_recalc_'.length + 32);
});

test('buildLockId：空/undefined 输入安全兜底，不抛异常', () => {
  assert.doesNotThrow(() => buildLockId('', ''));
  assert.doesNotThrow(() => buildLockId(undefined, undefined));
  assert.doesNotThrow(() => buildLockId(null, null));
});

// ==================== isLockExpired ====================

test('isLockExpired：锁文档不存在（null/undefined）视为已过期', () => {
  assert.equal(isLockExpired(null, Date.now()), true);
  assert.equal(isLockExpired(undefined, Date.now()), true);
});

test('isLockExpired：缺少 expiresAt 字段视为已过期，不会永久锁死', () => {
  assert.equal(isLockExpired({}, Date.now()), true);
  assert.equal(isLockExpired({ lockedAt: Date.now() }, Date.now()), true);
});

test('isLockExpired：expiresAt 晚于当前时间时判定为未过期', () => {
  const now = 1000000;
  assert.equal(isLockExpired({ expiresAt: now + 5000 }, now), false);
});

test('isLockExpired：expiresAt 早于当前时间时判定为已过期', () => {
  const now = 1000000;
  assert.equal(isLockExpired({ expiresAt: now - 1 }, now), true);
});

test('isLockExpired：expiresAt 恰好等于当前时间时判定为已过期（边界值，宁可提前释放也不误锁）', () => {
  const now = 1000000;
  assert.equal(isLockExpired({ expiresAt: now }, now), true);
});

// ==================== computeBackoffDelayMs ====================

test('computeBackoffDelayMs：返回值随重试次数指数增长（下界，不含抖动上限）', () => {
  const delay0 = computeBackoffDelayMs(0, 100);
  const delay1 = computeBackoffDelayMs(1, 100);
  const delay2 = computeBackoffDelayMs(2, 100);
  // 下界必然满足 base*2^attempt（抖动只会往上加，不会往下减）
  assert.ok(delay0 >= 100 && delay0 < 200);
  assert.ok(delay1 >= 200 && delay1 < 300);
  assert.ok(delay2 >= 400 && delay2 < 500);
});

test('computeBackoffDelayMs：重试次数超过封顶指数时不再继续指数膨胀', () => {
  const atCap = computeBackoffDelayMs(4, 100);
  const beyondCap = computeBackoffDelayMs(10, 100);
  // 两者应该落在同一个指数档位（2^4=16 倍）附近，不会因为 attempt=10 就爆炸成 2^10 倍
  assert.ok(atCap >= 1600 && atCap < 1700);
  assert.ok(beyondCap >= 1600 && beyondCap < 1700);
});

test('computeBackoffDelayMs：不传 baseMs 时使用默认基数，返回合法正数', () => {
  const delay = computeBackoffDelayMs(0);
  assert.ok(Number.isFinite(delay) && delay > 0);
});

test('computeBackoffDelayMs：负数/非法 attempt 安全兜底，不产生负延迟', () => {
  const delay = computeBackoffDelayMs(-5, 100);
  assert.ok(delay >= 100 && delay < 200);
});

// ==================== 默认常量合理性 ====================

test('默认常量：TTL/最大重试次数/退避基数均为正数，符合任务要求（30s TTL、3 次重试）', () => {
  assert.equal(DEFAULT_TTL_MS, 30000);
  assert.equal(DEFAULT_MAX_RETRIES, 3);
  assert.ok(DEFAULT_BACKOFF_BASE_MS > 0);
});
