// 纯校验逻辑，不依赖 wx-server-sdk，便于脱离云开发环境做单元测试
// （与 liveFactoryCore/lib/scheduling.js 把纯逻辑和 db I/O 拆开是同一个理由）。
'use strict';

/**
 * 退款金额必须是正整数分，且这笔订单累计已成功退款的金额 + 本次退款金额
 * 不能超过订单原始实付总额——防止拆成多笔退款把总额退超。
 */
function validateRefundAmount({ refundAmount, totalAmount, alreadyRefundedAmount }) {
  if (!Number.isInteger(refundAmount) || refundAmount <= 0) {
    return { valid: false, error: '退款金额必须是正整数（分）' };
  }
  if (!Number.isInteger(totalAmount) || totalAmount <= 0) {
    return { valid: false, error: '原订单金额非法' };
  }
  const already = Number.isInteger(alreadyRefundedAmount) ? alreadyRefundedAmount : 0;
  if (already + refundAmount > totalAmount) {
    return { valid: false, error: '退款总额不能超过原订单实付金额' };
  }
  return { valid: true };
}

/**
 * 🛡️（2026-09-16 金融级加固）退款请求复用校验：createPendingRefund 在 10 分钟
 * 窗口内命中同一 outTradeNo 下仍处于 PROCESSING 状态的退款记录时会直接复用它
 * （用于防止网络抖动导致的重复提交产生两条退款记录）。但"复用"的前提必须是
 * 这确实是同一次退款意图——如果本次请求的金额与被复用记录的金额不一致（如
 * 调用方在短时间内先后发起了两笔金额不同的退款请求），继续复用会导致"本地
 * refund_orders 记的是旧金额，但即将提交给微信退款接口的是新金额"这种本地
 * 账本与微信侧真实退款金额不一致的危险分叉。金额不一致时拒绝复用，由调用方
 * （wxPayCore/index.js handleRefund）把这个冲突原样报给上层，不静默用错误的
 * 金额继续退款。
 */
function validateReusableRefundAmount({ reusedAmount, requestedAmount }) {
  if (reusedAmount !== requestedAmount) {
    return {
      valid: false,
      error: `该笔支付已有一笔金额为 ¥${(reusedAmount / 100).toFixed(2)} 的退款正在处理中，与本次请求金额（¥${(requestedAmount / 100).toFixed(2)}）不一致，请核实后重试`
    };
  }
  return { valid: true };
}

module.exports = { validateRefundAmount, validateReusableRefundAmount };
