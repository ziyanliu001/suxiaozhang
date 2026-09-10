'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSmartReceiptDisplayItems,
  formatSmartReceiptTotalDisplay,
  buildSmartReceiptApplyText
} = require('./smartReceiptDraft');

// ==================== buildSmartReceiptDisplayItems ====================

test('buildSmartReceiptDisplayItems：正常 draft.items 转成 WXML 可渲染的展示数组', () => {
  const rows = buildSmartReceiptDisplayItems([
    { name: '青菜', categoryLabel: '生鲜蔬菜', amount: 3.2 },
    { name: '洗洁精', categoryLabel: '后厨耗材', amount: 12 }
  ]);
  assert.deepEqual(rows, [
    { name: '青菜', categoryLabel: '生鲜蔬菜', amountDisplay: '3.20' },
    { name: '洗洁精', categoryLabel: '后厨耗材', amountDisplay: '12.00' }
  ]);
});

test('buildSmartReceiptDisplayItems：非数组/null/undefined 兜底返回空数组，不抛异常', () => {
  assert.deepEqual(buildSmartReceiptDisplayItems(null), []);
  assert.deepEqual(buildSmartReceiptDisplayItems(undefined), []);
  assert.deepEqual(buildSmartReceiptDisplayItems('不是数组'), []);
  assert.deepEqual(buildSmartReceiptDisplayItems([]), []);
});

test('buildSmartReceiptDisplayItems：单条 item 缺 name/categoryLabel/amount 时兜底，不产生 undefined/NaN', () => {
  const rows = buildSmartReceiptDisplayItems([{}]);
  assert.equal(rows[0].name, '');
  assert.equal(rows[0].categoryLabel, '其他');
  assert.equal(rows[0].amountDisplay, '0.00');
});

// ==================== formatSmartReceiptTotalDisplay ====================

test('formatSmartReceiptTotalDisplay：正常数字格式化为两位小数字符串', () => {
  assert.equal(formatSmartReceiptTotalDisplay(17.7), '17.70');
  assert.equal(formatSmartReceiptTotalDisplay(0), '0.00');
});

test('formatSmartReceiptTotalDisplay：null/undefined（彻底未识别）返回空字符串，不伪造¥0.00', () => {
  assert.equal(formatSmartReceiptTotalDisplay(null), '');
  assert.equal(formatSmartReceiptTotalDisplay(undefined), '');
});

test('formatSmartReceiptTotalDisplay：非法数字（NaN/字符串垃圾）兜底返回空字符串', () => {
  assert.equal(formatSmartReceiptTotalDisplay(NaN), '');
  assert.equal(formatSmartReceiptTotalDisplay('abc'), '');
});

// ==================== buildSmartReceiptApplyText ====================

test('buildSmartReceiptApplyText：拼出「• 品名：¥金额」明细行 + 「实付合计：¥总额」锚点行，与既有 _applyOcrCategory 格式一致', () => {
  const text = buildSmartReceiptApplyText({
    merchant: '好邻居生活超市',
    reportDate: '2026-09-10',
    totalAmount: 17.7,
    items: [
      { name: '青菜', amount: 3.2 },
      { name: '豆腐', amount: 4.5 },
      { name: '洗洁精', amount: 12 }
    ]
  });
  assert.equal(text, '• 青菜：¥3.20\n• 豆腐：¥4.50\n• 洗洁精：¥12.00\n实付合计：¥17.70');
});

test('buildSmartReceiptApplyText：绝不把商户名称/日期拼进文本——避免污染 parseExpenseTextToItems 的明细解析', () => {
  const text = buildSmartReceiptApplyText({
    merchant: '好邻居生活超市',
    reportDate: '2026-09-10',
    totalAmount: 17.7,
    items: [{ name: '青菜', amount: 3.2 }]
  });
  assert.ok(!text.includes('好邻居生活超市'));
  assert.ok(!text.includes('2026-09-10'));
  assert.ok(!text.includes('商户'));
  assert.ok(!text.includes('日期'));
});

test('buildSmartReceiptApplyText：draft 为 null/undefined 时返回空字符串，不抛异常', () => {
  assert.equal(buildSmartReceiptApplyText(null), '');
  assert.equal(buildSmartReceiptApplyText(undefined), '');
});

test('buildSmartReceiptApplyText：items 为空数组时仍然输出实付合计锚点行', () => {
  const text = buildSmartReceiptApplyText({ totalAmount: 40, items: [] });
  assert.equal(text, '实付合计：¥40.00');
});

test('buildSmartReceiptApplyText：totalAmount 为 null（彻底未识别）时锚点行兜底为 ¥0.00，不抛异常', () => {
  const text = buildSmartReceiptApplyText({ totalAmount: null, items: [{ name: '青菜', amount: 3.2 }] });
  assert.equal(text, '• 青菜：¥3.20\n实付合计：¥0.00');
});

test('buildSmartReceiptApplyText：过滤掉缺 name 的脏 item，不产生「• ：¥x」这种空品名行', () => {
  const text = buildSmartReceiptApplyText({
    totalAmount: 10,
    items: [{ name: '', amount: 5 }, { amount: 5 }, { name: '青菜', amount: 10 }]
  });
  assert.equal(text, '• 青菜：¥10.00\n实付合计：¥10.00');
});
