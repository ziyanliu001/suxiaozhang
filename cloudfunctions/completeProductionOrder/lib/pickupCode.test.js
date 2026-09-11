'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generatePickupCode, verifyPickupCode, CODE_LENGTH } = require('./pickupCode');

test('generatePickupCode：确定性——相同 orderId 始终生成相同核销码', () => {
  const a = generatePickupCode('order_123');
  const b = generatePickupCode('order_123');
  assert.equal(a, b);
});

test('generatePickupCode：不同 orderId 大概率生成不同核销码', () => {
  const a = generatePickupCode('order_1');
  const b = generatePickupCode('order_2');
  assert.notEqual(a, b);
});

test('generatePickupCode：恒为 6 位纯数字字符串', () => {
  for (let i = 0; i < 20; i++) {
    const code = generatePickupCode(`order_${i}`);
    assert.equal(code.length, CODE_LENGTH);
    assert.match(code, /^\d{6}$/);
  }
});

test('generatePickupCode：空/undefined orderId 安全兜底，不抛异常', () => {
  assert.doesNotThrow(() => generatePickupCode(''));
  assert.doesNotThrow(() => generatePickupCode(undefined));
});

test('verifyPickupCode：完全一致时通过', () => {
  assert.equal(verifyPickupCode('123456', '123456'), true);
});

test('verifyPickupCode：前后空格容忍', () => {
  assert.equal(verifyPickupCode(' 123456 ', '123456'), true);
});

test('verifyPickupCode：不一致时拒绝', () => {
  assert.equal(verifyPickupCode('123456', '654321'), false);
});

test('verifyPickupCode：任一侧为空/undefined 时拒绝，不误判为通过', () => {
  assert.equal(verifyPickupCode('', '123456'), false);
  assert.equal(verifyPickupCode('123456', ''), false);
  assert.equal(verifyPickupCode(undefined, undefined), false);
});
