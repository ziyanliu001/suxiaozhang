// 云函数：getProductionBoard — Module B：制作看板，按日期区间聚合待生产任务清单与物料估算
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 🚨 查 tenant_members 而不是 user_roles：见 createProductionSpace/index.js
// 头部注释——live_factory 成员记录绝不能混进雨花公益专区依赖的 user_roles。
async function verifyTenantAccess(openid, tenantId, requiredRoles) {
  const res = await db.collection('tenant_members')
    .where({ _openid: openid, tenantId, status: 'approved' })
    .get();
  return (res.data || []).find((r) => requiredRoles.includes(r.role)) || null;
}

// 🐛 自愈：wxPayCore 支付成功后靠 dispatchNotifyHook 回调 createProductionOrder
// 把 production_orders.orderStatus 从 'pending_payment' 翻成 'paid'——此前这条
// 通知一旦失败会被静默吞掉且几乎无法重试（见 wxPayCore/lib/orderService.js
// 头部注释，已在同一轮修复），会导致"钱明明已经 PAID、production_orders 却
// 卡在 pending_payment"，看板查询按 orderStatus 过滤自然什么都查不到。这里
// 在看板查询前做一次轻量自愈：找出本租户还卡在 pending_payment、但已经拿到
// outTradeNo 的订单，重放一次 createProductionOrder 自己的 paymentSucceeded
// 处理（该处理本身幂等、会反查 payment_orders 确认真的 PAID 才生效，不是
// 无条件强推），修复历史遗留的卡单，不需要额外的人工介入或专门的运维脚本。
//
// 返回实际 healedCount 供前端展示"系统自动修复了 N 笔卡单"提示——只统计真正
// 由本次调用翻转成功的订单（result.success 且非 alreadyProcessed），跳过反查
// 未确认到 PAID 记录、本来就不该被激活的订单，避免把"买家其实没付款成功"
// 误报成"已修复"。
async function reconcileStuckOrders(tenantId) {
  const pendingRes = await db.collection('production_orders')
    .where({ tenantId, orderStatus: 'pending_payment' })
    .limit(50)
    .get()
    .catch(() => ({ data: [] }));

  const stuck = (pendingRes.data || []).filter((o) => !!o.outTradeNo);
  if (stuck.length === 0) return { healedCount: 0 };

  const outcomes = await Promise.all(stuck.map((o) =>
    cloud.callFunction({
      name: 'createProductionOrder',
      data: { action: 'paymentSucceeded', outTradeNo: o.outTradeNo, bizId: o._id }
    })
      .then((res) => !!(res.result && res.result.success && !res.result.alreadyProcessed))
      .catch((err) => {
        console.error('[getProductionBoard] 自愈重放 paymentSucceeded 失败:', o._id, err);
        return false;
      })
  ));
  return { healedCount: outcomes.filter(Boolean).length };
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

  const { healedCount } = await reconcileStuckOrders(tenantId);

  // 🎯 看板需要展示完整履约链路（待生产 → 生产中 → 已发货 → 已退款），不再
  // 只查 paid/in_production——但下面 tasks/materials 的备料聚合仍然只应该
  // 统计"还需要真的去生产"的订单，shipped 已经做完、refunded 已经取消，都
  // 不该再算进备料清单，所以这里先取全量再在内存里筛出 activeOrders 分开用
  const ordersRes = await db.collection('production_orders').where({
    tenantId,
    batchDate: _.gte(startDate).and(_.lte(endDate)),
    orderStatus: _.in(['paid', 'in_production', 'shipped', 'refunded'])
  }).limit(1000).get();

  const allOrders = ordersRes.data || [];
  const activeOrders = allOrders.filter((o) => o.orderStatus === 'paid' || o.orderStatus === 'in_production');

  const grouped = {}; // key: `${batchDate}__${productId}` -> { batchDate, productId, quantity }
  activeOrders.forEach((o) => {
    const key = `${o.batchDate}__${o.productId}`;
    if (!grouped[key]) grouped[key] = { batchDate: o.batchDate, productId: o.productId, quantity: 0 };
    grouped[key].quantity += o.quantity;
  });
  const tasks = Object.values(grouped).sort((a, b) => a.batchDate.localeCompare(b.batchDate));

  // 🎯 产能预警：直接读 production_capacity_counters（liveFactoryCore 排产时
  // CAS 原子扣减的同一张表），按 reserved/limit 换算利用率——这是"某批次已
  // 满、之后下单会自动顺延到更晚批次"这件事在数据层面唯一的真实来源，不是
  // 靠猜测或额外统计订单数反推
  const capacityRes = await db.collection('production_capacity_counters')
    .where({ tenantId, batchDate: _.gte(startDate).and(_.lte(endDate)) })
    .limit(1000)
    .get()
    .catch(() => ({ data: [] }));
  const capacityByBatch = {}; // key: `${batchDate}__${productId}` -> { reserved, limit, status }
  (capacityRes.data || []).forEach((c) => {
    const ratio = c.limit > 0 ? c.reserved / c.limit : 0;
    capacityByBatch[`${c.batchDate}__${c.productId}`] = {
      reserved: c.reserved,
      limit: c.limit,
      status: ratio >= 1 ? 'full' : (ratio >= 0.85 ? 'near_full' : 'normal')
    };
  });

  // 物料估算：只对配置了 materialList 的商品估算，未配置的不编造数据
  // 🐛 productName 反查用的 productIds 必须来自 allOrders 而不是 tasks——
  // tasks 只包含 activeOrders，若某批次的订单已全部发货/退款（该 batchDate+
  // productId 组合不再出现在 tasks 里），下面 orders 列表拼 productName 时
  // productMap 会查不到，已发货/已退款的历史订单卡片就会显示成空白商品名
  const productIds = [...new Set(allOrders.map((o) => o.productId))];
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

  // 单笔订单明细：供「排单与发货管理」页逐单标记发货/查看履约进度用，与
  // tasks 的聚合视图是同一份查询结果的两种展现，不重复查库。现在覆盖全部
  // 四种终态（paid/in_production/shipped/refunded），发货与退款相关字段
  // 按状态附带对应的物流/退款凭据，供前端卡片展示履约进度与退款红冲详情
  const orders = allOrders
    .map((o) => ({
      _id: o._id,
      productId: o.productId,
      productName: (productMap[o.productId] || {}).name || '',
      buyerOpenId: o.buyerOpenId,
      quantity: o.quantity,
      payAmount: o.payAmount,
      batchDate: o.batchDate,
      estimatedShippingDate: o.estimatedShippingDate,
      orderStatus: o.orderStatus,
      expressCompany: o.expressCompany || '',
      trackingNumber: o.trackingNumber || '',
      refundReason: o.refundReason || '',
      refundedAt: o.refundedAt || null
    }))
    .sort((a, b) => a.batchDate.localeCompare(b.batchDate));

  return {
    success: true,
    tasks: tasks.map((t) => ({ ...t, productName: (productMap[t.productId] || {}).name || '' })),
    materials: Object.entries(materialTotals).map(([materialName, v]) => ({ materialName, quantity: v.qty, unit: v.unit })),
    orders,
    capacityByBatch,
    healedStuckOrders: healedCount
  };
};
