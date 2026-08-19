// 云函数：createProductionOrder — Module B/C：预售下单，串联排产调度 + wxPayCore 收款 + 分账快照
//
// 🏛️ 架构对齐 createSubscriptionOrder：定价/校验在本函数完成，下单/支付状态机
// 转发给 wxPayCore；action:'paymentSucceeded' 是 wxPayCore 支付成功后的内部回调，
// 不面向小程序客户端，鉴权方式是反查 wxPayCore 的 payment_orders 账本确认真的
// PAID（与 createSubscriptionOrder/lib/applyPayment.js 同一份写法，见其注释）。
//
// 🔧 部署要求：环境变量需同时配置 WXPAY_INTERNAL_TOKEN（与 wxPayCore 一致）和
// LIVE_FACTORY_INTERNAL_TOKEN（与 liveFactoryCore 一致）。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const ORDERS_COLLECTION = 'production_orders';
const PAYMENT_ORDERS_COLLECTION = 'payment_orders';

// 🏛️ 分成比例策略默认值：与 PLAN_STORE_LIMITS 同类性质——这是产品定价/分账
// 政策的既定常量，不是替商家瞎编的具体业务数据，未在 tenants.settlementConfig
// 显式配置时按此兜底，保证"没配置也能把全链路跑通"
const DEFAULT_PRODUCER_RATE = 0.85;
const DEFAULT_PROMOTER_RATE = 0.05; // 仅当订单带 promoterOpenId 时生效

function isCollectionNotExistError(err) {
  return !!err && (
    err.errCode === -502005 ||
    /database collection not exists/i.test(String(err.errMsg || err.message || ''))
  );
}

// 🛡️ 佣金归属校验：此前直接信任客户端传来的 promoterOpenId 写进订单——任何人
// 传任意 openid 都能把推广佣金"分"给指定账号，是一个真实存在的漏洞。现在必须
// 反查 tenant_members 确认该 openid 在本租户确实是已批准的 promoter 才会被
// 采纳；校验不通过时静默丢弃（订单按无推广人处理），不阻断买家下单——推广
// 链接失效/伪造是攻击者或过期链接的问题，不该由买家的购买行为来承担后果。
async function resolveValidPromoterOpenId(tenantId, promoterOpenId) {
  if (!promoterOpenId) return '';
  const res = await db.collection('tenant_members')
    .where({ _openid: promoterOpenId, tenantId, role: 'promoter', status: 'approved' })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }));
  if (!res.data || res.data.length === 0) {
    console.warn('[createProductionOrder] promoterOpenId 校验未通过（非本租户已批准的 promoter），已丢弃归属:', { tenantId, promoterOpenId });
    return '';
  }
  return promoterOpenId;
}

async function resolveSettlementRates(tenantId, hasPromoter) {
  // 🐛 tenants 文档的 _id 是云数据库自动生成的，tenantId 只是文档里的业务字段
  // （见 createProductionSpace/createTenant 的 add() 写法），不能用 .doc(tenantId)
  // 按 _id 查——那样永远查不到，之前这里就是这么写的，只是靠下面的 .catch(()=>null)
  // + 默认费率兜底才没直接报错，实际后果是 settlementConfig 永远读不到、只会
  // 用默认费率，租户自定义的分成比例配置形同虚设
  const tenantRes = await db.collection('tenants').where({ tenantId }).limit(1).get().catch(() => ({ data: [] }));
  const cfg = (tenantRes.data && tenantRes.data[0] && tenantRes.data[0].settlementConfig) || {};
  const producerRate = Number.isFinite(cfg.producerRate) ? cfg.producerRate : DEFAULT_PRODUCER_RATE;
  const promoterRate = hasPromoter ? (Number.isFinite(cfg.promoterRate) ? cfg.promoterRate : DEFAULT_PROMOTER_RATE) : 0;
  return { producerRate, promoterRate };
}

async function bumpCustomerCheckin(tenantId, buyerOpenId, orderId) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const existingRes = await db.collection('customer_checkins').where({ tenantId, buyerOpenId }).limit(1).get().catch(() => ({ data: [] }));
  const existing = (existingRes.data && existingRes.data[0]) || null;
  if (existing) {
    if (existing.lastCheckinDate === dateStr) return; // 同日重复下单不重复计打卡
    await db.collection('customer_checkins').doc(existing._id).update({
      data: { streakCount: (existing.streakCount || 0) + 1, lastCheckinDate: dateStr, lastOrderId: orderId }
    }).catch(() => {});
  } else {
    await db.collection('customer_checkins').add({
      data: { tenantId, buyerOpenId, streakCount: 1, lastCheckinDate: dateStr, lastOrderId: orderId, createdAt: db.serverDate() }
    }).catch(() => {});
  }
}

// ── 下单 ──────────────────────────────────────────────────────────────────
async function handleCreateOrder(event) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  const tenantId = String(event.tenantId || '');
  const productId = String(event.productId || '');
  const quantity = Number(event.quantity);
  const promoterOpenId = event.promoterOpenId ? String(event.promoterOpenId) : '';
  if (!tenantId || !productId || !(quantity > 0)) {
    return { success: false, error: '参数缺失: tenantId/productId/quantity' };
  }

  const productRes = await db.collection('products').doc(productId).get().catch(() => null);
  const product = productRes && productRes.data;
  if (!product || product.tenantId !== tenantId || product.status !== 'active') {
    return { success: false, error: '商品不存在或已下架' };
  }
  if (!(product.price > 0) || !(product.dailyCapacityLimit > 0)) {
    return { success: false, error: '商品未完成产能/定价配置，暂不可下单' };
  }

  const verifiedPromoterOpenId = await resolveValidPromoterOpenId(tenantId, promoterOpenId);

  // 1. 排产：先占用产能，成功后再落订单，任何后续失败都必须释放这次占用
  const assignRes = await cloud.callFunction({
    name: 'liveFactoryCore',
    data: {
      action: 'assignBatch',
      internalToken: process.env.LIVE_FACTORY_INTERNAL_TOKEN || '',
      tenantId, productId,
      dailyCapacityLimit: product.dailyCapacityLimit,
      leadTimeDays: product.leadTimeDays || 0,
      quantity
    }
  }).catch((err) => ({ result: { success: false, error: String(err.errMsg || err.message || '排产服务异常') } }));

  const assign = assignRes.result || {};
  if (!assign.success) {
    return { success: false, error: assign.error || '排产失败，请重试' };
  }

  const payAmount = product.price * quantity;
  const orderData = {
    tenantId, productId,
    buyerOpenId: OPENID,
    promoterOpenId: verifiedPromoterOpenId,
    quantity,
    unitPrice: product.price,
    payAmount,
    batchDate: assign.batchDate,
    estimatedShippingDate: assign.estimatedShippingDate,
    orderStatus: 'pending_payment',
    createdBy: OPENID,
    createdAt: db.serverDate()
  };

  let orderId;
  try {
    const addRes = await db.collection(ORDERS_COLLECTION).add({ data: orderData });
    orderId = addRes._id;
  } catch (err) {
    if (isCollectionNotExistError(err)) {
      await db.createCollection(ORDERS_COLLECTION).catch(() => {});
      const addRes = await db.collection(ORDERS_COLLECTION).add({ data: orderData });
      orderId = addRes._id;
    } else {
      console.error('[createProductionOrder] 写入订单失败，释放已占用产能:', err);
      await releaseCapacity(tenantId, productId, assign.batchDate, quantity);
      return { success: false, error: '创建订单失败，请重试' };
    }
  }

  // 2. 转发 wxPayCore 统一下单
  let payRes;
  try {
    payRes = await cloud.callFunction({
      name: 'wxPayCore',
      data: {
        action: 'createOrder',
        internalToken: process.env.WXPAY_INTERNAL_TOKEN || '',
        openid: OPENID,
        tenantId,
        bizType: 'PRODUCTION_ORDER',
        bizId: orderId,
        amount: payAmount,
        description: `${product.name} x${quantity}`,
        notifyFn: 'createProductionOrder'
      }
    });
  } catch (err) {
    console.error('[createProductionOrder] 调用 wxPayCore 异常:', err);
    await db.collection(ORDERS_COLLECTION).doc(orderId).update({ data: { orderStatus: 'failed' } }).catch(() => {});
    await releaseCapacity(tenantId, productId, assign.batchDate, quantity);
    return { success: false, error: '支付服务暂时不可用，请重试' };
  }

  const payResult = payRes.result || {};
  if (!payResult.success) {
    await db.collection(ORDERS_COLLECTION).doc(orderId).update({ data: { orderStatus: 'failed' } }).catch(() => {});
    await releaseCapacity(tenantId, productId, assign.batchDate, quantity);
    return { success: false, error: payResult.error || '支付下单失败，请重试', paymentNotConfigured: payResult.paymentNotConfigured };
  }

  await db.collection(ORDERS_COLLECTION).doc(orderId).update({ data: { outTradeNo: payResult.outTradeNo } }).catch(() => {});

  return {
    success: true,
    orderId,
    outTradeNo: payResult.outTradeNo,
    batchDate: assign.batchDate,
    estimatedShippingDate: assign.estimatedShippingDate,
    payment: payResult.payment,
    mockMode: payResult.mockMode
  };
}

async function releaseCapacity(tenantId, productId, batchDate, quantity) {
  await cloud.callFunction({
    name: 'liveFactoryCore',
    data: {
      action: 'releaseBatchCapacity',
      internalToken: process.env.LIVE_FACTORY_INTERNAL_TOKEN || '',
      tenantId, productId, batchDate, quantity
    }
  }).catch((err) => console.error('[createProductionOrder] 释放产能失败（需人工核对）:', err));
}

// ── 支付成功回调 ──────────────────────────────────────────────────────────
async function handlePaymentSucceeded(event) {
  const { outTradeNo, bizId } = event;
  if (!outTradeNo || !bizId) return { success: false, error: '参数缺失' };

  const payOrderRes = await db.collection(PAYMENT_ORDERS_COLLECTION).where({ outTradeNo, bizId }).limit(1).get().catch(() => ({ data: [] }));
  const paymentOrder = (payOrderRes.data && payOrderRes.data[0]) || null;
  if (!paymentOrder || paymentOrder.status !== 'PAID') {
    console.error('[createProductionOrder] 拒绝处理：未找到匹配的 PAID 记录', { outTradeNo, bizId });
    return { success: false, error: '未确认到有效支付记录，拒绝激活' };
  }

  const orderRes = await db.collection(ORDERS_COLLECTION).doc(bizId).get().catch(() => null);
  const order = orderRes && orderRes.data;
  if (!order) return { success: false, error: '订单不存在' };
  if (order.orderStatus === 'paid') return { success: true, alreadyProcessed: true }; // 幂等

  await db.collection(ORDERS_COLLECTION).doc(bizId).update({
    data: { orderStatus: 'paid', paidAt: db.serverDate(), transactionId: paymentOrder.transactionId || '' }
  });

  const { producerRate, promoterRate } = await resolveSettlementRates(order.tenantId, !!order.promoterOpenId);
  await cloud.callFunction({
    name: 'liveFactoryCore',
    data: {
      action: 'buildSettlement',
      internalToken: process.env.LIVE_FACTORY_INTERNAL_TOKEN || '',
      tenantId: order.tenantId, orderId: bizId, payAmount: order.payAmount,
      producerRate, promoterRate
    }
  }).catch((err) => console.error('[createProductionOrder] 生成分账快照失败（需人工核对）:', err));

  await bumpCustomerCheckin(order.tenantId, order.buyerOpenId, bizId);

  return { success: true };
}

exports.main = async (event, context) => {
  if (event.action === 'paymentSucceeded') return handlePaymentSucceeded(event);
  return handleCreateOrder(event);
};
