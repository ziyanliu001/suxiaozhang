// 分账快照生成与退款红冲逻辑。
//
// 🔑 金额不变式：producerAmount + promoterAmount + platformFee 必须恒等于
// payAmount，一分不多一分不少。做法是先对 producer/promoter 份额向下取整
// （Math.floor，宁可少分不多分），platform_fee 取"付款总额减去两者之和"的
// 余数兜底——这样取整误差永远落在平台服务费这一桶里，不会出现"三项加总对不上
// 实收金额"这类账目对不平的问题（金额单位：分，整数运算，不用浮点）。
'use strict';

/**
 * @param {Object} params
 * @param {number} params.payAmount        实收金额（分）
 * @param {number} params.producerRate     出厂/手作结算比例，0~1
 * @param {number} params.promoterRate     推广分成比例，0~1；无推广人时传 0
 * @returns {{producerAmount: number, promoterAmount: number, platformFee: number}}
 */
function computeSettlementSplit({ payAmount, producerRate, promoterRate }) {
  if (!Number.isInteger(payAmount) || payAmount < 0) {
    throw new Error('payAmount 必须是非负整数（分）');
  }
  const producerAmount = Math.floor(payAmount * producerRate);
  const promoterAmount = Math.floor(payAmount * promoterRate);
  const platformFee = payAmount - producerAmount - promoterAmount;
  return { producerAmount, promoterAmount, platformFee };
}

/**
 * 构造一条待写入 order_settlements 的快照记录（不含 db 写入，纯数据组装，
 * 便于 Step 3 的支付成功回调直接复用）。
 *
 * 🎯 producerRate/promoterRate 与算出来的金额一起存进快照——费率是产品政策，
 * 未来可能调整（如工坊分成合作协议的费率变更），但历史订单的分账不能跟着
 * 一起变。只存金额、不存当时用的费率，日后翻查一笔历史订单只能反推出一个
 * 近似费率（还要考虑取整误差），不如直接把生效那一刻的费率原样存下来。
 */
function buildSettlementSnapshot({ tenantId, orderId, payAmount, producerRate, promoterRate }) {
  const split = computeSettlementSplit({ payAmount, producerRate, promoterRate });
  return {
    tenantId,
    orderId,
    payAmount,
    producerRate,
    promoterRate,
    ...split,
    settlementStatus: 'unsettled',
    isReversal: false
  };
}

/**
 * 退款红冲的纯决策逻辑：给定该订单当前"有效"的结算记录（金额已生效、非已被
 * 红冲的最新一条）与是否已存在红冲记录，决定该怎么处理。不做 db I/O，方便
 * 单测覆盖 unsettled / settled / 重复调用三种边界。
 *
 * 🏛️（2026-09-12 部分退款治理）新增可选参数 refundAmount（分）——此前退款
 * 恒等于结算记录的全额 payAmount，现在支持"退款金额 < payAmount"的部分
 * 退款场景，未传时兜底为全额退款（保持升级前调用方行为不变）：
 *   - unsettled + 部分退款：钱还没真正付给制作方/推广人，不需要冲销分录，
 *     而是把这条"待分账"快照本身的 payAmount 原地下修为"退款后的净额"
 *     （复用 computeSettlementSplit 用同一套 producerRate/promoterRate 重新
 *     算一遍拆分），保证订单后续真正触发分账（发货/自提核销）时，是按
 *     净额而不是退款前的原始全额去分，不会多分给制作方/推广人。
 *   - settled + 部分退款：钱已经按原始全额分出去了，必须用一条冲销分录
 *     红冲——冲销的三项金额不是简单按比例乘系数（那样会引入额外的取整
 *     误差分摊问题），而是直接对 refundAmount 重新走一遍
 *     computeSettlementSplit，复用已验证过的"producer/promoter 向下取整、
 *     platformFee 吃余数"取整策略，保证"本次冲销三项金额相加恰好等于本次
 *     退款金额"这条不变式在部分退款场景下依然成立。
 *
 * @param {Object} settlement          现有 order_settlements 记录
 * @param {boolean} reversalAlreadyExists  是否已存在针对该记录的红冲分录
 * @param {number} [refundAmount]      本次实际退款金额（分），未传时兜底为 settlement.payAmount（全额退款）
 * @returns {{ action: 'mark_refunded' }
 *         | { action: 'adjust_unsettled', adjustment: Object }
 *         | { action: 'create_reversal', reversalDoc: Object }
 *         | { action: 'noop' }}
 */
function decideRefundReversal(settlement, reversalAlreadyExists, refundAmount) {
  if (!settlement) {
    return { action: 'noop' };
  }
  if (settlement.isReversal) {
    // 冲销分录本身不应再被冲销
    return { action: 'noop' };
  }
  if (reversalAlreadyExists) {
    // 🛡️ 幂等：退款回调可能重推，同一条结算记录不能生成第二条冲销分录
    return { action: 'noop' };
  }

  const amount = (Number.isInteger(refundAmount) && refundAmount > 0)
    ? Math.min(refundAmount, settlement.payAmount)
    : settlement.payAmount; // 未传/非法值兜底为全额退款，兼容升级前调用方
  const isFullRefund = amount >= settlement.payAmount;

  if (settlement.settlementStatus === 'unsettled') {
    if (isFullRefund) {
      // 钱还没结算出去，原地标记即可，不需要额外的冲销分录
      return { action: 'mark_refunded' };
    }
    const netPayAmount = settlement.payAmount - amount;
    const netSplit = computeSettlementSplit({
      payAmount: netPayAmount,
      producerRate: settlement.producerRate,
      promoterRate: settlement.promoterRate
    });
    return {
      action: 'adjust_unsettled',
      adjustment: { payAmount: netPayAmount, ...netSplit }
    };
  }

  // settled：钱已经付给了 producer/promoter（或已线下打款），不能原地改数，
  // 必须用一条反向冲销分录留痕（会计上的"红冲"做法），原记录保持历史真实
  if (isFullRefund) {
    return {
      action: 'create_reversal',
      reversalDoc: {
        tenantId: settlement.tenantId,
        orderId: settlement.orderId,
        originalSettlementId: settlement._id,
        payAmount: -settlement.payAmount,
        // 费率是描述性元数据，不是金额，冲销分录原样带上原费率供核对用，不取负
        producerRate: settlement.producerRate,
        promoterRate: settlement.promoterRate,
        producerAmount: -settlement.producerAmount,
        promoterAmount: -settlement.promoterAmount,
        platformFee: -settlement.platformFee,
        settlementStatus: 'refunded',
        isReversal: true
      }
    };
  }

  const refundSplit = computeSettlementSplit({
    payAmount: amount,
    producerRate: settlement.producerRate,
    promoterRate: settlement.promoterRate
  });
  return {
    action: 'create_reversal',
    reversalDoc: {
      tenantId: settlement.tenantId,
      orderId: settlement.orderId,
      originalSettlementId: settlement._id,
      payAmount: -amount,
      producerRate: settlement.producerRate,
      promoterRate: settlement.promoterRate,
      producerAmount: -refundSplit.producerAmount,
      promoterAmount: -refundSplit.promoterAmount,
      platformFee: -refundSplit.platformFee,
      settlementStatus: 'partially_refunded',
      isReversal: true,
      isPartial: true
    }
  };
}

module.exports = { computeSettlementSplit, buildSettlementSnapshot, decideRefundReversal };
