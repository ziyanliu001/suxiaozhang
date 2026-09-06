// 云函数：manageTenantSettlementConfig — Module A 补充：支付模式（paymentMode）
// 与分账费率（settlementConfig）配置管理
// action: 'get' | 'update'
//
// 🏛️ 背景（《素食产销工坊升级与生态护城河演进计划书》里程碑 M0）：
// createProductionSpace 建空间时只会把 paymentMode 写死成默认值 'none'
// （见该云函数），此前全仓库没有任何一个云函数能把它改成 'direct_wechat'，
// 或者配置 settlementConfig.producerRate/promoterRate——只能去云开发控制台
// 手改数据库。本函数补齐这个从未存在过的管理入口，是护城河三"合规分账"
// 与护城河一"以产养善"两条线都要依赖的地基：没有这个入口，direct_wechat
// 全链路（completeProductionOrder 的 tryAutoProfitSharing）永远测不出来，
// 分账费率也永远只能吃 createProductionOrder.js 里硬编码的默认值
// （DEFAULT_PRODUCER_RATE=0.75/DEFAULT_PROMOTER_RATE=0.20）。
//
// ⚠️ 已知限制（如实标注，不在本函数职责范围内）：把 paymentMode 切到
// 'direct_wechat' 只是写库，不代表微信支付分账立刻就能跑通——真实分账
// 要求商户先在微信支付商户平台手动开通分账权限、且 completeProductionOrder/
// lib/buildReceivers.js 目前只支持 producer/promoter 两个接收方，接收方
// 本身还需要通过 wxPayCore 的 addProfitSharingReceiver 单独注册。本函数
// 只负责让这个配置"可以被设置"，不代表设置后自动具备真实分账能力。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const { validateSettlementConfigInput } = require('./lib/validateSettlementConfig');

// 🚨 查 tenant_members 而不是 user_roles：见 createProductionSpace/index.js
// 头部注释——live_factory 成员记录绝不能混进雨花公益专区依赖的 user_roles。
async function verifyTenantAccess(openid, tenantId, requiredRoles) {
  const res = await db.collection('tenant_members')
    .where({ _openid: openid, tenantId, status: 'approved' })
    .get();
  return (res.data || []).find((r) => requiredRoles.includes(r.role)) || null;
}

// 🐛 tenants 文档 _id 是自动生成的，tenantId 只是业务字段，.doc(tenantId)
// 永远查不到（与 markSettlementsSettled/completeProductionOrder 同一个
// 已修复过的坑，这里从一开始就按正确写法来），查询/更新必须先按 tenantId
// 反查出真实 _id
async function loadTenantByTenantId(tenantId) {
  const res = await db.collection('tenants').where({ tenantId }).limit(1).get().catch(() => ({ data: [] }));
  return (res.data && res.data[0]) || null;
}

async function handleGet(event, openid) {
  const tenantId = String(event.tenantId || '');
  if (!tenantId) return { success: false, error: '参数缺失: tenantId' };

  const caller = await verifyTenantAccess(openid, tenantId, ['space_owner', 'space_admin']);
  if (!caller) return { success: false, error: '无权限：仅空间负责人/管理员可查看支付与分账配置' };

  const tenant = await loadTenantByTenantId(tenantId);
  if (!tenant) return { success: false, error: '机构不存在' };

  const cfg = tenant.settlementConfig || {};
  return {
    success: true,
    paymentMode: tenant.paymentMode || 'none',
    // 🌟 未配置时把 createProductionOrder.js 里实际生效的默认费率原样吐给
    // 前端展示，而不是留空——工坊主打开设置页看到的应该是"当前实际生效的
    // 费率"，不是一个容易被误解成"0%"的空值
    producerRate: Number.isFinite(cfg.producerRate) ? cfg.producerRate : 0.75,
    promoterRate: Number.isFinite(cfg.promoterRate) ? cfg.promoterRate : 0.2,
    isCustomized: Number.isFinite(cfg.producerRate) || Number.isFinite(cfg.promoterRate)
  };
}

async function handleUpdate(event, openid) {
  const tenantId = String(event.tenantId || '');
  if (!tenantId) return { success: false, error: '参数缺失: tenantId' };

  const caller = await verifyTenantAccess(openid, tenantId, ['space_owner', 'space_admin']);
  if (!caller) return { success: false, error: '无权限：仅空间负责人/管理员可修改支付与分账配置' };

  const paymentMode = String(event.paymentMode || '');
  const producerRate = Number(event.producerRate);
  const promoterRate = Number(event.promoterRate);
  const validation = validateSettlementConfigInput({ paymentMode, producerRate, promoterRate });
  if (!validation.valid) return { success: false, error: validation.error };

  const tenant = await loadTenantByTenantId(tenantId);
  if (!tenant) return { success: false, error: '机构不存在' };

  await db.collection('tenants').doc(tenant._id).update({
    data: {
      paymentMode,
      settlementConfig: { producerRate, promoterRate },
      settlementConfigUpdatedBy: openid,
      settlementConfigUpdatedAt: db.serverDate()
    }
  });

  return {
    success: true,
    // 🌟 切到 direct_wechat 时提醒一句真实前置条件，不是拦截——见文件头部
    // "已知限制"注释，这里只是把同一句话透传给前端做一次性提示 Toast
    warning: paymentMode === 'direct_wechat'
      ? '已切换为微信直连自动分账模式，请确认已在微信支付商户平台开通分账权限，并为制作方/推广员完成分账接收方注册，否则发货时自动分账会静默失败'
      : ''
  };
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  switch (event.action) {
    case 'get': return handleGet(event, OPENID);
    case 'update': return handleUpdate(event, OPENID);
    default: return { success: false, error: `未知 action: ${event.action}` };
  }
};
