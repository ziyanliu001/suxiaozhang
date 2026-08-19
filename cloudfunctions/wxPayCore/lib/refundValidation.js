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

module.exports = { validateRefundAmount };
