'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  predictMealDemand,
  LOOKBACK_DAYS,
  SAME_WEEKDAY_WEIGHT,
  WEATHER_MULTIPLIER,
  HOLIDAY_MULTIPLIER,
  INGREDIENT_RATIO_PER_PERSON
} = require('./predictMealDemand');

// 🛡️（2026-09-10）雨花斋智能备餐与食材用量预测系统 · 一期原型回归测试
//
// targetDate 固定用 '2026-09-24'（周四），下面这份历史记录集合的星期几都是
// 提前用 Date.UTC(...).getUTCDay() 实测算出来的，不是拍脑袋猜的：
//   2026-09-23 周三（diff=1，相邻日期）
//   2026-09-20 周日（diff=4，相邻日期）
//   2026-09-17 周四（diff=7，同星期）
//   2026-09-10 周四（diff=14，同星期，恰好是回溯窗口边界）
//   2026-09-09 周三（diff=15，超出回溯窗口，应被排除）
const BASE_RECORDS = [
  { dateString: '2026-09-17', dineInSeniors: 100, deliverySeniors: 20 }, // 同星期，headcount=120
  { dateString: '2026-09-10', dineInSeniors: 110, deliverySeniors: 10 }, // 同星期，headcount=120
  { dateString: '2026-09-23', dineInSeniors: 70, deliverySeniors: 10 },  // 相邻，headcount=80
  { dateString: '2026-09-20', dineInSeniors: 80, deliverySeniors: 10 }   // 相邻，headcount=90
];
// 加权平均 = (120*2 + 120*2 + 80*1 + 90*1) / (2+2+1+1) = 650/6 = 108.333...

test('基础场景：同星期样本加权 2、相邻样本加权 1，正确算出加权平均与推荐人次', () => {
  const result = predictMealDemand({ historyRecords: BASE_RECORDS, targetDate: '2026-09-24' });
  assert.equal(result.insufficientData, false);
  assert.equal(result.basis.sameWeekdayCount, 2);
  assert.equal(result.basis.adjacentCount, 2);
  assert.equal(result.basis.baseAverage, 108.3);
  assert.equal(result.basis.weatherMultiplier, 1);
  assert.equal(result.basis.holidayMultiplier, 1);
  assert.equal(result.recommendedHeadcount, 108);
});

test('基础场景的食材换算：按 INGREDIENT_RATIO_PER_PERSON 比例乘以推荐人次', () => {
  const result = predictMealDemand({ historyRecords: BASE_RECORDS, targetDate: '2026-09-24' });
  assert.deepEqual(result.ingredients, {
    riceJin: 32.4,
    oilLiter: 3.24,
    vegetableJin: 54,
    seasoningJin: 2.16
  });
});

test('天气系数：weatherFactor="rain" 按 0.85 折减', () => {
  const result = predictMealDemand({ historyRecords: BASE_RECORDS, targetDate: '2026-09-24', weatherFactor: 'rain' });
  assert.equal(result.basis.weatherMultiplier, 0.85);
  assert.equal(result.recommendedHeadcount, 92);
});

test('天气系数：weatherFactor="storm"/"heavy_rain" 按 0.7 折减（恶劣天气比普通雨天折减更多）', () => {
  const storm = predictMealDemand({ historyRecords: BASE_RECORDS, targetDate: '2026-09-24', weatherFactor: 'storm' });
  assert.equal(storm.basis.weatherMultiplier, 0.7);
  assert.equal(storm.recommendedHeadcount, 76);

  const heavyRain = predictMealDemand({ historyRecords: BASE_RECORDS, targetDate: '2026-09-24', weatherFactor: 'heavy_rain' });
  assert.equal(heavyRain.basis.weatherMultiplier, 0.7);
});

test('天气系数：不认识的取值（含大小写变体）一律按 1 处理，不抛异常也不瞎折减', () => {
  const unknown = predictMealDemand({ historyRecords: BASE_RECORDS, targetDate: '2026-09-24', weatherFactor: 'foggy' });
  assert.equal(unknown.basis.weatherMultiplier, 1);
  assert.equal(unknown.recommendedHeadcount, 108);

  const upperCase = predictMealDemand({ historyRecords: BASE_RECORDS, targetDate: '2026-09-24', weatherFactor: 'RAIN' });
  assert.equal(upperCase.basis.weatherMultiplier, 0.85, '大小写不敏感，RAIN 应该等同于 rain');
});

test('天气系数：非字符串类型（数字/null/undefined）一律按 1 处理，不做隐式数字乘法', () => {
  assert.equal(predictMealDemand({ historyRecords: BASE_RECORDS, targetDate: '2026-09-24', weatherFactor: 0.5 }).basis.weatherMultiplier, 1);
  assert.equal(predictMealDemand({ historyRecords: BASE_RECORDS, targetDate: '2026-09-24', weatherFactor: null }).basis.weatherMultiplier, 1);
  assert.equal(predictMealDemand({ historyRecords: BASE_RECORDS, targetDate: '2026-09-24' }).basis.weatherMultiplier, 1);
});

test('节假日/传统吃素高峰：isHoliday=true 加权 1.25', () => {
  const result = predictMealDemand({ historyRecords: BASE_RECORDS, targetDate: '2026-09-24', isHoliday: true });
  assert.equal(result.basis.holidayMultiplier, 1.25);
  assert.equal(result.recommendedHeadcount, 135);
});

test('节假日 + 雨天叠加：两个系数相乘而不是取其一/相加', () => {
  const result = predictMealDemand({ historyRecords: BASE_RECORDS, targetDate: '2026-09-24', isHoliday: true, weatherFactor: 'rain' });
  assert.equal(result.basis.appliedMultiplier, 1.0625); // 0.85 * 1.25
  assert.equal(result.recommendedHeadcount, 115);
});

test('回溯窗口边界：diff=14（2026-09-10）计入窗口，diff=15（2026-09-09）被排除', () => {
  // 只给一条 diff=15 的记录：如果它被错误计入窗口，insufficientData 应为
  // false 且走"窗口内加权平均"分支（sameWeekdayCount/adjacentCount 至少一个
  // 不为 0）；实际应该走"窗口为空→退化为全部记录简单平均"分支
  const onlyTooOld = predictMealDemand({
    historyRecords: [{ dateString: '2026-09-09', dineInSeniors: 999, deliverySeniors: 999 }],
    targetDate: '2026-09-24'
  });
  assert.equal(onlyTooOld.basis.sameWeekdayCount, 0);
  assert.equal(onlyTooOld.basis.adjacentCount, 0);
  assert.equal(onlyTooOld.recommendedHeadcount, 1998, 'diff=15 的记录未落入窗口，走的是"全部记录简单平均"退化分支，而不是窗口加权分支');
});

test('targetDate 当天（diff=0）即便出现在 historyRecords 里也不计入窗口——不能用预测当天自己的数据预测自己', () => {
  const records = [...BASE_RECORDS, { dateString: '2026-09-24', dineInSeniors: 99999, deliverySeniors: 99999 }];
  const result = predictMealDemand({ historyRecords: records, targetDate: '2026-09-24' });
  assert.equal(result.recommendedHeadcount, 108, '不应该被 targetDate 当天那条离谱数据污染');
});

test('回溯窗口内没有任何记录，但历史记录里有更早的数据：退化为全部历史记录的简单平均', () => {
  const result = predictMealDemand({
    historyRecords: [{ dateString: '2026-08-01', dineInSeniors: 50, deliverySeniors: 10 }],
    targetDate: '2026-09-24'
  });
  assert.equal(result.insufficientData, false);
  assert.equal(result.basis.sameWeekdayCount, 0);
  assert.equal(result.basis.adjacentCount, 0);
  assert.equal(result.basis.baseAverage, 60);
  assert.equal(result.recommendedHeadcount, 60);
});

test('完全没有历史数据（空数组）：如实返回 insufficientData=true，不编造推荐人次', () => {
  const result = predictMealDemand({ historyRecords: [], targetDate: '2026-09-24' });
  assert.equal(result.insufficientData, true);
  assert.equal(result.recommendedHeadcount, null);
  assert.equal(result.ingredients, null);
});

test('historyRecords 未传（undefined）时按空数组处理，不抛异常', () => {
  const result = predictMealDemand({ targetDate: '2026-09-24' });
  assert.equal(result.insufficientData, true);
});

test('historyRecords 里混入 dateString 缺失/格式非法的脏数据：被过滤掉，不影响其余有效记录计算，也不抛异常', () => {
  const records = [
    ...BASE_RECORDS,
    { dateString: '不是日期', dineInSeniors: 5, deliverySeniors: 5 },
    { dineInSeniors: 5, deliverySeniors: 5 }, // 缺 dateString
    null,
    undefined
  ];
  const result = predictMealDemand({ historyRecords: records, targetDate: '2026-09-24' });
  assert.equal(result.recommendedHeadcount, 108, '脏数据应被过滤，结果应与只传 BASE_RECORDS 时一致');
});

test('单条记录缺 dineInSeniors/deliverySeniors 或为非数字：按 0 兜底，不产生 NaN', () => {
  const result = predictMealDemand({
    historyRecords: [
      { dateString: '2026-09-17' }, // 两个字段都缺
      { dateString: '2026-09-10', dineInSeniors: 'abc', deliverySeniors: null }
    ],
    targetDate: '2026-09-24'
  });
  assert.equal(result.insufficientData, false);
  assert.equal(result.recommendedHeadcount, 0);
  assert.ok(!Number.isNaN(result.recommendedHeadcount));
});

test('targetDate 缺失或格式非法时抛出异常，不返回一个看似合理的假结果', () => {
  assert.throws(() => predictMealDemand({ historyRecords: BASE_RECORDS, targetDate: '' }));
  assert.throws(() => predictMealDemand({ historyRecords: BASE_RECORDS, targetDate: '2026/09/24' }));
  assert.throws(() => predictMealDemand({ historyRecords: BASE_RECORDS, targetDate: undefined }));
  assert.throws(() => predictMealDemand({ historyRecords: BASE_RECORDS }));
});

test('推荐人次为 0 时，食材清单各项也应为 0，而不是跳过整个 ingredients 字段', () => {
  const result = predictMealDemand({
    historyRecords: [{ dateString: '2026-09-17', dineInSeniors: 0, deliverySeniors: 0 }],
    targetDate: '2026-09-24'
  });
  assert.deepEqual(result.ingredients, { riceJin: 0, oilLiter: 0, vegetableJin: 0, seasoningJin: 0 });
});

test('导出的常量与文档描述的规则一致（防止改了实现却忘了同步注释里写的数字）', () => {
  assert.equal(LOOKBACK_DAYS, 14);
  assert.equal(SAME_WEEKDAY_WEIGHT, 2);
  assert.equal(HOLIDAY_MULTIPLIER, 1.25);
  assert.equal(WEATHER_MULTIPLIER.rain, 0.85);
  assert.equal(WEATHER_MULTIPLIER.storm, 0.7);
  assert.equal(WEATHER_MULTIPLIER.heavy_rain, 0.7);
  assert.equal(INGREDIENT_RATIO_PER_PERSON.riceJin, 0.3);
  assert.equal(INGREDIENT_RATIO_PER_PERSON.oilLiter, 0.03);
  assert.equal(INGREDIENT_RATIO_PER_PERSON.vegetableJin, 0.5);
  assert.equal(INGREDIENT_RATIO_PER_PERSON.seasoningJin, 0.02);
});
