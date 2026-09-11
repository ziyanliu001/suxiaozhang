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
// 🔧 部署要求：
//   - 环境变量 WXPAY_INTERNAL_TOKEN（与 wxPayCore 一致）
//   - 环境变量 SHIPPING_NOTICE_TEMPLATE_ID（微信订阅消息"发货提醒"类模板
//     ID，未配置时静默跳过推送，不影响标记发货本身）
//   - config.json 的 openapi 权限需包含 subscribeMessage.send
//
// 📦 物流信息：expressCompany（六家常用快递 + "其他"，见 lib/validateShipment.js）
// 与 trackingNumber 是选填字段，两者必须同时提供或同时不提供；已发货订单
// 重复调用本函数可以用来补录/更正快递单号（幂等，不会重复触发分账/通知）。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { buildProfitSharingReceivers } = require('./lib/buildReceivers');
const { canMarkShipped, canMarkReadyForPickup, canVerifyPickup, normalizeDeliveryMethod } = require('./lib/orderStatusMachine');
const { validateShipment } = require('./lib/validateShipment');
const { buildShippingNoticePayload } = require('./lib/buildSubscribeMessagePayload');
const { generatePickupCode, verifyPickupCode } = require('./lib/pickupCode');

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 🔔 发货通知：仅在"这次调用真正把订单从非 shipped 状态转到 shipped"时才发
// （由调用方传入 wasAlreadyShipped 判断，同一订单重复标记/补录快递单号不会
// 重复推送）。任何环节失败都只 console.warn，不重新抛出——买家有没有订阅、
// 模板配额是否用尽、openid 是否已取消关注，都不能影响"订单已经成功标记
// 发货"这个已经落库的事实。
async function sendShippingNotice(order) {
  const templateId = process.env.SHIPPING_NOTICE_TEMPLATE_ID || '';
  if (!templateId) {
    console.warn('[completeProductionOrder] SHIPPING_NOTICE_TEMPLATE_ID 未配置，跳过发货通知推送');
    return;
  }
  try {
    const productRes = await db.collection('products').doc(order.productId).get().catch(() => null);
    const product = productRes && productRes.data;
    const payload = buildShippingNoticePayload({
      buyerOpenId: order.buyerOpenId,
      templateId,
      productName: product ? product.name : '',
      expressCompany: order.expressCompany || '',
      trackingNumber: order.trackingNumber || '',
      shippedAtStr: todayStr()
    });
    if (!payload) return;
    await cloud.openapi.subscribeMessage.send(payload);
  } catch (err) {
    console.warn('[completeProductionOrder] 发货通知推送失败（不阻断主流程）:', err);
  }
}

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

  // 🛡️ 原子领单（claim）：上面对 settlementStatus 的判断和下面真正调用微信
  // 分账网关之间存在窗口——"标记发货完成"被并发/重复调用（双击、客户端超时
  // 重试）会让两次调用都读到 settlementStatus !== 'settled' 从而双双通过检查，
  // 各自触发一次 requestProfitSharing，等于同一笔支付被重复分账、真实资金
  // 多分一次。改用与 wxPayCore.orderService.markPaidIdempotent 同一套 CAS
  // （条件更新）手法抢占一个独立的锁字段（不改 settlementStatus 本身，避免
  // getSettlementSummary 的三桶归类逻辑读到一个它不认识的中间状态而漏统计）：
  // where 命中 settlementStatus 仍是 'unsettled' 且尚未被锁定才允许更新，
  // 只有抢到 stats.updated===1 的这次调用才能继续往下发起分账请求。
  const claimRes = await db.collection('order_settlements').where({
    _id: settlement._id,
    settlementStatus: 'unsettled',
    profitSharingLockedAt: _.exists(false)
  }).update({ data: { profitSharingLockedAt: db.serverDate() } });
  if (!claimRes.stats || claimRes.stats.updated !== 1) {
    return { attempted: false, reason: '该订单分账正在被另一次请求处理或状态已变更，本次跳过（幂等）', skippedDueToRace: true };
  }

  const internalToken = process.env.WXPAY_INTERNAL_TOKEN || '';
  const shareRes = await cloud.callFunction({
    name: 'wxPayCore',
    data: { action: 'requestProfitSharing', internalToken, outTradeNo: order.outTradeNo, receivers }
  }).catch((err) => ({ result: { success: false, error: String(err.errMsg || err.message || '分账服务异常') } }));

  const share = shareRes.result || {};
  if (!share.success) {
    // 分账网关明确拒绝/异常：释放锁，允许"分成请重试"再次抢占
    await db.collection('order_settlements').doc(settlement._id).update({
      data: { profitSharingLockedAt: _.remove() }
    }).catch((err) => console.error('[completeProductionOrder] 释放分账占位失败（需人工核对是否卡死）:', settlement._id, err));
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
    data: {
      settlementStatus: 'settled', settledAt: db.serverDate(), settledBy: 'system_auto_profit_sharing', profitSharingOutOrderNo: share.outOrderNo,
      profitSharingLockedAt: _.remove()
    }
  });

  return { attempted: true, success: true, outOrderNo: share.outOrderNo, status: share.status };
}

// 🏛️（2026-09-12 履约状态机双轨化）物流发货分支——与原有逻辑完全一致，
// 只是从 exports.main 里拆出来，改由 deliveryMethod 分流调用
async function handleMarkShipped({ OPENID, tenantId, orderId, order, event }) {
  const statusCheck = canMarkShipped(order.orderStatus);
  if (!statusCheck.allowed) return { success: false, error: statusCheck.error };

  const shipment = validateShipment({ expressCompany: event.expressCompany, trackingNumber: event.trackingNumber });
  if (!shipment.valid) return { success: false, error: shipment.error };

  const updateData = {};
  if (!statusCheck.alreadyShipped) {
    updateData.orderStatus = 'shipped';
    updateData.shippedAt = db.serverDate();
    updateData.shippedBy = OPENID;
  }
  if (shipment.provided) {
    updateData.expressCompany = shipment.expressCompany;
    updateData.trackingNumber = shipment.trackingNumber;
  }
  if (Object.keys(updateData).length > 0) {
    await db.collection('production_orders').doc(orderId).update({ data: updateData });
  }

  // 重新读取，保证后续分账逻辑/发货通知用到的 order 字段是最新值
  const freshOrder = {
    ...order,
    orderStatus: 'shipped',
    expressCompany: shipment.provided ? shipment.expressCompany : (order.expressCompany || ''),
    trackingNumber: shipment.provided ? shipment.trackingNumber : (order.trackingNumber || '')
  };

  // 只在这次调用真正完成"未发货 -> 已发货"这次状态迁移时才推送通知，重复
  // 标记/补录快递单号不会重复打扰买家
  if (!statusCheck.alreadyShipped) {
    await sendShippingNotice(freshOrder);
  }

  const profitSharing = await tryAutoProfitSharing({ tenantId, order: freshOrder });

  return {
    success: true,
    orderStatus: 'shipped',
    expressCompany: freshOrder.expressCompany,
    trackingNumber: freshOrder.trackingNumber,
    profitSharing
  };
}

// 🏛️（2026-09-12 履约状态机双轨化）到店自提分支第一步——生成核销码，订单
// 进入 ready_for_pickup（终态前的"待自提"态，尚未分账，分账要等买家真正
// 到店核销后才触发，与物流路径"标记发货即分账"的时机保持同一个"钱已经
// 交付实体/确认交付事实后才分账"的原则）
async function handleMarkReadyForPickup({ orderId, order }) {
  const statusCheck = canMarkReadyForPickup(order.orderStatus);
  if (!statusCheck.allowed) return { success: false, error: statusCheck.error };

  const pickupCode = order.pickupCode || generatePickupCode(orderId);
  if (!statusCheck.alreadyReady) {
    await db.collection('production_orders').doc(orderId).update({
      data: { orderStatus: 'ready_for_pickup', readyForPickupAt: db.serverDate(), pickupCode }
    });
  }

  return { success: true, orderStatus: 'ready_for_pickup', pickupCode };
}

// 🏛️（2026-09-12 履约状态机双轨化）到店自提分支第二步——店长/管理员/制作方
// 核对买家出示的核销码，核验通过后订单进入 verified 终态，此时才真正触发
// 分账（与物流路径"标记发货即分账"对齐同一个时机原则：确认实体已经交付
// 给买家，才把钱分出去）
async function handleVerifyPickup(event) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  const tenantId = String(event.tenantId || '');
  const orderId = String(event.orderId || '');
  const inputCode = String(event.pickupCode || '').trim();
  if (!tenantId || !orderId) return { success: false, error: '参数缺失: tenantId/orderId' };
  if (!inputCode) return { success: false, error: '请输入自提核销码' };

  const caller = await verifyTenantAccess(OPENID, tenantId, ['space_owner', 'space_admin', 'producer']);
  if (!caller) return { success: false, error: '无权限：仅空间负责人/管理员/制作方可核销自提订单' };

  const orderRes = await db.collection('production_orders').doc(orderId).get().catch(() => null);
  const order = orderRes && orderRes.data;
  if (!order || order.tenantId !== tenantId) return { success: false, error: '订单不存在' };

  const statusCheck = canVerifyPickup(order.orderStatus);
  if (!statusCheck.allowed) return { success: false, error: statusCheck.error };

  if (!statusCheck.alreadyVerified) {
    if (!verifyPickupCode(inputCode, order.pickupCode)) {
      return { success: false, error: '核销码不正确，请核对后重试' };
    }
    // 🛡️ 条件更新防重复核销：where 命中 orderStatus 仍是 ready_for_pickup
    // 才允许更新，两次并发核销（如双击/重复扫码）只有一次能真正把状态从
    // ready_for_pickup 撞成 verified——与本仓库其余状态迁移同一套 CAS 手法
    const claimRes = await db.collection('production_orders').where({
      _id: orderId, orderStatus: 'ready_for_pickup'
    }).update({ data: { orderStatus: 'verified', verifiedAt: db.serverDate(), verifiedBy: OPENID } });
    if (!claimRes.stats || claimRes.stats.updated !== 1) {
      return { success: true, orderStatus: 'verified', alreadyVerified: true, profitSharing: { attempted: false, reason: '该订单已被另一次核销请求处理（幂等）' } };
    }
  }

  const freshOrder = { ...order, orderStatus: 'verified' };
  const profitSharing = await tryAutoProfitSharing({ tenantId, order: freshOrder });

  return { success: true, orderStatus: 'verified', profitSharing };
}

exports.main = async (event, context) => {
  if (event.action === 'verifyPickup') return handleVerifyPickup(event);

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

  const deliveryMethod = normalizeDeliveryMethod(order.deliveryMethod);
  if (deliveryMethod === 'self_pickup') {
    return handleMarkReadyForPickup({ orderId, order });
  }
  return handleMarkShipped({ OPENID, tenantId, orderId, order, event });
};
