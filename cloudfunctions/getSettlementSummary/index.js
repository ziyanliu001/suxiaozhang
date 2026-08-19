// 云函数：getSettlementSummary — Module C：简易对账看板
// 按 tenantId 查 order_settlements 的未结算/已结算净额/未结算即撤销三个汇总
// 桶，外加按订单合并后的明细列表。space_owner/space_admin 看全租户；producer
// 只看自己名下商品（products.producerOpenId）产生的订单分成，不泄露其他
// 制作方/推广人的收益明细。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { bucketSettlements, buildDetailRows } = require('./lib/bucketSettlements');

// 🚨 查 tenant_members 而不是 user_roles：见 createProductionSpace/index.js
// 头部注释——live_factory 成员记录绝不能混进雨花公益专区依赖的 user_roles。
async function verifyTenantAccess(openid, tenantId, requiredRoles) {
  const res = await db.collection('tenant_members')
    .where({ _openid: openid, tenantId, status: 'approved' })
    .get();
  return (res.data || []).find((r) => requiredRoles.includes(r.role)) || null;
}

const EMPTY_RESULT = () => ({ success: true, summary: bucketSettlements([]), details: [] });

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  const tenantId = String(event.tenantId || '');
  if (!tenantId) return { success: false, error: '参数缺失: tenantId' };

  const caller = await verifyTenantAccess(OPENID, tenantId, ['space_owner', 'space_admin', 'producer']);
  if (!caller) return { success: false, error: '无权限：仅空间负责人/管理员/制作方可查看对账' };

  let orderIdFilter = null; // null = 不按 orderId 过滤（owner/admin 看全租户）
  if (caller.role === 'producer') {
    const productsRes = await db.collection('products').where({ tenantId, producerOpenId: OPENID }).get();
    const productIds = (productsRes.data || []).map((p) => p._id);
    if (productIds.length === 0) return EMPTY_RESULT();

    const ordersRes = await db.collection('production_orders').where({ tenantId, productId: _.in(productIds) }).limit(1000).get();
    orderIdFilter = (ordersRes.data || []).map((o) => o._id);
    if (orderIdFilter.length === 0) return EMPTY_RESULT();
  }

  const where = orderIdFilter ? { tenantId, orderId: _.in(orderIdFilter) } : { tenantId };
  const settlementsRes = await db.collection('order_settlements').where(where).limit(1000).get();
  const docs = settlementsRes.data || [];

  const details = buildDetailRows(docs).sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });

  return {
    success: true,
    summary: bucketSettlements(docs),
    details: details.slice(0, 200)
  };
};
