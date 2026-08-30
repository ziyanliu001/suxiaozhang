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
// 🆕 codeType 维度：一张激活码要么是 'package'（常规套餐码，兑换后累加
//    plan_expire_at 有效期 + 更新 plan_type/max_stores_limit），要么是
//    'add_on'（扩容门店包码，兑换后只在当前 max_stores_limit 基础上累加
//    extraStores 家门店名额，不触碰 plan_type/plan_expire_at）——两者互不
//    影响，机构可以先兑换扩容包把门店上限拉高，再单独续费套餐年限，反之亦然
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
// 🐛 根因修复（2102 年到期日溢出）：generate 表单的"有效期天数"此前只校验
// `> 0`，没有上限——平台管理员一次多打/少删一个 0（如把 365 误输成 3650、
// 36500）会铸造出一张携带巨额 durationDays 的激活码，兑换后 addDaysToDateStr
// 会"正确地"把这个天数加上去，产生类似 2102 年这种远超预期的到期日。这不是
// 日期计算逻辑本身的 bug（setDate 累加天数没有任何溢出问题），而是数值输入
// 缺少合理上限——铸造激活码本就是给"按年付费"场景用的，10 年封顶足够覆盖
// 任何真实合同场景，超出这个范围基本可以断定是误输入
const MAX_DURATION_DAYS = 3650; // 10 年封顶
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
// 🏢 扩容门店包：单码默认加 1 家门店（generate 时可传 extraStores 铸造"加 N 家"
// 的批量装），上限 20 家/张，防止误操作铸造出一张能把配额拉到离谱数值的码
const DEFAULT_ADD_ON_EXTRA_STORES = 1;
const MAX_ADD_ON_EXTRA_STORES = 20;
const CODE_TYPES = ['package', 'add_on'];

// 🩹 一次性数据修复（action: 'repairNationalTenantExpireDate'）：订正开发环境
// 「雨花斋（全国总览机构）」在 tenants.expiresAt / tenant_subscriptions.
// serviceExpireDate 里残留的异常到期日脏数据（如 2102-12-31，根因见文件头
// 2102 年到期日溢出注释——handleRedeem 此前未对历史激活码的 durationDays
// 做封顶，兑换一张封顶修复前铸造的老码就会算出这类异常日期）。TARGET_TENANT_ID
// 与 createStore/updateStoreName/updateStoreStatus/processRoleAudit/
// manageTenantSubscription 五处 ensureNationalTenant() 完全同一份 ID 拷贝
// （各云函数独立部署，没有跨函数共享模块机制）。这是一次性维护动作，不是
// 常规业务写路径，用完即可从 exports.main 里移除这个 action 分支
const REPAIR_TARGET_TENANT_ID = 'yuhuazhai_national';
// 修复目标日期：与 addDaysToDateStr(今天, 365) 同一口径，落库统一用
// YYYY-MM-DD（不带时间/时区），与本文件/全项目所有到期日字段的既有约定一致
const REPAIR_TARGET_EXPIRE_DATE = '2027-08-30';

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

  const codeType = CODE_TYPES.includes(event.codeType) ? event.codeType : 'package';
  const quantity = Math.min(Math.max(parseInt(event.quantity, 10) || 1, 1), MAX_BATCH_QUANTITY);

  await ensureActivationCodesCollection();

  const codes = [];

  if (codeType === 'add_on') {
    // 🏢 扩容门店包码：不带 planType/durationDays，只带 extraStores（本张码
    // 兑换后为机构额外增加的门店名额）
    const extraStores = Math.min(
      Math.max(parseInt(event.extraStores, 10) || DEFAULT_ADD_ON_EXTRA_STORES, 1),
      MAX_ADD_ON_EXTRA_STORES
    );
    for (let i = 0; i < quantity; i++) {
      const { display, normalized } = generateRandomCode();
      const codeData = {
        code: display,
        codeNormalized: normalized,
        codeType: 'add_on',
        extraStores,
        status: 'UNUSED',
        createdBy: OPENID,
        createdAt: db.serverDate(),
        redeemedBy: null,
        redeemedByTenantId: null,
        redeemedAt: null
      };
      await db.collection(ACTIVATION_CODES_COLLECTION).add({ data: codeData });
      codes.push({ code: display, codeType: 'add_on', extraStores });
    }
    return { success: true, codes };
  }

  const planType = VALID_PLAN_TYPES.includes(event.planType) ? event.planType : DEFAULT_PLAN_TYPE;
  const durationDays = Number.isFinite(event.durationDays) && event.durationDays > 0
    ? Math.min(Math.floor(event.durationDays), MAX_DURATION_DAYS)
    : DEFAULT_DURATION_DAYS;

  for (let i = 0; i < quantity; i++) {
    const { display, normalized } = generateRandomCode();
    const codeData = {
      code: display,
      codeNormalized: normalized,
      codeType: 'package',
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
    codes.push({ code: display, codeType: 'package', planType, durationDays });
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
      codeType: c.codeType || 'package',
      planType: c.planType,
      durationDays: c.durationDays,
      extraStores: c.extraStores,
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

  // 🏢 扩容门店包码：只累加 max_stores_limit（cloudQuota.storeLimit），完全
  // 不碰 plan_type/plan_expire_at——与常规套餐码是两条独立的兑换路径
  if (codeDoc.codeType === 'add_on') {
    const extraStores = codeDoc.extraStores > 0 ? codeDoc.extraStores : DEFAULT_ADD_ON_EXTRA_STORES;
    // 基准配额：机构此前已有订阅记录时取其"当前生效配额"（显式存储值优先，
    // 否则回落到该套餐档位的默认值）；从未订阅过（纯 basic 机构首次兑换扩容包）
    // 时以 basic 默认配额为基准——扩容包叠加的是"门店数"这个独立维度，不应该
    // 因为兑换了一张扩容包就意外把机构从 basic 拔高成付费套餐
    const baseStoreLimit = existing
      ? ((existing.cloudQuota && existing.cloudQuota.storeLimit) || PLAN_STORE_LIMITS[existing.planType] || PLAN_STORE_LIMITS.basic)
      : PLAN_STORE_LIMITS.basic;
    const finalStoreLimit = baseStoreLimit + extraStores;

    const addOnEntry = {
      operatorId: OPENID,
      operateTime: db.serverDate(),
      fromExpireDate: existing ? existing.serviceExpireDate : null,
      toExpireDate: existing ? existing.serviceExpireDate : null,
      reason: `扩容门店包自助兑换：${codeDoc.code}（+${extraStores} 家门店）`
    };

    if (existing) {
      await db.collection(TENANT_SUB_COLLECTION).doc(existing._id).update({
        data: {
          status: 'active',
          lastRenewedAt: db.serverDate(),
          renewalHistory: _.push(addOnEntry),
          cloudQuota: { ...(existing.cloudQuota || {}), storeLimit: finalStoreLimit }
        }
      });
    } else {
      const newSubData = {
        tenantId,
        planType: 'basic',
        serviceStartDate: today,
        // basic 版本身没有到期概念，扩容包同样不赋予有效期——门店名额长期有效，
        // 直到机构自己升级/续费付费套餐才会引入真正的到期日
        serviceExpireDate: null,
        cloudQuota: { storeLimit: finalStoreLimit },
        status: 'active',
        lastRenewedAt: db.serverDate(),
        renewalHistory: [addOnEntry]
      };
      try {
        await db.collection(TENANT_SUB_COLLECTION).add({ data: newSubData });
      } catch (err) {
        if (!isCollectionNotExistError(err)) throw err;
        await db.createCollection(TENANT_SUB_COLLECTION).catch(() => {});
        await db.collection(TENANT_SUB_COLLECTION).add({ data: newSubData });
      }
    }

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
        codeType: 'add_on',
        extraStores,
        storeLimit: finalStoreLimit,
        planType: existing ? existing.planType : 'basic',
        serviceExpireDate: existing ? existing.serviceExpireDate : null
      }
    };
  }

  const planType = VALID_PLAN_TYPES.includes(codeDoc.planType) ? codeDoc.planType : DEFAULT_PLAN_TYPE;
  // 🐛 根因修复（专业版被误判永久有效的真正源头）：handleGenerate 铸造新码时
  // 已用 MAX_DURATION_DAYS 把 durationDays 封顶（见文件头 2102 年到期日溢出
  // 注释），但那只挡住"以后新铸造的码"——这里兑换时直接信任 codeDoc.durationDays
  // 里已经落库的值，对封顶修复上线前就已经铸造好、还没被兑换的historical
  // 激活码没有任何防护，兑一张这样的老码依然会算出 2102 年这种异常到期日。
  // 兑换时再套一层同样的封顶，双重保险确保不管码是什么时候铸造的，兑换出的
  // 到期日永远落在合理区间内
  const durationDays = Math.min(codeDoc.durationDays > 0 ? codeDoc.durationDays : DEFAULT_DURATION_DAYS, MAX_DURATION_DAYS);

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
      codeType: 'package',
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

// 🩹 一次性数据修复：见上方 REPAIR_TARGET_TENANT_ID 声明处注释。仅平台管理员
// 可执行；只精确改写 REPAIR_TARGET_TENANT_ID 这一个机构名下的记录，不做任何
// 批量/模糊匹配，不会误伤其他机构的正常订阅数据。tenant_subscriptions 下该
// 机构可能存在多条历史记录（每次续费都是 update 同一条，但不排除历史上因
// 集合曾不存在触发过 add() 兜底产生多条），全部一并修正，不只挑"最近一次
// 续费"的那一条，避免脏数据残留在旧记录里
async function handleRepairNationalTenantExpireDate(OPENID) {
  const caller = await resolveCaller(OPENID);
  if (!caller || caller.role !== 'platform_admin') {
    return { success: false, error: '无权限：仅平台管理员可执行该修复动作' };
  }

  const result = {
    tenantId: REPAIR_TARGET_TENANT_ID,
    repairedExpireDate: REPAIR_TARGET_EXPIRE_DATE,
    tenantsDocUpdated: false,
    subscriptionsFound: 0,
    subscriptionsUpdated: 0
  };

  // 1) tenants 集合：到期字段是 expiresAt（与 createSubscriptionOrder/lib/
  // applyPayment.js 支付成功后写回的字段名一致，不是 serviceExpireDate——
  // 那个字段名只存在于 tenant_subscriptions 集合，两个集合各自的字段命名
  // 不同，不能混用同一个名字去改）
  const tenantRes = await db.collection('tenants').doc(REPAIR_TARGET_TENANT_ID).get().catch(() => null);
  if (tenantRes && tenantRes.data) {
    await db.collection('tenants').doc(REPAIR_TARGET_TENANT_ID).update({
      data: { expiresAt: REPAIR_TARGET_EXPIRE_DATE }
    });
    result.tenantsDocUpdated = true;
  }

  // 2) tenant_subscriptions 集合：该机构名下全部记录的 serviceExpireDate 一并
  // 修正，并各自追加一条 renewalHistory 说明本次是数据修复，不是真实续费
  const subRes = await db.collection(TENANT_SUB_COLLECTION).where({ tenantId: REPAIR_TARGET_TENANT_ID }).get().catch(() => ({ data: [] }));
  const subDocs = subRes.data || [];
  result.subscriptionsFound = subDocs.length;
  for (const doc of subDocs) {
    await db.collection(TENANT_SUB_COLLECTION).doc(doc._id).update({
      data: {
        serviceExpireDate: REPAIR_TARGET_EXPIRE_DATE,
        renewalHistory: _.push({
          operatorId: OPENID,
          operateTime: db.serverDate(),
          fromExpireDate: doc.serviceExpireDate || null,
          toExpireDate: REPAIR_TARGET_EXPIRE_DATE,
          reason: '一次性数据修复：订正开发环境异常到期日脏数据（如 2102-12-31）为正常 1 年期限'
        })
      }
    });
    result.subscriptionsUpdated += 1;
  }

  return { success: true, data: result };
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
    if (action === 'repairNationalTenantExpireDate') {
      return await handleRepairNationalTenantExpireDate(OPENID);
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
