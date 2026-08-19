// 退款账本：refund_orders 是本模块名下所有退款尝试的唯一真源，与 payment_orders
// 同级但独立记录——一笔支付订单可能对应多次退款尝试（部分退款场景），用
// 独立集合而不是在 payment_orders 上加字段，避免"一对多"关系被硬塞进一对一字段。
'use strict';

const cloud = require('wx-server-sdk');
const db = cloud.database();
const COLLECTION = 'refund_orders';
const { validateRefundAmount } = require('./refundValidation');

const STATUS = Object.freeze({
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
  CLOSED: 'CLOSED',
  ABNORMAL: 'ABNORMAL'
});

function isCollectionNotExistError(err) {
  return !!err && (
    err.errCode === -502005 ||
    /database collection not exists/i.test(String(err.errMsg || err.message || ''))
  );
}

function genOutRefundNo() {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RFD${ts}${rand}`;
}

async function ensureCollection() {
  try {
    await db.collection(COLLECTION).limit(1).get();
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    await db.createCollection(COLLECTION).catch(() => {});
  }
}

const REUSE_WINDOW_MS = 10 * 60 * 1000;

async function findReusablePendingRefund({ outTradeNo }) {
  const res = await db.collection(COLLECTION)
    .where({ outTradeNo, status: STATUS.PROCESSING })
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get()
    .catch(() => ({ data: [] }));
  const record = res.data && res.data[0];
  if (!record) return null;
  const createdAtMs = record.createdAt ? new Date(record.createdAt).getTime() : 0;
  if (Date.now() - createdAtMs > REUSE_WINDOW_MS) return null;
  return record;
}

async function createPendingRefund({ outTradeNo, transactionId, tenantId, bizType, bizId, refundAmount, totalAmount, reason, mockMode, notifyFn }) {
  await ensureCollection();

  const reusable = await findReusablePendingRefund({ outTradeNo });
  if (reusable) return reusable;

  const outRefundNo = genOutRefundNo();
  const data = {
    outRefundNo, outTradeNo,
    transactionId: transactionId || '',
    tenantId: tenantId || '',
    bizType: bizType || '',
    bizId: bizId || '',
    refundAmount, totalAmount,
    reason: reason || '',
    notifyFn: notifyFn || '',
    status: STATUS.PROCESSING,
    mockMode: !!mockMode,
    createdAt: db.serverDate(),
    updatedAt: db.serverDate()
  };
  const addRes = await db.collection(COLLECTION).add({ data });
  return { ...data, _id: addRes._id };
}

async function getByOutRefundNo(outRefundNo) {
  const res = await db.collection(COLLECTION).where({ outRefundNo }).limit(1).get();
  return (res.data && res.data[0]) || null;
}

async function getSuccessfulRefundedTotal(outTradeNo) {
  const res = await db.collection(COLLECTION).where({ outTradeNo, status: STATUS.SUCCESS }).get();
  return (res.data || []).reduce((sum, r) => sum + (r.refundAmount || 0), 0);
}

// 幂等状态迁移：只允许从 PROCESSING 迁到终态，terminal 状态不会被覆盖
// （与 orderService.markPaidIdempotent 同一套 CAS 写法）。
async function markRefundStatus(outRefundNo, status, extra) {
  const res = await db.collection(COLLECTION).where({
    outRefundNo, status: STATUS.PROCESSING
  }).update({
    data: { status, ...(extra || {}), updatedAt: db.serverDate() }
  });
  const transitioned = res.stats && res.stats.updated === 1;
  const record = await getByOutRefundNo(outRefundNo);
  return { transitioned, record };
}

async function dispatchRefundNotifyHook(record) {
  if (!record || !record.notifyFn) return;
  try {
    await cloud.callFunction({
      name: record.notifyFn,
      data: { action: 'refundSucceeded', outTradeNo: record.outTradeNo, outRefundNo: record.outRefundNo, bizId: record.bizId, bizType: record.bizType }
    });
  } catch (err) {
    console.error(`[refundService] 通知业务方云函数 ${record.notifyFn} 失败:`, err);
  }
}

module.exports = {
  STATUS,
  validateRefundAmount,
  createPendingRefund,
  getByOutRefundNo,
  getSuccessfulRefundedTotal,
  markRefundStatus,
  dispatchRefundNotifyHook
};
