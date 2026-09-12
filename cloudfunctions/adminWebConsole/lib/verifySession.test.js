'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isSessionValid } = require('./verifySession');

test('会话不存在时无效', () => {
  assert.equal(isSessionValid(null, Date.now()).valid, false);
});

test('未过期时有效，返回 username', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  const result = isSessionValid({ username: 'admin', expiresAt: '2026-09-13T18:00:00Z' }, now);
  assert.equal(result.valid, true);
  assert.equal(result.username, 'admin');
});

test('已过期时无效', () => {
  const now = Date.parse('2026-09-13T20:00:00Z');
  assert.equal(isSessionValid({ username: 'admin', expiresAt: '2026-09-13T18:00:00Z' }, now).valid, false);
});

test('expiresAt 非法日期字符串时安全判定为无效', () => {
  assert.equal(isSessionValid({ username: 'admin', expiresAt: 'not-a-date' }, Date.now()).valid, false);
});
