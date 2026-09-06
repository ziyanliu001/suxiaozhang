'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSettlementConfigInput, VALID_PAYMENT_MODES } = require('./validateSettlementConfig');

const BASE = { paymentMode: 'none', producerRate: 0.75, promoterRate: 0.2 };

test('合法配置通过校验', () => {
  const res = validateSettlementConfigInput(BASE);
  assert.equal(res.valid, true);
});

test('paymentMode 只认 none/direct_wechat 两个真实存在的取值，其余一律拒绝', () => {
  assert.deepEqual(VALID_PAYMENT_MODES, ['none', 'direct_wechat']);
  assert.equal(validateSettlementConfigInput({ ...BASE, paymentMode: 'direct_wechat' }).valid, true);
  assert.equal(validateSettlementConfigInput({ ...BASE, paymentMode: 'agent_settlement' }).valid, false);
  assert.equal(validateSettlementConfigInput({ ...BASE, paymentMode: '' }).valid, false);
  assert.equal(validateSettlementConfigInput({ ...BASE, paymentMode: undefined }).valid, false);
});

test('producerRate 非法值（负数/超过1/非数字）时拒绝', () => {
  assert.equal(validateSettlementConfigInput({ ...BASE, producerRate: -0.1 }).valid, false);
  assert.equal(validateSettlementConfigInput({ ...BASE, producerRate: 1.1 }).valid, false);
  assert.equal(validateSettlementConfigInput({ ...BASE, producerRate: NaN }).valid, false);
  assert.equal(validateSettlementConfigInput({ ...BASE, producerRate: '0.75' }).valid, false);
});

test('promoterRate 非法值（负数/超过1/非数字）时拒绝，允许为 0', () => {
  assert.equal(validateSettlementConfigInput({ ...BASE, promoterRate: -0.1 }).valid, false);
  assert.equal(validateSettlementConfigInput({ ...BASE, promoterRate: 1.1 }).valid, false);
  assert.equal(validateSettlementConfigInput({ ...BASE, promoterRate: NaN }).valid, false);
  assert.equal(validateSettlementConfigInput({ ...BASE, promoterRate: 0 }).valid, true);
});

test('producerRate + promoterRate 恰好等于 1 时通过（边界值，平台费率为0也合法）', () => {
  assert.equal(validateSettlementConfigInput({ paymentMode: 'none', producerRate: 0.8, promoterRate: 0.2 }).valid, true);
});

test('producerRate + promoterRate 之和超过 1 时拒绝', () => {
  assert.equal(validateSettlementConfigInput({ paymentMode: 'none', producerRate: 0.9, promoterRate: 0.2 }).valid, false);
});

test('两者都为 0 时通过（100% 平台费率，极端但合法的配置）', () => {
  assert.equal(validateSettlementConfigInput({ paymentMode: 'none', producerRate: 0, promoterRate: 0 }).valid, true);
});
