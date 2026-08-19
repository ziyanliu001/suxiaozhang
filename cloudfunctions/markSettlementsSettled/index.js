// 云函数：markSettlementsSettled — Module C：agent_settlement/none 模式下，
// 管理员按日/周/月对账后，批量把已线下打款的分账记录标记为 settled。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

async function verifyTenantAccess(openid, tenantId, requiredRoles) {
  const res = await db.collection('user_roles')
    .where({ _openid: openid, tenantId, status: 'approved' })
    .get();
  return (res.data || []).find((r) => requiredRoles.includes(r.role)) || null;
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  const tenantId = String(event.tenantId || '');
  const orderIds = Array.isArray(event.orderIds) ? event.orderIds.filter(Boolean) : [];
  if (!tenantId || orderIds.length === 0) return { success: false, error: '参数缺失: tenantId/orderIds' };
  if (orderIds.length > 200) return { success: false, error: '单次最多标记 200 条' };

  const caller = await verifyTenantAccess(OPENID, tenantId, ['space_owner', 'space_admin']);
  if (!caller) return { success: false, error: '无权限：仅空间负责人/管理员可标记对账结果' };

  const tenantRes = await db.collection('tenants').doc(tenantId).get().catch(() => null);
  const paymentMode = tenantRes && tenantRes.data && tenantRes.data.paymentMode;
  if (paymentMode === 'direct_wechat') {
    return { success: false, error: 'direct_wechat 模式下分账应由微信支付自动划拨，不支持手动标记，请检查自动分账链路' };
  }

  const updateRes = await db.collection('order_settlements').where({
    tenantId, orderId: _.in(orderIds), isReversal: false, settlementStatus: 'unsettled'
  }).update({ data: { settlementStatus: 'settled', settledAt: db.serverDate(), settledBy: OPENID } });

  return { success: true, updatedCount: updateRes.stats.updated };
};
