'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { secretsMatch } = require('./secretsMatch');

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
  // ⚠️ 两边都是空字符串时视为"相等"——这正是 index.js 的 authorizeCaller()
  // 必须在调用 secretsMatch 之前先单独校验 `expected`（环境变量）非空的原因：
  // 环境变量未配置 + 调用方也没传 consoleSecret 时，若直接把两个 undefined
  // 丢进来比较会得到 true，等同于"密钥留空也能通过"，与 fail-closed 的既定
  // 原则相悖。这里显式验证这个边界行为存在，提醒调用方不能跳过那道前置校验。
  assert.equal(secretsMatch(undefined, undefined), true);
});

test('secretsMatch：大小写敏感（不做归一化）', () => {
  assert.equal(secretsMatch('Secret', 'secret'), false);
});
