// 云函数：createStore
// 机构超级管理员在本机构（tenant）下新建门店，写入 stores 集合并强制打上 tenantId。
//
// 🏢 多租户配额约束：新建门店前会读取该机构最新的 tenant_subscriptions 记录，
// 按 cloudQuota.storeLimit 校验门店数量上限，超出配额直接拒绝 —— 这是
// tenant_subscriptions 这张"服务订阅表"在业务链路中真正被读取并生效的地方，
// 而不仅仅是平台管理后台里的一份静态记录。
//
// 🛡️ 修复"账号尚未关联任何机构"误拦截：早期通过 setupSuperAdmin 引导创建的
// super_admin 账号可能没有传入 tenantId，导致 caller.tenantId 为空，所有依赖
// tenantId 的操作（建店、审批新门店申请）都会被误判为"未关联机构"而拦死。
// 现在 super_admin 缺失 tenantId 时统一回退到默认机构 DEFAULT_TENANT_ID
// （雨花斋总部/全国总览机构），并把该 tenantId 自愈写回其 user_roles 记录，
// 下次调用就不会再走这条兜底分支。
//
// 🌟 新增 bindAsManager：super_admin 新建门店时可选直接把自己的 storeId/storeName
// 绑定为该新店（角色仍保留 super_admin，不做降级 —— super_admin 的权限本就
// 超集覆盖 store_manager，这里只是把"当前所在门店"指向新店，便于日常报表等
// 界面默认落在这家新店上），免去二次审批流程。
//
// 🔒 事务化写入：建店文档 + bindAsManager 回写 + 默认账目模板预装，三者用
// db.startTransaction() 包在一起（与 manageReportApproval 的既有用法一致），
// 任何一步失败都整体回滚，不会留下"店建好了但模板没装成、或角色回写漏了"的
// 半成品脏数据。
//
// 🌱 账目模板预装：给新店在 expense_item_templates 里预装一组去宗教化的默认
// 常用支出项目（daily=每日食材杂购，fixed=房租/设备专项），避免"高频账目模板"
// 功能在新店第一天是空的；不编造默认金额（defaultAmount:null，与手动添加模板
// 时的既有规则一致——具体金额因店而异，不该替用户瞎填）。
//
// 🛡️ 未加"每个 OpenID 限建 1 店"的硬上限：本机构的多店配额已经由
// tenant_subscriptions.cloudQuota.storeLimit 控管（见下方配额校验），这才是
// 本产品"一个机构可以有多家门店、由同一个 super_admin 陆续建店管理"这个模型下
// 正确的防滥用边界；按 OpenID 限 1 店会直接堵死机构建第二/第三家店的正常需求。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 🛡️ 服务端内容安全兜底：门店名/初始公告此前只在小程序前端提交前调用
// msgSecCheck，绕过前端直接调用本云函数即可跳过审核——门店名对外公开展示，
// 风险较高。落库前服务端强制再查一遍，API 抖动时按 msgSecCheck 自身口径降级
// 放行，不因审核服务临时不可用而拦下正常建店。
async function checkContentSafe(text) {
  if (!text) return true;
  try {
    const res = await cloud.callFunction({
      name: 'msgSecCheck',
      data: { text, contentType: 'report' }
    });
    return !res.result || res.result.safe !== false;
  } catch (err) {
    console.warn('[createStore] 服务端内容安全检测调用失败，降级放行:', err);
    return true;
  }
}

const DEFAULT_TENANT_ID = 'yuhuazhai_national';
const DEFAULT_TENANT_STORE_LIMIT = 999;

// 🏛️ 「方案一：按机构维度统一授权与门店配额管理」——与 checkTenantPermission/
// activateTenantSubscription/manageTenantSubscription 四处完全同一份拷贝（本
// 仓库一贯做法：各云函数独立部署，没有跨函数共享模块机制）。没有任何生效中
// 订阅记录（全新机构，tenant_subscriptions 尚未初始化）时同样按 basic 档配额
// 兜底，不再单独维护一份更宽松的"试用配额"——basic 本身就是免费默认档
const PLAN_STORE_LIMITS = { basic: 2, pro: 10, enterprise: 30 };

// 🕊️ 到期宽限期（Grace Period）：与 checkTenantPermission 完全同一份拷贝（各
// 云函数独立部署，没有跨函数共享模块机制）。到期后 7 天内仍按原套餐配额放行
// 建店，不因为财务同事没来得及续费就立即把机构摁死在 basic 单店配额上
const GRACE_PERIOD_DAYS = 7;

// 🆕 轻量省市提取：超管快速建店（store-picker「新建门店」超管分支）目前只填
// 门店名称，不收集省市——province/city 缺失时尝试从门店名称/地址文本里猜一猜。
// 不追求覆盖全国行政区划，只覆盖本项目门店实际集中分布的常见地区；猜不出来
// 就返回空字符串，调用方自行决定兜底展示（如"未分类地区"），不编造数据
const REGION_CITY_TO_PROVINCE = {
  '厦门': '福建省', '漳州': '福建省', '泉州': '福建省', '福州': '福建省', '莆田': '福建省',
  '三明': '福建省', '南平': '福建省', '龙岩': '福建省', '宁德': '福建省'
};
const REGION_DISTRICT_TO_CITY = {
  '海沧': '厦门', '思明': '厦门', '湖里': '厦门', '集美': '厦门', '同安': '厦门', '翔安': '厦门',
  '芗城': '漳州', '龙文': '漳州', '龙海': '漳州',
  '鲤城': '泉州', '丰泽': '泉州', '洛江': '泉州', '泉港': '泉州', '晋江': '泉州', '石狮': '泉州', '南安': '泉州'
};
function extractRegionFromText(text) {
  const str = String(text || '');
  if (!str) return { province: '', city: '' };
  for (const cityBase of Object.keys(REGION_CITY_TO_PROVINCE)) {
    if (str.includes(cityBase)) {
      return { province: REGION_CITY_TO_PROVINCE[cityBase], city: `${cityBase}市` };
    }
  }
  for (const districtBase of Object.keys(REGION_DISTRICT_TO_CITY)) {
    if (str.includes(districtBase)) {
      const cityBase = REGION_DISTRICT_TO_CITY[districtBase];
      return { province: REGION_CITY_TO_PROVINCE[cityBase] || '', city: `${cityBase}市` };
    }
  }
  return { province: '', city: '' };
}

// 2026-09 重构：fixed 分类与 miniprogram/pages/index/index.ts 的
// EXPENSE_TEMPLATE_PRESETS.fixed 对齐收敛为 4 个标准规范项，避免新建门店种子数据
// 与前端"一键预置"/自愈兜底两套来源的命名不一致
const DEFAULT_EXPENSE_TEMPLATES = [
  { category: 'daily', itemName: '青菜' },
  { category: 'daily', itemName: '豆腐' },
  { category: 'daily', itemName: '大米' },
  { category: 'daily', itemName: '食用油' },
  { category: 'daily', itemName: '燃气费' },
  { category: 'fixed', itemName: '场地租金' },
  { category: 'fixed', itemName: '大型设备' },
  { category: 'fixed', itemName: '装修改造' },
  { category: 'fixed', itemName: '其他专项' }
];

// 确保默认机构（及其订阅配额）存在，供缺失 tenantId 的 super_admin 账号兜底使用
async function ensureNationalTenant() {
  const tenantRes = await db.collection('tenants').doc(DEFAULT_TENANT_ID).get().catch(() => null);
  if (!tenantRes || !tenantRes.data) {
    await db.collection('tenants').doc(DEFAULT_TENANT_ID).set({
      data: {
        name: '雨花斋（全国总览机构）',
        status: 'active',
        createdAt: db.serverDate(),
        createdBy: 'system_auto_init'
      }
    });
  }

  // 🛡️ tenant_subscriptions 集合可能在这套环境里还没被建过（-502005 database
  // collection not exists）——查询失败一律当"没有订阅记录"处理，走下面的 add()
  // 兜底创建，而不是让整个建店流程被一张还没初始化的订阅表卡死
  let subRes = null;
  try {
    subRes = await db.collection('tenant_subscriptions')
      .where({ tenantId: DEFAULT_TENANT_ID })
      .limit(1)
      .get();
  } catch (err) {
    console.warn('[createStore] tenant_subscriptions 查询失败（集合可能不存在），按无订阅记录处理:', err);
  }
  if (!subRes || !subRes.data || subRes.data.length === 0) {
    await db.collection('tenant_subscriptions').add({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        planType: 'enterprise',
        serviceStartDate: new Date().toISOString().slice(0, 10),
        serviceExpireDate: '2099-12-31',
        cloudQuota: { storeLimit: DEFAULT_TENANT_STORE_LIMIT },
        status: 'active',
        lastRenewedAt: db.serverDate(),
        renewalHistory: [{
          operatorId: 'system_auto_init',
          operateTime: db.serverDate(),
          fromExpireDate: null,
          toExpireDate: '2099-12-31',
          reason: '默认机构自动初始化'
        }]
      }
    });
  }
}

// 🔒 并发安全的门店配额占用：CAS（条件自增）+ 惰性迁移初始化，返回 true 代表
// 本次调用成功占用了一个配额名额（调用方后续必须真正建店；若建店失败务必调用
// releaseStoreQuota 归还），返回 false 代表配额已满
async function reserveStoreQuota(tenantId, storeLimit) {
  // 1) 常规路径：tenants.currentStoreCount 字段已存在，原子条件自增
  const casRes = await db.collection('tenants').where({
    _id: tenantId,
    currentStoreCount: _.lt(storeLimit)
  }).update({ data: { currentStoreCount: _.inc(1) } });
  if (casRes.stats.updated === 1) return true;

  // 2) 惰性迁移路径：currentStoreCount 在这条机构记录里可能还从未被写入过
  // （老机构，在"配额计数器"上线之前就已存在）。用 stores 集合的真实计数
  // 做一次性初始化——同样带 currentStoreCount 不存在 的 where 条件原子写入，
  // 若这期间另一个并发请求已经抢先完成了初始化，这次写入会 0 匹配落空，
  // 回落到步骤 3 按常规路径重试一次，不会出现"两次初始化互相覆盖导致计数
  // 偏小、变相放大配额"的问题
  const actualCountRes = await db.collection('stores').where({ tenantId }).count();
  await db.collection('tenants').where({
    _id: tenantId,
    currentStoreCount: _.exists(false)
  }).update({ data: { currentStoreCount: actualCountRes.total } }).catch(() => {});

  // 3) 兜底重试一次条件自增（覆盖"刚完成惰性初始化"或"字段已被并发请求初始化
  // 完毕"两种情形，是同一次条件自增，天然幂等安全）
  const retryRes = await db.collection('tenants').where({
    _id: tenantId,
    currentStoreCount: _.lt(storeLimit)
  }).update({ data: { currentStoreCount: _.inc(1) } });
  return retryRes.stats.updated === 1;
}

// 归还一次已占用但最终未能真正建店成功的配额名额（如建店事务本身失败），
// 避免"占用了名额、门店却没建成"导致配额被永久性泄漏、越占越少
async function releaseStoreQuota(tenantId) {
  await db.collection('tenants').doc(tenantId).update({
    data: { currentStoreCount: _.inc(-1) }
  }).catch((err) => console.error('[createStore] 配额归还失败（需要人工核对 tenants.currentStoreCount）:', tenantId, err));
}

// super_admin 缺失 tenantId 时的兜底 + 自愈回写
async function resolveCallerTenantId(caller) {
  if (caller.tenantId) return caller.tenantId;

  await ensureNationalTenant();
  await db.collection('user_roles').doc(caller._id).update({
    data: { tenantId: DEFAULT_TENANT_ID }
  }).catch(err => console.warn('[createStore] tenantId 自愈回写失败:', err));

  return DEFAULT_TENANT_ID;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { storeName, city, address, initialAnnouncement, bindAsManager, province, operatingStatus, latitude, longitude, orgType, supportedMeals } = event;
  const VALID_OPERATING_STATUSES = ['operating', 'preparing', 'paused'];
  // 🐛 根因修复（两套 orgType 枚举体系不统一）：此前这里漏了 tongxin_children/
  // tongxin_cancer_care——manageStoreProfile 的编辑白名单已经接受这两个值
  // （"同心慈善会矩阵"分组机构在用），但本函数（新建门店）的白名单没跟上，
  // 导致这两类机构永远无法通过正常建店流程创建同 orgType 的新门店。
  // 与 manageStoreProfile/index.js VALID_ORG_TYPES、createTenant/index.js
  // ORG_TYPES、miniprogram/utils/constants.ts ORG_TYPE_VALUES 四处保持
  // 同一份取值，改动这里务必同步改另外三处
  const VALID_ORG_TYPES = ['yuhuazhai', 'elderly_canteen', 'volunteer_station', 'rescue_team', 'tongxin_children', 'tongxin_cancer_care', 'other'];
  const finalOrgType = VALID_ORG_TYPES.includes(orgType) ? orgType : '';
  const finalOperatingStatus = VALID_OPERATING_STATUSES.includes(operatingStatus) ? operatingStatus : 'operating';
  // 🍚 供餐餐次配置：绝大多数雨花斋只供午餐，默认单餐次——与 manageStoreProfile
  // 同一份 MEAL_TYPES/DEFAULT_SUPPORTED_MEALS 口径（各云函数独立部署，没有跨函数
  // 共享模块机制，只能保持常量一致）。建店时未显式传入或传入非法值时回退默认档
  const MEAL_TYPES = ['breakfast', 'lunch', 'dinner'];
  const finalSupportedMeals = Array.isArray(supportedMeals)
    ? Array.from(new Set(supportedMeals.filter((m) => MEAL_TYPES.includes(m))))
    : [];

  if (!OPENID) {
    return { success: false, error: '无法获取用户身份' };
  }
  if (!storeName || !String(storeName).trim()) {
    return { success: false, error: '请填写门店名称' };
  }
  if (!(await checkContentSafe(String(storeName).trim())) || !(await checkContentSafe(String(initialAnnouncement || '').trim()))) {
    return { success: false, error: '内容包含违规信息，请修改后重新提交' };
  }

  try {
    const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
    const caller = roleRes.data && roleRes.data[0];

    if (!caller || caller.role !== 'super_admin') {
      return { success: false, error: '无权限：仅本机构超级管理员可新建门店' };
    }

    const tenantId = await resolveCallerTenantId(caller);

    // 1. 校验机构状态
    const tenantRes = await db.collection('tenants').doc(tenantId).get().catch(() => null);
    const tenant = tenantRes && tenantRes.data;
    if (tenant && (tenant.status === 'suspended' || tenant.status === 'expired')) {
      return { success: false, error: `机构服务当前处于「${tenant.status}」状态，无法新建门店，请联系平台管理员续费` };
    }

    // 2. 读取最新订阅，确定门店配额
    // 🛡️ tenant_subscriptions 集合可能尚未初始化（-502005 database collection
    // not exists）或查询异常——一律降级为"无订阅记录"，回退到试用默认配额继续
    // 建店，不能因为一张订阅表还没建好就把用户的建店请求整个挡下来
    let subRes = null;
    try {
      subRes = await db.collection('tenant_subscriptions')
        .where({ tenantId })
        .orderBy('lastRenewedAt', 'desc')
        .limit(1)
        .get();
    } catch (err) {
      console.warn('[createStore] tenant_subscriptions 查询失败（集合可能不存在），降级为试用默认配额继续建店:', err);
    }
    const subscription = subRes && subRes.data && subRes.data[0];

    let storeLimit = PLAN_STORE_LIMITS.basic;
    if (subscription) {
      if (subscription.status === 'suspended') {
        return { success: false, error: '订阅服务已暂停，无法新建门店，请联系平台管理员续费' };
      }
      // 🕊️ 宽限期：到期后 7 天内仍放行建店（按到期前的套餐配额），超出宽限期
      // 才真正拒绝——与 checkTenantPermission 的 isInGracePeriod 判断同一条口径
      const expireTime = subscription.serviceExpireDate ? new Date(subscription.serviceExpireDate).getTime() : NaN;
      const rawExpired = !Number.isNaN(expireTime) && expireTime < Date.now();
      if (rawExpired) {
        const graceDeadline = expireTime + GRACE_PERIOD_DAYS * 24 * 3600 * 1000;
        if (graceDeadline < Date.now()) {
          return { success: false, error: '服务已过期（含 7 天宽限期），无法新建门店，请联系平台管理员续费' };
        }
      }
      storeLimit = (subscription.cloudQuota && subscription.cloudQuota.storeLimit)
        || PLAN_STORE_LIMITS[subscription.planType]
        || PLAN_STORE_LIMITS.basic;
      // 🛡️ 服务端硬校验：basic（免费版）固定套餐门店配额，不信任 cloudQuota.storeLimit
      // 里可能存在的历史/脏数据（如绕开小程序前端直接调用 manageTenantSubscription
      // 云函数写入的旧记录），一律强制收敛为 basic 档配额
      if (subscription.planType === 'basic') {
        storeLimit = PLAN_STORE_LIMITS.basic;
      }
    }

    // 3. 并发安全的配额占用：用 tenants.currentStoreCount 做原子条件自增（CAS）
    // 而不是"先 count() 查询、再单独 insert"——后者存在 TOCTOU 竞态，两个并发
    // 建店请求都读到"未满配额"就都会通过校验，最终双双插入导致超额。
    // where 条件（currentStoreCount < storeLimit）与 inc(1) 操作在同一次
    // update() 里原子执行，是 MongoDB 单文档写操作天然具备的原子性保证，不需要
    // 额外的分布式锁；若这次 update 因为条件不满足而 0 匹配，代表配额确实已满。
    const reserved = await reserveStoreQuota(tenantId, storeLimit);
    if (!reserved) {
      // 🆕 errorCode：与 checkTenantPermission/getNationalDashboard 的
      // PLAN_UPGRADE_REQUIRED 同一套约定，供前端精确识别"这次失败是套餐配额
      // 问题"，从而弹出可操作的升级引导弹窗，而不是把这条 error 文案当成普通
      // 建店失败原样吐司了事
      const currentCountRes = await db.collection('tenants').doc(tenantId).field({ currentStoreCount: true }).get().catch(() => null);
      const currentCount = (currentCountRes && currentCountRes.data && currentCountRes.data.currentStoreCount) || storeLimit;
      return {
        success: false,
        error: `当前机构套餐门店额度已满(${currentCount}/${storeLimit})，请扩容或升级`,
        errorCode: 'STORE_LIMIT_REACHED'
      };
    }

    // 4-6. 建店 + bindAsManager 回写 + 默认账目模板预装，三步一个事务，失败整体回滚
    const trimmedName = String(storeName).trim();
    // 🆕 超管快速建店分支目前只填门店名称，不收集省市——province/city 都没传时，
    // 尝试从门店名称/地址文本里轻量提取兜底（"漳州XX雨花斋"→漳州市/福建省），
    // 猜不出来就留空，交给 getStoreList/getNationalDashboard 读取时兜底展示
    let finalProvince = province || '';
    let finalCity = city || '';
    if (!finalProvince && !finalCity) {
      const guessed = extractRegionFromText(`${trimmedName} ${address || ''}`);
      finalProvince = guessed.province;
      finalCity = guessed.city;
    }
    const transaction = await db.startTransaction();
    let newStoreId;
    try {
      const createRes = await transaction.collection('stores').add({
        data: {
          storeName: trimmedName,
          city: finalCity,
          // 🌟 address 独立于 city 存储：city 已被 getNationalDashboard 当作城市聚合维度使用，
          // 塞入完整地址会污染那个看板；initialAnnouncement 仅落库存证，公告系统本身
          // 目前是纯本机 wx.setStorageSync（见 index.ts onSaveNotice），前端建店成功后
          // 会自行套用到本机跑马灯，这里只负责持久化，不做任何下发/同步
          address: address || '',
          initialAnnouncement: initialAnnouncement || '',
          tenantId,
          status: 'active',
          // 🌐 门店选择器：运营状态（与上面 status 是两个不同维度，见 getStoreList 同款注释）
          // + 省份（城市已有 city 字段）+ 经纬度（供"附近门店"距离排序，可选，未提供时省略字段）
          operatingStatus: finalOperatingStatus,
          province: finalProvince,
          mealConfig: { supportedMeals: finalSupportedMeals.length > 0 ? finalSupportedMeals : ['lunch'] },
          ...(finalOrgType ? { orgType: finalOrgType } : {}),
          ...(typeof latitude === 'number' && typeof longitude === 'number' ? { latitude, longitude } : {}),
          createdBy: OPENID,
          createdAt: db.serverDate()
        }
      });
      newStoreId = createRes._id;

      // 可选：super_admin 直接把自己的当前门店指向新建的门店，免去"提交申请 -> 等待审批"
      // 的二次流程（角色仍保留 super_admin，不降级——见文件顶部注释）
      if (bindAsManager) {
        await transaction.collection('user_roles').doc(caller._id).update({
          data: {
            storeId: newStoreId,
            storeName: trimmedName
          }
        });
      }

      const now = db.serverDate();
      for (const tpl of DEFAULT_EXPENSE_TEMPLATES) {
        await transaction.collection('expense_item_templates').add({
          data: {
            tenantId,
            storeId: newStoreId,
            storeName: trimmedName,
            category: tpl.category,
            itemName: tpl.itemName,
            defaultAmount: null,
            createdBy: OPENID,
            createdAt: now,
            updateTime: now
          }
        });
      }

      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      // 🛡️ 门店没能真正建成，归还上面已经原子占用的一个配额名额，避免配额
      // 被永久性泄漏（占了名额、门店却没建出来）
      await releaseStoreQuota(tenantId);
      throw txErr;
    }

    const tenantAfterRes = await db.collection('tenants').doc(tenantId).field({ currentStoreCount: true }).get().catch(() => null);
    const currentStoreCount = (tenantAfterRes && tenantAfterRes.data && tenantAfterRes.data.currentStoreCount) || 0;

    return {
      success: true,
      storeId: newStoreId,
      storeName: trimmedName,
      tenantId,
      remainingQuota: Math.max(storeLimit - currentStoreCount, 0)
    };
  } catch (err) {
    console.error('[createStore] 异常:', err);
    return { success: false, error: err.message || '新建门店失败' };
  }
};
