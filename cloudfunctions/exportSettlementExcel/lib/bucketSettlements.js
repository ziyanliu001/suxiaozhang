// 纯逻辑：把一批 order_settlements 原始记录（含红冲分录）归并成三个可直接
// 展示的汇总桶，以及按订单合并后的明细行。不做 db I/O，便于单测；也不依赖
// wx-server-sdk。
//
// 🏛️（护城河三 M2）本文件与 getSettlementSummary/lib/bucketSettlements.js
// 内容完全一致——本仓库云函数间无共享模块（各自独立部署），导出功能需要与
// 对账看板展示完全同一套"归并/红冲净额"口径，只能复制一份。如果那边的归并
// 逻辑改了，这份要同步改，否则导出的表格会和页面上看到的对不上。
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

function pairReversals(docs) {
  const originals = (docs || []).filter((d) => !d.isReversal);
  const reversalByOriginalId = {};
  (docs || []).filter((d) => d.isReversal).forEach((r) => {
    if (r.originalSettlementId) reversalByOriginalId[r.originalSettlementId] = r;
  });
  return { originals, reversalByOriginalId };
}

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
      addToBucket(buckets.voided, d);
    }
  });

  return buckets;
}

function buildDetailRows(docs) {
  const { originals, reversalByOriginalId } = pairReversals(docs);
  return originals.map((d) => {
    const reversal = reversalByOriginalId[d._id];
    if (!reversal) {
      return {
        settlementId: d._id,
        orderId: d.orderId, payAmount: d.payAmount, producerAmount: d.producerAmount,
        promoterAmount: d.promoterAmount, platformFee: d.platformFee,
        settlementStatus: d.settlementStatus, createdAt: d.createdAt || null, settledAt: d.settledAt || null
      };
    }
    const net = netAmounts(d, reversal);
    return {
      settlementId: d._id,
      orderId: d.orderId, ...net,
      settlementStatus: 'settled_then_reversed',
      createdAt: d.createdAt || null, settledAt: d.settledAt || null, reversedAt: reversal.createdAt || null
    };
  });
}

module.exports = { bucketSettlements, buildDetailRows, emptyBucket };
