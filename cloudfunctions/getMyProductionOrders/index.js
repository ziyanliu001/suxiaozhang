// 云函数：getMyProductionOrders — 方向 B：买家自查「我的工坊订单」
//
// 🏛️ 全仓库此前没有任何买家自查 production_orders 的入口（getProductionBoard
// 是商家侧履约看板，仅 space_owner/space_admin/producer 可查）。本函数以
// {buyerOpenId: OPENID} 为唯一过滤维度——不按 tenantId 收窄，买家应该看到自己
// 在所有工坊下过的全部订单。这是"以调用者自身身份查自己的数据"，与
// getMyProductionSpaces（查"我自己所属的空间列表"）同一种安全模型，不是新的
// 越权面：不会下发其他买家的 buyerOpenId、不下发商家侧的 producerOpenId/
// 结算费率等敏感字段。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const ORDER_LIMIT = 100;

const STATUS_LABEL = {
  pending_payment: '待支付',
  paid: '已付款 · 待生产',
  in_production: '生产中',
  shipped: '已发货',
  refunded: '已退款',
  failed: '下单失败'
};

// 🆕（我的工坊订单页：下单时间展示）服务端格式化成固定的 YYYY-MM-DD HH:mm，
// 避免前端再处理 db.serverDate() 序列化后的时区/格式问题。createdAt 是
// createProductionOrder 用 db.serverDate() 写入的，经 .get() 取出后已经是
// 可以直接 new Date() 的值
function formatOrderTime(dateVal) {
  if (!dateVal) return '';
  const d = new Date(dateVal);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  try {
    const ordersRes = await db.collection('production_orders')
      .where({ buyerOpenId: OPENID })
      .orderBy('createdAt', 'desc')
      .limit(ORDER_LIMIT)
      .get();
    const orders = ordersRes.data || [];
    if (orders.length === 0) return { success: true, orders: [] };

    const productIds = [...new Set(orders.map((o) => o.productId).filter(Boolean))];
    const tenantIds = [...new Set(orders.map((o) => o.tenantId).filter(Boolean))];
    const orderIds = orders.map((o) => o._id);

    const [productsRes, tenantsRes, contributionsRes] = await Promise.all([
      productIds.length > 0
        ? db.collection('products').where({ _id: _.in(productIds) }).field({ name: true }).get().catch(() => ({ data: [] }))
        : Promise.resolve({ data: [] }),
      // 🐛 tenants 文档 _id 是自动生成的，tenantId 只是业务字段，不能用
      // _.in(tenantIds) 去匹配 _id——按业务字段 tenantId 查
      tenantIds.length > 0
        ? db.collection('tenants').where({ tenantId: _.in(tenantIds) }).field({ tenantId: true, tenantName: true }).get().catch(() => ({ data: [] }))
        : Promise.resolve({ data: [] }),
      // 🌾（护城河一）善行反哺凭据：charity_contributions 已有 orderId 字段，
      // orderIds 已经是"买家自己名下"过滤出来的结果，按 orderId 关联查询天然
      // 安全，不需要额外角色校验，也不新增 manageCharityContribution 的第三种
      // 查询模式（工坊侧/公益侧鉴权模型不适用于裸买家，硬塞进去反而复杂化
      // 那个函数）
      db.collection('charity_contributions')
        .where({ orderId: _.in(orderIds), pledgeStatus: _.neq('cancelled') })
        .get()
        .catch(() => ({ data: [] }))
    ]);

    const productNameMap = {};
    (productsRes.data || []).forEach((p) => { productNameMap[p._id] = p.name || ''; });
    const tenantNameMap = {};
    (tenantsRes.data || []).forEach((t) => { tenantNameMap[t.tenantId] = t.tenantName || '未命名工坊'; });
    const contributionByOrderId = {};
    (contributionsRes.data || []).forEach((c) => { contributionByOrderId[c.orderId] = c; });

    const result = orders.map((o) => {
      const contribution = contributionByOrderId[o._id];
      return {
        orderId: o._id,
        // 🆕（重新下单）productId/tenantId 原样透传——此前只返回派生出的
        // 展示用 productName/workshopName，买家点"重新下单"时需要这两个
        // 原始 ID 才能跳回对应商品的 storefront 页
        productId: o.productId || '',
        tenantId: o.tenantId || '',
        productName: productNameMap[o.productId] || '',
        workshopName: tenantNameMap[o.tenantId] || '未命名工坊',
        quantity: o.quantity || 0,
        payAmountYuan: ((o.payAmount || 0) / 100).toFixed(2),
        orderStatus: o.orderStatus,
        statusLabel: STATUS_LABEL[o.orderStatus] || o.orderStatus,
        // 🆕（订单号/下单时间核对）
        createdAtLabel: formatOrderTime(o.createdAt),
        // 🆕（失败原因）本次修复之前产生的历史失败订单没有这个字段，前端
        // 对空字符串做兜底文案，不编造具体原因
        failReason: o.failReason || '',
        batchDate: o.batchDate || '',
        estimatedShippingDate: o.estimatedShippingDate || '',
        expressCompany: o.expressCompany || '',
        trackingNumber: o.trackingNumber || '',
        appliedTierLevel: o.appliedTierLevel || 0,
        charityContribution: contribution
          ? {
            amountYuan: ((contribution.amount || 0) / 100).toFixed(2),
            pledgeStatus: contribution.pledgeStatus,
            targetStoreName: contribution.targetStoreName || ''
          }
          : null
      };
    });

    return { success: true, orders: result };
  } catch (err) {
    console.error('[getMyProductionOrders] 异常:', err);
    return { success: false, error: err.message || '加载失败' };
  }
};
