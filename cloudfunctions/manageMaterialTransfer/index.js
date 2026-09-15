// 云函数：manageMaterialTransfer — 雨花斋/助老食堂「爱心物资库存与跨店调配」
//
// 🏛️ 与商业进销存（manageInventoryItem/manageInventoryTransaction）彻底独立、
// 互不调用——那套系统服务端硬拒绝 orgType==='yuhuazhai'（docs/SCHEMA.md §6：
// "雨花斋专区保持极简阳光账本、不引入进销存复杂度"），本函数反过来只服务
// CHARITY_ORG_TYPES（雨花斋/助老食堂），两套系统不共享任何集合。
//
// 🛡️ 零可变余额字段设计：不维护任何 currentStock 类可变字段，结存永远在
// getStock 里现算（初始存量 + 捐赠 + 采购入库 − 消耗 + 调入 − 调出，见
// lib/computeMaterialStock.js 头部注释）。跨店调拨（create）因此只需要
// add() 一条不可变 material_transfer_logs 记录即可完成——单文档写入天然
// 原子，不需要、也不引入本仓库从未有过先例的"跨两个 storeId 的多文档事务"。
//
// action：
// - getStock（storeId）：现算四大主料（大米/食用油/面粉/时蔬）预估结存 +
//   健康度（告急/正常/富余），若有告急项顺带返回同机构（同城优先）富余门店
//   的调配建议（suggestions），一次往返给全，不单独开 action。
// - create（fromStoreId, toStoreId, item, quantityJin, handledBy）：登记一笔
//   跨店调拨（大米/食用油/面粉——时蔬保质期短不支持跨店调配），调用者须为
//   任一方门店的店长/大家长/超管，双方门店须同机构。
// - recordPurchase（storeId, item, quantityJin, amount?, receiptImage?）：
//   登记一笔小票采购入库（结构化提交，四类目全覆盖）——本仓库里 report_logs
//   的支出字段只存金额、没有重量字段，material_logs 的 OCR 识别重量语义上
//   是"消耗"不是"采购"，因此新开这个轻量集合承接"买了多少斤"这个此前完全
//   没有可靠数据源的信息，避免结存公式只减消耗不加采购、把"买了米吃了米"
//   误判成库存负数。
// - listTransfers（storeId, limit?）：该店参与的最近调拨记录（供调拨弹窗内
//   的"最近调拨"小列表使用）。
// - setBaseline（storeId, rice, oil, flour, vegetable）：设置/修改初始存量。

'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const crypto = require('crypto');

const { parseMaterialDonationToJin } = require('./lib/parseMaterialDonation');
const { computeMaterialStock } = require('./lib/computeMaterialStock');

const TRANSFER_COLLECTION = 'material_transfer_logs';
const PURCHASE_COLLECTION = 'material_purchase_logs';
const CONSUMPTION_COLLECTION = 'material_logs';
const REPORT_COLLECTION = 'report_logs';
const QUERY_LIMIT = 1000;
const SUGGESTION_CANDIDATE_LIMIT = 20;

const ITEM_LABELS = { rice: '大米', oil: '食用油', flour: '面粉', vegetable: '时蔬' };
const VALID_ITEMS = ['rice', 'oil', 'flour', 'vegetable'];
// 🥬 时蔬保质期短，跨店平调时效性差，跨店调拨只放开大米/食用油/面粉三项——
// 与任务需求"调配物资（大米/食用油/面粉）"的枚举保持一致；采购入库/初始存量/
// 结存展示仍是四类目全覆盖
const TRANSFERABLE_ITEMS = ['rice', 'oil', 'flour'];
// 🏛️ 本功能只服务公益专区——与商业进销存（拒绝 yuhuazhai）刚好互补，两套
// 系统合起来覆盖全部 orgType，互不重叠
const CHARITY_ORG_TYPES = ['yuhuazhai', 'elderly_canteen'];

async function checkContentSafe(text) {
  if (!text) return true;
  try {
    const res = await cloud.callFunction({ name: 'msgSecCheck', data: { text, contentType: 'report' } });
    return !res.result || res.result.safe !== false;
  } catch (err) {
    console.warn('[manageMaterialTransfer] 内容安全检测调用失败，降级放行:', err);
    return true;
  }
}

function sanitizePositiveNumber(value) {
  const n = parseFloat(value);
  if (isNaN(n) || n <= 0) return undefined;
  return Math.round(n * 100) / 100;
}

// 返回 null 表示"合法但未填写"（正常，可选字段），undefined 表示"格式不正确"
function sanitizeNonNegativeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseFloat(value);
  if (isNaN(n) || n < 0) return undefined;
  return Math.round(n * 100) / 100;
}

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

// 权限校验：仿照 manageInventoryTransaction 的 resolveWriteTarget，但反过来
// 只放行公益专区（CHARITY_ORG_TYPES），不是拒绝雨花斋。
//
// 🙋（2026-09-19 历史明细列表页）新增 opts.allowVolunteer——写操作（登记
// 调拨/采购/设置初始库存）与结存现算维持店长/大家长/超管专属，不放开；
// 但"查看历史明细"这个纯只读场景，任务需求明确是给志工用的（"方便志工
// 快速盘点核对"），只做只读查询、不产生任何写副作用，放开给 volunteer
// 角色是合理的权限收窄（读比写风险低得多），不代表全面放开这个云函数。
// 调用方必须显式传 { allowVolunteer: true } 才会命中这条豁免，默认行为
// （不传第三个参数）与此前完全一致
async function resolveAccessTarget(caller, requestedStoreId, opts) {
  const allowVolunteer = !!(opts && opts.allowVolunteer);
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  const isManagerRole = caller.role === 'store_manager' || caller.role === 'store_patriarch';
  const isReadOnlyVolunteer = allowVolunteer && caller.role === 'volunteer';

  if (isManagerRole || isReadOnlyVolunteer) {
    if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店，无法查看物资信息' };
    if (requestedStoreId && requestedStoreId !== caller.storeId) {
      return { allowed: false, error: '无权限：不能操作其他门店的物资' };
    }
    const storeRes = await db.collection('stores').doc(caller.storeId).get().catch(() => null);
    const store = storeRes && storeRes.data;
    if (!store) return { allowed: false, error: '门店不存在' };
    if (!CHARITY_ORG_TYPES.includes(store.orgType)) {
      return { allowed: false, error: '该功能仅服务雨花斋/助老食堂等公益专区' };
    }
    return { allowed: true, storeId: caller.storeId, tenantId: caller.tenantId || store.tenantId || '', store };
  }

  if (caller.role === 'super_admin') {
    if (!requestedStoreId) return { allowed: false, error: '请指定目标门店' };
    const storeRes = await db.collection('stores').doc(requestedStoreId).get().catch(() => null);
    const store = storeRes && storeRes.data;
    if (!store) return { allowed: false, error: '目标门店不存在' };
    if (!caller.tenantId || !store.tenantId || caller.tenantId !== store.tenantId) {
      return { allowed: false, error: '无权限：目标门店不属于您所在的机构' };
    }
    if (!CHARITY_ORG_TYPES.includes(store.orgType)) {
      return { allowed: false, error: '该功能仅服务雨花斋/助老食堂等公益专区' };
    }
    return { allowed: true, storeId: requestedStoreId, tenantId: caller.tenantId, store };
  }

  return {
    allowed: false,
    error: allowVolunteer ? '无权限：仅店长、大家长、义工或超级管理员可查看物资信息' : '无权限：仅店长、大家长或超级管理员可管理物资'
  };
}

// 查一家店的全部原始流水并现算结存——getStock 本店 + findSurplusPartners
// 候选门店共用同一段逻辑，避免两处各写一份查询代码
async function fetchStoreStock(tenantId, storeId, baseline) {
  const [reportRes, purchaseRes, consumptionRes, transferInRes, transferOutRes] = await Promise.all([
    db.collection(REPORT_COLLECTION).where({ tenantId, storeId }).field({ materials: true }).limit(QUERY_LIMIT).get(),
    db.collection(PURCHASE_COLLECTION).where({ tenantId, storeId }).limit(QUERY_LIMIT).get(),
    db.collection(CONSUMPTION_COLLECTION).where({ tenantId, storeId })
      .field({ riceCount: true, oilCount: true, flourCount: true, vegetableCount: true }).limit(QUERY_LIMIT).get(),
    db.collection(TRANSFER_COLLECTION).where({ tenantId, toStoreId: storeId }).limit(QUERY_LIMIT).get(),
    db.collection(TRANSFER_COLLECTION).where({ tenantId, fromStoreId: storeId }).limit(QUERY_LIMIT).get()
  ]);

  const donations = [];
  (reportRes.data || []).forEach((doc) => {
    (doc.materials || []).forEach((m) => {
      const parsed = parseMaterialDonationToJin(m);
      if (parsed) donations.push(parsed);
    });
  });

  const purchases = (purchaseRes.data || []).map((p) => ({ item: p.item, quantityJin: p.quantityJin }));
  const consumptions = consumptionRes.data || [];
  const transfersIn = (transferInRes.data || []).map((t) => ({ item: t.item, quantityJin: t.quantityJin }));
  const transfersOut = (transferOutRes.data || []).map((t) => ({ item: t.item, quantityJin: t.quantityJin }));

  return computeMaterialStock({ baseline: baseline || {}, donations, purchases, consumptions, transfersIn, transfersOut });
}

// 有告急项时，在同机构（同城优先）其余公益门店里找该项"富余"的候选，供
// 首页卡片提示"可向 XX 门店申请爱心平调"。候选门店数量有限（充电站量级），
// 逐店现算可接受，不引入额外的预聚合表
async function findSurplusPartners(tenantId, excludeStoreId, city, urgentItems) {
  const storesRes = await db.collection('stores').where({
    tenantId,
    orgType: _.in(CHARITY_ORG_TYPES),
    _id: _.neq(excludeStoreId)
  }).limit(SUGGESTION_CANDIDATE_LIMIT).get();
  const candidates = storesRes.data || [];
  if (candidates.length === 0) return [];

  const results = await Promise.all(candidates.map(async (s) => {
    try {
      const stock = await fetchStoreStock(tenantId, s._id, s.materialStockBaseline);
      return { store: s, stock };
    } catch (err) {
      console.warn('[manageMaterialTransfer] findSurplusPartners 候选门店结存计算失败，跳过:', s._id, err);
      return null;
    }
  }));

  const suggestions = [];
  urgentItems.forEach((item) => {
    const surplusCandidates = results
      .filter((r) => r && r.stock[item] && r.stock[item].status === 'surplus')
      .sort((a, b) => {
        const aSameCity = city && a.store.city === city ? 0 : 1;
        const bSameCity = city && b.store.city === city ? 0 : 1;
        if (aSameCity !== bSameCity) return aSameCity - bSameCity;
        return b.stock[item].jin - a.stock[item].jin;
      });
    if (surplusCandidates.length > 0) {
      const best = surplusCandidates[0];
      suggestions.push({
        item,
        itemLabel: ITEM_LABELS[item],
        storeId: best.store._id,
        storeName: best.store.storeName || '',
        jin: best.stock[item].jin
      });
    }
  });
  return suggestions;
}

async function handleGetStock(event, caller) {
  const target = await resolveAccessTarget(caller, event.storeId);
  if (!target.allowed) return { success: false, error: target.error };
  const { storeId, tenantId, store } = target;

  const baseline = store.materialStockBaseline || {};
  const stock = await fetchStoreStock(tenantId, storeId, baseline);

  const urgentItems = VALID_ITEMS.filter((k) => stock[k].status === 'urgent');
  let suggestions = [];
  if (urgentItems.length > 0) {
    suggestions = await findSurplusPartners(tenantId, storeId, store.city || '', urgentItems);
  }

  return { success: true, stock, baseline, suggestions };
}

async function handleCreateTransfer(event, caller, OPENID) {
  const { fromStoreId, toStoreId, item, quantityJin, handledBy } = event;

  if (!fromStoreId || !toStoreId) return { success: false, error: '请选择调出与调入门店' };
  if (fromStoreId === toStoreId) return { success: false, error: '调出与调入不能是同一家门店' };
  if (!TRANSFERABLE_ITEMS.includes(item)) return { success: false, error: '暂只支持调配大米/食用油/面粉' };
  const qty = sanitizePositiveNumber(quantityJin);
  if (qty === undefined) return { success: false, error: '请输入大于 0 的调配重量（斤）' };
  const safeHandledBy = String(handledBy || '').trim().slice(0, 50);
  if (!safeHandledBy) return { success: false, error: '请填写经手人姓名' };
  if (!(await checkContentSafe(safeHandledBy))) {
    return { success: false, error: '经手人姓名包含违规信息，请修改后重新提交' };
  }

  // 调用者必须归属调出或调入门店任意一方（店长/大家长/超管）
  let target = await resolveAccessTarget(caller, fromStoreId);
  if (!target.allowed) target = await resolveAccessTarget(caller, toStoreId);
  if (!target.allowed) return { success: false, error: '无权限：您不属于调出或调入门店任意一方' };

  const [fromStoreRes, toStoreRes] = await Promise.all([
    db.collection('stores').doc(fromStoreId).get().catch(() => null),
    db.collection('stores').doc(toStoreId).get().catch(() => null)
  ]);
  const fromStore = fromStoreRes && fromStoreRes.data;
  const toStore = toStoreRes && toStoreRes.data;
  if (!fromStore || !toStore) return { success: false, error: '调出或调入门店不存在' };
  if (!fromStore.tenantId || !toStore.tenantId || fromStore.tenantId !== toStore.tenantId) {
    return { success: false, error: '调出与调入门店必须属于同一机构' };
  }
  if (target.tenantId && target.tenantId !== fromStore.tenantId) {
    return { success: false, error: '无权限：不属于您所在的机构' };
  }

  const payload = {
    tenantId: fromStore.tenantId,
    fromStoreId,
    fromStoreName: fromStore.storeName || '',
    toStoreId,
    toStoreName: toStore.storeName || '',
    item,
    itemLabel: ITEM_LABELS[item],
    quantityJin: qty,
    handledBy: safeHandledBy
  };
  // 🙏 防伪存证码：跟随 getSunshineLedger.generateFootprintCode 既定惯例——
  // 人工可核验（对方可要求出证方用同一份字段重新算一遍核对），不是密码学
  // 签名。创建时算好存入文档，供海报生成/历史查询直接复用，不是每次现算
  const verificationCode = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();

  const now = new Date();
  const docData = {
    ...payload,
    operatorOpenId: OPENID,
    operatorName: caller.realName || caller.nickName || '',
    remark: '',
    verificationCode,
    createTime: db.serverDate()
  };

  const addRes = await db.collection(TRANSFER_COLLECTION).add({ data: docData });

  return {
    success: true,
    id: addRes._id,
    record: { ...docData, _id: addRes._id, createTime: now.toISOString() }
  };
}

async function handleRecordPurchase(event, caller, OPENID) {
  const { storeId, item, quantityJin, amount, receiptImage } = event;

  if (!VALID_ITEMS.includes(item)) return { success: false, error: '请选择合法的物资类目' };
  const qty = sanitizePositiveNumber(quantityJin);
  if (qty === undefined) return { success: false, error: '请输入大于 0 的采购重量（斤）' };
  const safeAmount = sanitizeNonNegativeNumber(amount);
  if (safeAmount === undefined) return { success: false, error: '金额格式不正确' };

  const target = await resolveAccessTarget(caller, storeId);
  if (!target.allowed) return { success: false, error: target.error };

  const docData = {
    tenantId: target.tenantId,
    storeId: target.storeId,
    storeName: target.store.storeName || '',
    item,
    itemLabel: ITEM_LABELS[item],
    quantityJin: qty,
    amount: safeAmount === null ? 0 : safeAmount,
    receiptImage: String(receiptImage || '').slice(0, 500),
    operatorOpenId: OPENID,
    operatorName: caller.realName || caller.nickName || '',
    remark: '',
    createTime: db.serverDate()
  };

  const addRes = await db.collection(PURCHASE_COLLECTION).add({ data: docData });
  return { success: true, id: addRes._id };
}

async function handleListTransfers(event, caller) {
  const { storeId, limit } = event;
  const target = await resolveAccessTarget(caller, storeId);
  if (!target.allowed) return { success: false, error: target.error };

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
  const [outRes, inRes] = await Promise.all([
    db.collection(TRANSFER_COLLECTION)
      .where({ tenantId: target.tenantId, fromStoreId: target.storeId })
      .orderBy('createTime', 'desc').limit(safeLimit).get(),
    db.collection(TRANSFER_COLLECTION)
      .where({ tenantId: target.tenantId, toStoreId: target.storeId })
      .orderBy('createTime', 'desc').limit(safeLimit).get()
  ]);

  const merged = [...(outRes.data || []), ...(inRes.data || [])]
    .sort((a, b) => new Date(b.createTime).getTime() - new Date(a.createTime).getTime())
    .slice(0, safeLimit);

  return { success: true, data: merged };
}

async function handleSetBaseline(event, caller) {
  const target = await resolveAccessTarget(caller, event.storeId);
  if (!target.allowed) return { success: false, error: target.error };

  const baseline = {};
  for (const key of VALID_ITEMS) {
    const v = sanitizeNonNegativeNumber(event[key]);
    if (v === undefined) return { success: false, error: `${ITEM_LABELS[key]}初始存量格式不正确` };
    baseline[key] = v === null ? 0 : v;
  }
  baseline.updatedAt = db.serverDate();
  baseline.updatedBy = caller.realName || caller.nickName || '';

  await db.collection('stores').doc(target.storeId).update({ data: { materialStockBaseline: baseline } });
  return { success: true, baseline };
}

// 🙋（2026-09-19 历史明细列表页）listTransfers 是调拨弹窗内嵌小列表专用
// （小 limit、管理员专属），这两个 history action 是给独立的历史明细
// 页用的：一次性返回上限较高的全量记录（HISTORY_MAX_LIMIT），日期范围/
// 物资类目筛选交给客户端在这批数据上现算——列表本身的数据量级（单店几个月
// 的调拨/采购流水）不需要服务端分页，见 pages 侧 lib/materialHistoryFilters.js
// 头部注释。志工只读可见（allowVolunteer:true），不产生任何写副作用
const HISTORY_MAX_LIMIT = 200;

async function handleListTransferHistory(event, caller) {
  const { storeId } = event;
  const target = await resolveAccessTarget(caller, storeId, { allowVolunteer: true });
  if (!target.allowed) return { success: false, error: target.error };

  const [outRes, inRes] = await Promise.all([
    db.collection(TRANSFER_COLLECTION)
      .where({ tenantId: target.tenantId, fromStoreId: target.storeId })
      .orderBy('createTime', 'desc').limit(HISTORY_MAX_LIMIT).get(),
    db.collection(TRANSFER_COLLECTION)
      .where({ tenantId: target.tenantId, toStoreId: target.storeId })
      .orderBy('createTime', 'desc').limit(HISTORY_MAX_LIMIT).get()
  ]);

  const merged = [...(outRes.data || []), ...(inRes.data || [])]
    .sort((a, b) => new Date(b.createTime).getTime() - new Date(a.createTime).getTime())
    .slice(0, HISTORY_MAX_LIMIT);

  return { success: true, data: merged };
}

async function handleListPurchaseHistory(event, caller) {
  const { storeId } = event;
  const target = await resolveAccessTarget(caller, storeId, { allowVolunteer: true });
  if (!target.allowed) return { success: false, error: target.error };

  const res = await db.collection(PURCHASE_COLLECTION)
    .where({ tenantId: target.tenantId, storeId: target.storeId })
    .orderBy('createTime', 'desc').limit(HISTORY_MAX_LIMIT).get();

  return { success: true, data: res.data || [] };
}

exports.main = async (event) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();

  if (!action) return { success: false, error: '缺少 action 参数' };

  try {
    const caller = await resolveCaller(OPENID);

    if (action === 'getStock') return await handleGetStock(event, caller);
    if (action === 'create') return await handleCreateTransfer(event, caller, OPENID);
    if (action === 'recordPurchase') return await handleRecordPurchase(event, caller, OPENID);
    if (action === 'listTransfers') return await handleListTransfers(event, caller);
    if (action === 'setBaseline') return await handleSetBaseline(event, caller);
    if (action === 'listTransferHistory') return await handleListTransferHistory(event, caller);
    if (action === 'listPurchaseHistory') return await handleListPurchaseHistory(event, caller);

    return { success: false, error: `不支持的 action: ${action}` };
  } catch (err) {
    console.error('[manageMaterialTransfer] 异常:', err);
    return { success: false, error: err.message || '操作失败' };
  }
};
