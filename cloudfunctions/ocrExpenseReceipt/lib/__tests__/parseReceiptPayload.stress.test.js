'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dataset = require('../ocrTestDataset.json');
const {
  parseReceiptPayload,
  normalizeOcrDigits,
  normalizeDecimalComma,
  chineseNumeralToValue,
  extractChineseWordAmount,
  extractChineseDate,
  cleanItemName
} = require('../parseReceiptPayload');

// 🔧（2026-09-11 真实/高拟真小票端到端压测·容错加固）本文件驱动
// ocrTestDataset.json 里 9 类高拟真脏数据样本跑通 parseReceiptPayload()，
// 与 parseReceiptPayload.test.js（针对已知正常样本的既有 21 条用例）是
// 互补关系：那份文件锁定"标准场景不能退化"，这份文件专门盯"真实世界的
// 脏数据边缘场景"，两份文件独立维护，互不删改对方的用例。
//
// 断言字段说明（expect 对象，均为可选，数据集里给了哪个字段就校验哪个）：
// - merchant/reportDate/totalAmount/totalAmountSource/flagNeedsReview：
//   直接与 parseReceiptPayload() 返回值对应字段做相等比较；
// - itemNames：这些品名必须全部出现在 result.items 里；
// - itemNamesExclude：这些字符串一律不能作为任何一条 item 的 name 出现
//   （验证"废弃行丢弃能力"——噪声行不应该被误判成商品）；
// - itemNamesExcludeSubstring：任何 item 的 name 都不能包含这些子串
//   （验证促销标签等噪声片段已被净化剥离）；
// - itemCategories：{品名: 期望的 category key} 映射，逐条核对分类结果。

function assertCaseExpectations(result, expect, caseId) {
  if (expect.merchant !== undefined) {
    assert.equal(result.merchant, expect.merchant, `[${caseId}] merchant`);
  }
  if (expect.reportDate !== undefined) {
    assert.equal(result.reportDate, expect.reportDate, `[${caseId}] reportDate`);
  }
  if (expect.totalAmount !== undefined) {
    assert.equal(result.totalAmount, expect.totalAmount, `[${caseId}] totalAmount`);
  }
  if (expect.totalAmountSource !== undefined) {
    assert.equal(result.totalAmountSource, expect.totalAmountSource, `[${caseId}] totalAmountSource`);
  }
  if (expect.flagNeedsReview !== undefined) {
    assert.equal(result.flagNeedsReview, expect.flagNeedsReview, `[${caseId}] flagNeedsReview（reviewReasons: ${JSON.stringify(result.reviewReasons)}）`);
  }
  const names = result.items.map((it) => it.name);
  if (expect.itemNames) {
    expect.itemNames.forEach((n) => {
      assert.ok(names.includes(n), `[${caseId}] 期望识别到品名"${n}"，实际品名列表: ${JSON.stringify(names)}`);
    });
  }
  if (expect.itemNamesExclude) {
    expect.itemNamesExclude.forEach((n) => {
      assert.ok(!names.includes(n), `[${caseId}] "${n}"不应作为品名出现（应被丢弃），实际品名列表: ${JSON.stringify(names)}`);
    });
  }
  if (expect.itemNamesExcludeSubstring) {
    expect.itemNamesExcludeSubstring.forEach((sub) => {
      names.forEach((n) => {
        assert.ok(!n.includes(sub), `[${caseId}] 品名"${n}"不应包含未净化的子串"${sub}"`);
      });
    });
  }
  if (expect.itemCategories) {
    Object.keys(expect.itemCategories).forEach((n) => {
      const item = result.items.find((it) => it.name === n);
      assert.ok(item, `[${caseId}] 未找到品名"${n}"，无法核对其分类`);
      assert.equal(item.category, expect.itemCategories[n], `[${caseId}] "${n}"的分类`);
    });
  }
}

// 逐条驱动数据集用例；每条独立成一个 test()，任一条失败时报告能精确定位
// 到具体是哪一类脏数据场景出了问题，不会被合并成一条笼统的失败信息
dataset.cases.forEach((c) => {
  test(`[压测样本] ${c.id} · ${c.category}`, () => {
    const result = parseReceiptPayload(c.input, c.options);
    assertCaseExpectations(result, c.expect || {}, c.id);
  });
});

// 汇总命中率：单独跑一遍全部用例统计通过数，作为"加固前后命中率对比"
// 汇报数据的来源——这里只做统计打印，不做断言（真正的通过/失败判定交给
// 上面逐条的 test()），任一条上面已经失败时这里也如实统计出来，不掩盖
test('[压测汇总] 数据集整体命中率统计（仅统计打印，不作为独立断言点）', () => {
  let passCount = 0;
  const failedIds = [];
  dataset.cases.forEach((c) => {
    try {
      const result = parseReceiptPayload(c.input, c.options);
      assertCaseExpectations(result, c.expect || {}, c.id);
      passCount++;
    } catch (err) {
      failedIds.push({ id: c.id, error: err.message });
    }
  });
  const total = dataset.cases.length;
  console.log(`\n[OCR 压测命中率] ${passCount}/${total} (${((passCount / total) * 100).toFixed(1)}%)`);
  if (failedIds.length > 0) {
    console.log('[未命中样本]', JSON.stringify(failedIds, null, 2));
  }
  assert.equal(passCount, total, `压测数据集应全部命中，未命中样本: ${JSON.stringify(failedIds.map((f) => f.id))}`);
});

// ==================== 新增纯函数单测：OCR 数字噪声纠偏 ====================

test('normalizeOcrDigits：O/o 纠偏为 0，I/l 纠偏为 1，仅在片段含真实数字时生效', () => {
  assert.equal(normalizeOcrDigits('3.2O'), '3.20');
  assert.equal(normalizeOcrDigits('4.5o'), '4.50');
  assert.equal(normalizeOcrDigits('l7.7O'), '17.70');
  assert.equal(normalizeOcrDigits('2O26-09-l0'), '2026-09-10');
});

test('normalizeOcrDigits：纯字母词（不含真实数字）不受影响，避免误伤商户名缩写', () => {
  assert.equal(normalizeOcrDigits('KFC'), 'KFC');
  assert.equal(normalizeOcrDigits('IKEA'), 'IKEA');
  assert.equal(normalizeOcrDigits('好邻居超市'), '好邻居超市');
});

test('normalizeOcrDigits：空/非字符串输入安全兜底，不抛异常', () => {
  assert.equal(normalizeOcrDigits(''), '');
  assert.equal(normalizeOcrDigits(null), '');
  assert.equal(normalizeOcrDigits(undefined), '');
});

test('normalizeDecimalComma：逗号跟 1-2 位数字按小数点纠偏，跟 3 位数字仍按千分位保留', () => {
  assert.equal(normalizeDecimalComma('3,50'), '3.50');
  assert.equal(normalizeDecimalComma('8,00'), '8.00');
  assert.equal(normalizeDecimalComma('1,234'), '1,234'); // 千分位不受影响
  assert.equal(normalizeDecimalComma('总计1,234元'), '总计1,234元');
});

// ==================== 新增纯函数单测：中文数字解析 ====================

test('chineseNumeralToValue：常见位值读法（十/百/千/万）正确转换', () => {
  assert.equal(chineseNumeralToValue('壹拾伍'), 15);
  assert.equal(chineseNumeralToValue('叁佰'), 300);
  assert.equal(chineseNumeralToValue('壹佰贰拾叁'), 123);
  assert.equal(chineseNumeralToValue('十五'), 15);
  assert.equal(chineseNumeralToValue('二十六'), 26);
  assert.equal(chineseNumeralToValue('一万两千'), 12000);
});

test('chineseNumeralToValue：空输入返回 null，不编造数据', () => {
  assert.equal(chineseNumeralToValue(''), null);
  assert.equal(chineseNumeralToValue(null), null);
});

test('extractChineseWordAmount：标准大写金额（元/角/分/整）正确提取', () => {
  assert.equal(extractChineseWordAmount('肆拾伍元整'), 45);
  assert.equal(extractChineseWordAmount('壹拾伍元伍角'), 15.5);
  assert.equal(extractChineseWordAmount('今收款：肆拾伍元整'), 45);
});

test('extractChineseWordAmount：降噪——地名/商户名里偶然出现的"数字+元"（无整/角/分）不会被误判成金额', () => {
  assert.equal(extractChineseWordAmount('家住三元里'), null);
  assert.equal(extractChineseWordAmount('上海元祖食品'), null);
});

test('extractChineseWordAmount：无匹配时返回 null，不抛异常', () => {
  assert.equal(extractChineseWordAmount('青菜3.20'), null);
  assert.equal(extractChineseWordAmount(''), null);
});

test('extractChineseDate：完整汉字年月日正确转换为 ISO 日期', () => {
  assert.equal(extractChineseDate('二零二六年九月十日'), '2026-09-10');
  assert.equal(extractChineseDate('交易时间：二零二六年一月一日'), '2026-01-01');
});

test('extractChineseDate：非法月日（超出范围）返回 null，不编造假日期', () => {
  assert.equal(extractChineseDate('二零二六年十三月一日'), null); // 十三月不存在
});

test('extractChineseDate：无匹配时返回 null', () => {
  assert.equal(extractChineseDate('2026年09月10日'), null); // 阿拉伯数字日期不归这个函数管
  assert.equal(extractChineseDate(''), null);
});

// ==================== 新增纯函数单测：品名净化 ====================

test('cleanItemName：剥离方括号促销标签，保留品类关键词', () => {
  assert.equal(cleanItemName('【特价】优质东北大米 25kg'), '优质东北大米25kg');
  assert.equal(cleanItemName('[满减]纯正菜籽油'), '纯正菜籽油');
});

test('cleanItemName：收敛品名内部残留空白（OCR 断字常见的多余空格）', () => {
  assert.equal(cleanItemName('青  菜'), '青菜');
});

test('cleanItemName：空/非法输入安全兜底，返回空字符串', () => {
  assert.equal(cleanItemName(''), '');
  assert.equal(cleanItemName(null), '');
  assert.equal(cleanItemName(undefined), '');
});

// ==================== 无年份日期兜底（options.assumedYear）====================

test('parseReceiptPayload：无年份日期（MM-DD）用 options.assumedYear 兜底假定年份', () => {
  const result = parseReceiptPayload(['测试店', '青菜 5.00', '实付：5.00', '09-10'], { assumedYear: 2026 });
  assert.equal(result.reportDate, '2026-09-10');
});

test('parseReceiptPayload：不传 assumedYear 时用真实当前年份兜底（不抛异常，具体年份不做断言，避免测试跟着系统时钟漂移）', () => {
  assert.doesNotThrow(() => parseReceiptPayload(['测试店', '青菜 5.00', '实付：5.00', '09-10']));
});

test('parseReceiptPayload：无年份日期兜底要求整行只有日期本身，不在长文本里挖字段，避免误伤含短横线的无关文本', () => {
  const result = parseReceiptPayload(['测试店', '青菜 5.00', '实付：5.00', '客服热线：400-800-1234']);
  assert.equal(result.reportDate, ''); // 电话号码里的短横线不应被误判成日期
});
