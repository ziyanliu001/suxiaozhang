// 云函数：createSubscriptionOrder
// 微信云开发原生支付统一下单：为调用者当前租户创建订阅订单，返回小程序端
// 拉起 wx.requestPayment 所需的 payment 参数对象。
//
// 入参（event）：
//   planType: string  套餐类型，支持 'PRO_YEARLY'（专业版年度订阅）/
//                      'FLAGSHIP_YEARLY'（旗舰版年度订阅）/ 'ADD_ON_STORE'
//                      （扩容门店包，按 quantity 家/年计费）
//   quantity: number  仅 ADD_ON_STORE 生效，购买的扩容门店数量，默认 1
//
// 安全边界：tenantId 从服务端 OPENID 反查 user_roles 获取，不信任客户端传参
// （与 activateTenantSubscription 同一防线）；权限校验仅允许 super_admin /
// store_patriarch 发起订购。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

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
// 扩容门店包：不是"套餐"，是独立的门店配额加购项——unitFee 为单店/年单价，
// 下单时按 quantity 叠加总价，payCallback 那边据此只增配额、不动 planType/到期日
const ADD_ON_STORE_CONFIG = {
  unitFee: 20000,              // 200.00 元 / 店 / 年
  durationDays: 365,
  bodyPrefix: '雨花助手门店扩容包'
};
const MAX_ADD_ON_QUANTITY = 20;

// 订单暂存集合：payCallback 通过 outTradeNo 反查此集合以获取 tenantId / planType
const ORDERS_COLLECTION = 'subscription_orders';

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function isCollectionNotExistError(err) {
  return !!err && (
    err.errCode === -502005 ||
    /database collection not exists/i.test(String(err.errMsg || err.message || ''))
  );
}

// outTradeNo 格式：SUBSYH + 毫秒时间戳 + 6 位随机字母数字
// 总长度约 24 位，满足微信支付"商户订单号不超过 32 位"要求
function genOutTradeNo() {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `SUBSYH${ts}${rand}`;
}

// ── 主函数 ────────────────────────────────────────────────────────────────────
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  // 1. 校验套餐类型：ADD_ON_STORE 走独立分支（不在 PLAN_CONFIG 里，元数据/
  // 总价计算方式与常规套餐订单不同——按 quantity 家门店 × 单价计费）
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

  // 2. 从服务端反查调用者的 tenantId 与角色权限
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

  // 3. 生成唯一订单号并写入 subscription_orders（payCallback 凭此反查 tenantId）
  const outTradeNo = genOutTradeNo();
  const orderData = {
    outTradeNo,
    tenantId,
    // 🏢 扩容门店包订单不带 planType（payCallback 据此分流：isAddOn 时只加
    // 门店配额，不触碰 tenant_subscriptions.planType/serviceExpireDate）
    ...(isAddOn ? { isAddOn: true, extraStores: addOnQuantity } : { planType: planCfg.planType }),
    durationDays: planCfg.durationDays,
    totalFee: planCfg.totalFee,
    status: 'pending',
    createdBy: OPENID,
    createdAt: db.serverDate()
  };

  try {
    await db.collection(ORDERS_COLLECTION).add({ data: orderData });
  } catch (err) {
    if (isCollectionNotExistError(err)) {
      await db.createCollection(ORDERS_COLLECTION).catch(() => {});
      await db.collection(ORDERS_COLLECTION).add({ data: orderData });
    } else {
      console.error('[createSubscriptionOrder] 写入订单记录失败:', err);
      return { success: false, error: '创建订单失败，请重试' };
    }
  }

  // 4. 调用微信云开发统一下单接口
  // 🔧 subMchId：商户号需在微信开发者工具→云开发控制台→微信支付中绑定并确认，
  //    云环境绑定后通常无需在代码里显式传入，保留空串以兼容子商户模式
  // 🛡️ 防御：cloud.pay 仅在云环境已绑定微信支付时才存在；未配置时直接返回
  //    友好错误，避免 TypeError 穿透到前端显示为乱码
  if (!cloud.pay || typeof cloud.pay.unifiedorder !== 'function') {
    await db.collection(ORDERS_COLLECTION)
      .where({ outTradeNo })
      .update({
        data: {
          status: 'failed',
          failedAt: db.serverDate(),
          failReason: '微信支付服务未在当前云环境开通'
        }
      })
      .catch(() => {});
    return {
      success: false,
      error: '当前环境暂未开通微信支付，请使用授权码兑换或联系大家长',
      paymentNotConfigured: true
    };
  }

  try {
    const orderResult = await cloud.pay.unifiedorder({
      body: planCfg.body,
      outTradeNo,
      spbillCreateIp: '127.0.0.1',
      subMchId: '',           // 若使用子商户模式，在此填写子商户号
      totalFee: planCfg.totalFee,
      envId: cloud.DYNAMIC_CURRENT_ENV,
      functionName: 'payCallback',  // 支付结果回调云函数名
      openId: OPENID                // JSAPI 支付必传
    });

    console.log('[createSubscriptionOrder] 统一下单成功:', { outTradeNo, tenantId, planKey });
    return {
      success: true,
      outTradeNo,
      payment: orderResult.payment
    };
  } catch (err) {
    console.error('[createSubscriptionOrder] 统一下单失败:', err);
    // 下单失败时将订单标记为 failed，避免遗留脏数据
    await db.collection(ORDERS_COLLECTION)
      .where({ outTradeNo })
      .update({
        data: {
          status: 'failed',
          failedAt: db.serverDate(),
          failReason: String(err.errMsg || err.message || '统一下单接口异常')
        }
      })
      .catch(() => {});
    return {
      success: false,
      error: `支付下单失败：${err.errMsg || err.message || '请重试'}`
    };
  }
};
