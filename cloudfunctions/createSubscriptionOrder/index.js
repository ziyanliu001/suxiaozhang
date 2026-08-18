// 云函数：createSubscriptionOrder
// 为调用者当前租户创建订阅订单——定价/权限校验仍在本函数完成，实际下单/支付
// 状态机已迁移到 wxPayCore（见 cloudfunctions/wxPayCore），本函数只保留"这个
// 业务场景特有的东西"：套餐价格表、tenantId 权限校验、subscription_orders
// 业务台账、以及支付成功后具体该怎么改 tenant_subscriptions（applyPayment.js）。
//
// 🏛️ 架构说明：
//   exports.main 默认动作（前端调用不传 action）= 下单：校验权限/算价 →
//   写 subscription_orders 台账 → 转发 wxPayCore.createOrder。
//   action: 'paymentSucceeded' 是 wxPayCore 支付成功后的回调入口（见
//   wxPayCore/lib/orderService.js dispatchNotifyHook），只在服务端内部触发，
//   不面向小程序客户端——鉴权方式不是 openid，而是反查 wxPayCore 自己的
//   payment_orders 账本，确认 outTradeNo 真的已经是 PAID 状态（见下方
//   handlePaymentSucceeded 注释），防止有人绕过支付直接伪造这个回调。
//
// 🆕 v2：此前（2026-08 之前）本函数直接调用微信云开发原生支付
// （cloud.pay.unifiedorder），支付结果由 payCallback 云函数接收。云开发原生
// 支付要求提前在控制台绑定商户号，在"主体认证与真实微信支付绑定的过渡期"
// 没法先把下单-支付-回调的完整链路跑通；wxPayCore 直接对接 APIv3 且带
// PAYMENT_MOCK_MODE 开关，过渡期可以先用 Mock 跑通全流程，真实商户号就绪后
// 只需在 wxPayCore 环境变量里配置真实凭证，本文件不需要任何改动。
// cloudfunctions/payCallback 保留但已停用（不会再被新订单触发），仅作为
// 切换瞬间那批"已经在 cloud.pay 流程里、支付成功回调尚未落地"的存量订单的
// 安全网，详见该文件头部注释。
//
// 🔧 部署要求：本函数环境变量需配置 WXPAY_INTERNAL_TOKEN，且必须与 wxPayCore
// 环境变量里的同名值完全一致（wxPayCore 靠它拦截非法的 createOrder/closeOrder
// 直接调用，见 wxPayCore/lib/payConfig.js 头部注释）。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { applySubscriptionPayment } = require('./lib/applyPayment');

// ── 套餐价格与元数据 ────────────────────────────────────────────────────────
// totalFee/unitFee 单位：分（人民币）；planType 对应 tenant_subscriptions
// 集合的字段值。三档套餐定价与门店配额（方案一：以机构为核心计费主体）：
//   基础版 basic    ¥0     / 门店上限 2  家（免费默认档，无需下单，不在此登记）
//   专业版 pro      ¥1,688 / 年，门店上限 10 家
//   旗舰版 enterprise ¥3,688 / 年，门店上限 30 家
//   扩容门店包 add_on ¥200 / 店 / 年，按需叠加最大门店配额，不改变 planType
const PLAN_CONFIG = {
  PRO_YEARLY: {
    totalFee: 168800,          // 1688.00 元
    planType: 'pro',
    durationDays: 365,
    body: '雨花助手专业版年度订阅'
  },
  FLAGSHIP_YEARLY: {
    totalFee: 368800,          // 3688.00 元
    planType: 'enterprise',
    durationDays: 365,
    body: '雨花助手旗舰版年度订阅'
  }
};
const ADD_ON_STORE_CONFIG = {
  unitFee: 20000,              // 200.00 元 / 店 / 年
  durationDays: 365,
  bodyPrefix: '雨花助手门店扩容包'
};
const MAX_ADD_ON_QUANTITY = 20;

const ORDERS_COLLECTION = 'subscription_orders';
const PAYMENT_ORDERS_COLLECTION = 'payment_orders'; // wxPayCore 自己的账本，此处只读用于校验

function isCollectionNotExistError(err) {
  return !!err && (
    err.errCode === -502005 ||
    /database collection not exists/i.test(String(err.errMsg || err.message || ''))
  );
}

// ── 下单：校验权限/算价 → 台账 → 转发 wxPayCore ──────────────────────────────
async function handleCreateOrder(event) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  const planKey = event.planType || 'PRO_YEARLY';
  const isAddOn = planKey === 'ADD_ON_STORE';
  let planCfg = null;
  let addOnQuantity = 0;
  if (isAddOn) {
    addOnQuantity = Math.min(Math.max(parseInt(event.quantity, 10) || 1, 1), MAX_ADD_ON_QUANTITY);
    planCfg = {
      totalFee: ADD_ON_STORE_CONFIG.unitFee * addOnQuantity,
      durationDays: ADD_ON_STORE_CONFIG.durationDays,
      body: `${ADD_ON_STORE_CONFIG.bodyPrefix} × ${addOnQuantity} 家/年`
    };
  } else {
    planCfg = PLAN_CONFIG[planKey];
  }
  if (!planCfg) {
    return { success: false, error: `不支持的套餐类型：${planKey}` };
  }

  let caller;
  try {
    const res = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
    caller = (res.data && res.data[0]) || null;
  } catch (err) {
    console.error('[createSubscriptionOrder] 查询用户角色失败:', err);
    return { success: false, error: '获取用户信息失败，请重试' };
  }

  if (!caller || caller.status !== 'approved') {
    return { success: false, error: '账号尚未通过审核，无法发起订购' };
  }
  if (caller.role !== 'super_admin' && caller.role !== 'store_patriarch') {
    return { success: false, error: '仅超级管理员/大家长可发起订购' };
  }
  const tenantId = caller.tenantId || '';
  if (!tenantId) {
    return { success: false, error: '无法确认所属机构，请联系技术支持' };
  }

  // 1. 业务台账：先写 subscription_orders（此时还没有 outTradeNo——由 wxPayCore
  // 统一生成），用文档 _id 作为 bizId 传给 wxPayCore，付款成功后凭它反查回这条记录
  const orderData = {
    tenantId,
    ...(isAddOn ? { isAddOn: true, extraStores: addOnQuantity } : { planType: planCfg.planType }),
    durationDays: planCfg.durationDays,
    totalFee: planCfg.totalFee,
    status: 'pending',
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
      console.error('[createSubscriptionOrder] 写入订单记录失败:', err);
      return { success: false, error: '创建订单失败，请重试' };
    }
  }

  // 2. 转发 wxPayCore 统一下单：金额/描述都是服务端刚算好的值，不接受客户端传入
  let payRes;
  try {
    payRes = await cloud.callFunction({
      name: 'wxPayCore',
      data: {
        action: 'createOrder',
        internalToken: process.env.WXPAY_INTERNAL_TOKEN || '',
        openid: OPENID,
        tenantId,
        bizType: 'SUBSCRIPTION',
        bizId: orderId,
        amount: planCfg.totalFee,
        description: planCfg.body,
        notifyFn: 'createSubscriptionOrder'
      }
    });
  } catch (err) {
    console.error('[createSubscriptionOrder] 调用 wxPayCore 异常:', err);
    await db.collection(ORDERS_COLLECTION).doc(orderId).update({
      data: { status: 'failed', failedAt: db.serverDate(), failReason: String(err.errMsg || err.message || 'wxPayCore 调用异常') }
    }).catch(() => {});
    return { success: false, error: '支付服务暂时不可用，请重试' };
  }

  const payResult = payRes.result || {};
  if (!payResult.success) {
    await db.collection(ORDERS_COLLECTION).doc(orderId).update({
      data: { status: 'failed', failedAt: db.serverDate(), failReason: payResult.error || '下单失败' }
    }).catch(() => {});
    // paymentNotConfigured 原样透传：前端 profile.ts 靠这个字段区分"引导配置/购买"弹窗 与普通错误 Toast
    return { success: false, error: payResult.error || '支付下单失败，请重试', paymentNotConfigured: payResult.paymentNotConfigured };
  }

  await db.collection(ORDERS_COLLECTION).doc(orderId).update({
    data: { outTradeNo: payResult.outTradeNo }
  }).catch((err) => console.warn('[createSubscriptionOrder] 回填 outTradeNo 失败（非致命）:', err));

  console.log('[createSubscriptionOrder] 下单成功:', { orderId, outTradeNo: payResult.outTradeNo, tenantId, planKey, mockMode: payResult.mockMode });
  return {
    success: true,
    outTradeNo: payResult.outTradeNo,
    payment: payResult.payment,
    mockMode: payResult.mockMode
  };
}

// ── 支付成功回调：由 wxPayCore 在订单转为 PAID 时内部触发 ────────────────────
// 🛡️ 鉴权：这个 action 没有 OPENID 上下文（服务端到服务端调用），不能靠身份
// 校验；改为反查 wxPayCore 的 payment_orders 账本，只有 outTradeNo 对应的记录
// 确实是 status:'PAID' 且 bizId 与本次回调一致，才认为这是一次真实的支付成功
// 通知——否则任何知道 bizId 的人都能靠直接调用这个 action 伪造"已支付"，绕开
// 实际付款直接把订阅改成已激活
async function handlePaymentSucceeded(event) {
  const { outTradeNo, bizId } = event;
  if (!outTradeNo || !bizId) {
    console.error('[createSubscriptionOrder] paymentSucceeded 参数缺失:', event);
    return { success: false, error: '参数缺失' };
  }

  let paymentOrder;
  try {
    const res = await db.collection(PAYMENT_ORDERS_COLLECTION).where({ outTradeNo, bizId }).limit(1).get();
    paymentOrder = (res.data && res.data[0]) || null;
  } catch (err) {
    console.error('[createSubscriptionOrder] 查询 payment_orders 失败:', err);
    return { success: false, error: '校验支付状态失败' };
  }

  if (!paymentOrder || paymentOrder.status !== 'PAID') {
    console.error('[createSubscriptionOrder] 拒绝处理：payment_orders 中未找到匹配的 PAID 记录', { outTradeNo, bizId });
    return { success: false, error: '未确认到有效支付记录，拒绝激活' };
  }

  let order;
  try {
    const res = await db.collection(ORDERS_COLLECTION).doc(bizId).get();
    order = res.data;
  } catch (err) {
    console.error('[createSubscriptionOrder] 订单不存在:', bizId, err);
    return { success: false, error: '订单不存在' };
  }

  // 幂等：已处理过的订单直接返回成功，避免 dispatchNotifyHook 异常重试时重复延期
  if (order.status === 'paid') {
    console.log('[createSubscriptionOrder] 订单已处理（幂等跳过）:', bizId);
    return { success: true, alreadyProcessed: true };
  }

  await applySubscriptionPayment(db, order, paymentOrder.transactionId);
  return { success: true };
}

exports.main = async (event) => {
  try {
    if (event.action === 'paymentSucceeded') {
      return await handlePaymentSucceeded(event);
    }
    return await handleCreateOrder(event);
  } catch (err) {
    console.error('[createSubscriptionOrder] 未捕获异常:', err);
    return { success: false, error: '操作失败，请重试' };
  }
};
