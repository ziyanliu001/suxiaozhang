'use strict';

// 📊（2026-09-12 大数据量性能治理 · Phase 1：日度预聚合快照写入）纯逻辑部分：
// 快照文档 ID 生成、目标日期计算、"某一家门店某一天"的原始记录如何聚合成
// 一条快照——都不依赖 wx-server-sdk，可直接单测。真正的数据库读（report_logs/
// material_logs/stores）与写（daily_tenant_snapshots）留在 index.js，与本
// 仓库既有的 index.js + lib/*.js 拆分写法一致。
//
// 🛡️ 与 cloudfunctions/getNationalDashboard/index.js 的实时聚合逻辑刻意保持
// 同一套字段口径（diningCount||diners、income||loveIncome||totalDonation 等
// 多字段兜底顺序），这样未来 getNationalDashboard 改读本快照表时，历史累计
// 数值不会因为口径不一致而突然跳变——两处独立维护同一份口径判断，是本仓库
// "云函数间无共享模块机制"的既定约束，不是遗漏。

function round2(num) {
  const n = parseFloat(num);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}

// 🛡️ 与 cloudfunctions/getNationalDashboard/lib/materialAggregateHelpers.js
// 的 convertJinToKg() 是同一份逻辑的独立拷贝——云函数之间没有跨目录共享
// 模块的机制（本仓库一贯约束，见 CLAUDE.md 第 3 节"Open-Core 单向依赖"
// 邻近段落），两个云函数各自的 package 在部署时是彼此隔离的独立目录，
// 跨云函数 `require('../otherFunction/lib/xxx')` 在本地能跑通、上传部署后
// 会因为找不到文件而报错。material_logs 的 riceCount 等字段"斤→公斤"这个
// 换算规则若未来调整，需要同步修改这两处拷贝。
function convertJinToKg(jin) {
  return Math.round((parseFloat(jin) || 0) * 0.5 * 10) / 10;
}

/**
 * 由 tenantId + storeId + dateString 生成确定性快照文档 _id，保证同一天
 * 重复触发（如手动补跑）天然幂等（用 set() 覆写，不产生重复文档）。
 * @param {string} tenantId
 * @param {string} storeId
 * @param {string} dateString YYYY-MM-DD
 * @returns {string}
 */
function buildSnapshotId(tenantId, storeId, dateString) {
  return `snapshot_${tenantId || ''}_${storeId || ''}_${dateString || ''}`;
}

/**
 * 计算"昨天"的 YYYY-MM-DD 字符串——cron 每日凌晨触发时，"昨天"就是需要
 * 生成快照的目标业务日期。now 作为显式参数传入（默认 Date.now()），保持
 * 本函数纯粹、可测试。
 * @param {number} [now] 时间戳，默认当前时间
 * @returns {string}
 */
function computeYesterdayDateString(now) {
  const base = typeof now === 'number' ? new Date(now) : new Date();
  base.setDate(base.getDate() - 1);
  const yyyy = String(base.getFullYear());
  const mm = String(base.getMonth() + 1).padStart(2, '0');
  const dd = String(base.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 把"某一家门店、某一天"的原始 report_logs 记录 + material_logs 聚合总量
 * 组装成一条 daily_tenant_snapshots 文档。永不抛异常——非法/缺失输入一律
 * 归约成全 0 的合法快照，不编造数据。
 *
 * 🆕（2026-09-12 大数据量性能治理 Phase 2：全国大屏读端接入）新增
 * expenseRecordCount/receiptRecordCount/auditedLockedCount/auditedWithProofCount/
 * sponsorCount/yangshanCount/yangshanAmount/yindeCount/yindeAmount/hasDiners/
 * hasActivity/stapleUrgent 这批字段——全部是"当天"维度的计数/求和/布尔标记，
 * 目的是让 getNationalDashboard 在按天聚合历史区间时，可以对
 * daily_tenant_snapshots 直接做 `_.aggregate.sum(field)` 拿到精确总量，而不需要
 * 在数据库聚合管道里写 $cond 条件表达式（未经生产环境验证的云开发聚合 DSL
 * 写法风险更高，能在这层纯函数里用普通 if/三元预先算好就不留到查询时算）。
 * 与 getNationalDashboard/index.js 里对应字段的判定口径逐一保持一致，见各
 * 字段处注释。
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.storeId
 * @param {string} params.storeName
 * @param {string} params.dateString 被统计的业务日期（不是生成时间）
 * @param {Array<object>} [params.reportRecords] 该门店该日期的 report_logs 原始记录
 *   （通常 0~1 条，多条时取"最后一条"的 todayBalance/stapleUrgent 作为当前状态，
 *   其余数值型字段仍然全部累加——一天出现多条记录本身是异常但不阻断快照生成）
 * @param {{riceKg?:number, flourKg?:number, oilKg?:number, veggieKg?:number}} [params.materialTotals]
 *   已换算成公斤的当日物资消耗量（换算本身由调用方复用
 *   getNationalDashboard/lib/materialAggregateHelpers.js 的 convertJinToKg()，
 *   本函数不重复实现同一份换算逻辑）
 * @returns {object} daily_tenant_snapshots 文档（不含 generatedAt，那个字段
 *   由调用方在写入前用 db.serverDate() 补上，本函数不产生任何时间副作用）
 */
function buildDailySnapshot(params) {
  const p = params || {};
  const tenantId = p.tenantId || '';
  const storeId = p.storeId || '';
  const storeName = p.storeName || '';
  const dateString = p.dateString || '';
  const records = Array.isArray(p.reportRecords) ? p.reportRecords : [];
  const materials = p.materialTotals || {};

  // 只统计生效记录：已作废/仍待店长核对的草稿不计入快照，口径与
  // getNationalDashboard 的 approvalStatus 过滤完全一致
  const validRecords = records.filter((r) => r && !r.isVoid &&
    (r.approvalStatus === 'APPROVED' || r.approvalStatus === 'AUDITED_LOCKED'));

  let totalDiners = 0;
  let totalIncome = 0;
  let totalExpense = 0;
  let dailyExpenseTotal = 0;
  let volunteerCount = 0;
  let volunteerHours = 0;
  let dineInSeniors = 0;
  let deliverySeniors = 0;
  let listeningSeniors = 0;
  let takeawayCount = 0;
  let deliveryVolunteers = 0;
  let latestBalance = 0;
  let hasAuditProof = false;
  // 🆕 见函数头部注释：以下全部是"当天"维度的计数/求和，供 getNationalDashboard
  // 历史区间聚合时直接 $sum，口径逐一对应该文件同名判断
  let expenseRecordCount = 0;   // 对应 expenseAmount > 0 的记录数（凭证合规率分母）
  let receiptRecordCount = 0;   // 其中附带凭证图片的记录数（凭证合规率分子）
  let auditedLockedCount = 0;   // approvalStatus === 'AUDITED_LOCKED' 的记录数
  let auditedWithProofCount = 0; // 其中同时带 _checksum 签名的记录数
  let sponsorCount = 0;         // donationItems 明细条目总数（阳善+阴德）
  let yangshanCount = 0;
  let yangshanAmount = 0;
  let yindeCount = 0;
  let yindeAmount = 0;
  let hasDiners = 0;   // 当天是否有 diners>0 的记录（0/1），对应原 entry.openDays 判定口径
  let hasActivity = 0; // 当天是否 diners>0 或 dailyExpense>0（0/1），对应原 nationalOpenDays 判定口径
  let stapleUrgent = false;

  validRecords.forEach((r) => {
    const diners = parseInt(r.diningCount || r.diners || 0, 10) || 0;
    const dailyExpense = parseFloat(r.dailyExpenseTotal || 0) || 0;
    totalDiners += diners;
    totalIncome += parseFloat(r.income || r.loveIncome || r.totalDonation || 0) || 0;
    totalExpense += parseFloat(r.expense || r.todayExpense || r.expenseAmount || 0) || 0;
    dailyExpenseTotal += dailyExpense;
    volunteerCount += parseFloat(r.volunteerCount || 0) || 0;
    volunteerHours += parseFloat(r.volunteerHours || 0) || 0;
    dineInSeniors += parseInt(r.dineInSeniors || 0, 10) || 0;
    deliverySeniors += parseInt(r.deliverySeniors || 0, 10) || 0;
    listeningSeniors += parseInt(r.listeningSeniors || 0, 10) || 0;
    takeawayCount += parseInt(r.takeawayCount || 0, 10) || 0;
    deliveryVolunteers += parseInt(r.deliveryVolunteers || 0, 10) || 0;
    // 一天多条记录属于异常场景，这里按数组原有顺序取"最后一条"的当前状态——
    // 调用方负责按 createTime/updateTime 排好序再传入，本函数不做排序假设
    latestBalance = parseFloat(r.todayBalance || 0) || 0;
    if (r.approvalStatus === 'AUDITED_LOCKED' && r._checksum) hasAuditProof = true;

    if (diners > 0) hasDiners = 1;
    if (diners > 0 || dailyExpense > 0) hasActivity = 1;
    stapleUrgent = r.stapleRiceStatus === 'urgent' || r.stapleOilStatus === 'urgent';

    const expenseAmount = parseFloat(r.expenseAmount || 0) || 0;
    const receiptImagesArr = Array.isArray(r.receiptImages) ? r.receiptImages : [];
    const receiptImageListArr = Array.isArray(r.receiptImageList) ? r.receiptImageList : [];
    const hasReceipt = receiptImagesArr.length > 0 || receiptImageListArr.length > 0;
    if (expenseAmount > 0) {
      expenseRecordCount++;
      if (hasReceipt) receiptRecordCount++;
    }

    if (r.approvalStatus === 'AUDITED_LOCKED') {
      auditedLockedCount++;
      if (r._checksum) auditedWithProofCount++;
    }

    // 阳善/阴德分流：按报告级 isAnonymous 判定，与 getNationalDashboard 的
    // yangshanCount/yindeCount 全局累加器同一口径（不是逐条 isAnonymous 覆盖，
    // 那个只用于捐赠墙展示脱敏，见该文件 resolveItemAnonymous 头部注释）
    const donationItems = Array.isArray(r.donationItems) ? r.donationItems : [];
    sponsorCount += donationItems.length;
    const donationAmount = donationItems.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
    if (r.isAnonymous) {
      yindeCount += donationItems.length;
      yindeAmount += donationAmount;
    } else {
      yangshanCount += donationItems.length;
      yangshanAmount += donationAmount;
    }
  });

  return {
    _id: buildSnapshotId(tenantId, storeId, dateString),
    tenantId,
    storeId,
    storeName,
    dateString,
    totalDiners,
    totalIncome: round2(totalIncome),
    totalExpense: round2(totalExpense),
    dailyExpenseTotal: round2(dailyExpenseTotal),
    volunteerCount,
    volunteerHours: Math.round(volunteerHours * 10) / 10,
    dineInSeniors,
    deliverySeniors,
    listeningSeniors,
    takeawayCount,
    deliveryVolunteers,
    latestBalance: round2(latestBalance),
    hasAuditProof,
    riceKg: parseFloat(materials.riceKg) || 0,
    flourKg: parseFloat(materials.flourKg) || 0,
    oilKg: parseFloat(materials.oilKg) || 0,
    veggieKg: parseFloat(materials.veggieKg) || 0,
    sourceReportCount: validRecords.length,
    expenseRecordCount,
    receiptRecordCount,
    auditedLockedCount,
    auditedWithProofCount,
    sponsorCount,
    yangshanCount,
    yangshanAmount: round2(yangshanAmount),
    yindeCount,
    yindeAmount: round2(yindeAmount),
    hasDiners,
    hasActivity,
    stapleUrgent
  };
}

module.exports = {
  buildSnapshotId,
  computeYesterdayDateString,
  convertJinToKg,
  buildDailySnapshot
};
