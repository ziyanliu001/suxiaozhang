'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkInvariant } = require('./checkInvariant');

test('三者之和等于 payAmount 时通过', () => {
  assert.equal(checkInvariant({ payAmount: 1000, producerAmount: 850, promoterAmount: 50, platformFee: 100 }), true);
});

test('三者之和不等于 payAmount 时不通过（数据异常）', () => {
  assert.equal(checkInvariant({ payAmount: 1000, producerAmount: 850, promoterAmount: 50, platformFee: 50 }), false);
});

test('净额行（红冲后归零）也应通过：0+0+0===0', () => {
  assert.equal(checkInvariant({ payAmount: 0, producerAmount: 0, promoterAmount: 0, platformFee: 0 }), true);
});

test('字段缺失时按 0 兜底计算，不抛异常', () => {
  assert.equal(checkInvariant({ payAmount: 0 }), true);
  assert.equal(checkInvariant({}), true);
});

test('row 为 null/undefined 时返回 false（不是"通过"，是"无法判断，视为异常"）', () => {
  assert.equal(checkInvariant(null), false);
  assert.equal(checkInvariant(undefined), false);
});
