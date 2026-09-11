'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractMaterialTotals,
  convertJinToKg,
  buildEstimatedMonthlySupplyNeedsText
} = require('./materialAggregateHelpers');

// ==================== extractMaterialTotals ====================

test('extractMaterialTotals：正常聚合结果正确提取四个总量', () => {
  const result = extractMaterialTotals({
    list: [{ totalRice: 120.5, totalFlour: 30, totalOil: 15.2, totalVegetable: 200 }]
  });
  assert.deepEqual(result, { riceTotal: 120.5, flourTotal: 30, oilTotal: 15.2, vegetableTotal: 200 });
});

test('extractMaterialTotals：list 为空数组（无匹配记录）时全部兜底为 0', () => {
  const result = extractMaterialTotals({ list: [] });
  assert.deepEqual(result, { riceTotal: 0, flourTotal: 0, oilTotal: 0, vegetableTotal: 0 });
});

test('extractMaterialTotals：整个结果为 null/undefined/非法形状时安全兜底，不抛异常', () => {
  assert.deepEqual(extractMaterialTotals(null), { riceTotal: 0, flourTotal: 0, oilTotal: 0, vegetableTotal: 0 });
  assert.deepEqual(extractMaterialTotals(undefined), { riceTotal: 0, flourTotal: 0, oilTotal: 0, vegetableTotal: 0 });
  assert.deepEqual(extractMaterialTotals({}), { riceTotal: 0, flourTotal: 0, oilTotal: 0, vegetableTotal: 0 });
  assert.deepEqual(extractMaterialTotals({ list: 'not-an-array' }), { riceTotal: 0, flourTotal: 0, oilTotal: 0, vegetableTotal: 0 });
});

test('extractMaterialTotals：字段值为非数字字符串时兜底为 0，不产生 NaN', () => {
  const result = extractMaterialTotals({ list: [{ totalRice: 'abc', totalFlour: null }] });
  assert.equal(result.riceTotal, 0);
  assert.equal(result.flourTotal, 0);
});

// ==================== convertJinToKg ====================

test('convertJinToKg：正确按 0.5 换算并保留一位小数', () => {
  assert.equal(convertJinToKg(100), 50);
  assert.equal(convertJinToKg(3), 1.5);
  assert.equal(convertJinToKg(3.33), 1.7); // 1.665 四舍五入到一位小数
});

test('convertJinToKg：0/负数/非法输入安全兜底为 0', () => {
  assert.equal(convertJinToKg(0), 0);
  assert.equal(convertJinToKg(-5), -2.5); // 负数按原样换算，不额外做 Math.max(0,...)，异常数据交给上游校验
  assert.equal(convertJinToKg(null), 0);
  assert.equal(convertJinToKg(undefined), 0);
  assert.equal(convertJinToKg('abc'), 0);
});

// ==================== buildEstimatedMonthlySupplyNeedsText ====================

test('buildEstimatedMonthlySupplyNeedsText：0 或负数返回"暂无数据"文案', () => {
  assert.equal(buildEstimatedMonthlySupplyNeedsText(0), '暂无近30天食材消耗数据');
  assert.equal(buildEstimatedMonthlySupplyNeedsText(-10), '暂无近30天食材消耗数据');
});

test('buildEstimatedMonthlySupplyNeedsText：小于 1000kg 按公斤展示', () => {
  assert.equal(buildEstimatedMonthlySupplyNeedsText(500), '大米约需 500 公斤/月');
  assert.equal(buildEstimatedMonthlySupplyNeedsText(999.6), '大米约需 1000 公斤/月');
});

test('buildEstimatedMonthlySupplyNeedsText：大于等于 1000kg 换算成吨展示', () => {
  assert.equal(buildEstimatedMonthlySupplyNeedsText(1000), '大米约需 1 吨/月');
  assert.equal(buildEstimatedMonthlySupplyNeedsText(2500), '大米约需 2.5 吨/月');
});

test('buildEstimatedMonthlySupplyNeedsText：非法输入按 0 处理，不抛异常', () => {
  assert.equal(buildEstimatedMonthlySupplyNeedsText(null), '暂无近30天食材消耗数据');
  assert.equal(buildEstimatedMonthlySupplyNeedsText('abc'), '暂无近30天食材消耗数据');
});
