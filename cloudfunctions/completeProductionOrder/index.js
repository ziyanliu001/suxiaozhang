// 云函数：completeProductionOrder — Module B/C：标记生产订单已发货/完成，
// 并在这个时点（而不是支付成功的瞬间）触发 direct_wechat 模式下的自动分账。
//
// 🏛️ 为什么分账放在这里而不是 createProductionOrder 的 paymentSucceeded 回调：
// 微信支付分账（profitsharing）是"从已支付交易里划出一部分给别人"，一旦划出
// 再遇到买家退款，商户要么要求分账方把钱"回退"（微信支付有对应的分账回退
// 接口，但需要接收方账户里还有余额，操作链路复杂），要么退款本身会失败/
// 需要人工处理。刚付款就分账、马上又要退款，是最容易撞上这类"分账回退失败"
// 的场景。等订单真正发货/完成（意味着不会再随手取消）才分账，能大幅降低
// 这个窗口——虽然发货后仍可能发生售后退款（processProductionRefund 里已经
// 标注了这个残余风险，见该文件注释），但概率和紧迫性都远低于"付款秒退"。
//
// 🔧 部署要求：环境变量需配置 WXPAY_INTERNAL_TOKEN（与 wxPayCore 一致）。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const { buildProfitSharingReceivers } = require('./lib/buildReceivers');

// 🚨 查 tenant_members 而不是 user_roles：见 createProductionSpace/index.js
// 头部注释——live_factory 成员记录绝不能混进雨花公益专区依赖的 user_roles。
async function verifyTenantAccess(openid, tenantId, requiredRoles) {
  const res = await db.collection('tenant_members')
    .where({ _openid: openid, tenantId, status: 'approved' })
    .get();
  return (res.data || []).find((r) => requiredRoles.includes(r.role)) || null;
}

// 尝试对一笔已支付订单发起自动分账 + 解冻剩余资金；只在 direct_wechat 模式、
// 且存在可分账接收方时才真正调用网关。任何失败都不影响"订单已发货"这个
// 主结果，失败信息通过 profitSharing.error 原样透出，供调用方提示"分账失败，
// 请重试"（可重复调用本函数——settlementStatus 已是 settled 时会直接跳过）。
async function tryAutoProfitSharing({ tenantId, order }) {
  // 🐛 tenants 文档 _id 是自动生成的，tenantId 只是业务字段（见
  // createProductionSpace 的 add() 写法），.doc(tenantId) 永远查不到，此前
  // 会导致 paymentMode 永远读成 undefined——不管租户实际是不是 direct_wechat
  // 模式，自动分账这条路径事实上从未被真正触发过
  const tenantRes = await db.collection('tenants').where({ tenantId }).limit(1).get().catch(() => ({ data: [] }));
  const paymentMode = tenantRes.data && tenantRes.data[0] && tenantRes.data[0].paymentMode;
  if (paymentMode !== 'direct_wechat') {
    return { attempted: false, reason: '该空间未开启微信直连分账（payment_mode 非 direct_wechat），分成请通过对账单人工确认' };
  }

  const settlementRes = await db.collection('order_settlements')
    .where({ tenantId, orderId: order._id, isReversal: false }).limit(1).get();
  const settlement = (settlementRes.data && settlementRes.data[0]) || null;
  if (!settlement) {
    return { attempted: false, reason: '未找到该订单的分账快照，无法分账' };
  }
  if (settlement.settlementStatus === 'settled') {
    return { attempted: false, reason: '该订单已完成分账', alreadySettled: true };
  }
  if (settlement.settlementStatus === 'refunded') {
    return { attempted: false, reason: '该订单已被红冲，不再分账' };
  }

  const productRes = await db.collection('products').doc(order.productId).get().catch(() => null);
  const product = productRes && productRes.data;

  const receivers = buildProfitSharingReceivers({ settlement, order, product });
  if (receivers.length === 0) {
    return { attempted: false, reason: '商品未配置制作方 producerOpenId 且订单无推广人，没有可自动分账的接收方，分成请人工确认' };
  }

  const internalToken = process.env.WXPAY_INTERNAL_TOKEN || '';
  const shareRes = await cloud.callFunction({
    name: 'wxPayCore',
    data: { action: 'requestProfitSharing', internalToken, outTradeNo: order.outTradeNo, receivers }
  }).catch((err) => ({ result: { success: false, error: String(err.errMsg || err.message || '分账服务异常') } }));

  const share = shareRes.result || {};
  if (!share.success) {
    return { attempted: true, success: false, error: share.error || '请求分账失败' };
  }

  // 分账请求已受理：立即调用 finishProfitSharing 释放未分完的剩余冻结资金，
  // 这一步失败不影响"分账已发起"这个事实，只记日志供人工核对
  const finishRes = await cloud.callFunction({
    name: 'wxPayCore',
    data: { action: 'finishProfitSharing', internalToken, outOrderNo: share.outOrderNo, description: '生产订单分账完结' }
  }).catch((err) => ({ result: { success: false, error: String(err.errMsg || err.message || '分账完结服务异常') } }));
  if (!(finishRes.result || {}).success) {
    console.error('[completeProductionOrder] finishProfitSharing 失败（需人工核对，冻结资金可能未释放）:', order._id, (finishRes.result || {}).error);
  }

  await db.collection('order_settlements').doc(settlement._id).update({
    data: { settlementStatus: 'settled', settledAt: db.serverDate(), settledBy: 'system_auto_profit_sharing', profitSharingOutOrderNo: share.outOrderNo }
  });

  return { attempted: true, success: true, outOrderNo: share.outOrderNo, status: share.status };
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  const tenantId = String(event.tenantId || '');
  const orderId = String(event.orderId || '');
  if (!tenantId || !orderId) return { success: false, error: '参数缺失: tenantId/orderId' };

  const caller = await verifyTenantAccess(OPENID, tenantId, ['space_owner', 'space_admin', 'producer']);
  if (!caller) return { success: false, error: '无权限：仅空间负责人/管理员/制作方可标记发货完成' };

  const orderRes = await db.collection('production_orders').doc(orderId).get().catch(() => null);
  const order = orderRes && orderRes.data;
  if (!order || order.tenantId !== tenantId) return { success: false, error: '订单不存在' };

  if (!['paid', 'in_production', 'shipped'].includes(order.orderStatus)) {
    return { success: false, error: `订单当前状态为 ${order.orderStatus}，无法标记发货` };
  }

  if (order.orderStatus !== 'shipped') {
    await db.collection('production_orders').doc(orderId).update({
      data: { orderStatus: 'shipped', shippedAt: db.serverDate(), shippedBy: OPENID }
    });
  }
  // 重新读取，保证后续分账逻辑用到的 order.orderStatus/其他字段是最新值
  const freshOrder = { ...order, orderStatus: 'shipped' };

  const profitSharing = await tryAutoProfitSharing({ tenantId, order: freshOrder });

  return { success: true, orderStatus: 'shipped', profitSharing };
};
