// 云函数：manageGroupBuyBatch — 护城河二「柔性产销协作与防超卖排期」
// 拼团批次管理：space_owner/space_admin 为某个商品的某一天批次配置阶梯价
// 与截止时间。批次一旦创建，买家在 storefront 选中这一天下单时会自动按
// liveFactoryCore.updateGroupBuyProgress 算出的阶梯价成交（见 createProductionOrder
// 的接线），本函数只负责批次本身的增删改查，不碰订单/价格计算逻辑。
//
// 🔑 自然键 {tenantId, productId, batchDate} 唯一确定一个批次——与
// production_capacity_counters 的唯一键完全同构（同一天同一商品只有一个
// 产能占用文档，也只应该有一个拼团批次），create 会先查重，避免同一天配出
// 两个互相冲突的拼团活动。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const { validateGroupBuyBatch } = require('./lib/validateGroupBuyBatch');

function isValidDateStr(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''));
}

// 🚨 查 tenant_members 而不是 user_roles：见 createProductionSpace/index.js
// 头部注释——live_factory 成员记录绝不能混进雨花公益专区依赖的 user_roles。
async function verifyTenantAccess(openid, tenantId, requiredRoles) {
  const res = await db.collection('tenant_members')
    .where({ _openid: openid, tenantId, status: 'approved' })
    .get();
  return (res.data || []).find((r) => requiredRoles.includes(r.role)) || null;
}

async function loadProductInTenant(tenantId, productId) {
  const productRes = await db.collection('products').doc(productId).get().catch(() => null);
  const product = productRes && productRes.data;
  if (!product || product.tenantId !== tenantId) return null;
  return product;
}

async function handleCreate(event) {
  const { tenantId, productId, batchDate, tierThresholds, deadlineAt } = event;
  if (!tenantId || !productId || !isValidDateStr(batchDate)) {
    return { success: false, error: '参数缺失或 batchDate 格式不正确' };
  }

  const product = await loadProductInTenant(tenantId, productId);
  if (!product) return { success: false, error: '商品不存在' };

  const existingRes = await db.collection('group_buy_batches').where({ tenantId, productId, batchDate }).limit(1).get().catch(() => ({ data: [] }));
  if (existingRes.data && existingRes.data.length > 0) {
    return { success: false, error: '该商品该日期已存在拼团批次，请使用编辑而不是新建' };
  }

  const check = validateGroupBuyBatch({ tierThresholds, deadlineAt, basePriceCents: product.price });
  if (!check.valid) return { success: false, error: check.error };

  const doc = {
    tenantId, productId, batchDate,
    tierThresholds: check.sortedTierThresholds,
    committedQuantity: 0,
    deadlineAt: check.deadline,
    status: 'collecting',
    createdAt: db.serverDate()
  };
  const addRes = await db.collection('group_buy_batches').add({ data: doc });
  return { success: true, batchId: addRes._id };
}

async function handleUpdate(event) {
  const { tenantId, productId, batchDate, tierThresholds, deadlineAt } = event;
  if (!tenantId || !productId || !isValidDateStr(batchDate)) {
    return { success: false, error: '参数缺失或 batchDate 格式不正确' };
  }

  const product = await loadProductInTenant(tenantId, productId);
  if (!product) return { success: false, error: '商品不存在' };

  const existingRes = await db.collection('group_buy_batches').where({ tenantId, productId, batchDate }).limit(1).get();
  const existing = (existingRes.data && existingRes.data[0]) || null;
  if (!existing) return { success: false, error: '该批次不存在' };
  if (existing.status !== 'collecting') return { success: false, error: '该批次已截止或已关闭，无法修改' };

  const check = validateGroupBuyBatch({ tierThresholds, deadlineAt, basePriceCents: product.price });
  if (!check.valid) return { success: false, error: check.error };

  await db.collection('group_buy_batches').doc(existing._id).update({
    data: { tierThresholds: check.sortedTierThresholds, deadlineAt: check.deadline }
  });
  return { success: true };
}

async function handleClose(event) {
  const { tenantId, productId, batchDate } = event;
  if (!tenantId || !productId || !isValidDateStr(batchDate)) {
    return { success: false, error: '参数缺失或 batchDate 格式不正确' };
  }
  const existingRes = await db.collection('group_buy_batches').where({ tenantId, productId, batchDate }).limit(1).get();
  const existing = (existingRes.data && existingRes.data[0]) || null;
  if (!existing) return { success: false, error: '该批次不存在' };
  if (existing.status === 'closed') return { success: true, alreadyClosed: true };

  await db.collection('group_buy_batches').doc(existing._id).update({ data: { status: 'closed' } });
  return { success: true };
}

async function handleList(event) {
  const { tenantId, productId } = event;
  if (!tenantId) return { success: false, error: '参数缺失: tenantId' };
  const where = productId ? { tenantId, productId } : { tenantId };
  const res = await db.collection('group_buy_batches').where(where).orderBy('batchDate', 'desc').limit(200).get();
  return { success: true, batches: res.data || [] };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  const tenantId = String(event.tenantId || '');
  if (!tenantId) return { success: false, error: '参数缺失: tenantId' };

  const caller = await verifyTenantAccess(OPENID, tenantId, ['space_owner', 'space_admin']);
  if (!caller) return { success: false, error: '无权限：仅空间负责人/管理员可管理拼团批次' };

  switch (event.action) {
    case 'create': return handleCreate(event);
    case 'update': return handleUpdate(event);
    case 'close': return handleClose(event);
    case 'list': return handleList(event);
    default: return { success: false, error: `未知 action: ${event.action}` };
  }
};
