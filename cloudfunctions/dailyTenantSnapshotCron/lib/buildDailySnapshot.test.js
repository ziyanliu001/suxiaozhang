'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSnapshotId,
  computeYesterdayDateString,
  convertJinToKg,
  buildDailySnapshot
} = require('./buildDailySnapshot');

// ==================== buildSnapshotId ====================

test('buildSnapshotId：正确拼接 tenantId/storeId/dateString', () => {
  assert.equal(buildSnapshotId('tenant_1', 'store_1', '2026-09-11'), 'snapshot_tenant_1_store_1_2026-09-11');
});

test('buildSnapshotId：确定性——相同输入始终生成相同 ID', () => {
  const a = buildSnapshotId('tenant_1', 'store_1', '2026-09-11');
  const b = buildSnapshotId('tenant_1', 'store_1', '2026-09-11');
  assert.equal(a, b);
});

test('buildSnapshotId：空/undefined 输入安全兜底，不抛异常', () => {
  assert.doesNotThrow(() => buildSnapshotId('', '', ''));
  assert.doesNotThrow(() => buildSnapshotId(undefined, undefined, undefined));
});

// ==================== computeYesterdayDateString ====================

test('computeYesterdayDateString：正确计算指定时间戳的前一天', () => {
  // 2026-09-12 10:00:00 的前一天是 2026-09-11
  const ts = new Date(2026, 8, 12, 10, 0, 0).getTime();
  assert.equal(computeYesterdayDateString(ts), '2026-09-11');
});

test('computeYesterdayDateString：跨月边界正确处理', () => {
  // 2026-10-01 的前一天是 2026-09-30
  const ts = new Date(2026, 9, 1, 2, 0, 0).getTime();
  assert.equal(computeYesterdayDateString(ts), '2026-09-30');
});

test('computeYesterdayDateString：跨年边界正确处理', () => {
  // 2027-01-01 的前一天是 2026-12-31
  const ts = new Date(2027, 0, 1, 2, 0, 0).getTime();
  assert.equal(computeYesterdayDateString(ts), '2026-12-31');
});

test('computeYesterdayDateString：不传 now 时使用真实当前时间，不抛异常', () => {
  assert.doesNotThrow(() => computeYesterdayDateString());
});

// ==================== convertJinToKg ====================

test('convertJinToKg：正确按 0.5 换算并保留一位小数（与 getNationalDashboard 的同名逻辑保持一致）', () => {
  assert.equal(convertJinToKg(100), 50);
  assert.equal(convertJinToKg(3), 1.5);
});

test('convertJinToKg：非法输入安全兜底为 0', () => {
  assert.equal(convertJinToKg(null), 0);
  assert.equal(convertJinToKg('abc'), 0);
});

// ==================== buildDailySnapshot ====================

test('buildDailySnapshot：单条生效记录正确聚合各字段', () => {
  const snapshot = buildDailySnapshot({
    tenantId: 'tenant_1',
    storeId: 'store_1',
    storeName: '海沧区雨花斋',
    dateString: '2026-09-11',
    reportRecords: [{
      approvalStatus: 'APPROVED',
      diningCount: 120,
      income: 500.5,
      expense: 300.25,
      dailyExpenseTotal: 280,
      volunteerCount: 5,
      volunteerHours: 12.5,
      dineInSeniors: 80,
      deliverySeniors: 20,
      listeningSeniors: 10,
      takeawayCount: 10,
      deliveryVolunteers: 3,
      todayBalance: 1200.75
    }],
    materialTotals: { riceKg: 25, flourKg: 5, oilKg: 3.5, veggieKg: 40 }
  });

  assert.equal(snapshot._id, 'snapshot_tenant_1_store_1_2026-09-11');
  assert.equal(snapshot.totalDiners, 120);
  assert.equal(snapshot.totalIncome, 500.5);
  assert.equal(snapshot.totalExpense, 300.25);
  assert.equal(snapshot.dailyExpenseTotal, 280);
  assert.equal(snapshot.volunteerCount, 5);
  assert.equal(snapshot.volunteerHours, 12.5);
  assert.equal(snapshot.latestBalance, 1200.75);
  assert.equal(snapshot.riceKg, 25);
  assert.equal(snapshot.sourceReportCount, 1);
  assert.equal(snapshot.hasAuditProof, false);
});

test('buildDailySnapshot：已作废（isVoid）记录不计入统计', () => {
  const snapshot = buildDailySnapshot({
    tenantId: 't', storeId: 's', storeName: '店', dateString: '2026-09-11',
    reportRecords: [
      { approvalStatus: 'APPROVED', isVoid: true, diningCount: 999, income: 999, expense: 999, todayBalance: 999 }
    ]
  });
  assert.equal(snapshot.totalDiners, 0);
  assert.equal(snapshot.sourceReportCount, 0);
});

test('buildDailySnapshot：仍待店长核对的 PENDING 草稿不计入统计', () => {
  const snapshot = buildDailySnapshot({
    tenantId: 't', storeId: 's', storeName: '店', dateString: '2026-09-11',
    reportRecords: [{ approvalStatus: 'PENDING', diningCount: 50 }]
  });
  assert.equal(snapshot.totalDiners, 0);
  assert.equal(snapshot.sourceReportCount, 0);
});

test('buildDailySnapshot：AUDITED_LOCKED 且带 _checksum 时 hasAuditProof 为 true', () => {
  const snapshot = buildDailySnapshot({
    tenantId: 't', storeId: 's', storeName: '店', dateString: '2026-09-11',
    reportRecords: [{ approvalStatus: 'AUDITED_LOCKED', _checksum: 'abc123', diningCount: 10 }]
  });
  assert.equal(snapshot.hasAuditProof, true);
});

test('buildDailySnapshot：AUDITED_LOCKED 但缺失 _checksum（签名缺口）时 hasAuditProof 为 false', () => {
  const snapshot = buildDailySnapshot({
    tenantId: 't', storeId: 's', storeName: '店', dateString: '2026-09-11',
    reportRecords: [{ approvalStatus: 'AUDITED_LOCKED', diningCount: 10 }]
  });
  assert.equal(snapshot.hasAuditProof, false);
});

test('buildDailySnapshot：一天多条生效记录时，数值型字段累加，latestBalance 取数组最后一条', () => {
  const snapshot = buildDailySnapshot({
    tenantId: 't', storeId: 's', storeName: '店', dateString: '2026-09-11',
    reportRecords: [
      { approvalStatus: 'APPROVED', diningCount: 50, todayBalance: 100 },
      { approvalStatus: 'APPROVED', diningCount: 30, todayBalance: 250 }
    ]
  });
  assert.equal(snapshot.totalDiners, 80);
  assert.equal(snapshot.latestBalance, 250);
  assert.equal(snapshot.sourceReportCount, 2);
});

test('buildDailySnapshot：diningCount 缺失时兜底读取 diners 字段（历史字段名兼容）', () => {
  const snapshot = buildDailySnapshot({
    tenantId: 't', storeId: 's', storeName: '店', dateString: '2026-09-11',
    reportRecords: [{ approvalStatus: 'APPROVED', diners: 42 }]
  });
  assert.equal(snapshot.totalDiners, 42);
});

test('buildDailySnapshot：reportRecords 为空数组/未传时返回全 0 的合法快照', () => {
  const snapshot = buildDailySnapshot({ tenantId: 't', storeId: 's', storeName: '店', dateString: '2026-09-11' });
  assert.equal(snapshot.totalDiners, 0);
  assert.equal(snapshot.totalIncome, 0);
  assert.equal(snapshot.sourceReportCount, 0);
  assert.equal(snapshot.riceKg, 0);
});

test('buildDailySnapshot：materialTotals 缺失字段时各自独立兜底为 0', () => {
  const snapshot = buildDailySnapshot({
    tenantId: 't', storeId: 's', storeName: '店', dateString: '2026-09-11',
    materialTotals: { riceKg: 10 }
  });
  assert.equal(snapshot.riceKg, 10);
  assert.equal(snapshot.flourKg, 0);
  assert.equal(snapshot.oilKg, 0);
  assert.equal(snapshot.veggieKg, 0);
});

test('buildDailySnapshot：整个 params 为 null/undefined 时安全兜底，不抛异常', () => {
  assert.doesNotThrow(() => buildDailySnapshot(null));
  assert.doesNotThrow(() => buildDailySnapshot(undefined));
  const snapshot = buildDailySnapshot(undefined);
  assert.equal(snapshot._id, 'snapshot___');
  assert.equal(snapshot.totalDiners, 0);
});
