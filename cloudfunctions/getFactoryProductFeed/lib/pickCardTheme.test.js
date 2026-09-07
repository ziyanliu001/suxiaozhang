'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickCardTheme, hashString, EMOJI_POOL, COLOR_POOL } = require('./pickCardTheme');

test('同一个 productId 每次调用返回完全一致的主题（确定性，不是随机）', () => {
  const a = pickCardTheme('product_abc');
  const b = pickCardTheme('product_abc');
  assert.deepEqual(a, b);
});

test('返回值一定落在预设的 emoji/颜色池内', () => {
  const theme = pickCardTheme('some_id');
  assert.ok(EMOJI_POOL.includes(theme.emoji));
  assert.ok(COLOR_POOL.includes(theme.color));
});

test('不同 productId 大概率取到不同主题（弱校验，用真实量级的 _id 抽样，不应全部相同）', () => {
  // 真实 productId 是云数据库自动生成的随机字符串（约 20+ 位），不是单字符——
  // 单字符样本 char code 挨得太近，哈希桶会撞在一起，不是这个函数的缺陷，
  // 是测试样本不真实
  const ids = ['64f1a2b3c4d5e6f7a8b90001', '64f1a2b3c4d5e6f7a8b90002', '64f1a2b3c4d5e6f7a8b90099', '64f1a2b3c4d5e6f7a8b90fff'];
  const themes = ids.map((id) => pickCardTheme(id));
  const uniqueColors = new Set(themes.map((t) => t.color));
  assert.ok(uniqueColors.size > 1);
});

test('空字符串/undefined/null 不抛异常，安全返回池内某个值', () => {
  assert.doesNotThrow(() => pickCardTheme(''));
  assert.doesNotThrow(() => pickCardTheme(undefined));
  assert.doesNotThrow(() => pickCardTheme(null));
  const theme = pickCardTheme(undefined);
  assert.ok(EMOJI_POOL.includes(theme.emoji));
});

test('hashString 对相同输入返回相同哈希值', () => {
  assert.equal(hashString('hello'), hashString('hello'));
});

test('hashString 对空字符串返回 0，不抛异常', () => {
  assert.equal(hashString(''), 0);
});
