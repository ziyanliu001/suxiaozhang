'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRefundAmount, validateReusableRefundAmount } = require('./refundValidation');

test('合法的全额退款通过校验', () => {
  const res = validateRefundAmount({ refundAmount: 1000, totalAmount: 1000, alreadyRefundedAmount: 0 });
  assert.equal(res.valid, true);
});

test('合法的部分退款通过校验', () => {
  const res = validateRefundAmount({ refundAmount: 300, totalAmount: 1000, alreadyRefundedAmount: 0 });
  assert.equal(res.valid, true);
});

test('退款金额为 0 或负数时拒绝', () => {
  assert.equal(validateRefundAmount({ refundAmount: 0, totalAmount: 1000, alreadyRefundedAmount: 0 }).valid, false);
  assert.equal(validateRefundAmount({ refundAmount: -100, totalAmount: 1000, alreadyRefundedAmount: 0 }).valid, false);
});

test('退款金额为非整数（分以下）时拒绝', () => {
  const res = validateRefundAmount({ refundAmount: 10.5, totalAmount: 1000, alreadyRefundedAmount: 0 });
  assert.equal(res.valid, false);
});

test('累计已退款 + 本次退款超过原订单总额时拒绝（防止拆多笔退超）', () => {
  const res = validateRefundAmount({ refundAmount: 500, totalAmount: 1000, alreadyRefundedAmount: 800 });
  assert.equal(res.valid, false);
  assert.match(res.error, /不能超过原订单实付金额/);
});

test('累计已退款 + 本次退款恰好等于原订单总额时通过（边界值）', () => {
  const res = validateRefundAmount({ refundAmount: 200, totalAmount: 1000, alreadyRefundedAmount: 800 });
  assert.equal(res.valid, true);
});

test('原订单金额非法（0/负数/非整数）时拒绝', () => {
  assert.equal(validateRefundAmount({ refundAmount: 100, totalAmount: 0, alreadyRefundedAmount: 0 }).valid, false);
  assert.equal(validateRefundAmount({ refundAmount: 100, totalAmount: -1, alreadyRefundedAmount: 0 }).valid, false);
});

// 🛡️（2026-09-16 金融级加固）createPendingRefund 复用窗口内既有 PROCESSING
// 记录时的金额一致性校验——防止"本地账本记的是旧金额、实际提交给微信的是
// 新金额"这种危险分叉，见 refundValidation.js validateReusableRefundAmount 注释
test('复用退款记录金额一致时通过', () => {
  const res = validateReusableRefundAmount({ reusedAmount: 500, requestedAmount: 500 });
  assert.equal(res.valid, true);
});

test('复用退款记录金额不一致时拒绝，并在错误信息里带出两个金额供核对', () => {
  const res = validateReusableRefundAmount({ reusedAmount: 500, requestedAmount: 800 });
  assert.equal(res.valid, false);
  assert.match(res.error, /5\.00/);
  assert.match(res.error, /8\.00/);
});
