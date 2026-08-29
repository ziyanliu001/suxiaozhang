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
 * @param {Object} settlement          现有 order_settlements 记录
 * @param {boolean} reversalAlreadyExists  是否已存在针对该记录的红冲分录
 * @returns {{ action: 'mark_refunded' } | { action: 'create_reversal', reversalDoc: Object } | { action: 'noop' }}
 */
function decideRefundReversal(settlement, reversalAlreadyExists) {
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
  if (settlement.settlementStatus === 'unsettled') {
    // 钱还没结算出去，原地标记即可，不需要额外的冲销分录
    return { action: 'mark_refunded' };
  }
  // settled：钱已经付给了 producer/promoter（或已线下打款），不能原地改数，
  // 必须用一条反向冲销分录留痕（会计上的"红冲"做法），原记录保持历史真实
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

module.exports = { computeSettlementSplit, buildSettlementSnapshot, decideRefundReversal };
