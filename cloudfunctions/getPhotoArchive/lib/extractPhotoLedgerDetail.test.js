'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractReceiptLedgerDetail,
  extractMenuLedgerDetail,
  extractActivityLedgerDetail
} = require('./extractPhotoLedgerDetail');

// ==================== extractReceiptLedgerDetail ====================

test('extractReceiptLedgerDetail：photoUrl 命中 fixedExpenseItems 某一条时，展示该条目真实名称与金额', () => {
  const reportLog = {
    dateString: '2026-07-21',
    expenseAmount: 888,
    fixedExpenseItems: [
      { name: '大米采购', amount: 320, independent_image_urls: ['https://x/a.jpg'] },
      { name: '店铺租金', amount: 500, independent_image_urls: ['https://x/b.jpg'] }
    ]
  };
  const detail = extractReceiptLedgerDetail(reportLog, 'https://x/b.jpg', '张三');
  assert.deepEqual(detail, {
    categoryLabel: '店铺租金',
    amount: 500,
    submitterName: '张三',
    dateString: '2026-07-21'
  });
});

test('extractReceiptLedgerDetail：photoUrl 未命中任何专项条目（通用小票池）时，兜底展示"当日综合支出"+expenseAmount', () => {
  const reportLog = {
    dateString: '2026-07-21',
    expenseAmount: 888,
    fixedExpenseItems: [
      { name: '大米采购', amount: 320, independent_image_urls: ['https://x/a.jpg'] }
    ]
  };
  const detail = extractReceiptLedgerDetail(reportLog, 'https://x/not-matched.jpg', '张三');
  assert.equal(detail.categoryLabel, '当日综合支出');
  assert.equal(detail.amount, 888);
});

test('extractReceiptLedgerDetail：fixedExpenseItems 缺失/非数组时不抛异常，按未命中兜底', () => {
  const detail = extractReceiptLedgerDetail({ dateString: '2026-07-21', expenseAmount: 100 }, 'https://x/a.jpg', '');
  assert.equal(detail.categoryLabel, '当日综合支出');
  assert.equal(detail.amount, 100);
});

test('extractReceiptLedgerDetail：submitterRealName 缺失/查无此人时兜底展示"义工"，不留空白', () => {
  const detail = extractReceiptLedgerDetail({ dateString: '2026-07-21', expenseAmount: 100 }, '', undefined);
  assert.equal(detail.submitterName, '义工');
});

test('extractReceiptLedgerDetail：matched.amount 为 0 时仍采信条目本身的 0，不误判为"未命中"而回退 expenseAmount', () => {
  const reportLog = {
    dateString: '2026-07-21',
    expenseAmount: 999,
    fixedExpenseItems: [
      { name: '样品赠送', amount: 0, independent_image_urls: ['https://x/free.jpg'] }
    ]
  };
  const detail = extractReceiptLedgerDetail(reportLog, 'https://x/free.jpg', '李四');
  assert.equal(detail.categoryLabel, '样品赠送');
  assert.equal(detail.amount, 0);
});

test('extractReceiptLedgerDetail：reportLog 为 null/undefined 时不抛异常，全部字段按空兜底', () => {
  const detail = extractReceiptLedgerDetail(null, 'https://x/a.jpg', '');
  assert.deepEqual(detail, {
    categoryLabel: '当日综合支出',
    amount: 0,
    submitterName: '义工',
    dateString: ''
  });
});

// ==================== extractMenuLedgerDetail ====================

test('extractMenuLedgerDetail：直接透传 menuText，不做二次解析', () => {
  const detail = extractMenuLedgerDetail({ menuText: '四菜一汤：红烧茄子、清炒时蔬、番茄鸡蛋、炒豆芽、紫菜蛋花汤' });
  assert.equal(detail.menuText, '四菜一汤：红烧茄子、清炒时蔬、番茄鸡蛋、炒豆芽、紫菜蛋花汤');
});

test('extractMenuLedgerDetail：menuText 缺失/空字符串时兜底提示文案，不展示空白', () => {
  assert.equal(extractMenuLedgerDetail({}).menuText, '（未填写菜品说明）');
  assert.equal(extractMenuLedgerDetail(null).menuText, '（未填写菜品说明）');
});

// ==================== extractActivityLedgerDetail ====================

test('extractActivityLedgerDetail：优先取 totalDineCount/totalVolunteers 细分合计', () => {
  const detail = extractActivityLedgerDetail({ totalDineCount: 42, totalVolunteers: 5, diningCount: 10, volunteerCount: 2 });
  assert.equal(detail.diningCount, 42);
  assert.equal(detail.volunteerCount, 5);
  assert.equal(detail.hasSameDayReport, true);
});

test('extractActivityLedgerDetail：totalDineCount/totalVolunteers 缺失时回退 diningCount/volunteerCount', () => {
  const detail = extractActivityLedgerDetail({ diningCount: 10, volunteerCount: 2 });
  assert.equal(detail.diningCount, 10);
  assert.equal(detail.volunteerCount, 2);
});

test('extractActivityLedgerDetail：当天查无同店 report_logs（null）时，人次全部归零且 hasSameDayReport 为 false，供前端区分"真的是 0"还是"没有台账"', () => {
  const detail = extractActivityLedgerDetail(null);
  assert.equal(detail.diningCount, 0);
  assert.equal(detail.volunteerCount, 0);
  assert.equal(detail.hasSameDayReport, false);
});
