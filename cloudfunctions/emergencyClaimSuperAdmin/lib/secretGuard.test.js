'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_DURATION_MS,
  secretsMatch,
  evaluateLockout,
  computeNextAttemptRecord,
  buildAttemptDocId
} = require('./secretGuard');

// ==================== secretsMatch ====================

test('secretsMatch：完全一致时返回 true', () => {
  assert.equal(secretsMatch('my-secret-123', 'my-secret-123'), true);
});

test('secretsMatch：不一致时返回 false', () => {
  assert.equal(secretsMatch('wrong', 'my-secret-123'), false);
});

test('secretsMatch：长度不同时安全返回 false，不抛异常', () => {
  assert.equal(secretsMatch('short', 'a-much-longer-secret-value'), false);
  assert.equal(secretsMatch('a-much-longer-secret-value', 'short'), false);
});

test('secretsMatch：空字符串/undefined 输入安全兜底，不抛异常', () => {
  assert.equal(secretsMatch('', 'expected'), false);
  assert.equal(secretsMatch(undefined, 'expected'), false);
  assert.equal(secretsMatch('provided', ''), false);
  assert.equal(secretsMatch(undefined, undefined), true); // 两边都是空字符串，视为相等
});

test('secretsMatch：大小写敏感（不做归一化）', () => {
  assert.equal(secretsMatch('Secret', 'secret'), false);
});

// ==================== evaluateLockout ====================

test('evaluateLockout：从未失败过（record 为 null）时允许', () => {
  assert.deepEqual(evaluateLockout(null, Date.now()), { allowed: true });
});

test('evaluateLockout：record 存在但没有 lockedUntil 字段时允许', () => {
  assert.deepEqual(evaluateLockout({ failCount: 2 }, Date.now()), { allowed: true });
});

test('evaluateLockout：lockedUntil 早于 now（已过锁定期）时允许', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  const record = { failCount: 5, lockedUntil: '2026-09-13T11:00:00Z' };
  assert.deepEqual(evaluateLockout(record, now), { allowed: true });
});

test('evaluateLockout：lockedUntil 晚于 now 时拒绝，并给出剩余分钟数提示', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  const record = { failCount: 5, lockedUntil: '2026-09-13T12:10:00Z' };
  const result = evaluateLockout(record, now);
  assert.equal(result.allowed, false);
  assert.match(result.error, /10 分钟/);
  assert.equal(result.lockedUntil, record.lockedUntil);
});

test('evaluateLockout：lockedUntil 是非法日期字符串时安全兜底为允许（不因脏数据卡死正常调用）', () => {
  const record = { failCount: 5, lockedUntil: 'not-a-date' };
  assert.deepEqual(evaluateLockout(record, Date.now()), { allowed: true });
});

// ==================== computeNextAttemptRecord ====================

test('computeNextAttemptRecord：成功时清零失败计数、解除锁定', () => {
  const record = { failCount: 4, lockedUntil: null };
  const next = computeNextAttemptRecord(record, true, Date.now());
  assert.equal(next.failCount, 0);
  assert.equal(next.lockedUntil, null);
});

test('computeNextAttemptRecord：失败时累加计数，未达上限不设置锁定', () => {
  const next = computeNextAttemptRecord({ failCount: 1 }, false, Date.now());
  assert.equal(next.failCount, 2);
  assert.equal(next.lockedUntil, null);
});

test('computeNextAttemptRecord：失败累加到达上限时设置锁定截止时间', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  const next = computeNextAttemptRecord({ failCount: MAX_FAILED_ATTEMPTS - 1 }, false, now);
  assert.equal(next.failCount, MAX_FAILED_ATTEMPTS);
  assert.equal(next.lockedUntil, new Date(now + LOCKOUT_DURATION_MS).toISOString());
});

test('computeNextAttemptRecord：record 为 null（首次失败）时按 0 起算', () => {
  const next = computeNextAttemptRecord(null, false, Date.now());
  assert.equal(next.failCount, 1);
});

test('computeNextAttemptRecord：正常流程下 evaluateLockout 会在锁定期内提前拦截，本函数不会被调用到——但防御性地假设这条路径真的被触发（如极端并发竞态绕过了锁定检查），继续失败会顺延锁定截止时间，而不是放任攻击者在锁定期内继续免费重试却不产生任何新的代价', () => {
  const now = Date.parse('2026-09-13T12:05:00Z');
  const record = { failCount: MAX_FAILED_ATTEMPTS + 2, lockedUntil: '2026-09-13T12:30:00Z' };
  const next = computeNextAttemptRecord(record, false, now);
  assert.equal(next.lockedUntil, new Date(now + LOCKOUT_DURATION_MS).toISOString());
});

// ==================== buildAttemptDocId ====================

test('buildAttemptDocId：确定性——相同 openid 始终生成相同文档 ID', () => {
  assert.equal(buildAttemptDocId('openid_abc'), buildAttemptDocId('openid_abc'));
});

test('buildAttemptDocId：不同 openid 生成不同文档 ID', () => {
  assert.notEqual(buildAttemptDocId('openid_abc'), buildAttemptDocId('openid_xyz'));
});

test('buildAttemptDocId：固定前缀，便于人工在数据库控制台按前缀识别', () => {
  assert.match(buildAttemptDocId('openid_abc'), /^emergency_claim_attempt_[a-f0-9]{32}$/);
});

test('buildAttemptDocId：空/undefined openid 安全兜底，不抛异常', () => {
  assert.doesNotThrow(() => buildAttemptDocId(''));
  assert.doesNotThrow(() => buildAttemptDocId(undefined));
});
