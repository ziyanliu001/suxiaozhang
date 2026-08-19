// 云函数：manageProduct — Module B：商品（SKU）管理 CRUD
// action: 'create' | 'update' | 'list' | 'get' | 'remove' | 'restore'
//
// 🛡️ remove 是软删除（status:'inactive'），不做硬删除——production_orders/
// production_capacity_counters/order_settlements 都通过 productId 引用商品，
// 硬删除会让历史订单、制作看板变成悬空引用，破坏 getProductionBoard 的
// 物料估算与 getPresaleCalendar 的商品信息展示。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const { validateProductInput } = require('./lib/validateProduct');

// 🚨 查 tenant_members 而不是 user_roles：见 createProductionSpace/index.js
// 头部注释——live_factory 成员记录绝不能混进雨花公益专区依赖的 user_roles。
async function verifyTenantAccess(openid, tenantId, requiredRoles) {
  const res = await db.collection('tenant_members')
    .where({ _openid: openid, tenantId, status: 'approved' })
    .get();
  return (res.data || []).find((r) => requiredRoles.includes(r.role)) || null;
}

function pickEditableFields(event) {
  return {
    name: event.name,
    price: Number(event.price),
    dailyCapacityLimit: Number(event.dailyCapacityLimit),
    leadTimeDays: Number(event.leadTimeDays),
    materialList: event.materialList,
    producerOpenId: event.producerOpenId,
    description: event.description
  };
}

async function handleCreate(event, openid) {
  const tenantId = String(event.tenantId || '');
  if (!tenantId) return { success: false, error: '参数缺失: tenantId' };
  const caller = await verifyTenantAccess(openid, tenantId, ['space_owner', 'space_admin']);
  if (!caller) return { success: false, error: '无权限：仅空间负责人/管理员可管理商品' };

  const fields = pickEditableFields(event);
  const validation = validateProductInput(fields);
  if (!validation.valid) return { success: false, error: validation.error };

  const addRes = await db.collection('products').add({
    data: {
      tenantId,
      name: validation.name,
      price: fields.price,
      dailyCapacityLimit: fields.dailyCapacityLimit,
      leadTimeDays: fields.leadTimeDays,
      materialList: fields.materialList || [],
      producerOpenId: validation.producerOpenId || '',
      description: validation.description || '',
      status: 'active',
      createdBy: openid,
      createdAt: db.serverDate()
    }
  });
  return { success: true, productId: addRes._id };
}

async function loadOwnedProduct(productId, tenantId, openid, requiredRoles) {
  const productRes = await db.collection('products').doc(productId).get().catch(() => null);
  const product = productRes && productRes.data;
  if (!product || product.tenantId !== tenantId) return { error: '商品不存在' };
  const caller = await verifyTenantAccess(openid, tenantId, requiredRoles);
  if (!caller) return { error: '无权限：仅空间负责人/管理员可管理商品' };
  return { product };
}

async function handleUpdate(event, openid) {
  const tenantId = String(event.tenantId || '');
  const productId = String(event.productId || '');
  if (!tenantId || !productId) return { success: false, error: '参数缺失: tenantId/productId' };

  const { error } = await loadOwnedProduct(productId, tenantId, openid, ['space_owner', 'space_admin']);
  if (error) return { success: false, error };

  const fields = pickEditableFields(event);
  const validation = validateProductInput(fields);
  if (!validation.valid) return { success: false, error: validation.error };

  await db.collection('products').doc(productId).update({
    data: {
      name: validation.name,
      price: fields.price,
      dailyCapacityLimit: fields.dailyCapacityLimit,
      leadTimeDays: fields.leadTimeDays,
      materialList: fields.materialList || [],
      producerOpenId: validation.producerOpenId || '',
      description: validation.description || '',
      updatedAt: db.serverDate()
    }
  });
  return { success: true };
}

async function handleSetStatus(event, openid, status) {
  const tenantId = String(event.tenantId || '');
  const productId = String(event.productId || '');
  if (!tenantId || !productId) return { success: false, error: '参数缺失: tenantId/productId' };

  const { error } = await loadOwnedProduct(productId, tenantId, openid, ['space_owner', 'space_admin']);
  if (error) return { success: false, error };

  await db.collection('products').doc(productId).update({ data: { status, updatedAt: db.serverDate() } });
  return { success: true };
}

async function handleList(event) {
  const tenantId = String(event.tenantId || '');
  if (!tenantId) return { success: false, error: '参数缺失: tenantId' };
  const status = event.status && event.status !== 'all' ? String(event.status) : undefined;

  const where = status ? { tenantId, status } : { tenantId };
  const res = await db.collection('products').where(where).limit(200).get();
  return { success: true, products: res.data || [] };
}

async function handleGet(event) {
  const productId = String(event.productId || '');
  if (!productId) return { success: false, error: '参数缺失: productId' };
  const res = await db.collection('products').doc(productId).get().catch(() => null);
  if (!res || !res.data) return { success: false, error: '商品不存在' };
  return { success: true, product: res.data };
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  switch (event.action) {
    case 'create': return handleCreate(event, OPENID);
    case 'update': return handleUpdate(event, OPENID);
    case 'remove': return handleSetStatus(event, OPENID, 'inactive');
    case 'restore': return handleSetStatus(event, OPENID, 'active');
    case 'list': return handleList(event);
    case 'get': return handleGet(event);
    default: return { success: false, error: `未知 action: ${event.action}` };
  }
};
