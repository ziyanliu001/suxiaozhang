// 云函数：payCallback
// 微信支付异步通知回调——支付成功后由微信平台主动 POST 至此函数，
// 签名验证由云开发统一处理，本函数只需处理业务层逻辑：
//
//   1. 查询对应的 subscription_orders 记录（获取 tenantId / planType / durationDays）
//   2. 更新 tenant_subscriptions（订阅数据唯一真源，与 activateTenantSubscription 同一张表）
//   3. 同步更新 tenants 集合（status / subscriptionStatus / expiresAt）
//   4. 将订单状态标记为 paid
//
// 🛡️ 幂等保证：订单状态已为 paid 时直接返回成功，避免微信重复推送时多次延期。
// 🚫 本函数不可被前端直接调用——入口仅限微信支付服务器的回调推送。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const ORDERS_COLLECTION = 'subscription_orders';
const TENANT_SUB_COLLECTION = 'tenant_subscriptions';

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function isCollectionNotExistError(err) {
  return !!err && (
    err.errCode === -502005 ||
    /database collection not exists/i.test(String(err.errMsg || err.message || ''))
  );
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDaysToDateStr(dateStr, days) {
  let base = dateStr ? new Date(dateStr) : new Date();
  if (Number.isNaN(base.getTime())) base = new Date();
  base.setDate(base.getDate() + days);
  const y = base.getFullYear();
  const m = String(base.getMonth() + 1).padStart(2, '0');
  const day = String(base.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 套餐档位排序：只升不降（已是 enterprise 的租户用 pro 订单续费时保持 enterprise）
const PLAN_RANK = { basic: 0, pro: 1, enterprise: 2 };
// 🏛️ 「方案一：按机构维度统一授权与门店配额管理」——与 checkTenantPermission/
// createStore/activateTenantSubscription/manageTenantSubscription 同一份拷贝
const PLAN_STORE_LIMITS = { basic: 2, pro: 10, enterprise: 30 };

// ── 主函数 ────────────────────────────────────────────────────────────────────
exports.main = async (event) => {
  // 云开发支付回调 event 字段说明：
  //   ResultCode    - 'SUCCESS' 表示支付成功；其他值为失败/关单/退款
  //   OutTradeNo    - 商户订单号（与 createSubscriptionOrder 写入的 outTradeNo 一致）
  //   TransactionId - 微信支付交易流水号
  const { ResultCode, OutTradeNo, TransactionId } = event;

  console.log('[payCallback] 收到支付回调:', { ResultCode, OutTradeNo, TransactionId });

  // 非 SUCCESS 通知（用户取消、关单、退款等）直接返回 ok，不做业务处理
  if (ResultCode !== 'SUCCESS') {
    console.log('[payCallback] 非支付成功通知，忽略:', ResultCode);
    return { errcode: 0, errmsg: 'ok' };
  }

  if (!OutTradeNo) {
    console.error('[payCallback] OutTradeNo 缺失，忽略本次回调');
    return { errcode: 0, errmsg: 'ok' };
  }

  // ── Step 1：查询订单，获取 tenantId / planType / durationDays ──────────────
  let order;
  try {
    const res = await db.collection(ORDERS_COLLECTION)
      .where({ outTradeNo: OutTradeNo })
      .limit(1)
      .get();
    order = (res.data && res.data[0]) || null;
  } catch (err) {
    console.error('[payCallback] 查询订单失败:', err);
    // 即使查询失败，也要返回 ok 让微信不再重试（业务告警应通过日志监控）
    return { errcode: 0, errmsg: 'ok' };
  }

  if (!order) {
    console.error('[payCallback] 订单不存在，OutTradeNo=', OutTradeNo);
    return { errcode: 0, errmsg: 'ok' };
  }

  // 幂等保护：已 paid 的订单跳过
  if (order.status === 'paid') {
    console.log('[payCallback] 订单已处理（幂等跳过）:', OutTradeNo);
    return { errcode: 0, errmsg: 'ok' };
  }

  const { tenantId, planType, durationDays, isAddOn, extraStores } = order;
  if (!tenantId || (!planType && !isAddOn)) {
    console.error('[payCallback] 订单数据不完整:', { tenantId, planType, isAddOn, OutTradeNo });
    return { errcode: 0, errmsg: 'ok' };
  }

  // ── Step 2：更新 tenant_subscriptions（订阅数据唯一真源）──────────────────
  const today = todayStr();
  let existing = null;
  try {
    const subRes = await db.collection(TENANT_SUB_COLLECTION)
      .where({ tenantId })
      .orderBy('lastRenewedAt', 'desc')
      .limit(1)
      .get();
    existing = (subRes.data && subRes.data[0]) || null;
  } catch (err) {
    if (!isCollectionNotExistError(err)) {
      console.error('[payCallback] 查询订阅记录失败:', err);
    }
    // existing 为 null 则后续走新增分支
  }

  // 🏢 扩容门店包订单：只累加 max_stores_limit（cloudQuota.storeLimit），
  // 完全不碰 planType/serviceExpireDate——与 activateTenantSubscription 的
  // add_on 兑换分支同一条业务逻辑，两条入口（微信支付 / 授权码）殊途同归
  let finalPlanType;
  let newExpireDate;
  if (isAddOn) {
    const safeExtraStores = (Number.isFinite(extraStores) && extraStores > 0) ? extraStores : 1;
    const baseStoreLimit = existing
      ? ((existing.cloudQuota && existing.cloudQuota.storeLimit) || PLAN_STORE_LIMITS[existing.planType] || PLAN_STORE_LIMITS.basic)
      : PLAN_STORE_LIMITS.basic;
    const finalStoreLimit = baseStoreLimit + safeExtraStores;
    finalPlanType = existing ? existing.planType : 'basic';
    newExpireDate = existing ? existing.serviceExpireDate : null;

    const addOnEntry = {
      operatorId: 'WX_PAY',
      operateTime: db.serverDate(),
      fromExpireDate: existing ? (existing.serviceExpireDate || null) : null,
      toExpireDate: newExpireDate,
      reason: `微信支付成功激活扩容门店包（+${safeExtraStores} 家），订单号：${OutTradeNo}`
    };

    try {
      if (existing) {
        await db.collection(TENANT_SUB_COLLECTION).doc(existing._id).update({
          data: {
            status: 'active',
            lastRenewedAt: db.serverDate(),
            renewalHistory: _.push(addOnEntry),
            cloudQuota: { ...(existing.cloudQuota || {}), storeLimit: finalStoreLimit }
          }
        });
      } else {
        const newSubData = {
          tenantId,
          planType: 'basic',
          serviceStartDate: today,
          serviceExpireDate: null,
          cloudQuota: { storeLimit: finalStoreLimit },
          status: 'active',
          lastRenewedAt: db.serverDate(),
          renewalHistory: [addOnEntry]
        };
        try {
          await db.collection(TENANT_SUB_COLLECTION).add({ data: newSubData });
        } catch (err) {
          if (!isCollectionNotExistError(err)) throw err;
          await db.createCollection(TENANT_SUB_COLLECTION).catch(() => {});
          await db.collection(TENANT_SUB_COLLECTION).add({ data: newSubData });
        }
      }
    } catch (err) {
      console.error('[payCallback] 更新 tenant_subscriptions（扩容包）失败:', err);
      return { errcode: 0, errmsg: 'ok' };
    }
  } else {
    // 续期不清零：未到期时从现有到期日顺延，避免提前续费白白损失剩余天数
    const existingExpire = existing && existing.serviceExpireDate;
    const existingStillValid = !!existingExpire && new Date(existingExpire).getTime() > Date.now();
    const baseDate = existingStillValid ? existingExpire : today;
    const safeDurationDays = (Number.isFinite(durationDays) && durationDays > 0) ? durationDays : 365;
    newExpireDate = addDaysToDateStr(baseDate, safeDurationDays);

    // 只升不降：已是 enterprise 时用 pro 续费仍保持 enterprise
    const existingPlanRank = existing ? (PLAN_RANK[existing.planType] || 0) : 0;
    const incomingPlanRank = PLAN_RANK[planType] || 0;
    finalPlanType = incomingPlanRank >= existingPlanRank ? planType : (existing.planType || planType);

    // 🐛 同步收敛门店配额：与 activateTenantSubscription 的 handleRedeem 同一条
    // "只升不降"口径——取"该档位的默认配额"与"机构此前已有的配额"两者较大值，
    // 不能无条件按套餐默认值覆盖，否则会抹掉此前通过扩容包购买的额外门店名额
    const existingStoreLimit = (existing && existing.cloudQuota && existing.cloudQuota.storeLimit) || 0;
    const planDefaultStoreLimit = PLAN_STORE_LIMITS[finalPlanType] || PLAN_STORE_LIMITS.basic;
    const finalStoreLimit = Math.max(existingStoreLimit, planDefaultStoreLimit);

    const renewalEntry = {
      operatorId: 'WX_PAY',
      operateTime: db.serverDate(),
      fromExpireDate: existing ? (existing.serviceExpireDate || null) : null,
      toExpireDate: newExpireDate,
      reason: `微信支付成功激活，订单号：${OutTradeNo}`
    };

    try {
      if (existing) {
        await db.collection(TENANT_SUB_COLLECTION).doc(existing._id).update({
          data: {
            planType: finalPlanType,
            serviceExpireDate: newExpireDate,
            serviceStartDate: existing.serviceStartDate || today,
            status: 'active',
            lastRenewedAt: db.serverDate(),
            renewalHistory: _.push(renewalEntry),
            cloudQuota: { ...(existing.cloudQuota || {}), storeLimit: finalStoreLimit }
          }
        });
      } else {
        const newSubData = {
          tenantId,
          planType: finalPlanType,
          serviceStartDate: today,
          serviceExpireDate: newExpireDate,
          cloudQuota: { storeLimit: finalStoreLimit },
          status: 'active',
          lastRenewedAt: db.serverDate(),
          renewalHistory: [renewalEntry]
        };
        try {
          await db.collection(TENANT_SUB_COLLECTION).add({ data: newSubData });
        } catch (err) {
          if (!isCollectionNotExistError(err)) throw err;
          await db.createCollection(TENANT_SUB_COLLECTION).catch(() => {});
          await db.collection(TENANT_SUB_COLLECTION).add({ data: newSubData });
        }
      }
    } catch (err) {
      console.error('[payCallback] 更新 tenant_subscriptions 失败:', err);
      // 记录失败但仍返回 ok，避免微信无限重试；告警应通过日志监控触达
      return { errcode: 0, errmsg: 'ok' };
    }
  }

  // ── Step 3：同步更新 tenants 集合 ─────────────────────────────────────────
  // subscriptionStatus / expiresAt 是在 tenants 文档上额外记录的副本字段，
  // 便于运营后台快速查看；tenant_subscriptions 才是权限鉴权的唯一真源。
  try {
    await db.collection('tenants').doc(tenantId).update({
      data: {
        status: 'active',
        subscriptionStatus: 'active',
        expiresAt: newExpireDate
      }
    });
  } catch (err) {
    // 非致命：tenants 更新失败不影响 checkTenantPermission 的权限判断（走 tenant_subscriptions）
    console.warn('[payCallback] 更新 tenants 状态失败（非致命）:', err);
  }

  // ── Step 4：标记订单为 paid ───────────────────────────────────────────────
  try {
    await db.collection(ORDERS_COLLECTION).doc(order._id).update({
      data: {
        status: 'paid',
        paidAt: db.serverDate(),
        transactionId: TransactionId || '',
        finalPlanType,
        newExpireDate
      }
    });
  } catch (err) {
    console.warn('[payCallback] 标记订单 paid 失败（非致命）:', err);
  }

  console.log('[payCallback] 订阅激活完成:', { tenantId, finalPlanType, newExpireDate, OutTradeNo });
  return { errcode: 0, errmsg: 'ok' };
};
