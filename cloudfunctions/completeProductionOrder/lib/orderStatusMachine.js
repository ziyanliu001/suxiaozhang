// 发货状态机：production_orders.orderStatus 允许流转到 'shipped' 的合法起点。
// 纯逻辑，不依赖 wx-server-sdk，便于单测（与本仓库其它 lib/ 拆分同一个理由）。
'use strict';

// pending_payment/failed/refunded 都不能直接标记发货：未付款的订单没有真实
// 交易可对应，refunded 的订单已经退款+释放产能，重新标发货会让"钱已经退了、
// 货却显示已发"这种账实不符的状态出现
const SHIPPABLE_STATUSES = ['paid', 'in_production', 'shipped'];

/**
 * @param {string} orderStatus 订单当前状态
 * @returns {{allowed: true, alreadyShipped: boolean} | {allowed: false, error: string}}
 */
function canMarkShipped(orderStatus) {
  if (!SHIPPABLE_STATUSES.includes(orderStatus)) {
    return { allowed: false, error: `订单当前状态为 ${orderStatus}，无法标记发货` };
  }
  return { allowed: true, alreadyShipped: orderStatus === 'shipped' };
}

module.exports = { canMarkShipped, SHIPPABLE_STATUSES };
