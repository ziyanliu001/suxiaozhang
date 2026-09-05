// 退款账本：refund_orders 是本模块名下所有退款尝试的唯一真源，与 payment_orders
// 同级但独立记录——一笔支付订单可能对应多次退款尝试（部分退款场景），用
// 独立集合而不是在 payment_orders 上加字段，避免"一对多"关系被硬塞进一对一字段。
'use strict';

const cloud = require('wx-server-sdk');
const db = cloud.database();
const _ = db.command;
const COLLECTION = 'refund_orders';
const { validateRefundAmount } = require('./refundValidation');
const { ORDERS_COLLECTION } = require('./orderService');

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

// 🛡️ 原子防重复退款：在 payment_orders 主记录上抢占一把"退款处理中"锁——
// 只有抢到锁的调用才能继续走"查重复用 -> 插入新退款记录"这段本身有竞态
// 窗口的逻辑，抢不到直接拒绝（不排队等待），与 orderService.markPaidIdempotent
// 同一套 CAS（条件更新）手法：where 命中 refundLockedAt 不存在才允许更新，
// stats.updated===1 才算真正抢到。锁只在 createPendingRefund 的函数级
// try/finally 内持有，正常退款请求几毫秒就会释放，不影响后续的合法退款
// （包括同一笔支付先后发起的多次部分退款）。
async function acquireRefundLock(outTradeNo) {
  const res = await db.collection(ORDERS_COLLECTION).where({
    outTradeNo,
    refundLockedAt: _.exists(false)
  }).update({ data: { refundLockedAt: db.serverDate() } });
  return !!(res.stats && res.stats.updated === 1);
}

async function releaseRefundLock(outTradeNo) {
  await db.collection(ORDERS_COLLECTION).where({ outTradeNo }).update({
    data: { refundLockedAt: _.remove() }
  }).catch((err) => console.error('[refundService] 释放退款锁失败（需人工核对是否卡死）:', outTradeNo, err));
}

async function createPendingRefund({ outTradeNo, transactionId, tenantId, bizType, bizId, refundAmount, totalAmount, reason, mockMode, notifyFn }) {
  await ensureCollection();

  const reusable = await findReusablePendingRefund({ outTradeNo });
  if (reusable) return reusable;

  const locked = await acquireRefundLock(outTradeNo);
  if (!locked) {
    const err = new Error('该笔支付已有退款正在处理中，请稍后重试，不要重复提交');
    err.code = 'REFUND_IN_PROGRESS';
    throw err;
  }

  try {
    // 抢到锁之后，不会再有并发者能同时插入，这次重新查一遍复用窗口是可信的，
    // 覆盖"两次调用几乎同时到达、都在抢锁前查到过一次'不存在'"的边界情况
    const reusableAfterLock = await findReusablePendingRefund({ outTradeNo });
    if (reusableAfterLock) return reusableAfterLock;

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
  } finally {
    await releaseRefundLock(outTradeNo);
  }
}

async function getByOutRefundNo(outRefundNo) {
  const res = await db.collection(COLLECTION).where({ outRefundNo }).limit(1).get();
  return (res.data && res.data[0]) || null;
}

// 🐛 超额退款修复：此前只统计 status:SUCCESS 的历史退款，同一笔支付如果已有
// 一条 PROCESSING（微信侧尚未回执终态，真实网络场景下可能持续数秒到数分钟）
// 的退款记录，这里会读成 0——若此时发起第二笔退款，两笔金额分别校验都不超额，
// 但合计已经超过原订单实付总额，等于系统性放过了"分批退款、旧的还没到终态
// 就发起新的"这种超额退款场景。改为把 PROCESSING 也计入"已占用额度"，与
// SUCCESS 一起校验，堵住这条口子。
async function getCommittedRefundedTotal(outTradeNo) {
  const res = await db.collection(COLLECTION).where({
    outTradeNo,
    status: _.in([STATUS.SUCCESS, STATUS.PROCESSING])
  }).get();
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
  getCommittedRefundedTotal,
  markRefundStatus,
  dispatchRefundNotifyHook
};
