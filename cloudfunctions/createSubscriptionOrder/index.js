// 云函数：createSubscriptionOrder
// 微信云开发原生支付统一下单：为调用者当前租户创建订阅订单，返回小程序端
// 拉起 wx.requestPayment 所需的 payment 参数对象。
//
// 入参（event）：
//   planType: string  套餐类型，目前支持 'ADVANCED_YEARLY'（专业版年度订阅）
//
// 安全边界：tenantId 从服务端 OPENID 反查 user_roles 获取，不信任客户端传参
// （与 activateTenantSubscription 同一防线）；权限校验仅允许 super_admin /
// store_patriarch 发起订购。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// ── 套餐价格与元数据 ────────────────────────────────────────────────────────
// totalFee 单位：分（人民币）；planType 对应 tenant_subscriptions 集合的字段值
const PLAN_CONFIG = {
  ADVANCED_YEARLY: {
    totalFee: 29800,           // 298.00 元
    planType: 'pro',
    durationDays: 365,
    body: '雨花助手专业版年度订阅'
  }
};

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

  // 1. 校验套餐类型
  const planKey = event.planType || 'ADVANCED_YEARLY';
  const planCfg = PLAN_CONFIG[planKey];
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
    planType: planCfg.planType,
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
