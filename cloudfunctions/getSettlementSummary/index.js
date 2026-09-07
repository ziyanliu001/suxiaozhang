// 云函数：getSettlementSummary — Module C：简易对账看板 + 运营简报
// 按 tenantId 查 order_settlements 的未结算/已结算净额/未结算即撤销三个汇总
// 桶，外加按订单合并后的明细列表，以及近 7 天/近 30 天的出货运营简报
// （opsStats）。space_owner/space_admin 看全租户；producer 只看自己名下
// 商品（products.producerOpenId）产生的订单分成，不泄露其他制作方/推广人
// 的收益明细。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { bucketSettlements, buildDetailRows } = require('./lib/bucketSettlements');
const { computeOpsStats, emptyStats } = require('./lib/computeOpsStats');

// 🚨 查 tenant_members 而不是 user_roles：见 createProductionSpace/index.js
// 头部注释——live_factory 成员记录绝不能混进雨花公益专区依赖的 user_roles。
async function verifyTenantAccess(openid, tenantId, requiredRoles) {
  const res = await db.collection('tenant_members')
    .where({ _openid: openid, tenantId, status: 'approved' })
    .get();
  return (res.data || []).find((r) => requiredRoles.includes(r.role)) || null;
}

const EMPTY_RESULT = () => ({
  success: true,
  summary: bucketSettlements([]),
  details: [],
  opsStats: { last7: emptyStats(), last30: emptyStats() }
});

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  const tenantId = String(event.tenantId || '');
  if (!tenantId) return { success: false, error: '参数缺失: tenantId' };

  const caller = await verifyTenantAccess(OPENID, tenantId, ['space_owner', 'space_admin', 'producer']);
  if (!caller) return { success: false, error: '无权限：仅空间负责人/管理员/制作方可查看对账' };

  // 🌟（护城河三 M2）settlement-summary 页"批量确认结算"入口只应该在
  // direct_wechat 模式之外展示——该模式下分账由微信支付自动划拨
  // （tryAutoProfitSharing），手动标记会被 markSettlementsSettled 直接拒绝
  // （见该云函数注释）。与三桶汇总同一次调用一并下发，前端不用再多打一次
  // 云函数请求去单独查 paymentMode
  const tenantRes = await db.collection('tenants').where({ tenantId }).limit(1).get().catch(() => ({ data: [] }));
  const paymentMode = (tenantRes.data && tenantRes.data[0] && tenantRes.data[0].paymentMode) || 'none';

  // 🌟（护城河一 M1）累计转捐额度：与三桶结算汇总同一次调用一并下发，供
  // settlement-summary 页展示"已转捐给公益厨房 ¥X"。转捐是 space_owner/
  // space_admin 的动作（见 manageCharityContribution.pledge 权限校验），
  // 与下方 producer 视角的 productIdFilter 收窄无关，统一按 tenantId 全量
  // 口径展示——producer 本来就看不到、也不需要看到转捐信息之外的其他人的
  // 分成明细，但"整个租户捐了多少"这个数字对所有能看对账页的角色都一样
  const charityRes = await db.collection('charity_contributions')
    .where({ tenantId, pledgeStatus: _.neq('cancelled') })
    .field({ amount: true })
    .limit(1000)
    .get()
    .catch(() => ({ data: [] }));
  const charityPledgedTotal = (charityRes.data || []).reduce((sum, c) => sum + (c.amount || 0), 0);

  let productIdFilter = null; // null = 不按商品过滤（owner/admin 看全租户）
  if (caller.role === 'producer') {
    const productsRes = await db.collection('products').where({ tenantId, producerOpenId: OPENID }).get();
    productIdFilter = (productsRes.data || []).map((p) => p._id);
    if (productIdFilter.length === 0) return { ...EMPTY_RESULT(), charityPledgedTotal, paymentMode };
  }

  // 🔑 production_orders 是 opsStats（出货单量/份数）与 order_settlements 查询
  // 范围（orderId 过滤）共用的同一份底层数据，只查一次
  const ordersWhere = productIdFilter ? { tenantId, productId: _.in(productIdFilter) } : { tenantId };
  const ordersRes = await db.collection('production_orders').where(ordersWhere).limit(1000).get();
  const orders = ordersRes.data || [];
  if (orders.length === 0) return { ...EMPTY_RESULT(), charityPledgedTotal, paymentMode };

  const orderIds = orders.map((o) => o._id);
  const settlementsRes = await db.collection('order_settlements').where({ tenantId, orderId: _.in(orderIds) }).limit(1000).get();
  const docs = settlementsRes.data || [];

  const details = buildDetailRows(docs).sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });

  const settlementByOrderId = {};
  details.forEach((row) => { settlementByOrderId[row.orderId] = row; });

  const shippedOrders = orders.filter((o) => o.orderStatus === 'shipped');
  const now = new Date();
  const opsStats = {
    last7: computeOpsStats(shippedOrders, settlementByOrderId, now, 7),
    last30: computeOpsStats(shippedOrders, settlementByOrderId, now, 30)
  };

  return {
    success: true,
    summary: bucketSettlements(docs),
    details: details.slice(0, 200),
    opsStats,
    charityPledgedTotal,
    paymentMode
  };
};
