'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SESSION_DURATION_MS, generateSessionToken, buildSessionDoc, isSessionValid } = require('./sessionToken');

test('generateSessionToken：每次生成不同的、64 位十六进制令牌', () => {
  const a = generateSessionToken();
  const b = generateSessionToken();
  assert.notEqual(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test('buildSessionDoc：以令牌本身作为 _id，携带 username 与过期时间', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  const doc = buildSessionDoc('token123', 'admin', now);
  assert.equal(doc._id, 'token123');
  assert.equal(doc.username, 'admin');
  assert.equal(doc.expiresAt, new Date(now + SESSION_DURATION_MS).toISOString());
});

test('isSessionValid：会话不存在时无效', () => {
  const result = isSessionValid(null, Date.now());
  assert.equal(result.valid, false);
});

test('isSessionValid：未过期时有效，返回 username', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  const doc = { username: 'admin', expiresAt: '2026-09-13T18:00:00Z' };
  const result = isSessionValid(doc, now);
  assert.equal(result.valid, true);
  assert.equal(result.username, 'admin');
});

test('isSessionValid：已过期时无效', () => {
  const now = Date.parse('2026-09-13T20:00:00Z');
  const doc = { username: 'admin', expiresAt: '2026-09-13T18:00:00Z' };
  assert.equal(isSessionValid(doc, now).valid, false);
});

test('isSessionValid：expiresAt 为非法日期字符串时安全判定为无效（脏数据不应被当成永久有效）', () => {
  const doc = { username: 'admin', expiresAt: 'not-a-date' };
  assert.equal(isSessionValid(doc, Date.now()).valid, false);
});
