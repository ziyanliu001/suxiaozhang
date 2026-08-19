// 云函数：getProductionBoard — Module B：制作看板，按日期区间聚合待生产任务清单与物料估算
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
  const startDate = String(event.startDate || '');
  const endDate = String(event.endDate || '');
  if (!tenantId || !startDate || !endDate) {
    return { success: false, error: '参数缺失: tenantId/startDate/endDate' };
  }

  const caller = await verifyTenantAccess(OPENID, tenantId, ['space_owner', 'space_admin', 'producer']);
  if (!caller) return { success: false, error: '无权限：仅空间负责人/管理员/制作方可查看制作看板' };

  // 只统计已付款、尚未发货完结的订单，按 batchDate+productId 聚合数量
  const ordersRes = await db.collection('production_orders').where({
    tenantId,
    batchDate: _.gte(startDate).and(_.lte(endDate)),
    orderStatus: _.in(['paid', 'in_production'])
  }).limit(1000).get();

  const grouped = {}; // key: `${batchDate}__${productId}` -> { batchDate, productId, quantity }
  (ordersRes.data || []).forEach((o) => {
    const key = `${o.batchDate}__${o.productId}`;
    if (!grouped[key]) grouped[key] = { batchDate: o.batchDate, productId: o.productId, quantity: 0 };
    grouped[key].quantity += o.quantity;
  });
  const tasks = Object.values(grouped).sort((a, b) => a.batchDate.localeCompare(b.batchDate));

  // 物料估算：只对配置了 materialList 的商品估算，未配置的不编造数据
  const productIds = [...new Set(tasks.map((t) => t.productId))];
  const productsRes = productIds.length
    ? await db.collection('products').where({ _id: _.in(productIds) }).get()
    : { data: [] };
  const productMap = {};
  (productsRes.data || []).forEach((p) => { productMap[p._id] = p; });

  const materialTotals = {}; // materialName -> { qty, unit }
  tasks.forEach((t) => {
    const product = productMap[t.productId];
    const materialList = (product && Array.isArray(product.materialList)) ? product.materialList : [];
    materialList.forEach((m) => {
      if (!materialTotals[m.materialName]) materialTotals[m.materialName] = { qty: 0, unit: m.unit || '' };
      materialTotals[m.materialName].qty += (m.qtyPerUnit || 0) * t.quantity;
    });
  });

  // 单笔订单明细：供「排单与发货管理」页逐单标记发货用，与 tasks 的聚合视图
  // 是同一份查询结果的两种展现，不重复查库
  const orders = (ordersRes.data || [])
    .map((o) => ({
      _id: o._id,
      productId: o.productId,
      productName: (productMap[o.productId] || {}).name || '',
      buyerOpenId: o.buyerOpenId,
      quantity: o.quantity,
      payAmount: o.payAmount,
      batchDate: o.batchDate,
      estimatedShippingDate: o.estimatedShippingDate,
      orderStatus: o.orderStatus
    }))
    .sort((a, b) => a.batchDate.localeCompare(b.batchDate));

  return {
    success: true,
    tasks: tasks.map((t) => ({ ...t, productName: (productMap[t.productId] || {}).name || '' })),
    materials: Object.entries(materialTotals).map(([materialName, v]) => ({ materialName, quantity: v.qty, unit: v.unit })),
    orders
  };
};
