// 云函数：liveFactorySettlementCron — 护城河三 M2：工坊 T+1 对账定时扫描。
//
// 🏛️ 语义边界（重要，决定了下面的查询条件）：正常分账发生在
// completeProductionOrder 标记"已发货"的那一刻（见该文件头部注释：分账故意
// 推迟到发货，避开"刚付款就退款"导致的分账回退空档）。这意味着"支付后 24
// 小时未结算"完全是正常状态——很多商品的 leadTimeDays 排产周期本来就超过
// 一天，此时订单可能压根还没发货。本 cron 只能扫描"已发货、但发货后满 24
// 小时仍未结算"的记录，这才是真正的"漏网记录"，绝不能按 order_settlements
// 的 createdAt（支付时刻）来判断，否则会把大批正常排产中的订单错误当成异常。
//
// 🌟 T+1 的语义只是"发现漏网记录 + 兜底/提醒"，不是"到点强制结清"：
//   - direct_wechat 模式：补跑一次与 completeProductionOrder 发货时完全相同
//     的自动分账逻辑（tryAutoProfitSharing，本文件内复制维护，两处需同步）。
//     正常流程下发货时就该分账成功，这里只兜底"当时因为网络抖动/分账网关
//     临时故障没有真正触发成功"的记录。
//   - 其余模式（人工/受托对账）：本来就该由人工核实清楚再确认结算
//     （markSettlementsSettled），cron 不会替空间负责人做这个决定，只是按
//     租户聚合待确认笔数/金额，推送一条提醒（24 小时冷却，避免刷屏）。
//
// 🔧 部署要求：
//   - 环境变量 WXPAY_INTERNAL_TOKEN（与 completeProductionOrder/wxPayCore 一致）
//   - 环境变量 SETTLEMENT_REMINDER_TEMPLATE_ID（微信订阅消息"待办提醒"类模板
//     ID，未配置时静默跳过推送，不影响扫描/自动分账本身）
//   - config.json 的定时触发器需要随部署一并生效，本地/手动调用 exports.main
//     只能验证扫描与分账/推送逻辑，无法验证触发时机本身
//
// 🌟 单条订单/单个租户失败不影响其余：任一环节抛错只 console.warn 并继续，
// 与 cronHeartbeatWatcher 同一套"扫描容错"原则。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { buildProfitSharingReceivers } = require('./lib/buildReceivers');
const { buildSettlementReminderPayload } = require('./lib/buildSettlementReminderPayload');

const SHIPPED_GRACE_MS = 24 * 60 * 60 * 1000; // T+1：发货满 24 小时才纳入扫描
const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100;
const BATCH_CAP = 5000;

function isCollectionNotExistError(err) {
  return !!err && (err.errCode === -502005 || /database collection not exists/i.test(String(err.errMsg || err.message || '')));
}

async function fetchOverdueShippedOrders(cutoff) {
  const all = [];
  let skip = 0;
  while (skip < BATCH_CAP) {
    let res;
    try {
      res = await db.collection('production_orders')
        .where({ orderStatus: 'shipped', shippedAt: _.lte(cutoff) })
        .skip(skip).limit(BATCH_SIZE).get();
    } catch (err) {
      if (!isCollectionNotExistError(err)) throw err;
      return all;
    }
    const rows = res.data || [];
    all.push(...rows);
    if (rows.length < BATCH_SIZE) break;
    skip += BATCH_SIZE;
  }
  return all;
}

// 🐛 tenants 文档 _id 是自动生成的，tenantId 只是业务字段（见
// createProductionSpace 的 add() 写法），.doc(tenantId) 永远查不到——同一批
// 订单常常同属一个租户，用 Map 缓存避免对同一 tenantId 重复查询
async function getTenant(tenantId, cache) {
  if (cache.has(tenantId)) return cache.get(tenantId);
  const res = await db.collection('tenants').where({ tenantId }).limit(1).get().catch(() => ({ data: [] }));
  const tenant = (res.data && res.data[0]) || null;
  cache.set(tenantId, tenant);
  return tenant;
}

function isInReminderCooldown(tenant, now) {
  if (!tenant || !tenant.lastSettlementReminderAt) return false;
  const lastMs = new Date(tenant.lastSettlementReminderAt).getTime();
  if (isNaN(lastMs)) return false;
  return now - lastMs < REMINDER_COOLDOWN_MS;
}

// 🏛️ 与 completeProductionOrder/index.js 的 tryAutoProfitSharing 逻辑完全
// 一致（本仓库云函数间无共享模块，各自独立部署，只能复制维护），唯一差异是
// 这里的调用方是定时扫描而非"标记发货"这个动作本身。两处如需改动分账口径，
// 必须同步修改，否则 T+1 兜底会用旧逻辑重新分账。
async function tryAutoProfitSharing({ tenantId, order }) {
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

  // 🛡️ 同款 CAS 领单：见 completeProductionOrder 的 tryAutoProfitSharing 注释
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
    await db.collection('order_settlements').doc(settlement._id).update({
      data: { profitSharingLockedAt: _.remove() }
    }).catch((err) => console.error('[liveFactorySettlementCron] 释放分账占位失败（需人工核对是否卡死）:', settlement._id, err));
    return { attempted: true, success: false, error: share.error || '请求分账失败' };
  }

  const finishRes = await cloud.callFunction({
    name: 'wxPayCore',
    data: { action: 'finishProfitSharing', internalToken, outOrderNo: share.outOrderNo, description: '生产订单分账完结（T+1 兜底）' }
  }).catch((err) => ({ result: { success: false, error: String(err.errMsg || err.message || '分账完结服务异常') } }));
  if (!(finishRes.result || {}).success) {
    console.error('[liveFactorySettlementCron] finishProfitSharing 失败（需人工核对，冻结资金可能未释放）:', order._id, (finishRes.result || {}).error);
  }

  await db.collection('order_settlements').doc(settlement._id).update({
    data: {
      settlementStatus: 'settled', settledAt: db.serverDate(), settledBy: 'system_auto_profit_sharing_t1_cron', profitSharingOutOrderNo: share.outOrderNo,
      profitSharingLockedAt: _.remove()
    }
  });

  return { attempted: true, success: true, outOrderNo: share.outOrderNo, status: share.status };
}

exports.main = async () => {
  const reminderTemplateId = process.env.SETTLEMENT_REMINDER_TEMPLATE_ID || '';
  const now = Date.now();
  const cutoff = new Date(now - SHIPPED_GRACE_MS);
  const orders = await fetchOverdueShippedOrders(cutoff);

  let unsettledFound = 0;
  let autoSettledCount = 0;
  let autoSettleFailedCount = 0;
  let failedCount = 0;
  const tenantCache = new Map();
  // 人工模式（或 direct_wechat 但缺可分账接收方）按 tenantId 聚合，一个租户
  // 一条提醒，而不是每一单一条推送——避免刷屏
  const pendingByTenant = new Map();

  for (const order of orders) {
    try {
      const tenantId = order.tenantId;
      if (!tenantId) continue;

      const settlementRes = await db.collection('order_settlements')
        .where({ tenantId, orderId: order._id, isReversal: false }).limit(1).get();
      const settlement = (settlementRes.data && settlementRes.data[0]) || null;
      if (!settlement || settlement.settlementStatus !== 'unsettled') continue;

      unsettledFound++;
      const tenant = await getTenant(tenantId, tenantCache);
      const paymentMode = tenant && tenant.paymentMode;

      let handledByAutoSharing = false;
      if (paymentMode === 'direct_wechat') {
        const result = await tryAutoProfitSharing({ tenantId, order });
        if (result.success) {
          autoSettledCount++;
          handledByAutoSharing = true;
        } else if (result.attempted) {
          autoSettleFailedCount++;
        }
        // attempted:false 且非"已结算/正被并发处理"的情况（如缺可分账接收方）
        // 仍然需要人工确认，落进待提醒清单，不当作已处理
      }

      if (!handledByAutoSharing) {
        const bucket = pendingByTenant.get(tenantId) || { count: 0, amount: 0 };
        bucket.count += 1;
        bucket.amount += (settlement.producerAmount || 0) + (settlement.promoterAmount || 0);
        pendingByTenant.set(tenantId, bucket);
      }
    } catch (err) {
      failedCount++;
      console.warn('[liveFactorySettlementCron] 单条订单处理失败（不影响其余记录）:', order._id, err);
    }
  }

  let reminderSentCount = 0;
  let reminderSkippedCooldownCount = 0;
  for (const [tenantId, bucket] of pendingByTenant.entries()) {
    try {
      const tenant = tenantCache.get(tenantId);
      if (!tenant) continue;
      if (isInReminderCooldown(tenant, now)) {
        reminderSkippedCooldownCount++;
        continue;
      }
      if (!reminderTemplateId) continue;

      const ownerRes = await db.collection('tenant_members')
        .where({ tenantId, role: 'space_owner', status: 'approved' }).limit(1).get();
      const owner = (ownerRes.data && ownerRes.data[0]) || null;
      if (!owner || !owner._openid) continue;

      const payload = buildSettlementReminderPayload({
        ownerOpenId: owner._openid,
        templateId: reminderTemplateId,
        tenantName: tenant.tenantName || '',
        pendingCount: bucket.count,
        pendingAmountYuan: (bucket.amount / 100).toFixed(2)
      });
      if (!payload) continue;

      await cloud.openapi.subscribeMessage.send(payload);
      await db.collection('tenants').doc(tenant._id).update({
        data: { lastSettlementReminderAt: db.serverDate() }
      });
      reminderSentCount++;
    } catch (err) {
      failedCount++;
      console.warn('[liveFactorySettlementCron] 待确认提醒推送失败（不影响其余租户）:', tenantId, err);
    }
  }

  return {
    success: true,
    scannedOrders: orders.length,
    unsettledFound,
    autoSettledCount,
    autoSettleFailedCount,
    tenantsPendingManualConfirm: pendingByTenant.size,
    reminderSentCount,
    reminderSkippedCooldownCount,
    failedCount,
    reminderTemplateConfigured: !!reminderTemplateId
  };
};
