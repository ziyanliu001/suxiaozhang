'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  emptyAggregate,
  addInto,
  computeYesterdayStr,
  splitHistoricalRange,
  buildStoreAggregateMap,
  computeTodayIncrementByStore,
  mergeStoreTotals,
  isFullyCoveredBySnapshots,
  sumAcrossStores
} = require('./hybridDashboardAggregation');

// ==================== computeYesterdayStr ====================

test('computeYesterdayStr：正确计算前一天', () => {
  assert.equal(computeYesterdayStr('2026-09-12'), '2026-09-11');
});

test('computeYesterdayStr：跨月/跨年边界', () => {
  assert.equal(computeYesterdayStr('2026-10-01'), '2026-09-30');
  assert.equal(computeYesterdayStr('2027-01-01'), '2026-12-31');
});

test('computeYesterdayStr：非法输入返回空字符串，不抛异常', () => {
  assert.equal(computeYesterdayStr(''), '');
  assert.equal(computeYesterdayStr(undefined), '');
  assert.equal(computeYesterdayStr('abc'), '');
});

// ==================== splitHistoricalRange ====================

test('splitHistoricalRange：rangeStartDate 为 null（全部时间）时历史区间恒存在', () => {
  const { historicalStart, historicalEnd, hasHistoricalRange } = splitHistoricalRange(null, '2026-09-12');
  assert.equal(historicalStart, null);
  assert.equal(historicalEnd, '2026-09-11');
  assert.equal(hasHistoricalRange, true);
});

test('splitHistoricalRange：rangeStartDate 早于等于昨天时存在历史区间', () => {
  const res = splitHistoricalRange('2026-09-01', '2026-09-12');
  assert.equal(res.hasHistoricalRange, true);
});

test('splitHistoricalRange：rangeStartDate 就是今天时不存在历史区间（近7天等窗口起点晚于昨天的边界情况）', () => {
  const res = splitHistoricalRange('2026-09-12', '2026-09-12');
  assert.equal(res.hasHistoricalRange, false);
});

// ==================== buildStoreAggregateMap ====================

test('buildStoreAggregateMap：正确从聚合结果行提取 Map(storeId -> 字段合计)', () => {
  const aggRes = {
    list: [
      { _id: 'store_1', totalDiners: 100, totalIncome: 500 },
      { _id: 'store_2', totalDiners: 30 }
    ]
  };
  const map = buildStoreAggregateMap(aggRes);
  assert.equal(map.size, 2);
  assert.equal(map.get('store_1').totalDiners, 100);
  assert.equal(map.get('store_1').totalIncome, 500);
  assert.equal(map.get('store_2').totalDiners, 30);
  assert.equal(map.get('store_2').totalIncome, 0); // 缺失字段兜底为 0
});

test('buildStoreAggregateMap：list 为空/缺失时返回空 Map，不抛异常', () => {
  assert.equal(buildStoreAggregateMap({}).size, 0);
  assert.equal(buildStoreAggregateMap(null).size, 0);
  assert.equal(buildStoreAggregateMap({ list: [] }).size, 0);
});

test('buildStoreAggregateMap：缺失 _id 的行被跳过', () => {
  const map = buildStoreAggregateMap({ list: [{ totalDiners: 5 }] });
  assert.equal(map.size, 0);
});

// ==================== computeTodayIncrementByStore ====================

test('computeTodayIncrementByStore：按 resolveStoreKey 分组累加核心数值字段', () => {
  const logs = [
    { storeId: 's1', diningCount: 50, income: 100, expense: 40, dailyExpenseTotal: 30 },
    { storeId: 's1', diningCount: 20, income: 50, expense: 10, dailyExpenseTotal: 5 },
    { storeId: 's2', diningCount: 10, income: 20 }
  ];
  const map = computeTodayIncrementByStore(logs, (log) => log.storeId);
  assert.equal(map.get('s1').totalDiners, 70);
  assert.equal(map.get('s1').totalIncome, 150);
  assert.equal(map.get('s1').totalExpense, 50);
  assert.equal(map.get('s1').dailyExpenseTotal, 35);
  assert.equal(map.get('s2').totalDiners, 10);
});

test('computeTodayIncrementByStore：resolveStoreKey 返回 null 的记录被跳过（未匹配到任何门店）', () => {
  const logs = [{ diningCount: 999 }];
  const map = computeTodayIncrementByStore(logs, () => null);
  assert.equal(map.size, 0);
});

test('computeTodayIncrementByStore：hasDiners/hasActivity 标记口径与 buildDailySnapshot 一致', () => {
  const logs = [
    { storeId: 's1', diningCount: 0, dailyExpenseTotal: 50 }, // 只有支出，无堂食
    { storeId: 's2', diningCount: 0, dailyExpenseTotal: 0 }   // 完全没活动
  ];
  const map = computeTodayIncrementByStore(logs, (log) => log.storeId);
  assert.equal(map.get('s1').hasDiners, 0);
  assert.equal(map.get('s1').hasActivity, 1);
  assert.equal(map.get('s2').hasDiners, 0);
  assert.equal(map.get('s2').hasActivity, 0);
});

test('computeTodayIncrementByStore：凭证合规/审计存证/阳善阴德口径与快照生成端一致', () => {
  const logs = [
    { storeId: 's1', expenseAmount: 100, receiptImages: ['a.jpg'] },
    { storeId: 's1', expenseAmount: 50 },
    { storeId: 's1', approvalStatus: 'AUDITED_LOCKED', _checksum: 'x' },
    { storeId: 's1', isAnonymous: false, donationItems: [{ amount: 100 }] },
    { storeId: 's1', isAnonymous: true, donationItems: [{ amount: 20 }] }
  ];
  const map = computeTodayIncrementByStore(logs, (log) => log.storeId);
  const t = map.get('s1');
  assert.equal(t.expenseRecordCount, 2);
  assert.equal(t.receiptRecordCount, 1);
  assert.equal(t.auditedLockedCount, 1);
  assert.equal(t.auditedWithProofCount, 1);
  assert.equal(t.yangshanCount, 1);
  assert.equal(t.yangshanAmount, 100);
  assert.equal(t.yindeCount, 1);
  assert.equal(t.yindeAmount, 20);
});

test('computeTodayIncrementByStore：空数组/非数组输入安全兜底', () => {
  assert.equal(computeTodayIncrementByStore([], () => 's1').size, 0);
  assert.equal(computeTodayIncrementByStore(null, () => 's1').size, 0);
});

// ==================== mergeStoreTotals ====================

test('mergeStoreTotals：历史与今日增量逐字段相加', () => {
  const historical = { ...emptyAggregate(), totalDiners: 100, totalIncome: 500 };
  const today = { ...emptyAggregate(), totalDiners: 10, totalIncome: 50 };
  const merged = mergeStoreTotals(historical, today);
  assert.equal(merged.totalDiners, 110);
  assert.equal(merged.totalIncome, 550);
});

test('mergeStoreTotals：任一侧缺失时按空聚合处理，不抛异常', () => {
  assert.doesNotThrow(() => mergeStoreTotals(null, null));
  const merged = mergeStoreTotals(undefined, { totalDiners: 5 });
  assert.equal(merged.totalDiners, 5);
});

// ==================== isFullyCoveredBySnapshots ====================

test('isFullyCoveredBySnapshots：全部门店都在 Map 中时返回 true', () => {
  const map = new Map([['s1', {}], ['s2', {}]]);
  assert.equal(isFullyCoveredBySnapshots(['s1', 's2'], map), true);
});

test('isFullyCoveredBySnapshots：任一门店缺失时返回 false（新店/cron 未跑过的优雅降级判定）', () => {
  const map = new Map([['s1', {}]]);
  assert.equal(isFullyCoveredBySnapshots(['s1', 's2'], map), false);
});

test('isFullyCoveredBySnapshots：目标门店列表为空时保守返回 false', () => {
  assert.equal(isFullyCoveredBySnapshots([], new Map()), false);
  assert.equal(isFullyCoveredBySnapshots(null, new Map()), false);
});

// ==================== sumAcrossStores ====================

test('sumAcrossStores：正确汇总 Map values 的字段合计', () => {
  const map = new Map([
    ['s1', { ...emptyAggregate(), totalDiners: 100 }],
    ['s2', { ...emptyAggregate(), totalDiners: 30 }]
  ]);
  const total = sumAcrossStores(map.values());
  assert.equal(total.totalDiners, 130);
});

test('sumAcrossStores：空输入返回全 0 聚合，不抛异常', () => {
  const total = sumAcrossStores([]);
  assert.equal(total.totalDiners, 0);
  assert.doesNotThrow(() => sumAcrossStores(null));
});

// ==================== addInto / emptyAggregate ====================

test('emptyAggregate：所有字段初始化为 0', () => {
  const agg = emptyAggregate();
  assert.equal(agg.totalDiners, 0);
  assert.equal(agg.yangshanAmount, 0);
});

test('addInto：source 缺失字段按 0 处理，不产生 NaN', () => {
  const target = emptyAggregate();
  addInto(target, { totalDiners: 5 });
  assert.equal(target.totalDiners, 5);
  assert.equal(target.totalIncome, 0);
  assert.equal(Number.isNaN(target.totalExpense), false);
});
