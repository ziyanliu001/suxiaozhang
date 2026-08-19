// 运营简报统计：对"已发货"订单按时间区间聚合出货单量/份数与结算金额。
// 纯逻辑，不依赖 wx-server-sdk，便于单测。
//
// 🔑 与 bucketSettlements/buildDetailRows 是同一份净额口径：settlementByOrderId
// 传入的应该是 buildDetailRows() 的输出（按 orderId 建的查找表），已经把
// "已结算后又被红冲"的订单净成 0——这里不重新处理红冲配对，直接复用那份
// 已经算好的净额，避免同一套配对逻辑在两个文件里各写一遍、日后改一处忘了
// 改另一处。
'use strict';

function emptyStats() {
  return { orderCount: 0, totalQuantity: 0, producerAmount: 0, promoterAmount: 0, platformFee: 0 };
}

/**
 * @param {Array<Object>} shippedOrders  production_orders 文档数组，仅含
 *   orderStatus==='shipped' 的记录（每条至少有 _id/quantity/shippedAt）
 * @param {Object<string, Object>} settlementByOrderId  orderId -> 该订单的
 *   净额结算行（buildDetailRows 输出的单行；找不到对应结算行的订单金额按 0 算，
 *   不阻断整体统计——理论上不应该发生，但防御性处理数据不一致的情况）
 * @param {Date} now  统计基准时刻（不传则用 new Date()）
 * @param {number} rangeDays  统计区间天数（如 7/30），含起止两端
 * @returns {{orderCount: number, totalQuantity: number, producerAmount: number, promoterAmount: number, platformFee: number}}
 */
function computeOpsStats(shippedOrders, settlementByOrderId, now, rangeDays) {
  if (!Array.isArray(shippedOrders) || shippedOrders.length === 0) return emptyStats();
  if (!Number.isFinite(rangeDays) || rangeDays <= 0) return emptyStats();

  const base = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();
  const cutoff = new Date(base);
  cutoff.setDate(cutoff.getDate() - rangeDays);
  const cutoffMs = cutoff.getTime();
  const nowMs = base.getTime();

  const stats = emptyStats();
  const lookup = settlementByOrderId || {};

  shippedOrders.forEach((order) => {
    if (!order || !order.shippedAt) return; // 没有 shippedAt 的记录不参与统计，不猜发货时间
    const shippedMs = new Date(order.shippedAt).getTime();
    if (isNaN(shippedMs) || shippedMs < cutoffMs || shippedMs > nowMs) return;

    stats.orderCount += 1;
    stats.totalQuantity += Number.isFinite(order.quantity) ? order.quantity : 0;

    const settlement = lookup[order._id];
    if (settlement) {
      stats.producerAmount += settlement.producerAmount || 0;
      stats.promoterAmount += settlement.promoterAmount || 0;
      stats.platformFee += settlement.platformFee || 0;
    }
  });

  return stats;
}

module.exports = { computeOpsStats, emptyStats };
