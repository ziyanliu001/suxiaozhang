'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isDefaultOcrResultEmpty,
  isParseReceiptResultEmpty,
  adaptParseReceiptDraftToLegacyResult,
  adaptLegacyOcrResultToParseReceiptDraft
} = require('./ocrEngineFallback');

// ==================== isDefaultOcrResultEmpty ====================

test('isDefaultOcrResultEmpty：success:false 判定为空', () => {
  assert.equal(isDefaultOcrResultEmpty({ success: false }), true);
});

test('isDefaultOcrResultEmpty：null/undefined 结果判定为空', () => {
  assert.equal(isDefaultOcrResultEmpty(null), true);
  assert.equal(isDefaultOcrResultEmpty(undefined), true);
});

test('isDefaultOcrResultEmpty：success:true 判定为非空', () => {
  assert.equal(isDefaultOcrResultEmpty({ success: true, amount: '12.00' }), false);
});

// ==================== isParseReceiptResultEmpty ====================

test('isParseReceiptResultEmpty：success:false 判定为空', () => {
  assert.equal(isParseReceiptResultEmpty({ success: false, error: '解析失败' }), true);
});

test('isParseReceiptResultEmpty：success:true 但 items 空且 totalAmount 为 null 判定为空', () => {
  assert.equal(isParseReceiptResultEmpty({ success: true, items: [], totalAmount: null }), true);
});

test('isParseReceiptResultEmpty：items 有内容时判定为非空，即使 totalAmount 为 null', () => {
  assert.equal(isParseReceiptResultEmpty({ success: true, items: [{ name: '青菜', amount: 3 }], totalAmount: null }), false);
});

test('isParseReceiptResultEmpty：totalAmount 有值时判定为非空，即使 items 为空', () => {
  assert.equal(isParseReceiptResultEmpty({ success: true, items: [], totalAmount: 39.9 }), false);
});

// ==================== adaptParseReceiptDraftToLegacyResult ====================

test('adaptParseReceiptDraftToLegacyResult：正常 draft 转成旧字段结果形状', () => {
  const draft = {
    merchant: '鲜丰水果生鲜超市',
    totalAmount: 39.9,
    discountAmount: 5,
    flagNeedsReview: false,
    items: [
      { name: '苹果', amount: 12.5 },
      { name: '香蕉', amount: 27.4 }
    ]
  };
  const legacy = adaptParseReceiptDraftToLegacyResult(draft);
  assert.equal(legacy.success, true);
  assert.equal(legacy.amount, '39.90');
  assert.equal(legacy.totalAmount, '39.90');
  assert.equal(legacy.merchant, '鲜丰水果生鲜超市');
  assert.equal(legacy.discount_amount, '5.00');
  assert.equal(legacy.isHighConfidence, true);
  assert.deepEqual(legacy.itemList, [
    { name: '苹果', price: '12.50' },
    { name: '香蕉', price: '27.40' }
  ]);
  assert.equal(legacy.formattedText, '• 苹果：¥12.50\n• 香蕉：¥27.40');
});

test('adaptParseReceiptDraftToLegacyResult：items 为空、只有 totalAmount 时 formattedText 退回小票金额单行', () => {
  const legacy = adaptParseReceiptDraftToLegacyResult({ totalAmount: 20, items: [] });
  assert.equal(legacy.formattedText, '• 小票金额：¥20.00');
  assert.deepEqual(legacy.itemList, []);
});

test('adaptParseReceiptDraftToLegacyResult：draft 为 null/undefined 时安全兜底，不抛异常', () => {
  const legacy = adaptParseReceiptDraftToLegacyResult(null);
  assert.equal(legacy.success, true);
  assert.equal(legacy.amount, '');
  assert.equal(legacy.formattedText, '');
  assert.deepEqual(legacy.itemList, []);
});

test('adaptParseReceiptDraftToLegacyResult：flagNeedsReview 为 true 时 isHighConfidence 为 false', () => {
  const legacy = adaptParseReceiptDraftToLegacyResult({ totalAmount: 10, items: [], flagNeedsReview: true });
  assert.equal(legacy.isHighConfidence, false);
});

// ==================== adaptLegacyOcrResultToParseReceiptDraft ====================

test('adaptLegacyOcrResultToParseReceiptDraft：正常旧字段结果转成 draft 形状', () => {
  const legacy = {
    merchant: '张阿姨',
    amount: '200.00',
    itemList: [{ name: '转账', price: '200.00' }]
  };
  const draft = adaptLegacyOcrResultToParseReceiptDraft(legacy);
  assert.equal(draft.merchant, '张阿姨');
  assert.equal(draft.totalAmount, 200);
  assert.equal(draft.flagNeedsReview, true);
  assert.equal(draft.reviewReasons.length, 1);
  assert.deepEqual(draft.items, [{ name: '转账', amount: 200, categoryLabel: '其他' }]);
});

test('adaptLegacyOcrResultToParseReceiptDraft：amount 缺失/非法时 totalAmount 兜底为 null，不伪造 0', () => {
  const draft = adaptLegacyOcrResultToParseReceiptDraft({ amount: '', itemList: [] });
  assert.equal(draft.totalAmount, null);
});

test('adaptLegacyOcrResultToParseReceiptDraft：legacyResult 为 null/undefined 时安全兜底，不抛异常', () => {
  const draft = adaptLegacyOcrResultToParseReceiptDraft(null);
  assert.equal(draft.merchant, '');
  assert.equal(draft.totalAmount, null);
  assert.deepEqual(draft.items, []);
});
