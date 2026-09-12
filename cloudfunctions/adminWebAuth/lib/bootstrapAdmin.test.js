'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MIN_PASSWORD_LENGTH, validateBootstrapInput, buildAdminDocId } = require('./bootstrapAdmin');

// ==================== validateBootstrapInput ====================

test('合法的用户名 + 密码通过校验，用户名去除首尾空白', () => {
  const res = validateBootstrapInput('  admin  ', 'a'.repeat(MIN_PASSWORD_LENGTH));
  assert.equal(res.valid, true);
  assert.equal(res.username, 'admin');
});

test('用户名为空/纯空白/undefined 时拒绝', () => {
  assert.equal(validateBootstrapInput('', 'a'.repeat(MIN_PASSWORD_LENGTH)).valid, false);
  assert.equal(validateBootstrapInput('   ', 'a'.repeat(MIN_PASSWORD_LENGTH)).valid, false);
  assert.equal(validateBootstrapInput(undefined, 'a'.repeat(MIN_PASSWORD_LENGTH)).valid, false);
});

test('用户名超过 50 字时拒绝', () => {
  const res = validateBootstrapInput('u'.repeat(51), 'a'.repeat(MIN_PASSWORD_LENGTH));
  assert.equal(res.valid, false);
  assert.match(res.error, /用户名过长/);
});

test('密码短于最小长度时拒绝', () => {
  const res = validateBootstrapInput('admin', 'short');
  assert.equal(res.valid, false);
  assert.match(res.error, new RegExp(String(MIN_PASSWORD_LENGTH)));
});

test('密码为空/undefined 时拒绝', () => {
  assert.equal(validateBootstrapInput('admin', '').valid, false);
  assert.equal(validateBootstrapInput('admin', undefined).valid, false);
});

test('密码恰好等于最小长度时通过', () => {
  assert.equal(validateBootstrapInput('admin', 'a'.repeat(MIN_PASSWORD_LENGTH)).valid, true);
});

// ==================== buildAdminDocId ====================

test('确定性——相同用户名始终生成相同文档 ID', () => {
  assert.equal(buildAdminDocId('admin'), buildAdminDocId('admin'));
});

test('大小写不敏感——避免同一用户名因大小写不同被当成两个账号', () => {
  assert.equal(buildAdminDocId('Admin'), buildAdminDocId('admin'));
});

test('不同用户名生成不同文档 ID', () => {
  assert.notEqual(buildAdminDocId('admin1'), buildAdminDocId('admin2'));
});

test('固定前缀，便于人工在数据库控制台按前缀识别', () => {
  assert.match(buildAdminDocId('admin'), /^web_admin_[a-f0-9]{32}$/);
});

test('空/undefined 用户名安全兜底，不抛异常', () => {
  assert.doesNotThrow(() => buildAdminDocId(''));
  assert.doesNotThrow(() => buildAdminDocId(undefined));
});
