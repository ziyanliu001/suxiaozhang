// 云函数：manageCharityContribution — 护城河一「以产养善·物资反哺链」核心
// action: 'pledge' | 'redeem' | 'list'
//
// 🏛️ 背景（《素食产销工坊升级与生态护城河演进计划书》里程碑 M1）：直播产销
// 工坊（tenant_members 体系）与雨花公益专区（user_roles 体系）是刻意物理
// 隔离的两套系统（见 createProductionSpace/index.js 头部注释——历史上混过
// 一次导致权限查询随机串号）。本函数是这两套体系之间唯一被设计出来的桥梁：
// 只读写一张全新的中间账本集合 charity_contributions，绝不直接查/改对方
// 体系的私有集合（工坊侧不碰 user_roles/report_logs，公益侧不碰
// tenant_members/production_orders）。
//
// 🛡️ 架构决策（计划书 2.1 节）：走内部账本额度，不接入微信真实分账——
// 给"公益基金池"开一个真实的微信分账接收方需要额外的商户级接收方注册、
// 可能要做官方要求的敏感信息加密（本仓库未实现），且分账回退全链路空白。
// 本函数只做纯记账：pledge 时不触发任何真实资金划转，producerAmount 依然
// 按原有链路（tryAutoProfitSharing / markSettlementsSettled）结算给制作方，
// "转捐给公益厨房"只是制作方自愿把已经到手/即将到手的这份钱在账本上标记为
// "承诺捐给谁"，真正变成公益厨房手里能花的钱走人工核销，不是本函数负责的
// 实时资金动作。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { validatePledgeInput, validateRedeemInput } = require('./lib/validateContribution');

// 🚨 查 tenant_members 而不是 user_roles：见 createProductionSpace/index.js
// 头部注释——live_factory 成员记录绝不能混进雨花公益专区依赖的 user_roles。
async function verifyTenantAccess(openid, tenantId, requiredRoles) {
  const res = await db.collection('tenant_members')
    .where({ _openid: openid, tenantId, status: 'approved' })
    .get();
  return (res.data || []).find((r) => requiredRoles.includes(r.role)) || null;
}

// 🛡️ 公益侧鉴权唯一入口：查 user_roles（雨花体系既有集合），不查
// tenant_members——与上面的 verifyTenantAccess 是本函数里仅有的两处鉴权，
// 分别对应两套完全独立的角色体系，绝不交叉查询。store_manager 限本店；
// store_patriarch/super_admin 限"与目标门店同一机构"（tenantId 一致）内
// 任意门店，镜像 manageStoreProfile 的 CROSS_STORE_VIEW_ROLES 同类权限收窄
const CHARITY_SIDE_MANAGERIAL_ROLES = ['store_manager', 'store_patriarch', 'super_admin'];

async function verifyCharitySideAccess(openid, targetStoreId) {
  const storeRes = await db.collection('stores').doc(targetStoreId).get().catch(() => null);
  const store = storeRes && storeRes.data;
  if (!store) return { ok: false, error: '目标门店不存在' };

  const roleRes = await db.collection('user_roles').where({ _openid: openid }).limit(1).get();
  const caller = roleRes.data && roleRes.data[0];
  if (!caller || !CHARITY_SIDE_MANAGERIAL_ROLES.includes(caller.role)) {
    return { ok: false, error: '无权限：仅店长/大家长/超级管理员可核销物资额度' };
  }
  if (caller.role === 'store_manager' && caller.storeId !== targetStoreId) {
    return { ok: false, error: '无权限：店长只能核销自己门店收到的额度' };
  }
  if ((caller.role === 'store_patriarch' || caller.role === 'super_admin') && caller.tenantId !== store.tenantId) {
    return { ok: false, error: '无权限：只能核销本机构门店收到的额度' };
  }
  return { ok: true, store, caller };
}

// 🌟（护城河一 M1）转捐目标门店选择列表：不用 getStoreList 云函数——那个
// 函数的跨机构发现分支要求先传一个精确的 orgType 才会触发（且它的
// buildOrgTypeCondition 只做"雨花 vs 非雨花"二元判断，没法精确筛出"社区
// 助餐/义工服务站"这类细分业态），而且工坊管理员在 user_roles 里本来就
// 没有记录（live_factory 走 tenant_members 独立体系），走那条函数的"按
// 自己 tenantId 查询"分支只会拿到空列表。转捐目标本来就应该是"浏览全平台
// 任意机构的门店"，不涉及租户隔离（门店名称本就是非敏感的公开展示信息，
// 见 getStoreList 自己的头部注释），这里直接查 stores 集合返回全量列表，
// 交给前端本地按门店名做关键词过滤，不做服务端模糊搜索（省去正则转义等
// 安全顾虑，本模块目标用户规模也不需要服务端分页搜索）
async function handleListTargetStores(event, openid) {
  const tenantId = String(event.tenantId || '');
  if (!tenantId) return { success: false, error: '参数缺失: tenantId' };
  const caller = await verifyTenantAccess(openid, tenantId, ['space_owner', 'space_admin']);
  if (!caller) return { success: false, error: '无权限：仅空间负责人/管理员可选择转捐目标' };

  const res = await db.collection('stores')
    .where({ status: _.neq('inactive') })
    .orderBy('storeName', 'asc')
    .limit(100)
    .get();
  return {
    success: true,
    stores: (res.data || []).map((s) => ({
      storeId: s._id,
      storeName: s.storeName || '未命名门店',
      orgType: s.orgType || '',
      city: s.city || '',
      province: s.province || ''
    }))
  };
}

async function handlePledge(event, openid) {
  const tenantId = String(event.tenantId || '');
  const settlementId = String(event.settlementId || '');
  const targetStoreId = String(event.targetStoreId || '');
  const amount = Number(event.amount);
  if (!tenantId || !settlementId || !targetStoreId) {
    return { success: false, error: '参数缺失: tenantId/settlementId/targetStoreId' };
  }

  const caller = await verifyTenantAccess(openid, tenantId, ['space_owner', 'space_admin']);
  if (!caller) return { success: false, error: '无权限：仅空间负责人/管理员可发起转捐' };

  const settlementRes = await db.collection('order_settlements').doc(settlementId).get().catch(() => null);
  const settlement = settlementRes && settlementRes.data;
  if (!settlement || settlement.tenantId !== tenantId) {
    return { success: false, error: '分账记录不存在' };
  }

  const validation = validatePledgeInput({ amount, settlement });
  if (!validation.valid) return { success: false, error: validation.error };

  const targetStoreRes = await db.collection('stores').doc(targetStoreId).get().catch(() => null);
  const targetStore = targetStoreRes && targetStoreRes.data;
  if (!targetStore || targetStore.status === 'inactive') {
    return { success: false, error: '目标门店不存在或已停用' };
  }

  // 🛡️ 幂等/防重：确定性 _id（与 liveFactoryCore.buildSettlement 的
  // settle_${tenantId}_${orderId} 同一个模式）——同一笔结算记录只能转捐一次，
  // .add() 撞到已存在的 _id 会直接失败，不需要额外的唯一索引也能保证原子性
  const contributionId = `charity_${settlementId}`;
  try {
    await db.collection('charity_contributions').add({
      data: {
        _id: contributionId,
        tenantId,
        orderId: settlement.orderId,
        settlementId,
        sourceType: 'profit_share',
        amount,
        targetStoreId,
        targetStoreName: targetStore.storeName || '',
        targetOrgType: targetStore.orgType || '',
        pledgeStatus: 'pledged',
        pledgedBy: openid,
        pledgedAt: db.serverDate()
      }
    });
  } catch (err) {
    if (err && (err.errCode === -502002 || /already exists/i.test(String(err.errMsg || err.message || '')))) {
      return { success: false, error: '这笔分账记录已经转捐过了，不能重复转捐' };
    }
    throw err;
  }

  return { success: true, contributionId };
}

async function handleRedeem(event, openid) {
  const contributionId = String(event.contributionId || '');
  if (!contributionId) return { success: false, error: '参数缺失: contributionId' };

  const contributionRes = await db.collection('charity_contributions').doc(contributionId).get().catch(() => null);
  const contribution = contributionRes && contributionRes.data;
  if (!contribution) return { success: false, error: '转捐记录不存在' };
  if (contribution.pledgeStatus !== 'pledged') {
    return { success: false, error: `该记录当前状态是「${contribution.pledgeStatus}」，不是待核销状态` };
  }

  const access = await verifyCharitySideAccess(openid, contribution.targetStoreId);
  if (!access.ok) return { success: false, error: access.error };

  const validation = validateRedeemInput({ redeemNote: event.redeemNote });
  if (!validation.valid) return { success: false, error: validation.error };

  // 🛡️ CAS 防重复核销：条件更新只在仍是 pledged 状态时才生效，避免两个
  // 管理员并发点击核销导致重复处理（与 completeProductionOrder 的
  // profitSharingLockedAt 同一类"更新条件里带上前置状态"的并发防护写法）
  const updateRes = await db.collection('charity_contributions').where({
    _id: contributionId, pledgeStatus: 'pledged'
  }).update({
    data: {
      pledgeStatus: 'redeemed',
      redeemedBy: openid,
      redeemedAt: db.serverDate(),
      redeemNote: validation.redeemNote
    }
  });
  if (updateRes.stats.updated !== 1) {
    return { success: false, error: '核销失败，请刷新后重试（可能已被其他管理员核销）' };
  }

  return { success: true };
}

async function handleList(event, openid) {
  const tenantId = event.tenantId ? String(event.tenantId) : '';
  const targetStoreId = event.targetStoreId ? String(event.targetStoreId) : '';
  if (!tenantId && !targetStoreId) {
    return { success: false, error: '参数缺失: tenantId 或 targetStoreId 至少传一个' };
  }

  if (tenantId) {
    // 工坊侧视角："我捐了多少"
    const caller = await verifyTenantAccess(openid, tenantId, ['space_owner', 'space_admin']);
    if (!caller) return { success: false, error: '无权限：仅空间负责人/管理员可查看转捐记录' };
    const res = await db.collection('charity_contributions')
      .where({ tenantId })
      .orderBy('pledgedAt', 'desc')
      .limit(200)
      .get();
    return { success: true, contributions: res.data || [] };
  }

  // 公益侧视角："我收到了多少可核销额度"
  const access = await verifyCharitySideAccess(openid, targetStoreId);
  if (!access.ok) return { success: false, error: access.error };
  const res = await db.collection('charity_contributions')
    .where({ targetStoreId })
    .orderBy('pledgedAt', 'desc')
    .limit(200)
    .get();
  return { success: true, contributions: res.data || [] };
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  switch (event.action) {
    case 'listTargetStores': return handleListTargetStores(event, OPENID);
    case 'pledge': return handlePledge(event, OPENID);
    case 'redeem': return handleRedeem(event, OPENID);
    case 'list': return handleList(event, OPENID);
    default: return { success: false, error: `未知 action: ${event.action}` };
  }
};
