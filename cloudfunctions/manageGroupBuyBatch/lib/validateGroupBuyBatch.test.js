'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGroupBuyBatch } = require('./validateGroupBuyBatch');

const NOW = new Date('2026-09-07T00:00:00Z');
const FUTURE = '2026-09-10T00:00:00Z';
const PAST = '2026-09-01T00:00:00Z';

const VALID_TIERS = [
  { minQuantity: 10, unitPriceOverride: 900 },
  { minQuantity: 30, unitPriceOverride: 800 },
  { minQuantity: 50, unitPriceOverride: 700 }
];

test('合法配置通过校验，返回排序后的档位与解析出的 deadline', () => {
  const r = validateGroupBuyBatch({ tierThresholds: VALID_TIERS, deadlineAt: FUTURE, basePriceCents: 1000 }, NOW);
  assert.equal(r.valid, true);
  assert.equal(r.sortedTierThresholds.length, 3);
  assert.equal(r.sortedTierThresholds[0].minQuantity, 10);
  assert.ok(r.deadline instanceof Date);
});

test('乱序传入也能通过校验（内部会排序）', () => {
  const shuffled = [VALID_TIERS[2], VALID_TIERS[0], VALID_TIERS[1]];
  const r = validateGroupBuyBatch({ tierThresholds: shuffled, deadlineAt: FUTURE, basePriceCents: 1000 }, NOW);
  assert.equal(r.valid, true);
  assert.equal(r.sortedTierThresholds[0].minQuantity, 10);
});

test('空数组/非数组时拒绝', () => {
  assert.equal(validateGroupBuyBatch({ tierThresholds: [], deadlineAt: FUTURE, basePriceCents: 1000 }, NOW).valid, false);
  assert.equal(validateGroupBuyBatch({ tierThresholds: null, deadlineAt: FUTURE, basePriceCents: 1000 }, NOW).valid, false);
});

test('超过 5 档时拒绝', () => {
  const sixTiers = Array.from({ length: 6 }, (_, i) => ({ minQuantity: (i + 1) * 10, unitPriceOverride: 1000 - i * 10 }));
  assert.equal(validateGroupBuyBatch({ tierThresholds: sixTiers, deadlineAt: FUTURE, basePriceCents: 1000 }, NOW).valid, false);
});

test('minQuantity 非正整数时拒绝', () => {
  const bad = [{ minQuantity: 0, unitPriceOverride: 900 }];
  assert.equal(validateGroupBuyBatch({ tierThresholds: bad, deadlineAt: FUTURE, basePriceCents: 1000 }, NOW).valid, false);
  const bad2 = [{ minQuantity: 1.5, unitPriceOverride: 900 }];
  assert.equal(validateGroupBuyBatch({ tierThresholds: bad2, deadlineAt: FUTURE, basePriceCents: 1000 }, NOW).valid, false);
});

test('unitPriceOverride 非正整数时拒绝', () => {
  const bad = [{ minQuantity: 10, unitPriceOverride: 0 }];
  assert.equal(validateGroupBuyBatch({ tierThresholds: bad, deadlineAt: FUTURE, basePriceCents: 1000 }, NOW).valid, false);
});

test('阶梯价大于等于原价时拒绝', () => {
  const bad = [{ minQuantity: 10, unitPriceOverride: 1000 }];
  assert.equal(validateGroupBuyBatch({ tierThresholds: bad, deadlineAt: FUTURE, basePriceCents: 1000 }, NOW).valid, false);
  const bad2 = [{ minQuantity: 10, unitPriceOverride: 1200 }];
  assert.equal(validateGroupBuyBatch({ tierThresholds: bad2, deadlineAt: FUTURE, basePriceCents: 1000 }, NOW).valid, false);
});

test('minQuantity 重复时拒绝', () => {
  const bad = [{ minQuantity: 10, unitPriceOverride: 900 }, { minQuantity: 10, unitPriceOverride: 800 }];
  assert.equal(validateGroupBuyBatch({ tierThresholds: bad, deadlineAt: FUTURE, basePriceCents: 1000 }, NOW).valid, false);
});

test('单价倒挂（买得多反而更贵）时拒绝', () => {
  const bad = [{ minQuantity: 10, unitPriceOverride: 700 }, { minQuantity: 30, unitPriceOverride: 800 }];
  assert.equal(validateGroupBuyBatch({ tierThresholds: bad, deadlineAt: FUTURE, basePriceCents: 1000 }, NOW).valid, false);
});

test('相邻两档单价相等时允许（单调不增，不要求严格递减）', () => {
  const ok = [{ minQuantity: 10, unitPriceOverride: 800 }, { minQuantity: 30, unitPriceOverride: 800 }];
  assert.equal(validateGroupBuyBatch({ tierThresholds: ok, deadlineAt: FUTURE, basePriceCents: 1000 }, NOW).valid, true);
});

test('deadlineAt 格式非法时拒绝', () => {
  assert.equal(validateGroupBuyBatch({ tierThresholds: VALID_TIERS, deadlineAt: '不是日期', basePriceCents: 1000 }, NOW).valid, false);
  assert.equal(validateGroupBuyBatch({ tierThresholds: VALID_TIERS, deadlineAt: '', basePriceCents: 1000 }, NOW).valid, false);
});

test('deadlineAt 早于或等于当前时间时拒绝', () => {
  assert.equal(validateGroupBuyBatch({ tierThresholds: VALID_TIERS, deadlineAt: PAST, basePriceCents: 1000 }, NOW).valid, false);
  assert.equal(validateGroupBuyBatch({ tierThresholds: VALID_TIERS, deadlineAt: NOW.toISOString(), basePriceCents: 1000 }, NOW).valid, false);
});

test('basePriceCents 非法时拒绝', () => {
  assert.equal(validateGroupBuyBatch({ tierThresholds: VALID_TIERS, deadlineAt: FUTURE, basePriceCents: 0 }, NOW).valid, false);
  assert.equal(validateGroupBuyBatch({ tierThresholds: VALID_TIERS, deadlineAt: FUTURE, basePriceCents: -100 }, NOW).valid, false);
});
