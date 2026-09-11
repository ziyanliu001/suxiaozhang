'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRefundAmount } = require('./partialRefund');

test('未传 requestedRefundAmount 时兜底为全额退款（兼容升级前调用方行为）', () => {
  const res = validateRefundAmount(10000, undefined);
  assert.equal(res.valid, true);
  assert.equal(res.amount, 10000);
  assert.equal(res.isFullRefund, true);
});

test('requestedRefundAmount 为 null/空字符串同样兜底为全额退款', () => {
  assert.equal(validateRefundAmount(10000, null).amount, 10000);
  assert.equal(validateRefundAmount(10000, '').amount, 10000);
});

test('合法的部分退款金额通过校验，isFullRefund 为 false', () => {
  const res = validateRefundAmount(10000, 3000);
  assert.equal(res.valid, true);
  assert.equal(res.amount, 3000);
  assert.equal(res.isFullRefund, false);
});

test('退款金额等于实付金额时 isFullRefund 为 true', () => {
  const res = validateRefundAmount(10000, 10000);
  assert.equal(res.isFullRefund, true);
});

test('退款金额超过实付金额时拒绝', () => {
  const res = validateRefundAmount(10000, 10001);
  assert.equal(res.valid, false);
  assert.match(res.error, /不能超过/);
});

test('退款金额为 0/负数/非整数时拒绝', () => {
  assert.equal(validateRefundAmount(10000, 0).valid, false);
  assert.equal(validateRefundAmount(10000, -100).valid, false);
  assert.equal(validateRefundAmount(10000, 99.5).valid, false);
});

test('退款金额为非数字字符串/NaN 时拒绝，不放过脏输入', () => {
  assert.equal(validateRefundAmount(10000, 'abc').valid, false);
  assert.equal(validateRefundAmount(10000, NaN).valid, false);
});

test('订单实付金额本身异常（非正整数）时拒绝', () => {
  assert.equal(validateRefundAmount(0, 100).valid, false);
  assert.equal(validateRefundAmount(-1, 100).valid, false);
  assert.equal(validateRefundAmount(99.9, 100).valid, false);
});
