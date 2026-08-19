// 分账账本：profit_sharing_orders 记录每一次分账请求单及其接收方明细。
'use strict';

const cloud = require('wx-server-sdk');
const db = cloud.database();
const COLLECTION = 'profit_sharing_orders';
const { RECEIVER_TYPES, validateReceivers } = require('./profitSharingValidation');

function isCollectionNotExistError(err) {
  return !!err && (
    err.errCode === -502005 ||
    /database collection not exists/i.test(String(err.errMsg || err.message || ''))
  );
}

function genOutOrderNo() {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `SHR${ts}${rand}`;
}

async function ensureCollection() {
  try {
    await db.collection(COLLECTION).limit(1).get();
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    await db.createCollection(COLLECTION).catch(() => {});
  }
}

async function createPendingShare({ outTradeNo, transactionId, tenantId, bizType, bizId, receivers, mockMode, notifyFn }) {
  await ensureCollection();
  const outOrderNo = genOutOrderNo();
  const data = {
    outOrderNo, outTradeNo,
    transactionId: transactionId || '',
    tenantId: tenantId || '',
    bizType: bizType || '',
    bizId: bizId || '',
    receivers,
    notifyFn: notifyFn || '',
    status: 'PROCESSING',
    mockMode: !!mockMode,
    createdAt: db.serverDate(),
    updatedAt: db.serverDate()
  };
  const addRes = await db.collection(COLLECTION).add({ data });
  return { ...data, _id: addRes._id };
}

async function getByOutOrderNo(outOrderNo) {
  const res = await db.collection(COLLECTION).where({ outOrderNo }).limit(1).get();
  return (res.data && res.data[0]) || null;
}

async function markShareStatus(outOrderNo, status, extra) {
  await db.collection(COLLECTION).where({ outOrderNo }).update({
    data: { status, ...(extra || {}), updatedAt: db.serverDate() }
  });
  return getByOutOrderNo(outOrderNo);
}

module.exports = {
  RECEIVER_TYPES,
  validateReceivers,
  createPendingShare,
  getByOutOrderNo,
  markShareStatus
};
