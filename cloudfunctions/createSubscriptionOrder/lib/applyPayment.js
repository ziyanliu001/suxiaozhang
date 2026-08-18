// 支付成功后的订阅激活逻辑：从 cloudfunctions/payCallback/index.js 原样迁移过来
// （Step 2/3/4 的业务规则完全不变——续期不清零/只升不降/门店配额只升不降），
// 唯一变化是触发方式：此前由微信云开发原生支付（cloud.pay）在支付成功后直接
// 调用 payCallback 云函数；现在由 wxPayCore 统一处理 APIv3 下单/回调后，通过
// notifyFn 回调本函数（见 index.js 的 action: 'paymentSucceeded'），本模块只是
// 把"付成功了具体该怎么改 tenant_subscriptions/tenants"这部分业务逻辑原地保留。
const TENANT_SUB_COLLECTION = 'tenant_subscriptions';

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

// order: subscription_orders 文档（tenantId/planType/durationDays/isAddOn/extraStores/outTradeNo）
// transactionId: 微信支付交易流水号（Mock 模式下是 wxPayCore 生成的 MOCK_TXN_ 前缀值）
async function applySubscriptionPayment(db, order, transactionId) {
  const _ = db.command;
  const { tenantId, planType, durationDays, isAddOn, extraStores, outTradeNo } = order;

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
      console.error('[applySubscriptionPayment] 查询订阅记录失败:', err);
    }
  }

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
      reason: `微信支付成功激活扩容门店包（+${safeExtraStores} 家），订单号：${outTradeNo}`
    };

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
  } else {
    const existingExpire = existing && existing.serviceExpireDate;
    const existingStillValid = !!existingExpire && new Date(existingExpire).getTime() > Date.now();
    const baseDate = existingStillValid ? existingExpire : today;
    const safeDurationDays = (Number.isFinite(durationDays) && durationDays > 0) ? durationDays : 365;
    newExpireDate = addDaysToDateStr(baseDate, safeDurationDays);

    const existingPlanRank = existing ? (PLAN_RANK[existing.planType] || 0) : 0;
    const incomingPlanRank = PLAN_RANK[planType] || 0;
    finalPlanType = incomingPlanRank >= existingPlanRank ? planType : (existing.planType || planType);

    const existingStoreLimit = (existing && existing.cloudQuota && existing.cloudQuota.storeLimit) || 0;
    const planDefaultStoreLimit = PLAN_STORE_LIMITS[finalPlanType] || PLAN_STORE_LIMITS.basic;
    const finalStoreLimit = Math.max(existingStoreLimit, planDefaultStoreLimit);

    const renewalEntry = {
      operatorId: 'WX_PAY',
      operateTime: db.serverDate(),
      fromExpireDate: existing ? (existing.serviceExpireDate || null) : null,
      toExpireDate: newExpireDate,
      reason: `微信支付成功激活，订单号：${outTradeNo}`
    };

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
  }

  await db.collection('tenants').doc(tenantId).update({
    data: { status: 'active', subscriptionStatus: 'active', expiresAt: newExpireDate }
  }).catch((err) => {
    console.warn('[applySubscriptionPayment] 更新 tenants 状态失败（非致命）:', err);
  });

  await db.collection('subscription_orders').doc(order._id).update({
    data: {
      status: 'paid',
      paidAt: db.serverDate(),
      transactionId: transactionId || '',
      finalPlanType,
      newExpireDate
    }
  }).catch((err) => {
    console.warn('[applySubscriptionPayment] 标记订单 paid 失败（非致命）:', err);
  });

  console.log('[applySubscriptionPayment] 订阅激活完成:', { tenantId, finalPlanType, newExpireDate, outTradeNo });
  return { finalPlanType, newExpireDate };
}

module.exports = { applySubscriptionPayment };
