'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canMarkShipped } = require('./orderStatusMachine');

test('paid 状态允许标记发货，且不算"已经发过"', () => {
  const res = canMarkShipped('paid');
  assert.equal(res.allowed, true);
  assert.equal(res.alreadyShipped, false);
});

test('in_production 状态允许标记发货', () => {
  const res = canMarkShipped('in_production');
  assert.equal(res.allowed, true);
  assert.equal(res.alreadyShipped, false);
});

test('shipped 状态仍然"允许"（幂等重入，用于补录/更正快递单号），但标记为已发过', () => {
  const res = canMarkShipped('shipped');
  assert.equal(res.allowed, true);
  assert.equal(res.alreadyShipped, true);
});

test('pending_payment 状态拒绝：未付款订单没有真实交易可对应', () => {
  const res = canMarkShipped('pending_payment');
  assert.equal(res.allowed, false);
  assert.match(res.error, /pending_payment/);
});

test('refunded 状态拒绝：钱已退、产能已释放，不能倒回去标发货', () => {
  const res = canMarkShipped('refunded');
  assert.equal(res.allowed, false);
});

test('failed 状态拒绝', () => {
  const res = canMarkShipped('failed');
  assert.equal(res.allowed, false);
});

test('未知/空状态一律拒绝，不放过任何白名单外的值', () => {
  assert.equal(canMarkShipped('').allowed, false);
  assert.equal(canMarkShipped(undefined).allowed, false);
  assert.equal(canMarkShipped('some_typo_status').allowed, false);
});
