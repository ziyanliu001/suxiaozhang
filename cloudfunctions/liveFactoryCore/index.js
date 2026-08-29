// 云函数：liveFactoryCore
// 素食直播产销协同的纯基础设施层——生产批次顺延调度 / 分账快照 / 退款红冲。
// 定位与 wxPayCore 完全同构（见该函数头部注释）：本函数不认识"谁在下单""这个
// tenant 的角色权限规则"，业务方云函数（createProductionOrder/processProductionRefund
// 等）先完成自己的鉴权，再把已核验好的参数交给本函数落地。
//
// 🛡️ 安全边界：所有 action 都是"改数据"操作（占用/释放产能、生成分账、红冲），
// 只信任携带正确 LIVE_FACTORY_INTERNAL_TOKEN 的服务端调用方，与 wxPayCore 的
// requireInternalCaller 同一份写法——fail-closed：未配置或不匹配一律拒绝，
// 令牌已在云开发控制台配置。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const { assignProductionBatch, makeDbReserveFn, makeDbReleaseFn } = require('./lib/scheduling');
const { buildSettlementSnapshot, decideRefundReversal } = require('./lib/settlement');

function requireInternalCaller(event) {
  const expected = process.env.LIVE_FACTORY_INTERNAL_TOKEN || '';
  if (!expected) {
    console.error('[liveFactoryCore] LIVE_FACTORY_INTERNAL_TOKEN 未配置，拒绝所有调用（fail-closed）');
    return false;
  }
  return event.internalToken === expected;
}

// ── action: assignBatch ──────────────────────────────────────────────────
async function handleAssignBatch(event) {
  const { tenantId, productId, dailyCapacityLimit, leadTimeDays, quantity, preferredDate } = event;
  if (!tenantId || !productId || !(dailyCapacityLimit > 0) || !(quantity > 0)) {
    return { success: false, error: '参数缺失: tenantId/productId/dailyCapacityLimit/quantity' };
  }
  const reserveFn = makeDbReserveFn(db, tenantId, productId);
  const result = await assignProductionBatch({
    dailyCapacityLimit,
    leadTimeDays: Number.isFinite(leadTimeDays) ? leadTimeDays : 0,
    quantity,
    orderCreateTime: new Date(),
    reserveFn,
    preferredDate: preferredDate ? String(preferredDate) : undefined
  });
  return result;
}

// ── action: releaseBatchCapacity（退款/取消订单时释放已占用产能）───────────
async function handleReleaseBatchCapacity(event) {
  const { tenantId, productId, batchDate, quantity } = event;
  if (!tenantId || !productId || !batchDate || !(quantity > 0)) {
    return { success: false, error: '参数缺失: tenantId/productId/batchDate/quantity' };
  }
  const releaseFn = makeDbReleaseFn(db, tenantId, productId);
  await releaseFn(batchDate, quantity);
  return { success: true };
}

// ── action: buildSettlement（支付成功后生成分账快照）────────────────────────
async function handleBuildSettlement(event) {
  const { tenantId, orderId, payAmount, producerRate, promoterRate } = event;
  if (!tenantId || !orderId || !(payAmount >= 0)) {
    return { success: false, error: '参数缺失: tenantId/orderId/payAmount' };
  }
  // 幂等：同一 orderId 已生成过快照则直接返回既有记录，避免支付回调重推重复入账
  const existingRes = await db.collection('order_settlements').where({ tenantId, orderId, isReversal: false }).limit(1).get();
  if (existingRes.data && existingRes.data.length > 0) {
    return { success: true, settlement: existingRes.data[0], alreadyExists: true };
  }
  const snapshot = buildSettlementSnapshot({
    tenantId, orderId, payAmount,
    producerRate: Number.isFinite(producerRate) ? producerRate : 0,
    promoterRate: Number.isFinite(promoterRate) ? promoterRate : 0
  });
  const addRes = await db.collection('order_settlements').add({ data: { ...snapshot, createdAt: db.serverDate() } });
  return { success: true, settlement: { _id: addRes._id, ...snapshot } };
}

// ── action: reverseSettlement（退款红冲）────────────────────────────────────
async function handleReverseSettlement(event) {
  const { tenantId, orderId } = event;
  if (!tenantId || !orderId) {
    return { success: false, error: '参数缺失: tenantId/orderId' };
  }
  const settlementRes = await db.collection('order_settlements')
    .where({ tenantId, orderId, isReversal: false }).limit(1).get();
  const settlement = (settlementRes.data && settlementRes.data[0]) || null;
  if (!settlement) {
    return { success: false, error: '未找到该订单的分账记录' };
  }

  const reversalRes = await db.collection('order_settlements')
    .where({ tenantId, orderId, originalSettlementId: settlement._id, isReversal: true }).limit(1).get();
  const reversalAlreadyExists = !!(reversalRes.data && reversalRes.data.length > 0);

  const decision = decideRefundReversal(settlement, reversalAlreadyExists);
  if (decision.action === 'noop') {
    return { success: true, action: 'noop' };
  }
  if (decision.action === 'mark_refunded') {
    await db.collection('order_settlements').doc(settlement._id).update({
      data: { settlementStatus: 'refunded', refundedAt: db.serverDate() }
    });
    return { success: true, action: 'mark_refunded' };
  }
  // create_reversal
  await db.collection('order_settlements').add({ data: { ...decision.reversalDoc, createdAt: db.serverDate() } });
  return { success: true, action: 'create_reversal' };
}

exports.main = async (event, context) => {
  if (!requireInternalCaller(event)) {
    return { success: false, error: '无权限：liveFactoryCore 仅限内部业务云函数调用' };
  }
  switch (event.action) {
    case 'assignBatch': return handleAssignBatch(event);
    case 'releaseBatchCapacity': return handleReleaseBatchCapacity(event);
    case 'buildSettlement': return handleBuildSettlement(event);
    case 'reverseSettlement': return handleReverseSettlement(event);
    default: return { success: false, error: `未知 action: ${event.action}` };
  }
};
