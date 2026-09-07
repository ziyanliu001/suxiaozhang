'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTierPrice } = require('./groupBuyTier');

const TIERS = [
  { minQuantity: 10, unitPriceOverride: 900 },
  { minQuantity: 30, unitPriceOverride: 800 },
  { minQuantity: 50, unitPriceOverride: 700 }
];

test('未达最低阶梯时使用原价，appliedTierLevel 为 0', () => {
  const r = resolveTierPrice(TIERS, 5, 1000);
  assert.equal(r.unitPrice, 1000);
  assert.equal(r.appliedTierLevel, 0);
});

test('恰好达到某档 minQuantity 时命中该档（边界值）', () => {
  const r = resolveTierPrice(TIERS, 10, 1000);
  assert.equal(r.unitPrice, 900);
  assert.equal(r.appliedTierLevel, 10);
});

test('介于两档之间时命中较低的那档', () => {
  const r = resolveTierPrice(TIERS, 25, 1000);
  assert.equal(r.unitPrice, 900);
  assert.equal(r.appliedTierLevel, 10);
});

test('超过最高档时命中最高档', () => {
  const r = resolveTierPrice(TIERS, 100, 1000);
  assert.equal(r.unitPrice, 700);
  assert.equal(r.appliedTierLevel, 50);
});

test('tierThresholds 乱序传入也能正确排序命中', () => {
  const shuffled = [TIERS[2], TIERS[0], TIERS[1]];
  const r = resolveTierPrice(shuffled, 40, 1000);
  assert.equal(r.unitPrice, 800);
  assert.equal(r.appliedTierLevel, 30);
});

test('空数组/非法输入时安全返回原价，不抛异常', () => {
  assert.deepEqual(resolveTierPrice([], 100, 1000), { unitPrice: 1000, appliedTierLevel: 0 });
  assert.deepEqual(resolveTierPrice(null, 100, 1000), { unitPrice: 1000, appliedTierLevel: 0 });
  assert.deepEqual(resolveTierPrice(undefined, 100, 1000), { unitPrice: 1000, appliedTierLevel: 0 });
});

test('数组元素字段缺失/非法时被过滤，不参与命中计算', () => {
  const dirty = [{ minQuantity: 10 }, { unitPriceOverride: 500 }, null, { minQuantity: 20, unitPriceOverride: 600 }];
  const r = resolveTierPrice(dirty, 20, 1000);
  assert.equal(r.unitPrice, 600);
  assert.equal(r.appliedTierLevel, 20);
});
