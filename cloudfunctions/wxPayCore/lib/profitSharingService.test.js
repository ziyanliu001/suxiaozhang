'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateReceivers } = require('./profitSharingValidation');

test('单个合法接收方通过校验', () => {
  const res = validateReceivers({
    receivers: [{ type: 'PERSONAL_OPENID', account: 'oOpenId1', amount: 500, description: '推广分成' }],
    transactionAmount: 1000
  });
  assert.equal(res.valid, true);
  assert.equal(res.totalAmount, 500);
});

test('多个接收方金额总和不超过订单总额时通过', () => {
  const res = validateReceivers({
    receivers: [
      { type: 'PERSONAL_OPENID', account: 'producer1', amount: 700 },
      { type: 'PERSONAL_OPENID', account: 'promoter1', amount: 100 }
    ],
    transactionAmount: 1000
  });
  assert.equal(res.valid, true);
  assert.equal(res.totalAmount, 800);
});

test('接收方为空数组时拒绝', () => {
  const res = validateReceivers({ receivers: [], transactionAmount: 1000 });
  assert.equal(res.valid, false);
});

test('receivers 缺少 account 时拒绝', () => {
  const res = validateReceivers({ receivers: [{ type: 'PERSONAL_OPENID', amount: 100 }], transactionAmount: 1000 });
  assert.equal(res.valid, false);
});

test('receiver type 不在支持范围内时拒绝', () => {
  const res = validateReceivers({
    receivers: [{ type: 'UNKNOWN_TYPE', account: 'x', amount: 100 }],
    transactionAmount: 1000
  });
  assert.equal(res.valid, false);
  assert.match(res.error, /不支持的 receiver type/);
});

test('receiver amount 为 0 或非整数时拒绝', () => {
  assert.equal(validateReceivers({ receivers: [{ type: 'PERSONAL_OPENID', account: 'x', amount: 0 }], transactionAmount: 1000 }).valid, false);
  assert.equal(validateReceivers({ receivers: [{ type: 'PERSONAL_OPENID', account: 'x', amount: 10.5 }], transactionAmount: 1000 }).valid, false);
});

test('接收方金额总和超过订单实付总额时拒绝', () => {
  const res = validateReceivers({
    receivers: [
      { type: 'PERSONAL_OPENID', account: 'producer1', amount: 700 },
      { type: 'PERSONAL_OPENID', account: 'promoter1', amount: 400 }
    ],
    transactionAmount: 1000
  });
  assert.equal(res.valid, false);
  assert.match(res.error, /不能超过订单实付金额/);
});

test('未传 transactionAmount 时跳过总额上限校验（仅校验单项合法性）', () => {
  const res = validateReceivers({
    receivers: [{ type: 'PERSONAL_OPENID', account: 'x', amount: 999999 }],
    transactionAmount: undefined
  });
  assert.equal(res.valid, true);
});
