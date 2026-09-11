// 履约状态机：production_orders.orderStatus 允许流转到 'shipped'/'ready_for_pickup'/
// 'verified' 的合法起点。纯逻辑，不依赖 wx-server-sdk，便于单测（与本仓库其它
// lib/ 拆分同一个理由）。
//
// 🏛️（2026-09-12 履约状态机双轨化）此前"标记发货"只有一条路径（生成
// 快递单号 → shipped，终态）。新增 `production_orders.deliveryMethod`
// （'logistics'|'self_pickup'，下单时买家选定，缺失时按 'logistics' 兜底
// 兼容老订单/老客户端）区分两条终态路径：
//   - logistics（物流发货）：paid/in_production → shipped（不变，仍需快递
//     公司+单号，见 lib/validateShipment.js）
//   - self_pickup（到店自提）：paid/in_production → ready_for_pickup
//     （生成自提核销码）→ verified（店长/管理员/制作方扫码或手动输入核销
//     码核验后核销，终态）
// 两条路径互斥（一笔订单的 deliveryMethod 下单时确定，不支持中途切换），
// 但共用同一套"退款前必须处于某个已进入履约流程但尚未完成/退款的状态"的
// REFUNDABLE_STATUSES 判断（见 processProductionRefund/index.js）。
'use strict';

// pending_payment/failed/refunded 都不能直接标记发货/生成自提码：未付款的
// 订单没有真实交易可对应，refunded 的订单已经退款+释放产能，重新推进履约
// 状态会让"钱已经退了、货却显示已发/已自提"这种账实不符的状态出现
const SHIPPABLE_SOURCE_STATUSES = ['paid', 'in_production'];

/**
 * 物流发货：paid/in_production → shipped；shipped 状态下重复调用视为幂等
 * 重入（补录/更正快递单号用），不算流转失败。
 * @param {string} orderStatus 订单当前状态
 * @returns {{allowed: true, alreadyShipped: boolean} | {allowed: false, error: string}}
 */
function canMarkShipped(orderStatus) {
  if (orderStatus === 'shipped') {
    return { allowed: true, alreadyShipped: true };
  }
  if (!SHIPPABLE_SOURCE_STATUSES.includes(orderStatus)) {
    return { allowed: false, error: `订单当前状态为 ${orderStatus}，无法标记发货` };
  }
  return { allowed: true, alreadyShipped: false };
}

/**
 * 到店自提：paid/in_production → ready_for_pickup（生成/展示自提核销码）；
 * ready_for_pickup 状态下重复调用视为幂等重入（重新展示核销码），已经
 * verified（已核销完成）的订单不允许倒退回 ready_for_pickup。
 * @param {string} orderStatus 订单当前状态
 * @returns {{allowed: true, alreadyReady: boolean} | {allowed: false, error: string}}
 */
function canMarkReadyForPickup(orderStatus) {
  if (orderStatus === 'ready_for_pickup') {
    return { allowed: true, alreadyReady: true };
  }
  if (!SHIPPABLE_SOURCE_STATUSES.includes(orderStatus)) {
    return { allowed: false, error: `订单当前状态为 ${orderStatus}，无法生成自提核销码` };
  }
  return { allowed: true, alreadyReady: false };
}

/**
 * 自提核销：ready_for_pickup → verified；verified 状态下重复调用视为幂等
 * 重入（同一码被重复扫描/提交），不算错误。
 * @param {string} orderStatus 订单当前状态
 * @returns {{allowed: true, alreadyVerified: boolean} | {allowed: false, error: string}}
 */
function canVerifyPickup(orderStatus) {
  if (orderStatus === 'verified') {
    return { allowed: true, alreadyVerified: true };
  }
  if (orderStatus !== 'ready_for_pickup') {
    return { allowed: false, error: `订单当前状态为 ${orderStatus}，尚未生成自提核销码或已处理，无法核销` };
  }
  return { allowed: true, alreadyVerified: false };
}

/**
 * 归一化 deliveryMethod：非法/缺失值一律按 'logistics' 兜底——覆盖两类
 * 场景：(1) 本次改造之前创建的历史订单没有这个字段；(2) 尚未升级的老客户端
 * 下单时不会传这个参数。两者都应该退回原有的"物流发货"单一路径，不因为
 * 字段缺失而报错拒绝。
 * @param {any} raw
 * @returns {'logistics' | 'self_pickup'}
 */
function normalizeDeliveryMethod(raw) {
  return raw === 'self_pickup' ? 'self_pickup' : 'logistics';
}

module.exports = {
  SHIPPABLE_SOURCE_STATUSES,
  canMarkShipped,
  canMarkReadyForPickup,
  canVerifyPickup,
  normalizeDeliveryMethod
};
