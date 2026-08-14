// 云函数：activateTenantSubscription
// 【激活码/授权码自助兑换】项目尚未接入微信支付商户号前的"完全自动化授权"
// 替代方案：机构自己的 super_admin/store_patriarch 输入一张预先铸造好的激活码，
// 校验通过立即生效——不经过任何人工审批，也不需要联系平台管理员/开发者。
//
// 🏛️ 架构对齐：订阅数据的唯一真源仍是 tenant_subscriptions 集合（与
// manageTenantSubscription/checkTenantPermission 完全同一张表、同一套
// planType/serviceExpireDate 字段），本函数只是多加了一条"自助生效"的写入
// 路径，不新开一份 tenants.subscriptionStatus/expiresAt 影子字段——两处都记
// "套餐是什么"，后续一旦只改了其中一处，就会出现两个地方说法不一致的数据
// 完整性 bug（这个教训 checkTenantPermission 文件头注释里已经写明，这里不
// 重蹈覆辙）。写入这张表后，checkTenantPermission/getNationalDashboard 等
// 既有鉴权链路无需任何改动就能立即认到新的套餐状态。
//
// action: 'generate' —— 平台管理员批量铸造激活码（不对外自助开放，机构自己
//                        无法凭空生成激活码兑换给自己，只能拿到已购买/已分发
//                        的实体卡号/授权码来兑换）
// action: 'redeem'   —— 机构自己的 super_admin/store_patriarch 自助兑换，
//                        一次性核销，立即延长/开通 tenant_subscriptions
// action: 'list'     —— 平台管理员查看已铸造的激活码台账（按状态筛选/翻页），
//                        铸造与分发管理页依赖这个动作回看历史批次、核对哪些
//                        已经被兑换、卖给了哪家机构，不是本次自动化范围但同样
//                        只对平台管理员开放

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const ACTIVATION_CODES_COLLECTION = 'tenant_activation_codes';
const TENANT_SUB_COLLECTION = 'tenant_subscriptions';
const DEFAULT_DURATION_DAYS = 365;
const DEFAULT_PLAN_TYPE = 'pro';
// 激活码只用来解锁付费档位——basic 本就是默认免费档，没有"兑换成 basic"这回事
const VALID_PLAN_TYPES = ['pro', 'enterprise'];
const PLAN_RANK = { basic: 0, pro: 1, enterprise: 2 };
const MAX_BATCH_QUANTITY = 50;

// 🌟 高对比度字符集：剔除 0/O、1/I 这类肉眼易混淆字符，与 manageStoreInviteCode
// 同一套生成规则，人工朗读/誊抄卡号不容易抄错
const CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// 🛡️ -502005 DATABASE_COLLECTION_NOT_EXIST：tenant_activation_codes 是本次
// 新增的集合，云环境里可能还没人手动建过表——与 manageStoreInviteCode/
// manageTenantSubscription 同一套自愈口径
function isCollectionNotExistError(err) {
  return !!err && (err.errCode === -502005 || /database collection not exists/i.test(String(err.errMsg || err.message || '')));
}

function generateRandomCode() {
  let raw = '';
  for (let i = 0; i < 12; i++) {
    raw += CODE_CHARSET[Math.floor(Math.random() * CODE_CHARSET.length)];
  }
  return { display: `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`, normalized: raw };
}

function normalizeCodeInput(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDaysToDateStr(dateStr, days) {
  let base = dateStr ? new Date(dateStr) : new Date();
  if (Number.isNaN(base.getTime())) {
    base = new Date();
  }
  base.setDate(base.getDate() + days);
  const y = base.getFullYear();
  const m = String(base.getMonth() + 1).padStart(2, '0');
  const day = String(base.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

async function ensureActivationCodesCollection() {
  try {
    await db.collection(ACTIVATION_CODES_COLLECTION).limit(1).get();
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    await db.createCollection(ACTIVATION_CODES_COLLECTION).catch(() => {});
  }
}

async function findCodeByNormalized(codeNormalized) {
  try {
    const res = await db.collection(ACTIVATION_CODES_COLLECTION).where({ codeNormalized }).limit(1).get();
    return (res.data && res.data[0]) || null;
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    await db.createCollection(ACTIVATION_CODES_COLLECTION).catch(() => {});
    return null;
  }
}

// 🔒 铸造激活码：仅平台管理员（运营方自己）可执行，机构侧账号无法自己生成
// 激活码兑换给自己——激活码代表的是"已经通过其他渠道完成的一笔付款"，铸造
// 环节本身不在本次自动化范围内（尚未接入支付网关，见文件头注释）
async function handleGenerate(event, OPENID) {
  const caller = await resolveCaller(OPENID);
  if (!caller || caller.role !== 'platform_admin') {
    return { success: false, error: '无权限：仅平台管理员可铸造激活码' };
  }

  const planType = VALID_PLAN_TYPES.includes(event.planType) ? event.planType : DEFAULT_PLAN_TYPE;
  const durationDays = Number.isFinite(event.durationDays) && event.durationDays > 0
    ? Math.floor(event.durationDays)
    : DEFAULT_DURATION_DAYS;
  const quantity = Math.min(Math.max(parseInt(event.quantity, 10) || 1, 1), MAX_BATCH_QUANTITY);

  await ensureActivationCodesCollection();

  const codes = [];
  for (let i = 0; i < quantity; i++) {
    const { display, normalized } = generateRandomCode();
    const codeData = {
      code: display,
      codeNormalized: normalized,
      planType,
      durationDays,
      status: 'UNUSED',
      createdBy: OPENID,
      createdAt: db.serverDate(),
      redeemedBy: null,
      redeemedByTenantId: null,
      redeemedAt: null
    };
    await db.collection(ACTIVATION_CODES_COLLECTION).add({ data: codeData });
    codes.push({ code: display, planType, durationDays });
  }

  return { success: true, codes };
}

// 📋 铸造历史台账：仅平台管理员可查看，按状态筛选（不传/'all' 时不过滤）。
// 已兑换的码额外反查一次 tenants 集合把 redeemedByTenantId 换成机构名——
// 管理页不需要自己再记一遍每个 tenantId 对应哪家机构
async function handleList(event, OPENID) {
  const caller = await resolveCaller(OPENID);
  if (!caller || caller.role !== 'platform_admin') {
    return { success: false, error: '无权限：仅平台管理员可查看激活码台账' };
  }

  await ensureActivationCodesCollection();

  const where = {};
  if (event.status === 'UNUSED' || event.status === 'USED') {
    where.status = event.status;
  }

  const LIST_LIMIT = 100;
  let codes = [];
  try {
    const res = await db.collection(ACTIVATION_CODES_COLLECTION)
      .where(where)
      .orderBy('createdAt', 'desc')
      .limit(LIST_LIMIT)
      .get();
    codes = res.data || [];
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    codes = [];
  }

  const tenantIds = Array.from(new Set(codes.filter((c) => c.redeemedByTenantId).map((c) => c.redeemedByTenantId)));
  const tenantNameMap = {};
  if (tenantIds.length > 0) {
    try {
      const tenantsRes = await db.collection('tenants').where({ _id: _.in(tenantIds) }).field({ name: true }).get();
      (tenantsRes.data || []).forEach((t) => { tenantNameMap[t._id] = t.name || t._id; });
    } catch (err) {
      // 机构名查询失败不影响主列表展示，静默降级为展示原始 tenantId
    }
  }

  return {
    success: true,
    codes: codes.map((c) => ({
      code: c.code,
      planType: c.planType,
      durationDays: c.durationDays,
      status: c.status,
      createdAt: c.createdAt,
      redeemedAt: c.redeemedAt,
      redeemedByTenantName: c.redeemedByTenantId ? (tenantNameMap[c.redeemedByTenantId] || c.redeemedByTenantId) : ''
    }))
  };
}

// 🌸 自助兑换：机构自己的 super_admin/store_patriarch 输入激活码即时生效，
// 全程无需任何人工审批。tenantId 只从调用者自己的 user_roles 记录反查，
// 绝不信任客户端传参——否则伪造/猜测其他机构的 tenantId 就能把激活码平白
// 兑换到别的机构账上（与 checkTenantPermission 同一条防线）
async function handleRedeem(event, OPENID) {
  const codeNormalized = normalizeCodeInput(event.activationCode || event.code);
  if (!codeNormalized) {
    return { success: false, error: '请输入有效的激活码' };
  }

  const caller = await resolveCaller(OPENID);
  if (!caller || caller.status !== 'approved') {
    return { success: false, error: '无权限：账号尚未通过审核' };
  }
  // 🛡️ 仅机构自己的最高管理者可自助兑换：与本页"套餐升级/续费"卡片本身的
  // 唤起权限保持一致（见 profile.ts onGoToPlatformAdminTenants 注释：
  // super_admin/store_patriarch 才能唤起这张卡片，其余角色连入口都看不到）
  if (caller.role !== 'super_admin' && caller.role !== 'store_patriarch') {
    return { success: false, error: '无权限：仅超级管理员/大家长可兑换激活码' };
  }
  const tenantId = caller.tenantId || '';
  if (!tenantId) {
    return { success: false, error: '无法确认您所属的机构，暂不支持兑换激活码' };
  }

  const codeDoc = await findCodeByNormalized(codeNormalized);
  if (!codeDoc) {
    return { success: false, error: '激活码不存在或输入有误' };
  }
  if (codeDoc.status !== 'UNUSED') {
    return { success: false, error: '该激活码已被使用，一次性口令不可重复兑换' };
  }

  const planType = VALID_PLAN_TYPES.includes(codeDoc.planType) ? codeDoc.planType : DEFAULT_PLAN_TYPE;
  const durationDays = codeDoc.durationDays > 0 ? codeDoc.durationDays : DEFAULT_DURATION_DAYS;

  let existing = null;
  try {
    const subRes = await db.collection(TENANT_SUB_COLLECTION)
      .where({ tenantId })
      .orderBy('lastRenewedAt', 'desc')
      .limit(1)
      .get();
    existing = (subRes.data && subRes.data[0]) || null;
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    existing = null;
  }

  const today = todayStr();
  // 🌟 续期不清零：已生效套餐且尚未到期时，从"现有到期日"往后顺延，而不是从
  // 今天重新起算——提前兑换续费码不会白白损失剩余天数
  const existingExpire = existing && existing.serviceExpireDate;
  const existingStillValid = !!existingExpire && new Date(existingExpire).getTime() > Date.now();
  const baseDate = existingStillValid ? existingExpire : today;
  const newExpireDate = addDaysToDateStr(baseDate, durationDays);

  // 🌟 只升不降：已经是 enterprise 的机构兑换一张 pro 激活码，不应该被打回 pro
  const existingPlanRank = existing ? (PLAN_RANK[existing.planType] || 0) : 0;
  const codePlanRank = PLAN_RANK[planType] || 0;
  const finalPlanType = codePlanRank >= existingPlanRank ? planType : existing.planType;

  const renewalEntry = {
    operatorId: OPENID,
    operateTime: db.serverDate(),
    fromExpireDate: existing ? existing.serviceExpireDate : null,
    toExpireDate: newExpireDate,
    reason: `激活码自助兑换：${codeDoc.code}`
  };

  if (existing) {
    await db.collection(TENANT_SUB_COLLECTION).doc(existing._id).update({
      data: {
        planType: finalPlanType,
        serviceExpireDate: newExpireDate,
        serviceStartDate: existing.serviceStartDate || today,
        status: 'active',
        lastRenewedAt: db.serverDate(),
        renewalHistory: _.push(renewalEntry)
      }
    });
  } else {
    const newSubData = {
      tenantId,
      planType: finalPlanType,
      serviceStartDate: today,
      serviceExpireDate: newExpireDate,
      cloudQuota: {},
      status: 'active',
      lastRenewedAt: db.serverDate(),
      renewalHistory: [renewalEntry]
    };
    try {
      await db.collection(TENANT_SUB_COLLECTION).add({ data: newSubData });
    } catch (err) {
      if (!isCollectionNotExistError(err)) throw err;
      await db.createCollection(TENANT_SUB_COLLECTION).catch(() => {});
      await db.collection(TENANT_SUB_COLLECTION).add({ data: newSubData });
    }
  }

  // 首次开通/续费成功后，机构状态从 trial/suspended/expired 转为 active——
  // 与 manageTenantSubscription createOrRenewSubscription 同一条自愈口径
  await db.collection('tenants').doc(tenantId).update({
    data: { status: 'active' }
  }).catch(() => {});

  await db.collection(ACTIVATION_CODES_COLLECTION).doc(codeDoc._id).update({
    data: {
      status: 'USED',
      redeemedBy: OPENID,
      redeemedByTenantId: tenantId,
      redeemedAt: db.serverDate()
    }
  });

  return {
    success: true,
    data: {
      planType: finalPlanType,
      serviceExpireDate: newExpireDate
    }
  };
}

exports.main = async (event) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();

  if (!OPENID) {
    return { success: false, error: '无法获取用户身份' };
  }

  try {
    if (action === 'generate') {
      return await handleGenerate(event, OPENID);
    }
    if (action === 'redeem') {
      return await handleRedeem(event, OPENID);
    }
    if (action === 'list') {
      return await handleList(event, OPENID);
    }
    return { success: false, error: `不支持的 action: ${action}` };
  } catch (err) {
    console.error('[activateTenantSubscription] 异常:', err);
    // 🛡️ 严禁把裸的数据库报错（如 -502005 DATABASE_COLLECTION_NOT_EXIST）暴露给
    // 终端用户——各写/读路径已经各自做了自愈重试，这里是兜底防线
    if (isCollectionNotExistError(err)) {
      return { success: false, error: '系统配置维护中，请联系技术支持' };
    }
    return { success: false, error: err.message || '操作失败' };
  }
};
