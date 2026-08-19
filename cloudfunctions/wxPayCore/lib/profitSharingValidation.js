// 纯校验逻辑，不依赖 wx-server-sdk，便于脱离云开发环境做单元测试
// （与 liveFactoryCore/lib/scheduling.js 把纯逻辑和 db I/O 拆开是同一个理由）。
'use strict';

const RECEIVER_TYPES = ['MERCHANT_ID', 'PERSONAL_OPENID', 'PERSONAL_SUB_OPENID'];

/**
 * 接收方列表非空、每项 type/account/amount 合法，且金额总和不超过订单实付
 * 总额（微信支付分账本身也有这条硬约束，这里提前校验避免把一个注定失败的
 * 请求发去真实网关）。
 */
function validateReceivers({ receivers, transactionAmount }) {
  if (!Array.isArray(receivers) || receivers.length === 0) {
    return { valid: false, error: 'receivers 不能为空' };
  }
  let sum = 0;
  for (const r of receivers) {
    if (!r || !r.account) return { valid: false, error: 'receivers 每一项都需要 account' };
    if (!RECEIVER_TYPES.includes(r.type)) return { valid: false, error: `不支持的 receiver type: ${r.type}` };
    if (!Number.isInteger(r.amount) || r.amount <= 0) return { valid: false, error: 'receiver amount 必须是正整数（分）' };
    sum += r.amount;
  }
  if (Number.isInteger(transactionAmount) && sum > transactionAmount) {
    return { valid: false, error: '分账接收方金额总和不能超过订单实付金额' };
  }
  return { valid: true, totalAmount: sum };
}

module.exports = { RECEIVER_TYPES, validateReceivers };
