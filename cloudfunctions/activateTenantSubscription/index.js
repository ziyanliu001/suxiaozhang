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
// action: 'revoke'   —— 平台管理员作废一张尚未核销的激活码（如铸造错档位/
//                        打印出错/联系人取消订单），仅对 status === 'UNUSED'
//                        的码生效——已核销的码代表机构已经拿到了实打实的套餐
//                        权益，作废它不会、也不该收回已生效的 tenant_subscriptions

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

// 🏛️ 「方案一：按机构维度统一授权与门店配额管理」——与 checkTenantPermission/
// createStore/manageTenantSubscription 三处完全同一份拷贝（本仓库一贯做法：
// 各云函数独立部署，没有跨函数共享模块机制）。兑换激活码时按码上标注的套餐
// 档位自动同步门店上限（见 handleRedeem），不需要平台管理员再手动补一次
// createOrRenewSubscription 才能把门店配额调对
const PLAN_STORE_LIMITS = { basic: 2, pro: 10, enterprise: 30 };

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
  if (event.status === 'UNUSED' || event.status === 'USED' || event.status === 'REVOKED') {
    where.status = event.status;
  }

  // 📄 分页：台账会随着一批批铸造持续增长，不能无限期一次性拉全量。skip 由
  // 客户端"触底加载更多"累加传入；多查一条（PAGE_SIZE + 1）用来判断 hasMore，
  // 不需要额外一次 count() 查询总数
  const PAGE_SIZE = 20;
  const skip = Math.max(parseInt(event.skip, 10) || 0, 0);
  let codes = [];
  let hasMore = false;
  try {
    const res = await db.collection(ACTIVATION_CODES_COLLECTION)
      .where(where)
      .orderBy('createdAt', 'desc')
      .skip(skip)
      .limit(PAGE_SIZE + 1)
      .get();
    const rows = res.data || [];
    hasMore = rows.length > PAGE_SIZE;
    codes = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
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
    hasMore,
    nextSkip: skip + codes.length,
    codes: codes.map((c) => ({
      _id: c._id,
      code: c.code,
      planType: c.planType,
      durationDays: c.durationDays,
      status: c.status,
      createdAt: c.createdAt,
      redeemedAt: c.redeemedAt,
      redeemedByTenantName: c.redeemedByTenantId ? (tenantNameMap[c.redeemedByTenantId] || c.redeemedByTenantId) : '',
      revokedAt: c.revokedAt,
      revokeReason: c.revokeReason || ''
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

  // 🏢 任务 A：核销成功后同步更新最大允许门店数（cloudQuota.storeLimit）。
  // 同样"只升不降"——取"该档位的默认配额"与"机构此前已有的配额"两者较大值，
  // 而不是无条件覆盖：避免抹掉平台管理员此前手动为该机构额外购买的扩容包
  // 配额（如 enterprise 默认 30 家，但这家机构谈了个 50 家的定制合同），
  // 兑换一张不影响档位的低阶码也不应该把扩容包配额打回默认值
  const existingStoreLimit = (existing && existing.cloudQuota && existing.cloudQuota.storeLimit) || 0;
  const planDefaultStoreLimit = PLAN_STORE_LIMITS[finalPlanType] || PLAN_STORE_LIMITS[DEFAULT_PLAN_TYPE];
  const finalStoreLimit = Math.max(existingStoreLimit, planDefaultStoreLimit);

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
        renewalHistory: _.push(renewalEntry),
        cloudQuota: { ...(existing.cloudQuota || {}), storeLimit: finalStoreLimit }
      }
    });
  } else {
    const newSubData = {
      tenantId,
      planType: finalPlanType,
      serviceStartDate: today,
      serviceExpireDate: newExpireDate,
      cloudQuota: { storeLimit: finalStoreLimit },
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
      serviceExpireDate: newExpireDate,
      storeLimit: finalStoreLimit
    }
  };
}

// 🗑️ 作废激活码：仅平台管理员可执行，且只对 status === 'UNUSED' 的码生效。
// 按 _id 精确定位（而不是重新解析用户输入的卡号文本）——本函数只在平台管理员
// 自己的台账列表里调用，doc._id 早已由 handleList 原样透传给前端，不存在
// "作废别人猜出来的码" 这类越权场景，不需要走 handleRedeem 那套输入校验/
// 归一化逻辑
async function handleRevoke(event, OPENID) {
  const caller = await resolveCaller(OPENID);
  if (!caller || caller.role !== 'platform_admin') {
    return { success: false, error: '无权限：仅平台管理员可作废激活码' };
  }

  const codeId = event.codeId;
  if (!codeId) {
    return { success: false, error: '缺少 codeId 参数' };
  }
  const reason = String(event.reason || '').trim();
  if (!reason) {
    return { success: false, error: '请填写作废原因，便于后续对账审计' };
  }

  const codeRes = await db.collection(ACTIVATION_CODES_COLLECTION).doc(codeId).get().catch(() => null);
  const codeDoc = codeRes && codeRes.data;
  if (!codeDoc) {
    return { success: false, error: '激活码不存在' };
  }
  if (codeDoc.status !== 'UNUSED') {
    // 🛡️ 已核销的码代表机构已经拿到了实打实的套餐权益，作废它不会、也不该
    // 收回已生效的 tenant_subscriptions——只有还没被兑换掉的码才能作废
    return { success: false, error: codeDoc.status === 'REVOKED' ? '该激活码已作废，无需重复操作' : '该激活码已被核销，无法作废' };
  }

  await db.collection(ACTIVATION_CODES_COLLECTION).doc(codeId).update({
    data: {
      status: 'REVOKED',
      revokedBy: OPENID,
      revokedAt: db.serverDate(),
      revokeReason: reason
    }
  });

  return { success: true };
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
    if (action === 'revoke') {
      return await handleRevoke(event, OPENID);
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
    // 🐛 根因修复：兜底文案此前是 `err.message || '操作失败'`，err.message
    // 可能是任意底层异常的原始措辞，不该原样展示给用户。统一改为固定友好
    // 文案，详细堆栈已经在上面 console.error 里，便于开发者排查
    return { success: false, error: '操作失败，请重试' };
  }
};
