'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_DURATION_MS,
  evaluateLockout,
  computeNextAttemptRecord,
  buildLoginAttemptDocId
} = require('./loginLockout');

test('evaluateLockout：从未失败过时允许', () => {
  assert.deepEqual(evaluateLockout(null, Date.now()), { allowed: true });
});

test('evaluateLockout：锁定期内拒绝并提示剩余分钟数', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  const record = { failCount: 5, lockedUntil: '2026-09-13T12:15:00Z' };
  const result = evaluateLockout(record, now);
  assert.equal(result.allowed, false);
  assert.match(result.error, /15 分钟/);
});

test('evaluateLockout：锁定期已过时允许', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  const record = { failCount: 5, lockedUntil: '2026-09-13T11:00:00Z' };
  assert.deepEqual(evaluateLockout(record, now), { allowed: true });
});

test('computeNextAttemptRecord：成功时清零失败计数', () => {
  const next = computeNextAttemptRecord({ failCount: 3 }, true, Date.now());
  assert.equal(next.failCount, 0);
  assert.equal(next.lockedUntil, null);
});

test('computeNextAttemptRecord：失败累加到上限时设置锁定', () => {
  const now = Date.now();
  const next = computeNextAttemptRecord({ failCount: MAX_FAILED_ATTEMPTS - 1 }, false, now);
  assert.equal(next.failCount, MAX_FAILED_ATTEMPTS);
  assert.equal(next.lockedUntil, new Date(now + LOCKOUT_DURATION_MS).toISOString());
});

test('buildLoginAttemptDocId：确定性且大小写不敏感（同一用户名不因大小写产生两条独立锁定记录）', () => {
  assert.equal(buildLoginAttemptDocId('Admin'), buildLoginAttemptDocId('admin'));
});

test('buildLoginAttemptDocId：不同用户名生成不同 ID', () => {
  assert.notEqual(buildLoginAttemptDocId('admin1'), buildLoginAttemptDocId('admin2'));
});
