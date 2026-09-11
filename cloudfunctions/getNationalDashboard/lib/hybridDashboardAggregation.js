'use strict';

// 📊（2026-09-12 大数据量性能治理 Phase 2：全国大屏读端接入预聚合快照）
//
// 设计：把大屏统计窗口拆成"历史区间（含至昨天）"与"今天"两段——
//   - 历史区间：改读 daily_tenant_snapshots 的数据库侧 $sum 聚合（按 storeId
//     分组），聚合管道的输出行数 = 涉及门店数，不受 report_logs 原始文档
//     "单次查询最多返回 1000 条"的限制影响，无论底层原始记录有多少条，
//     这部分汇总永远精确。
//   - 今天：cron 每日凌晨才生成前一天的快照，当天数据必然还没有对应快照，
//     改为对已经在内存里的 allLogs（getNationalDashboard/index.js 主循环
//     已拉取）按 dateString===今天 做一次轻量二次扫描——当天的记录数天然
//     很小（不可能撞上 1000 条上限），可以安全地精确累加。
//
// 🛡️ 优雅降级（这是本模块最重要的正确性约束）：daily_tenant_snapshots 是
// 2026-09-12 才新增的集合，新店/cron 刚上线还没跑过一轮的门店天然没有
// 历史快照——这不代表这些门店没有数据，只代表"还没来得及被预聚合"。对这
// 类门店，调用方（getNationalDashboard/index.js）必须继续使用原有的
// report_logs 逐条累加结果作为该店的回退值，不能因为快照缺失就把这些门店
// 的数字清零，也不能因此中断整个大屏的渲染。本文件只提供纯粹的合并/覆盖
// 判定逻辑，不做任何"缺失即报错"的假设。
//
// 与 dailyTenantSnapshotCron/lib/buildDailySnapshot.js 是同一份字段口径的
// 消费端，两者必须保持同步（本仓库云函数间无共享模块机制的既定约束）。

// 需要从 daily_tenant_snapshots 按天 $sum 聚合的字段清单——全部是纯数值型的
// 计数/求和字段，口径详见 dailyTenantSnapshotCron/lib/buildDailySnapshot.js
// 对应字段头部注释
const SNAPSHOT_SUM_FIELDS = [
  'totalDiners', 'totalIncome', 'totalExpense', 'dailyExpenseTotal',
  'volunteerCount', 'volunteerHours',
  'dineInSeniors', 'deliverySeniors', 'listeningSeniors', 'takeawayCount', 'deliveryVolunteers',
  'expenseRecordCount', 'receiptRecordCount', 'auditedLockedCount', 'auditedWithProofCount',
  'sponsorCount', 'yangshanCount', 'yangshanAmount', 'yindeCount', 'yindeAmount',
  'hasDiners', 'hasActivity', 'sourceReportCount'
];

function emptyAggregate() {
  const obj = {};
  SNAPSHOT_SUM_FIELDS.forEach((f) => { obj[f] = 0; });
  return obj;
}

function addInto(target, source) {
  SNAPSHOT_SUM_FIELDS.forEach((f) => {
    target[f] = (target[f] || 0) + (Number(source && source[f]) || 0);
  });
  return target;
}

/**
 * 计算给定日期字符串的前一天——与 dailyTenantSnapshotCron/lib/buildDailySnapshot.js
 * 的 computeYesterdayDateString() 是同一份逻辑的独立拷贝（云函数间无共享模块
 * 机制，见 CLAUDE.md 既定约束），入参改为显式的"今天"日期字符串而不是时间戳，
 * 直接复用调用方（index.js 的 isoDateNDaysAgo(0)）已经算好的 todayStr，避免
 * 二次时区换算假设。
 * @param {string} todayStr 'YYYY-MM-DD'
 * @returns {string} 空字符串表示输入非法
 */
function computeYesterdayStr(todayStr) {
  const parts = String(todayStr || '').split('-').map((n) => parseInt(n, 10));
  const [y, m, d] = parts;
  if (!y || !m || !d) return '';
  const date = new Date(y, m - 1, d - 1);
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 把大屏请求的时间窗口拆成"历史区间（走快照聚合）"与"今天（走实时增量）"
 * 两段。rangeStartDate 传 null/空 表示"全部时间"（历史区间不设下界）。
 * @param {string|null} rangeStartDate
 * @param {string} todayStr
 * @returns {{ historicalStart: string|null, historicalEnd: string, hasHistoricalRange: boolean }}
 */
function splitHistoricalRange(rangeStartDate, todayStr) {
  const historicalEnd = computeYesterdayStr(todayStr);
  const hasHistoricalRange = !!historicalEnd && (!rangeStartDate || rangeStartDate <= historicalEnd);
  return { historicalStart: rangeStartDate || null, historicalEnd, hasHistoricalRange };
}

/**
 * 从 `daily_tenant_snapshots` 按 storeId 分组聚合
 * （`.group({_id:'$storeId', ...}).end()`）的原始返回结果里提取出
 * Map(storeId -> 该店历史区间内各字段总和)。
 * @param {{list?: Array<object>}} aggRes
 * @returns {Map<string, object>}
 */
function buildStoreAggregateMap(aggRes) {
  const map = new Map();
  const rows = (aggRes && Array.isArray(aggRes.list)) ? aggRes.list : [];
  rows.forEach((row) => {
    const storeId = row && row._id;
    if (!storeId) return;
    const sums = emptyAggregate();
    SNAPSHOT_SUM_FIELDS.forEach((f) => { sums[f] = Number(row[f]) || 0; });
    map.set(storeId, sums);
  });
  return map;
}

/**
 * 今日实时增量：只扫描"今天"这一天的原始 report_logs 记录（数据量天然很小，
 * 不存在 1000 条截断风险），按 resolveStoreKey 解析出的门店 key 分组累加，
 * 产出与 SNAPSHOT_SUM_FIELDS 同名字段的当日合计。门店归属判定（storeId 直接
 * 命中 / 门店名兜底匹配）由调用方通过 resolveStoreKey 回调传入（复用
 * index.js 主循环已经建好的 storeStatsMap 做判定），本函数只负责纯粹的字段
 * 累加，与 index.js 的可变状态解耦，可独立单测。
 * @param {Array<object>} todayLogs 已过滤为 dateString===今天 的 report_logs 原始记录
 * @param {(log: object) => (string|null)} resolveStoreKey
 * @returns {Map<string, object>}
 */
function computeTodayIncrementByStore(todayLogs, resolveStoreKey) {
  const map = new Map();
  (Array.isArray(todayLogs) ? todayLogs : []).forEach((log) => {
    const matchedKey = resolveStoreKey(log);
    if (!matchedKey) return;
    if (!map.has(matchedKey)) map.set(matchedKey, emptyAggregate());
    const t = map.get(matchedKey);

    const diners = parseInt(log.diningCount || log.diners || 0, 10) || 0;
    const income = parseFloat(log.income || log.loveIncome || log.totalDonation || 0) || 0;
    const expense = parseFloat(log.expense || log.todayExpense || log.expenseAmount || 0) || 0;
    const dailyExpense = parseFloat(log.dailyExpenseTotal || 0) || 0;
    t.totalDiners += diners;
    t.totalIncome += income;
    t.totalExpense += expense;
    t.dailyExpenseTotal += dailyExpense;
    t.volunteerCount += parseFloat(log.volunteerCount) || 0;
    t.volunteerHours += parseFloat(log.volunteerHours) || 0;
    t.dineInSeniors += parseInt(log.dineInSeniors, 10) || 0;
    t.deliverySeniors += parseInt(log.deliverySeniors, 10) || 0;
    t.listeningSeniors += parseInt(log.listeningSeniors, 10) || 0;
    t.takeawayCount += parseInt(log.takeawayCount, 10) || 0;
    t.deliveryVolunteers += parseInt(log.deliveryVolunteers, 10) || 0;
    if (diners > 0) t.hasDiners += 1;
    if (diners > 0 || dailyExpense > 0) t.hasActivity += 1;
    t.sourceReportCount += 1;

    const expenseAmount = parseFloat(log.expenseAmount || 0) || 0;
    const receiptImagesArr = Array.isArray(log.receiptImages) ? log.receiptImages : [];
    const receiptImageListArr = Array.isArray(log.receiptImageList) ? log.receiptImageList : [];
    const hasReceipt = receiptImagesArr.length > 0 || receiptImageListArr.length > 0;
    if (expenseAmount > 0) {
      t.expenseRecordCount += 1;
      if (hasReceipt) t.receiptRecordCount += 1;
    }

    if (log.approvalStatus === 'AUDITED_LOCKED') {
      t.auditedLockedCount += 1;
      if (log._checksum) t.auditedWithProofCount += 1;
    }

    const donationItems = Array.isArray(log.donationItems) ? log.donationItems : [];
    t.sponsorCount += donationItems.length;
    const donationAmount = donationItems.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
    if (log.isAnonymous) {
      t.yindeCount += donationItems.length;
      t.yindeAmount += donationAmount;
    } else {
      t.yangshanCount += donationItems.length;
      t.yangshanAmount += donationAmount;
    }
  });
  return map;
}

/**
 * 把"历史快照聚合"与"今天实时增量"两份同 storeId 的字段集合逐项相加，
 * 产出该门店在当前查询窗口内的精确合计——不受 report_logs 分页 1000 条
 * 上限影响（历史部分来自数据库侧 $sum 聚合，今天部分只扫描单日数据）。
 * 任一参数缺失时按空聚合处理，不抛异常。
 */
function mergeStoreTotals(historicalSums, todayIncrement) {
  const merged = emptyAggregate();
  addInto(merged, historicalSums);
  addInto(merged, todayIncrement);
  return merged;
}

/**
 * 判断目标门店集合是否被快照聚合"完全覆盖"——只有全部覆盖时，才能诚实地
 * 熄灭 dataIntegrity.isTruncated 警告；只要有一家门店缺失快照（新店/cron
 * 尚未跑过/历史断档），就必须保守地保留警告标志，不能对外宣称"数据已
 * 100% 精确"。
 * @param {Array<string>} targetStoreIds
 * @param {Map<string, object>} storeAggregateMap
 */
function isFullyCoveredBySnapshots(targetStoreIds, storeAggregateMap) {
  if (!Array.isArray(targetStoreIds) || targetStoreIds.length === 0) return false;
  return targetStoreIds.every((id) => storeAggregateMap.has(id));
}

/**
 * 汇总一组门店的字段合计（Map 的 values）——用于把"已经确定使用的每店合计"
 * （可能是 hybrid 覆盖值，也可能是回退的原始累加值）求和成全局总量。
 * @param {Iterable<object>} perStoreTotalsList
 */
function sumAcrossStores(perStoreTotalsList) {
  const total = emptyAggregate();
  Array.from(perStoreTotalsList || []).forEach((t) => addInto(total, t));
  return total;
}

module.exports = {
  SNAPSHOT_SUM_FIELDS,
  emptyAggregate,
  addInto,
  computeYesterdayStr,
  splitHistoricalRange,
  buildStoreAggregateMap,
  computeTodayIncrementByStore,
  mergeStoreTotals,
  isFullyCoveredBySnapshots,
  sumAcrossStores
};
