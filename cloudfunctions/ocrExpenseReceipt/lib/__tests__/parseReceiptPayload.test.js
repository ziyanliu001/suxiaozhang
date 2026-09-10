'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseReceiptPayload,
  classifyItemCategory,
  extractTotalAmount,
  extractMerchant,
  extractReportDate,
  extractDiscountAmount
} = require('../parseReceiptPayload');

// ==================== 场景一：超市机打小票（含折扣与实付） ====================

test('超市机打小票：识别商品明细、折扣、实付金额，明细合计-优惠=实付时不标记疑点', () => {
  const lines = [
    '好邻居生活超市',
    '青菜 3.20',
    '豆腐 4.50',
    '洗洁精 12.00',
    '小计：19.70',
    '店铺优惠：2.00',
    '实付金额：17.70',
    '找零：0.00',
    '2026年09月10日 18:23:05',
    '欢迎光临，谢谢惠顾'
  ];
  const result = parseReceiptPayload(lines);

  assert.equal(result.merchant, '好邻居生活超市');
  assert.equal(result.reportDate, '2026-09-10');
  assert.equal(result.totalAmount, 17.7);
  assert.equal(result.totalAmountSource, 'tier1_actual_pay');
  assert.equal(result.discountAmount, 2);
  assert.equal(result.items.length, 3);
  assert.equal(result.sumItemsAmount, 19.7);
  assert.equal(result.categorySummary.fresh_veggie, 7.7); // 青菜+豆腐
  assert.equal(result.categorySummary.kitchen_supplies, 12);
  assert.equal(result.categorySummary.staple_grain_oil, 0);
  assert.deepEqual(result.reviewReasons, []);
  assert.equal(result.flagNeedsReview, false);
});

test('超市机打小票：找零行绝不会被当成总金额或商品行', () => {
  const result = parseReceiptPayload(['实付：20.00', '找零：5.00', '青菜 10.00']);
  assert.equal(result.totalAmount, 20);
  assert.ok(!result.items.some((i) => i.amount === 5));
});

// ==================== 场景二：农贸市场手写收据（单价/重量/合计） ====================

test('农贸市场手写收据：单价×重量=小计的三种写法都能正确解析并通过一致性校验', () => {
  const lines = [
    '陈记蔬菜摊',
    '青菜 3斤 x 2.50 = 7.50',
    '土豆 5斤 x 1.80 = 9.00',
    '豆角 2斤 4.60', // 只给重量+小计，没写单价，单价反推不参与校验
    '合计：21.10',
    '2026-09-08'
  ];
  const result = parseReceiptPayload(lines);

  assert.equal(result.merchant, '陈记蔬菜摊');
  assert.equal(result.reportDate, '2026-09-08');
  assert.equal(result.totalAmount, 21.1);
  assert.equal(result.totalAmountSource, 'tier2_subtotal');
  assert.equal(result.items.length, 3);

  const qingcai = result.items.find((i) => i.name === '青菜');
  assert.equal(qingcai.quantity, 3);
  assert.equal(qingcai.unitPrice, 2.5);
  assert.equal(qingcai.amount, 7.5);
  assert.equal(qingcai.priceMismatch, false);
  assert.equal(qingcai.category, 'fresh_veggie');

  const doujiao = result.items.find((i) => i.name === '豆角');
  assert.equal(doujiao.quantity, 2);
  assert.equal(doujiao.amount, 4.6);
  assert.equal(doujiao.unitPrice, 2.3); // 4.60 / 2 反推
  assert.equal(doujiao.priceMismatch, false); // 反推单价不参与一致性校验，不会被误标

  assert.equal(result.flagNeedsReview, false);
});

test('单价×数量与识别金额不一致时标记 priceMismatch，并把具体品名写进 reviewReasons', () => {
  // OCR 疑似把秤重数字识别错：4 斤 × 2.00 元/斤 = 8.00，但整行金额印的是 12.00
  const result = parseReceiptPayload(['临时测试摊', '白萝卜 4斤 x 2.00 = 12.00', '实付：12.00']);

  const item = result.items.find((i) => i.name === '白萝卜');
  assert.ok(item);
  assert.equal(item.priceMismatch, true);
  assert.equal(item.expectedAmount, 8);
  assert.ok(result.reviewReasons.some((r) => r.includes('白萝卜')));
  assert.equal(result.flagNeedsReview, true);
});

test('[xN] 数量标记场景：印刷数字是单价，需要乘以数量才是小计，不应误报 priceMismatch', () => {
  const result = parseReceiptPayload(['洗洁精[x2] 12.00']);
  const item = result.items[0];
  assert.equal(item.quantity, 2);
  assert.equal(item.unitPrice, 12);
  assert.equal(item.amount, 24);
  assert.equal(item.priceMismatch, false);
});

// ==================== 场景三：模糊/缺漏金额的兜底异常分支 ====================

test('彻底无法识别出总金额与商品明细：totalAmount 为 null，如实标记疑点，不编造数据', () => {
  const result = parseReceiptPayload(['###', '???@@@', '3.5', '----']);
  assert.equal(result.totalAmount, null);
  assert.equal(result.items.length, 0);
  assert.equal(result.flagNeedsReview, true);
  assert.ok(result.reviewReasons.some((r) => r.includes('未能识别到总金额')));
  assert.ok(result.reviewReasons.some((r) => r.includes('交易对手')));
  assert.ok(result.reviewReasons.some((r) => r.includes('日期')));
});

test('没有总金额关键字但有可解析的商品明细：退回明细合计代替，且必须标记疑点（不当成高置信度结果）', () => {
  const result = parseReceiptPayload([
    '阳光生鲜',
    '大米 5斤 x 3.00 = 15.00',
    '食用油 25.00',
    '2026/09/09'
  ]);

  assert.equal(result.totalAmount, 40);
  assert.equal(result.totalAmountSource, null); // 关键字层面确实没找到，来源字段如实为空
  assert.equal(result.flagNeedsReview, true);
  assert.ok(result.reviewReasons.some((r) => r.includes('已用商品明细合计代替')));
  assert.equal(result.merchant, '阳光生鲜');
  assert.equal(result.reportDate, '2026-09-09');
});

test('总金额与商品明细合计相差过大：标记疑点并给出具体差额', () => {
  const result = parseReceiptPayload(['青菜 10.00', '豆腐 10.00', '实付：5.00']);
  assert.equal(result.flagNeedsReview, true);
  assert.ok(result.reviewReasons.some((r) => r.includes('相差')));
});

test('空输入/非法输入永不抛异常，如实归约为"识别不到"', () => {
  assert.doesNotThrow(() => parseReceiptPayload(null));
  assert.doesNotThrow(() => parseReceiptPayload(undefined));
  assert.doesNotThrow(() => parseReceiptPayload(12345));
  assert.doesNotThrow(() => parseReceiptPayload({}));

  const result = parseReceiptPayload(null);
  assert.equal(result.totalAmount, null);
  assert.equal(result.items.length, 0);
  assert.equal(result.flagNeedsReview, true);
  assert.deepEqual(result.rawTextLines, []);
});

// ==================== 场景四：增值税电子发票样例 ====================

test('增值税电子发票：价税合计（小写）优先作为总金额，销售方与购买方不会互相认错', () => {
  const lines = [
    '电子发票（普通发票）',
    '发票号码：25332000000123456789',
    '开票日期：2026年09月10日',
    '购买方名称：雨花斋素食馆',
    '销售方名称：宏发粮油贸易有限公司',
    '货物名称：大米 数量：10 单价：45.00 金额：450.00',
    '货物名称：食用油 数量：5 单价：60.00 金额：300.00',
    '价税合计（大写）柒佰伍拾元整 （小写）¥750.00'
  ];
  const result = parseReceiptPayload(lines);

  assert.equal(result.merchant, '宏发粮油贸易有限公司');
  assert.notEqual(result.merchant, '雨花斋素食馆'); // 购买方是"我们自己"，绝不能被当成交易对手
  assert.equal(result.reportDate, '2026-09-10');
  assert.equal(result.totalAmount, 750);
  assert.equal(result.totalAmountSource, 'invoice_total');
  assert.equal(result.items.length, 2);

  const rice = result.items.find((i) => i.name === '大米');
  assert.equal(rice.quantity, 10);
  assert.equal(rice.unitPrice, 45);
  assert.equal(rice.amount, 450);
  assert.equal(rice.category, 'staple_grain_oil');

  const oil = result.items.find((i) => i.name === '食用油');
  assert.equal(oil.amount, 300);
  assert.equal(oil.category, 'staple_grain_oil');

  assert.equal(result.flagNeedsReview, false);
  assert.deepEqual(result.reviewReasons, []);
});

test('发票场景：销售方标签单独一行、名称在下一行时同样能识别（拆行兼容）', () => {
  const merchant = extractMerchant(['购买方：雨花斋素食馆', '销售方名称：', '锦绣果蔬批发部']);
  assert.equal(merchant, '锦绣果蔬批发部');
});

// ==================== 分类归集（品类 -> 预设类别）独立单测 ====================

test('classifyItemCategory：大米/面粉类映射到主食粮油', () => {
  assert.equal(classifyItemCategory('东北大米').key, 'staple_grain_oil');
  assert.equal(classifyItemCategory('富强粉').key, 'staple_grain_oil');
  assert.equal(classifyItemCategory('大豆油').key, 'staple_grain_oil');
});

test('classifyItemCategory：青菜/豆腐类映射到生鲜蔬菜', () => {
  assert.equal(classifyItemCategory('青菜').key, 'fresh_veggie');
  assert.equal(classifyItemCategory('嫩豆腐').key, 'fresh_veggie');
});

test('classifyItemCategory：洗洁精/纸巾类映射到后厨耗材', () => {
  assert.equal(classifyItemCategory('洗洁精').key, 'kitchen_supplies');
  assert.equal(classifyItemCategory('抽纸巾').key, 'kitchen_supplies');
});

test('classifyItemCategory：不在任何预设关键词表里的品类兜底归为"其他"，不强行凑类别', () => {
  const c = classifyItemCategory('矿泉水');
  assert.equal(c.key, 'other');
  assert.equal(c.label, '其他');
});

// ==================== 总金额/日期/商户/优惠 —— 关键子函数独立单测 ====================

test('extractTotalAmount：关键字单独一行、金额在下一行的拆行兼容', () => {
  const r = extractTotalAmount(['实付', '57.30']);
  assert.equal(r.amount, 57.3);
  assert.equal(r.source, 'tier1_actual_pay');
});

test('extractTotalAmount：找零行必须被排除，不干扰总金额判定', () => {
  const r = extractTotalAmount(['找零：3.00', '实付：20.00']);
  assert.equal(r.amount, 20);
});

test('extractTotalAmount：千分位逗号金额能正确解析', () => {
  const r = extractTotalAmount(['价税合计（大写）壹仟贰佰元整 （小写）¥1,200.00']);
  assert.equal(r.amount, 1200);
  assert.equal(r.source, 'invoice_total');
});

test('extractDiscountAmount：多条优惠行累加，不是只取第一条', () => {
  assert.equal(extractDiscountAmount(['店铺优惠：5.00', '优惠券：3.50']), 8.5);
  assert.equal(extractDiscountAmount(['青菜 10.00']), 0);
});

test('extractReportDate：兼容 年/月/日、连字符、斜杠三种分隔符', () => {
  assert.equal(extractReportDate(['2026年09月10日']), '2026-09-10');
  assert.equal(extractReportDate(['2026-9-8']), '2026-09-08');
  assert.equal(extractReportDate(['2026/09/09']), '2026-09-09');
});

test('extractReportDate：月份/日期非法时不编造一个假日期，返回空字符串', () => {
  assert.equal(extractReportDate(['2026-13-01']), '');
  assert.equal(extractReportDate(['没有任何日期信息的一行文字']), '');
});
