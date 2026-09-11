'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canMarkShipped,
  canMarkReadyForPickup,
  canVerifyPickup,
  normalizeDeliveryMethod
} = require('./orderStatusMachine');

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

// ==================== canMarkReadyForPickup（到店自提：生成核销码）====================

test('canMarkReadyForPickup：paid/in_production 允许生成核销码，且不算"已生成"', () => {
  assert.equal(canMarkReadyForPickup('paid').allowed, true);
  assert.equal(canMarkReadyForPickup('paid').alreadyReady, false);
  assert.equal(canMarkReadyForPickup('in_production').allowed, true);
});

test('canMarkReadyForPickup：ready_for_pickup 幂等重入，标记为已生成', () => {
  const res = canMarkReadyForPickup('ready_for_pickup');
  assert.equal(res.allowed, true);
  assert.equal(res.alreadyReady, true);
});

test('canMarkReadyForPickup：verified/refunded/pending_payment/failed 一律拒绝——已核销完成的订单不能倒退回待自提', () => {
  ['verified', 'refunded', 'pending_payment', 'failed', 'shipped'].forEach((s) => {
    assert.equal(canMarkReadyForPickup(s).allowed, false, `${s} 不应允许生成核销码`);
  });
});

// ==================== canVerifyPickup（到店自提：核销）====================

test('canVerifyPickup：ready_for_pickup 允许核销，且不算"已核销"', () => {
  const res = canVerifyPickup('ready_for_pickup');
  assert.equal(res.allowed, true);
  assert.equal(res.alreadyVerified, false);
});

test('canVerifyPickup：verified 幂等重入，标记为已核销', () => {
  const res = canVerifyPickup('verified');
  assert.equal(res.allowed, true);
  assert.equal(res.alreadyVerified, true);
});

test('canVerifyPickup：paid/in_production/shipped/refunded 一律拒绝——尚未生成核销码或已走物流路径', () => {
  ['paid', 'in_production', 'shipped', 'refunded', 'pending_payment'].forEach((s) => {
    assert.equal(canVerifyPickup(s).allowed, false, `${s} 不应允许核销`);
  });
});

// ==================== normalizeDeliveryMethod ====================

test('normalizeDeliveryMethod：self_pickup 原样保留', () => {
  assert.equal(normalizeDeliveryMethod('self_pickup'), 'self_pickup');
});

test('normalizeDeliveryMethod：logistics/缺失/非法值一律兜底为 logistics（老订单/老客户端兼容）', () => {
  assert.equal(normalizeDeliveryMethod('logistics'), 'logistics');
  assert.equal(normalizeDeliveryMethod(undefined), 'logistics');
  assert.equal(normalizeDeliveryMethod(''), 'logistics');
  assert.equal(normalizeDeliveryMethod('some_typo'), 'logistics');
});
