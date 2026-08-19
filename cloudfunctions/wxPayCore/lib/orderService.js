// 订单状态机 + 幂等控制：payment_orders 是本模块名下所有支付订单的唯一真源，
// 与具体业务（订阅/捐赠/…）完全解耦——业务方只需要在下单时传 bizType/bizId/
// notifyFn，剩下的下单-支付-回调-状态流转全部由本模块统一处理，业务方只在
// notifyFn 指定的自己的云函数里接收"这笔订单确实付款成功了"这一个事实。
const cloud = require('wx-server-sdk');

const db = cloud.database();
const _ = db.command;
const ORDERS_COLLECTION = 'payment_orders';

const STATUS = Object.freeze({
  PENDING_PAY: 'PENDING_PAY',
  PAID: 'PAID',
  CLOSED: 'CLOSED',
  REFUNDED: 'REFUNDED'
});

function isCollectionNotExistError(err) {
  return !!err && (
    err.errCode === -502005 ||
    /database collection not exists/i.test(String(err.errMsg || err.message || ''))
  );
}

async function ensureCollection() {
  try {
    await db.collection(ORDERS_COLLECTION).limit(1).get();
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    await db.createCollection(ORDERS_COLLECTION).catch(() => {});
  }
}

function genOutTradeNo() {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `PAY${ts}${rand}`;
}

// 防重复下单：同一 openid + bizType + bizId 若已存在一笔未过期的 PENDING_PAY
// 订单，直接复用它而不是再开一张新单——即便前端的双击防护失效（网络抖动导致
// 用户重试点击），也不会在数据库里产生一堆孤儿订单。10 分钟内视为"未过期"，
// 与 unifiedorder 默认的支付有效期数量级一致。
const REUSE_WINDOW_MS = 10 * 60 * 1000;

async function findReusablePendingOrder({ openid, bizType, bizId }) {
  const res = await db.collection(ORDERS_COLLECTION)
    .where({ openid, bizType, bizId, status: STATUS.PENDING_PAY })
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get()
    .catch(() => ({ data: [] }));
  const order = res.data && res.data[0];
  if (!order) return null;
  const createdAtMs = order.createdAt ? new Date(order.createdAt).getTime() : 0;
  if (Date.now() - createdAtMs > REUSE_WINDOW_MS) return null;
  return order;
}

async function createPendingOrder({ openid, tenantId, bizType, bizId, amount, description, notifyFn, mockMode }) {
  await ensureCollection();

  const reusable = await findReusablePendingOrder({ openid, bizType, bizId });
  if (reusable) return reusable;

  const outTradeNo = genOutTradeNo();
  const data = {
    outTradeNo,
    openid,
    tenantId: tenantId || '',
    bizType,
    bizId: bizId || '',
    amount,
    description,
    notifyFn: notifyFn || '',
    status: STATUS.PENDING_PAY,
    mockMode: !!mockMode,
    prepayId: '',
    transactionId: '',
    createdAt: db.serverDate(),
    updatedAt: db.serverDate()
  };
  const addRes = await db.collection(ORDERS_COLLECTION).add({ data });
  return { ...data, _id: addRes._id };
}

async function attachPrepayId(outTradeNo, prepayId) {
  await db.collection(ORDERS_COLLECTION).where({ outTradeNo }).update({
    data: { prepayId, updatedAt: db.serverDate() }
  });
}

async function getByOutTradeNo(outTradeNo) {
  const res = await db.collection(ORDERS_COLLECTION).where({ outTradeNo }).limit(1).get();
  return (res.data && res.data[0]) || null;
}

// 幂等的"标记为已支付"：用条件更新（CAS）代替"先查再判断再写"，避免真实回调
// 重复推送、或 mock-pay-success 被连点两次时的竞态——两次并发调用只有一次能
// 命中 status:PENDING_PAY 这个前置条件，stats.updated===1 的那次才是"真正
// 触发了一次状态迁移"，只有它需要去调用业务方的 notifyFn。
async function markPaidIdempotent(outTradeNo, transactionId) {
  const res = await db.collection(ORDERS_COLLECTION).where({
    outTradeNo,
    status: STATUS.PENDING_PAY
  }).update({
    data: {
      status: STATUS.PAID,
      transactionId: transactionId || '',
      paidAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });

  const transitioned = res.stats && res.stats.updated === 1;
  const order = await getByOutTradeNo(outTradeNo);
  return { transitioned, order };
}

async function markClosed(outTradeNo, reason) {
  const res = await db.collection(ORDERS_COLLECTION).where({
    outTradeNo,
    status: STATUS.PENDING_PAY
  }).update({
    data: {
      status: STATUS.CLOSED,
      closeReason: reason || '',
      closedAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  return res.stats && res.stats.updated === 1;
}

async function markRefunded(outTradeNo, reason) {
  const res = await db.collection(ORDERS_COLLECTION).where({
    outTradeNo,
    status: STATUS.PAID
  }).update({
    data: {
      status: STATUS.REFUNDED,
      refundReason: reason || '',
      refundedAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  return res.stats && res.stats.updated === 1;
}

// 支付成功后回调业务方：notifyFn 指定的云函数名以 action:'paymentSucceeded' +
// outTradeNo/bizId 被调用。内部仍然不重新抛出异常——订单本身的 PAID 状态已经
// 落库，业务方回调失败属于"下游没接住通知"，不该让上游的支付主流程（尤其是
// 真实微信回调必须尽快返回 200，否则微信会重试轰炸）被拖住。
//
// 🐛 曾经的隐患：这里此前吞掉了两类失败——(a) cloud.callFunction 本身抛异常
// （如目标函数未部署/权限问题），(b) 目标函数正常返回但内部业务逻辑判定失败
// （如 event.result.success === false），第二类此前压根没被检查过，业务方
// 拒绝处理时这里会被当成"调用成功"直接放过。两类失败都只进 console.error，
// 调用方（mockPaySuccess/真实回调）拿不到任何信号，导致"钱已经 PAID、下游
// 业务状态却没同步"这种不一致只能在很久之后被动发现（例如 getProductionBoard
// 看板一直查不到明明已支付的订单）。现在返回 {success, error}，调用方可以
// 把这个信号透出去，出问题时至少不是完全黑箱。
async function dispatchNotifyHook(order) {
  if (!order.notifyFn) return { success: false, error: '订单未配置 notifyFn' };
  try {
    const res = await cloud.callFunction({
      name: order.notifyFn,
      data: { action: 'paymentSucceeded', outTradeNo: order.outTradeNo, bizId: order.bizId, bizType: order.bizType }
    });
    const result = res && res.result;
    if (result && result.success === false) {
      console.error(`[orderService] 业务方云函数 ${order.notifyFn} 拒绝处理支付成功通知:`, result.error);
      return { success: false, error: result.error || '业务方拒绝处理' };
    }
    return { success: true };
  } catch (err) {
    console.error(`[orderService] 通知业务方云函数 ${order.notifyFn} 失败:`, err);
    return { success: false, error: String(err.errMsg || err.message || '调用业务方云函数异常') };
  }
}

module.exports = {
  STATUS,
  ORDERS_COLLECTION,
  createPendingOrder,
  attachPrepayId,
  getByOutTradeNo,
  markPaidIdempotent,
  markClosed,
  markRefunded,
  dispatchNotifyHook
};
