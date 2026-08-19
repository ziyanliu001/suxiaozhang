// 纯逻辑：把一批 order_settlements 原始记录（含红冲分录）归并成三个可直接
// 展示的汇总桶。不做 db I/O，便于单测；也不依赖 wx-server-sdk。
//
// 三个桶各自的含义（对应 liveFactoryCore/lib/settlement.js 的 decideRefundReversal
// 产生的三种记录形态）：
//   unsettled  待结算：settlementStatus==='unsettled' 的原始记录，钱还没发。
//   settled    已结算净额：settlementStatus==='settled' 的原始记录金额，
//              若之后发生"已结算后退款"（create_reversal 路径，见 settlement.js），
//              对应的红冲分录金额是负数、且带 originalSettlementId 指回原记录——
//              这里会把红冲金额加回原记录，得到"实际还留在对方账上、没被追回"
//              的净额，而不是从未减少过的历史毛发放数（那样会一直虚高）。
//   voided     未结算即被撤销：settlementStatus==='refunded' 但 isReversal===false
//              的原始记录——这是 mark_refunded 路径（钱从没发出去过，直接原地
//              标记撤销，见 decideRefundReversal），金额从未真正支付，与"已结算
//              后又被追回"是两码事，不能混进 settled 桶，否则会让人误以为这笔
//              钱曾经付出去过。
'use strict';

function emptyBucket() {
  return { count: 0, payAmount: 0, producerAmount: 0, promoterAmount: 0, platformFee: 0 };
}

function addToBucket(bucket, doc) {
  bucket.count += 1;
  bucket.payAmount += doc.payAmount || 0;
  bucket.producerAmount += doc.producerAmount || 0;
  bucket.promoterAmount += doc.promoterAmount || 0;
  bucket.platformFee += doc.platformFee || 0;
}

function netAmounts(original, reversal) {
  return {
    payAmount: original.payAmount + reversal.payAmount,
    producerAmount: original.producerAmount + reversal.producerAmount,
    promoterAmount: original.promoterAmount + reversal.promoterAmount,
    platformFee: original.platformFee + reversal.platformFee
  };
}

/**
 * 把一批 order_settlements 原始文档拆成"原始记录列表"+"originalSettlementId
 * -> 对应红冲分录"的查找表，供 bucketSettlements/buildDetailRows 共用，避免
 * 两处各写一遍配对逻辑。
 */
function pairReversals(docs) {
  const originals = (docs || []).filter((d) => !d.isReversal);
  const reversalByOriginalId = {};
  (docs || []).filter((d) => d.isReversal).forEach((r) => {
    if (r.originalSettlementId) reversalByOriginalId[r.originalSettlementId] = r;
  });
  return { originals, reversalByOriginalId };
}

/**
 * @param {Array<Object>} docs order_settlements 原始文档数组（同时包含
 *   isReversal:false 的原始记录与 isReversal:true 的红冲分录）
 * @returns {{unsettled: Object, settled: Object, voided: Object}}
 */
function bucketSettlements(docs) {
  const buckets = { unsettled: emptyBucket(), settled: emptyBucket(), voided: emptyBucket() };
  const { originals, reversalByOriginalId } = pairReversals(docs);

  originals.forEach((d) => {
    if (d.settlementStatus === 'unsettled') {
      addToBucket(buckets.unsettled, d);
    } else if (d.settlementStatus === 'settled') {
      const reversal = reversalByOriginalId[d._id];
      addToBucket(buckets.settled, reversal ? netAmounts(d, reversal) : d);
    } else if (d.settlementStatus === 'refunded') {
      // isReversal:false 且 status:'refunded' —— 只有 mark_refunded（未结算即撤销）
      // 路径会产生这种组合；isReversal:true 的红冲分录已经在上面按 originalId
      // 并入对应的 settled 净额里，不需要（也不应该）单独再计一次
      addToBucket(buckets.voided, d);
    }
  });

  return buckets;
}

/**
 * 按订单产出一行一单的明细（供列表展示）：已结算后又被红冲的订单合并成一行
 * 净额 + status:'settled_then_reversed'，不展示原始记录/红冲分录两条正负抵消
 * 看起来像"重复"的行——原始未加工的双分录账本仍完整保留在 order_settlements
 * 集合里，只是不在这个"简易对账看板"的列表视图里逐条铺开。
 */
function buildDetailRows(docs) {
  const { originals, reversalByOriginalId } = pairReversals(docs);
  return originals.map((d) => {
    const reversal = reversalByOriginalId[d._id];
    if (!reversal) {
      return {
        orderId: d.orderId, payAmount: d.payAmount, producerAmount: d.producerAmount,
        promoterAmount: d.promoterAmount, platformFee: d.platformFee,
        settlementStatus: d.settlementStatus, createdAt: d.createdAt || null, settledAt: d.settledAt || null
      };
    }
    const net = netAmounts(d, reversal);
    return {
      orderId: d.orderId, ...net,
      settlementStatus: 'settled_then_reversed',
      createdAt: d.createdAt || null, settledAt: d.settledAt || null, reversedAt: reversal.createdAt || null
    };
  });
}

module.exports = { bucketSettlements, buildDetailRows, emptyBucket };
