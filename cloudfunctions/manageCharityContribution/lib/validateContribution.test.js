'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePledgeInput, validateRedeemInput } = require('./validateContribution');

const SETTLED = { settlementStatus: 'settled', isReversal: false, producerAmount: 1000 };

test('合法转捐（金额等于制作方分成）通过校验', () => {
  const res = validatePledgeInput({ amount: 1000, settlement: SETTLED });
  assert.equal(res.valid, true);
});

test('合法转捐（金额小于制作方分成）通过校验', () => {
  const res = validatePledgeInput({ amount: 500, settlement: SETTLED });
  assert.equal(res.valid, true);
});

test('分账记录不存在时拒绝', () => {
  assert.equal(validatePledgeInput({ amount: 500, settlement: null }).valid, false);
});

test('红冲记录不能转捐', () => {
  const res = validatePledgeInput({ amount: 500, settlement: { ...SETTLED, isReversal: true } });
  assert.equal(res.valid, false);
});

test('未结算（unsettled）状态不能转捐', () => {
  const res = validatePledgeInput({ amount: 500, settlement: { ...SETTLED, settlementStatus: 'unsettled' } });
  assert.equal(res.valid, false);
});

test('已撤销（refunded）状态不能转捐', () => {
  const res = validatePledgeInput({ amount: 500, settlement: { ...SETTLED, settlementStatus: 'refunded' } });
  assert.equal(res.valid, false);
});

test('转捐金额为 0/负数/非整数时拒绝', () => {
  assert.equal(validatePledgeInput({ amount: 0, settlement: SETTLED }).valid, false);
  assert.equal(validatePledgeInput({ amount: -100, settlement: SETTLED }).valid, false);
  assert.equal(validatePledgeInput({ amount: 99.5, settlement: SETTLED }).valid, false);
});

test('转捐金额超过制作方分成金额时拒绝', () => {
  assert.equal(validatePledgeInput({ amount: 1001, settlement: SETTLED }).valid, false);
});

test('核销备注合法/超长', () => {
  assert.equal(validateRedeemInput({ redeemNote: '兑换成20斤大米' }).valid, true);
  assert.equal(validateRedeemInput({ redeemNote: '' }).valid, true);
  assert.equal(validateRedeemInput({ redeemNote: 'x'.repeat(201) }).valid, false);
});
