'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TRANSFER_ITEM_FILTER_OPTIONS,
  PURCHASE_ITEM_FILTER_OPTIONS,
  DATE_RANGE_OPTIONS,
  resolveDateRangeStart,
  filterRecordsByDateRange,
  filterRecordsByItem,
  applyMaterialHistoryFilters
} = require('./materialHistoryFilters');

const NOW = new Date('2026-09-19T10:00:00+08:00');

// ============ 1. 日期范围筛选 ============

test('resolveDateRangeStart："today" 返回当天 00:00:00', () => {
  const start = resolveDateRangeStart('today', NOW);
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 8); // 0-indexed，9月
  assert.equal(start.getDate(), 19);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
});

test('resolveDateRangeStart："7d"/"30d" 分别回溯 6/29 天（含今天共 7/30 天）', () => {
  const start7d = resolveDateRangeStart('7d', NOW);
  assert.equal(Math.round((NOW.getTime() - start7d.getTime()) / (24 * 60 * 60 * 1000)), 6);

  const start30d = resolveDateRangeStart('30d', NOW);
  assert.equal(Math.round((NOW.getTime() - start30d.getTime()) / (24 * 60 * 60 * 1000)), 29);
});

test('resolveDateRangeStart："all" 返回 null，表示不设下限', () => {
  assert.equal(resolveDateRangeStart('all', NOW), null);
});

test('filterRecordsByDateRange：只保留 createTime 落在范围内的记录', () => {
  const records = [
    { id: 'today', createTime: '2026-09-19T02:00:00Z' }, // 早于 NOW 但仍是当天（北京时间 09-19 10:00）
    { id: 'yesterday', createTime: '2026-09-18T02:00:00Z' },
    { id: 'tenDaysAgo', createTime: '2026-09-09T02:00:00Z' },
    { id: 'sixtyDaysAgo', createTime: '2026-07-21T02:00:00Z' }
  ];

  const todayOnly = filterRecordsByDateRange(records, 'today', NOW);
  assert.deepEqual(todayOnly.map((r) => r.id), ['today']);

  const last7d = filterRecordsByDateRange(records, '7d', NOW);
  assert.deepEqual(last7d.map((r) => r.id), ['today', 'yesterday']);

  const last30d = filterRecordsByDateRange(records, '30d', NOW);
  assert.deepEqual(last30d.map((r) => r.id), ['today', 'yesterday', 'tenDaysAgo']);

  const all = filterRecordsByDateRange(records, 'all', NOW);
  assert.equal(all.length, 4);
});

test('filterRecordsByDateRange：createTime 缺失/非法的记录一律排除（除 "all" 外），不让脏数据混进筛选结果', () => {
  const records = [
    { id: 'ok', createTime: '2026-09-19T02:00:00Z' },
    { id: 'missing' },
    { id: 'invalid', createTime: 'not-a-date' }
  ];
  const filtered = filterRecordsByDateRange(records, '7d', NOW);
  assert.deepEqual(filtered.map((r) => r.id), ['ok']);
});

test('filterRecordsByDateRange：空数组/非数组输入安全返回空数组', () => {
  assert.deepEqual(filterRecordsByDateRange([], '7d', NOW), []);
  assert.deepEqual(filterRecordsByDateRange(null, '7d', NOW), []);
  assert.deepEqual(filterRecordsByDateRange(undefined, 'all', NOW), []);
});

// ============ 2. 物资类目筛选 ============

test('filterRecordsByItem：itemValue 非空时只保留匹配的记录', () => {
  const records = [{ item: 'rice' }, { item: 'oil' }, { item: 'rice' }];
  assert.deepEqual(filterRecordsByItem(records, 'rice'), [{ item: 'rice' }, { item: 'rice' }]);
});

test('filterRecordsByItem：itemValue 为空字符串（"全部"）时原样返回，不过滤', () => {
  const records = [{ item: 'rice' }, { item: 'oil' }];
  assert.deepEqual(filterRecordsByItem(records, ''), records);
});

test('filterRecordsByItem：空数组/非数组输入安全返回空数组', () => {
  assert.deepEqual(filterRecordsByItem([], 'rice'), []);
  assert.deepEqual(filterRecordsByItem(null, 'rice'), []);
});

// ============ 3. 组合筛选 ============

test('applyMaterialHistoryFilters：日期范围 + 物资类目两个维度同时生效', () => {
  const records = [
    { id: 'a', item: 'rice', createTime: '2026-09-19T02:00:00Z' },
    { id: 'b', item: 'oil', createTime: '2026-09-19T02:00:00Z' },
    { id: 'c', item: 'rice', createTime: '2026-07-01T02:00:00Z' }
  ];
  const result = applyMaterialHistoryFilters(records, { dateRange: '7d', item: 'rice' }, NOW);
  assert.deepEqual(result.map((r) => r.id), ['a']);
});

test('applyMaterialHistoryFilters：filters 缺省字段时兜底为"全部"（不过滤），不抛异常', () => {
  const records = [{ id: 'a', item: 'rice', createTime: '2026-01-01T00:00:00Z' }];
  assert.deepEqual(applyMaterialHistoryFilters(records, {}, NOW).map((r) => r.id), ['a']);
  assert.deepEqual(applyMaterialHistoryFilters(records, undefined, NOW).map((r) => r.id), ['a']);
});

// ============ 4. 纯素类目完整性（与 pages/index/lib/materialTransferForm.js 独立维护的同一条边界） ============

const NON_VEGETARIAN_KEYWORDS = [
  '肉', '荤', '蛋', '奶', '鱼', '虾', '蟹', '贝', '禽', '骨',
  '鸡', '鸭', '鹅', '猪', '牛', '羊', '兔', '海鲜', '腊', '腌',
  '火腿', '培根', '鱼翅', '鲍鱼', '燕窝', '明胶', '猪油', '牛油', '奶油', '黄油'
];

function assertAllVegetarian(options, listName) {
  options.forEach((opt) => {
    if (!opt.value) return; // "全部" 选项没有实际物资含义，跳过
    NON_VEGETARIAN_KEYWORDS.forEach((kw) => {
      assert.equal(opt.label.includes(kw), false, `${listName} 里的"${opt.label}"命中荤食关键词"${kw}"，违反纯素边界`);
    });
  });
}

test('TRANSFER_ITEM_FILTER_OPTIONS：不含任何荤食关键词', () => {
  assertAllVegetarian(TRANSFER_ITEM_FILTER_OPTIONS, 'TRANSFER_ITEM_FILTER_OPTIONS');
});

test('PURCHASE_ITEM_FILTER_OPTIONS：不含任何荤食关键词', () => {
  assertAllVegetarian(PURCHASE_ITEM_FILTER_OPTIONS, 'PURCHASE_ITEM_FILTER_OPTIONS');
});

test('TRANSFER_ITEM_FILTER_OPTIONS：精确等于"全部+大米+食用油+面粉"，不含时蔬（与 cloudfunctions/manageMaterialTransfer 的 TRANSFERABLE_ITEMS 同源口径）', () => {
  assert.deepEqual(TRANSFER_ITEM_FILTER_OPTIONS.map((o) => o.value), ['', 'rice', 'oil', 'flour']);
});

test('PURCHASE_ITEM_FILTER_OPTIONS：精确等于"全部+大米+食用油+面粉+时蔬"四类目全覆盖', () => {
  assert.deepEqual(PURCHASE_ITEM_FILTER_OPTIONS.map((o) => o.value), ['', 'rice', 'oil', 'flour', 'vegetable']);
});

test('DATE_RANGE_OPTIONS：精确等于 今天/近7天/近30天/全部 四档，顺序即展示顺序', () => {
  assert.deepEqual(DATE_RANGE_OPTIONS.map((o) => o.value), ['today', '7d', '30d', 'all']);
});
