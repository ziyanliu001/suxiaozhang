// 部分退款金额校验：纯逻辑，不依赖 wx-server-sdk。
//
// 🏛️（2026-09-12）此前退款金额恒等于 order.payAmount（硬编码全额退款），
// 现在允许调用方传入 refundAmount（分，与 production_orders.payAmount 同一
// 单位——支付类金额按"分"整型存储，见 CLAUDE.md 第 3 节金额存储口径分类，
// 产销工坊订单走的是这一档，不是公益记账"元"浮点那一档）指定实际退款
// 金额，服务端仍然强校验一次，不信任客户端传来的任意数字。
//
// 🛡️ 范围说明（如实标注）：本仓库当前架构里一笔订单只允许发起一次真正的
// 退款动作（processProductionRefund/index.js 的 refundClaimedAt CAS 领单
// 是"全局唯一一次"级别的锁，不是"按剩余可退余额"的累计锁）——本函数校验
// 的是"这一次退款金额是否合法（大于 0 且不超过订单实付金额）"，不支持
// "分多次逐步退到全额"这种多次累计退款场景，那需要更大范围的状态机与
// 已退款累计字段设计，本次不做。
'use strict';

/**
 * @param {number} payAmount 订单实付金额（分，整数）
 * @param {any} requestedRefundAmount 调用方传入的退款金额；未提供（undefined/null）
 *   时兜底为全额退款，保持与本函数上线前"退款金额恒等于 payAmount"的调用方
 *   行为兼容
 * @returns {{valid: true, amount: number, isFullRefund: boolean} | {valid: false, error: string}}
 */
function validateRefundAmount(payAmount, requestedRefundAmount) {
  if (!Number.isInteger(payAmount) || payAmount <= 0) {
    return { valid: false, error: '订单实付金额异常，无法计算退款' };
  }
  const amount = (requestedRefundAmount === undefined || requestedRefundAmount === null || requestedRefundAmount === '')
    ? payAmount
    : Number(requestedRefundAmount);
  if (!Number.isInteger(amount) || amount <= 0) {
    return { valid: false, error: '退款金额必须是大于 0 的整数（单位：分）' };
  }
  if (amount > payAmount) {
    return { valid: false, error: '退款金额不能超过订单实付金额' };
  }
  return { valid: true, amount, isFullRefund: amount === payAmount };
}

module.exports = { validateRefundAmount };
