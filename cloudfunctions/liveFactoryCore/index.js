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
// 🛡️ 原子防重复结算：下面这次"查是否已存在 -> 插入"之间仍有并发窗口（真实
// 支付回调网络重推、或 buildSettlement 被并发调用两次），单靠这次查询不足以
// 兜底。改用确定性 _id（同一 tenantId+orderId 永远算出同一个 _id）——即使
// 两次几乎同时的调用都通过了"不存在"检查，数据库对 _id 的唯一性约束也只会
// 让其中一次 add() 成功，另一次会失败；失败后回查该确定性 _id，命中说明是
// 被并发的另一次调用抢先插入，按幂等处理返回既有记录，而不是真失败。
function buildSettlementDocId(tenantId, orderId) {
  return `settle_${tenantId}_${orderId}`;
}

async function handleBuildSettlement(event) {
  const { tenantId, orderId, payAmount, producerRate, promoterRate } = event;
  if (!tenantId || !orderId || !(payAmount >= 0)) {
    return { success: false, error: '参数缺失: tenantId/orderId/payAmount' };
  }
  // 幂等快路径：同一 orderId 已生成过快照则直接返回既有记录，避免支付回调重推
  // 重复入账；这次查询本身有竞态窗口，真正的防重兜底在下面的确定性 _id 上
  const existingRes = await db.collection('order_settlements').where({ tenantId, orderId, isReversal: false }).limit(1).get();
  if (existingRes.data && existingRes.data.length > 0) {
    return { success: true, settlement: existingRes.data[0], alreadyExists: true };
  }
  const snapshot = buildSettlementSnapshot({
    tenantId, orderId, payAmount,
    producerRate: Number.isFinite(producerRate) ? producerRate : 0,
    promoterRate: Number.isFinite(promoterRate) ? promoterRate : 0
  });
  const docId = buildSettlementDocId(tenantId, orderId);
  try {
    await db.collection('order_settlements').add({ data: { _id: docId, ...snapshot, createdAt: db.serverDate() } });
    return { success: true, settlement: { _id: docId, ...snapshot } };
  } catch (err) {
    const raceRes = await db.collection('order_settlements').doc(docId).get().catch(() => null);
    if (raceRes && raceRes.data) {
      return { success: true, settlement: raceRes.data, alreadyExists: true };
    }
    throw err;
  }
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
    // 🛡️ 条件更新防重复：加 settlementStatus:'unsettled' 前置条件做 CAS，
    // 而不是无条件 update——两次并发调用只有一次能真正把状态从 unsettled
    // 撞成 refunded；另一次 stats.updated 会是 0，说明状态已经被别的调用
    // 改变（可能是并发的另一次红冲、也可能是 tryAutoProfitSharing 抢先把它
    // 结算成了 settled），按幂等处理为 noop，不覆盖已经发生的状态迁移。
    // 结算与红冲互相竞速属于既有已知残余风险（见 processProductionRefund
    // 文件头注释），这里只保证"红冲本身不会被重复执行"，不解决跨函数竞速。
    const claimRes = await db.collection('order_settlements').where({
      _id: settlement._id,
      settlementStatus: 'unsettled'
    }).update({ data: { settlementStatus: 'refunded', refundedAt: db.serverDate() } });
    if (!claimRes.stats || claimRes.stats.updated !== 1) {
      return { success: true, action: 'noop' };
    }
    return { success: true, action: 'mark_refunded' };
  }
  // create_reversal：与 buildSettlement 同一套确定性 _id 防重手法——一条原始
  // 结算记录至多对应一条红冲分录，用 originalSettlementId 派生出确定性 _id，
  // 并发的重复红冲请求会撞唯一性约束，失败后回查即可识别为已处理
  const reversalDocId = `settle_reversal_${settlement._id}`;
  try {
    await db.collection('order_settlements').add({ data: { _id: reversalDocId, ...decision.reversalDoc, createdAt: db.serverDate() } });
    return { success: true, action: 'create_reversal' };
  } catch (err) {
    const raceRes = await db.collection('order_settlements').doc(reversalDocId).get().catch(() => null);
    if (raceRes && raceRes.data) {
      return { success: true, action: 'noop' };
    }
    throw err;
  }
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
