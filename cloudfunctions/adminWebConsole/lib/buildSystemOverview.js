// 系统运行大盘：纯计算逻辑，不做 db I/O。
'use strict';

/**
 * 计算"昨日快照生成覆盖率"——daily_tenant_snapshots 昨天实际生成的门店数
 * 占全网活跃门店总数的百分比，供 Web 管理中台一眼看出 dailyTenantSnapshotCron
 * 昨晚是否正常跑完全部门店（见 docs/SCHEMA.md 8.2 节 Phase 1）。
 * @param {number} generated 昨日实际生成快照的门店数
 * @param {number} expected 全网活跃门店总数
 * @returns {number|null} 百分比（保留一位小数），expected 为 0 时返回 null
 *   （没有任何活跃门店，"覆盖率"这个概念本身没有意义，不能除以 0 硬凑一个数）
 */
function computeCoveragePercent(generated, expected) {
  if (!Number.isFinite(expected) || expected <= 0) return null;
  const safeGenerated = Number.isFinite(generated) ? generated : 0;
  return Math.round((safeGenerated / expected) * 1000) / 10;
}

/**
 * 组装系统运行大盘响应体——纯粹的字段打包 + 覆盖率计算，真正的数据库
 * 计数查询留在 index.js。
 * @param {object} params
 * @param {number} params.totalActiveStores
 * @param {number} params.totalTenants
 * @param {number} params.snapshotsGeneratedYesterday
 * @param {string} params.snapshotDateChecked 被核对覆盖率的那一天（昨天）
 * @returns {object}
 */
function buildSystemOverview({ totalActiveStores, totalTenants, snapshotsGeneratedYesterday, snapshotDateChecked }) {
  return {
    totalActiveStores: totalActiveStores || 0,
    totalTenants: totalTenants || 0,
    snapshotCoverage: {
      dateChecked: snapshotDateChecked || '',
      generated: snapshotsGeneratedYesterday || 0,
      expected: totalActiveStores || 0,
      percent: computeCoveragePercent(snapshotsGeneratedYesterday, totalActiveStores)
    }
  };
}

module.exports = { computeCoveragePercent, buildSystemOverview };
