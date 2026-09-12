'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateSalt, hashPassword, verifyPassword } = require('./passwordHash');

test('generateSalt：每次生成不同的盐值', () => {
  const a = generateSalt();
  const b = generateSalt();
  assert.notEqual(a, b);
  assert.match(a, /^[a-f0-9]{32}$/);
});

test('hashPassword：同一密码 + 同一盐值始终产生相同哈希（确定性）', async () => {
  const salt = generateSalt();
  const h1 = await hashPassword('my-password-123', salt);
  const h2 = await hashPassword('my-password-123', salt);
  assert.equal(h1, h2);
});

test('hashPassword：同一密码不同盐值产生不同哈希', async () => {
  const h1 = await hashPassword('my-password-123', generateSalt());
  const h2 = await hashPassword('my-password-123', generateSalt());
  assert.notEqual(h1, h2);
});

test('verifyPassword：正确密码通过校验', async () => {
  const salt = generateSalt();
  const hash = await hashPassword('correct-password', salt);
  assert.equal(await verifyPassword('correct-password', salt, hash), true);
});

test('verifyPassword：错误密码拒绝', async () => {
  const salt = generateSalt();
  const hash = await hashPassword('correct-password', salt);
  assert.equal(await verifyPassword('wrong-password', salt, hash), false);
});

test('verifyPassword：哈希长度不同（脏数据/篡改）时安全返回 false，不抛异常', async () => {
  const salt = generateSalt();
  assert.equal(await verifyPassword('any-password', salt, 'short-invalid-hash'), false);
});

test('verifyPassword：expectedHash 缺失/undefined 时安全返回 false', async () => {
  const salt = generateSalt();
  assert.equal(await verifyPassword('any-password', salt, undefined), false);
});
