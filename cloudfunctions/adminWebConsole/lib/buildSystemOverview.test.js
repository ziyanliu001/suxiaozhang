'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeCoveragePercent, buildSystemOverview } = require('./buildSystemOverview');

test('computeCoveragePercent：正常计算百分比，保留一位小数', () => {
  assert.equal(computeCoveragePercent(45, 50), 90);
  assert.equal(computeCoveragePercent(1, 3), 33.3);
});

test('computeCoveragePercent：expected 为 0/非法时返回 null，不除以 0', () => {
  assert.equal(computeCoveragePercent(10, 0), null);
  assert.equal(computeCoveragePercent(10, undefined), null);
  assert.equal(computeCoveragePercent(10, NaN), null);
});

test('computeCoveragePercent：generated 缺失/非法时按 0 处理', () => {
  assert.equal(computeCoveragePercent(undefined, 100), 0);
  assert.equal(computeCoveragePercent(NaN, 100), 0);
});

test('buildSystemOverview：正常打包并计算覆盖率', () => {
  const result = buildSystemOverview({
    totalActiveStores: 50, totalTenants: 10, snapshotsGeneratedYesterday: 45, snapshotDateChecked: '2026-09-12'
  });
  assert.equal(result.totalActiveStores, 50);
  assert.equal(result.totalTenants, 10);
  assert.equal(result.snapshotCoverage.generated, 45);
  assert.equal(result.snapshotCoverage.expected, 50);
  assert.equal(result.snapshotCoverage.percent, 90);
  assert.equal(result.snapshotCoverage.dateChecked, '2026-09-12');
});

test('buildSystemOverview：全部字段缺失时安全兜底为 0，不抛异常', () => {
  const result = buildSystemOverview({});
  assert.equal(result.totalActiveStores, 0);
  assert.equal(result.totalTenants, 0);
  assert.equal(result.snapshotCoverage.percent, null);
});
