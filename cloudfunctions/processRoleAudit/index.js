// 云函数：processRoleAudit - 角色申请审批（含"新建门店"自动建店）
//
// 🌟 双模式门店申请配套能力：
// 1. 已有门店（storeSelectionType === 'existing'）：沿用原有店长/超管审核逻辑。
// 2. 新建门店（storeSelectionType === 'custom' 或 storeId 为空）：仅限超级管理员审批
//    （新门店尚不存在店长人选）。审批通过时：
//    - 按 {tenantId, storeName} 在 stores 表中查重，命中则复用该门店 _id；
//    - 未命中则新建门店记录（校验机构状态与 tenant_subscriptions 门店配额，
//      与 createStore 云函数的配额规则保持一致，避免此处成为配额限制的绕行口子）；
//    - 将最终确定的 storeId / storeName 连同 tenantId 一并回写进 user_roles 权限表。
//
// 🛡️ 安全加固：storeId/storeName 不再信任客户端传入，全部以服务端已存储的
// 申请记录（user_roles 文档本身）为准重新推导，杜绝伪造 storeId 越权审核。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const _ = db.command;

const DEFAULT_TENANT_ID = 'yuhuazhai_national';
const DEFAULT_TENANT_STORE_LIMIT = 999;
const MAX_STORE_PHOTOS = 9;
const MAX_TEXT_FIELD_LENGTH = 500;

// 🏛️ 「方案一：按机构维度统一授权与门店配额管理」——与 checkTenantPermission/
// createStore/activateTenantSubscription/manageTenantSubscription 四处完全
// 同一份拷贝（本仓库一贯做法：各云函数独立部署，没有跨函数共享模块机制）。
// resolveOrCreateStore 是"自助新建门店成为首任大家长"这条自裂变路径实际建店
// 的地方，必须与 createStore 云函数走同一套配额规则/同一个 currentStoreCount
// 计数器，否则会成为配额限制的绕行口子（见文件头注释）
const PLAN_STORE_LIMITS = { basic: 2, pro: 10, enterprise: 30 };

function sanitizeText(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, MAX_TEXT_FIELD_LENGTH);
}

// storePhotos 是新建门店申请阶段收集的云存储 fileID 数组，门店本身尚未创建，
// 只能先落在申请文档上，approve 时再一并写入新建/复用的 stores 文档
function sanitizePhotos(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((item) => typeof item === 'string' && item.trim()).slice(0, MAX_STORE_PHOTOS);
}

// 🆕 轻量省市提取：申请人没有手动选省市（如老流程/客户端未升级）时，尝试从
// 门店名称/地址文本里猜一猜。不追求覆盖全国行政区划，只覆盖本项目门店实际
// 集中分布的常见地区（门店名常见"漳州XX雨花斋"这类省略"市"字的写法，或
// "海沧区雨花斋"这类只写了区名的写法）；猜不出来就返回空字符串，调用方自行
// 决定兜底展示（如"未分类地区"），不编造数据
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

// 🐛 云函数容器时区固定为 UTC，与 submitFeedback/index.js 同一套换算，避免申请
// 时间字符串比北京时间少 8 小时（这个坑在项目里已经踩过不止一次）
function formatCreateTime(createTime) {
  const d = createTime instanceof Date ? createTime : new Date(createTime);
  if (isNaN(d.getTime())) return '';
  const cst = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${cst.getUTCFullYear()}-${pad(cst.getUTCMonth() + 1)}-${pad(cst.getUTCDate())} ${pad(cst.getUTCHours())}:${pad(cst.getUTCMinutes())}`;
}

// 确保默认机构（及其订阅配额）存在，供缺失 tenantId 的 super_admin 账号兜底使用
// （与 createStore 云函数保持一致的自愈逻辑）
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

  const subRes = await db.collection('tenant_subscriptions')
    .where({ tenantId: DEFAULT_TENANT_ID })
    .limit(1)
    .get();
  if (!subRes.data || subRes.data.length === 0) {
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

// 🛡️ 修复"账号尚未分配所属机构"误拦截：super_admin 缺失 tenantId 时回退到默认机构，
// 并自愈回写，避免每次审批都要重新判定
async function resolveAuditorTenantId(auditor) {
  if (auditor.tenantId) return auditor.tenantId;

  await ensureNationalTenant();
  await db.collection('user_roles').doc(auditor._id).update({
    data: { tenantId: DEFAULT_TENANT_ID }
  }).catch(err => console.warn('[processRoleAudit] tenantId 自愈回写失败:', err));

  return DEFAULT_TENANT_ID;
}

// 按 {tenantId, storeName} 查重复用或新建门店，返回 { storeId, storeName }
// 🔒 并发安全的门店配额占用：与 createStore 云函数 reserveStoreQuota 完全
// 同一份实现（同一个 tenants.currentStoreCount 计数器，两条建店路径必须共用
// 同一套 CAS 逻辑才不会互相绕过对方的配额校验）。CAS（条件自增）+ 惰性迁移
// 初始化，返回 true 代表本次调用成功占用了一个配额名额（调用方后续必须真正
// 建店；若建店失败务必调用 releaseStoreQuota 归还），返回 false 代表配额已满
async function reserveStoreQuota(tenantId, storeLimit) {
  const casRes = await db.collection('tenants').where({
    _id: tenantId,
    currentStoreCount: _.lt(storeLimit)
  }).update({ data: { currentStoreCount: _.inc(1) } });
  if (casRes.stats.updated === 1) return true;

  const actualCountRes = await db.collection('stores').where({ tenantId }).count();
  await db.collection('tenants').where({
    _id: tenantId,
    currentStoreCount: _.exists(false)
  }).update({ data: { currentStoreCount: actualCountRes.total } }).catch(() => {});

  const retryRes = await db.collection('tenants').where({
    _id: tenantId,
    currentStoreCount: _.lt(storeLimit)
  }).update({ data: { currentStoreCount: _.inc(1) } });
  return retryRes.stats.updated === 1;
}

// 归还一次已占用但最终未能真正建店成功的配额名额，避免配额被永久性泄漏
async function releaseStoreQuota(tenantId) {
  await db.collection('tenants').doc(tenantId).update({
    data: { currentStoreCount: _.inc(-1) }
  }).catch((err) => console.error('[processRoleAudit] 配额归还失败（需要人工核对 tenants.currentStoreCount）:', tenantId, err));
}

async function resolveOrCreateStore(tenantId, storeName, operatorOpenId) {
  const existingRes = await db.collection('stores').where({ tenantId, storeName }).limit(1).get();
  if (existingRes.data && existingRes.data.length > 0) {
    const existing = existingRes.data[0];
    return { storeId: existing._id, storeName: existing.storeName };
  }

  // 校验机构状态
  const tenantRes = await db.collection('tenants').doc(tenantId).get().catch(() => null);
  const tenant = tenantRes && tenantRes.data;
  if (tenant && (tenant.status === 'suspended' || tenant.status === 'expired')) {
    throw new Error(`机构服务当前处于「${tenant.status}」状态，无法新建门店，请联系平台管理员续费`);
  }

  // 校验订阅门店配额（与 createStore 云函数保持一致）
  const subRes = await db.collection('tenant_subscriptions')
    .where({ tenantId })
    .orderBy('lastRenewedAt', 'desc')
    .limit(1)
    .get();
  const subscription = subRes.data && subRes.data[0];

  let storeLimit = PLAN_STORE_LIMITS.basic;
  if (subscription) {
    if (subscription.status === 'suspended' || subscription.status === 'expired') {
      throw new Error('订阅服务已暂停/过期，无法新建门店，请联系平台管理员续费');
    }
    const todayStr = new Date().toISOString().slice(0, 10);
    if (subscription.serviceExpireDate && subscription.serviceExpireDate < todayStr) {
      throw new Error('服务已过期，无法新建门店，请联系平台管理员续费');
    }
    storeLimit = (subscription.cloudQuota && subscription.cloudQuota.storeLimit)
      || PLAN_STORE_LIMITS[subscription.planType]
      || PLAN_STORE_LIMITS.basic;
    // 🛡️ 服务端硬校验：与 createStore 云函数保持一致——basic（免费版）固定
    // 套餐门店配额，不信任 cloudQuota.storeLimit 里可能存在的历史/脏数据，
    // 一律强制收敛为 basic 档配额
    if (subscription.planType === 'basic') {
      storeLimit = PLAN_STORE_LIMITS.basic;
    }
  }

  // 🔒 并发安全的配额占用：与 createStore 云函数同一套 CAS 计数器（见文件头
  // reserveStoreQuota 注释），不再用"先 count() 查询、再单独 insert"这种存在
  // TOCTOU 竞态的写法
  const reserved = await reserveStoreQuota(tenantId, storeLimit);
  if (!reserved) {
    throw new Error(`当前机构套餐门店配额已满（上限 ${storeLimit} 家），请升级套餐或购买扩容包`);
  }

  let createRes;
  try {
    createRes = await db.collection('stores').add({
      data: {
        storeName,
        tenantId,
        status: 'active',
        createdBy: operatorOpenId,
        createdAt: db.serverDate()
      }
    });
  } catch (err) {
    // 🛡️ 门店没能真正建成，归还上面已经原子占用的一个配额名额
    await releaseStoreQuota(tenantId);
    throw err;
  }

  return { storeId: createRes._id, storeName };
}

// 🌸 提交身份申请：从原来客户端直接 db.collection('user_roles').add() 收拢到这里，
// 服务端统一决定 status/role/approveTime，客户端不再能直接摆布这几个字段——
// 否则客户端理论上可以直接 add 一条 status:'approved'、requestedRole:'store_manager'
// 的记录自我提权，而不是老实走 pending 审批。
// 义工加入已有门店：免审核即刻生效（提升义工体验）；其余场景（管理身份 / 新建门店）
// 一律进入 pending，交由 approve/reject 分支按权限分级处理。
async function submitRoleApply(event, OPENID) {
  const { storeId, storeName, storeSelectionType, customStoreName, realName, phone, requestedRole, tenantId, address, contactPhone, storePhotos, province, city, district, adminKey, orgType } = event;

  if (!realName || !String(realName).trim()) return { success: false, error: '请填写真实姓名' };
  if (!phone || !String(phone).trim()) return { success: false, error: '请填写手机号' };
  if (!requestedRole) return { success: false, error: '请选择申请岗位' };

  const isCustom = storeSelectionType === 'custom';
  const isElevatedRole = requestedRole === 'store_manager' || requestedRole === 'store_patriarch';

  if (isCustom) {
    if (!customStoreName || !String(customStoreName).trim()) {
      return { success: false, error: '请填写新门店名称' };
    }
    // 🛡️ 服务端兜底：新建门店申请必须先补全门店档案（客户端已做同款拦截，
    // 这里防止绕过客户端直接调云函数），三项缺一不可
    if (!address || !String(address).trim() || !contactPhone || !String(contactPhone).trim() || !Array.isArray(storePhotos) || sanitizePhotos(storePhotos).length === 0) {
      return { success: false, error: '申请新建门店需先补全门店档案（地址/联系电话/门店照片）' };
    }
  }

  // 🛡️ 已有门店（!isCustom）路径统一在这里查一次目标门店文档，供下面档案完整性/
  // 管理员密钥/自动过审三处校验共用（此前各自独立 doc(storeId).get()，同一次请求
  // 打三次几乎一样的查询）。更关键的是：existingStoreDoc.tenantId 才是本次申请
  // 真正归属的机构——不再信任客户端传入的 tenantId 字段（与本项目一贯的"tenantId
  // 只从服务端已存数据反查"安全模型对齐，见 checkTenantPermission/createStore 等
  // 处同款注释）。这在"选择工作空间"新用户跨机构挑选站点加入的场景下是必需的：
  // 该场景下前端出于隐私边界压根不知道目标门店的 tenantId（见 getStoreList 发现
  // 模式不透出 tenantId），客户端传参这里恒为空，只能靠服务端反查
  let existingStoreDoc = null;
  if (!isCustom) {
    if (!storeId) {
      return { success: false, error: '请选择一个门店' };
    }
    const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
    existingStoreDoc = storeRes && storeRes.data;
    if (!existingStoreDoc) {
      return { success: false, error: '目标门店不存在' };
    }

    // 🛡️ 新店长/新家长任命申请（已有门店）：此前这里的门店档案完整性校验只挂在
    // isCustom 分支下，"高阶角色申请"其实从未真正被拦截过——只要选的是已有门店，
    // 申请店长/家长完全不检查该店档案是否补全。校验对象是目标门店【已存的】
    // address/contactPhone/storePhotos（不是本次申请提交的字段——申请人此刻大概率
    // 还没有编辑门店档案的权限，见 manageStoreProfile resolveWriteTarget），
    // 避免一家档案空白的门店被批出店长/家长
    if (isElevatedRole) {
      const hasPhotos = Array.isArray(existingStoreDoc.storePhotos) && existingStoreDoc.storePhotos.length > 0;
      const hasAddress = !!(existingStoreDoc.address && String(existingStoreDoc.address).trim());
      const hasContactPhone = !!(existingStoreDoc.contactPhone && String(existingStoreDoc.contactPhone).trim());
      if (!hasAddress || !hasContactPhone || !hasPhotos) {
        return { success: false, error: '该门店档案尚未补全（地址/联系电话/门店照片），请先联系现任店长在【门店档案】页补全后再申请' };
      }
    }
  }

  // 🔐 管理员密钥校验：已有门店的管理岗位申请（大家长/店长/财务）须通过密钥验证。
  // 新建门店（isCustom）此时门店尚未存在，跳过；门店未设 adminKey 时也跳过（向后兼容）。
  if (existingStoreDoc && ['store_patriarch', 'store_manager', 'finance'].includes(requestedRole)) {
    const storedKey = existingStoreDoc.adminKey;
    if (storedKey && String(storedKey).trim()) {
      if (sanitizeText(adminKey || '') !== String(storedKey).trim()) {
        return { success: false, error: '管理员密钥错误，请向现任大家长/店长索取' };
      }
    }
  }

  // 义工 + 已有门店：门店必须真实存在才允许免审即时生效，避免伪造/过期 storeId 也能自动过审
  const autoApprove = requestedRole === 'volunteer' && !isCustom && !!existingStoreDoc;

  const docData = {
    realName: String(realName).trim(),
    phone: String(phone).trim(),
    storeId: isCustom ? '' : storeId,
    // 🛡️ 已有门店路径的 storeName 也改用服务端反查到的真实值，不信任客户端传参
    // （与下面 tenantId 同一处修复，见 existingStoreDoc 注释）
    storeName: isCustom ? String(customStoreName).trim() : (existingStoreDoc.storeName || storeName || ''),
    storeSelectionType: storeSelectionType || 'existing',
    customStoreName: isCustom ? String(customStoreName).trim() : '',
    // 🛡️ 已有门店路径：tenantId 必须是目标门店真实归属的机构（existingStoreDoc.tenantId），
    // 不信任客户端传参——见上方 existingStoreDoc 注释。新建门店路径（isCustom）不受影响，
    // 仍沿用客户端传入的 tenantId（该场景下 tenantId 来自申请人自己刚调用 createTenant
    // 拿到的真实返回值，属于合法的客户端可信输入）
    tenantId: isCustom ? (tenantId || '') : (existingStoreDoc.tenantId || ''),
    requestedRole,
    role: 'volunteer',
    status: autoApprove ? 'approved' : 'pending',
    applyTime: db.serverDate()
  };
  // 🏪 新建门店阶段收集的门店档案：approve 时随建店/复用逻辑一并写入 stores 文档
  if (isCustom) {
    docData.address = sanitizeText(address);
    docData.contactPhone = sanitizeText(contactPhone);
    docData.storePhotos = sanitizePhotos(storePhotos);
    // 🏢 平台类型：写入门店档案，供全国大屏按 orgType 筛选聚合
    const VALID_ORG_TYPES = ['yuhuazhai', 'elderly_canteen', 'volunteer_station', 'rescue_team', 'other'];
    docData.orgType = VALID_ORG_TYPES.includes(orgType) ? orgType : 'other';
    // 🆕 所属地区：优先用申请人在 <picker mode="region"> 里手动选择的省市区；
    // 客户端未传（如老版本小程序）时，尝试从门店名称/地址文本里轻量提取兜底
    const submittedProvince = sanitizeText(province);
    const submittedCity = sanitizeText(city);
    if (submittedProvince || submittedCity) {
      docData.province = submittedProvince;
      docData.city = submittedCity;
      docData.district = sanitizeText(district);
    } else {
      const guessed = extractRegionFromText(`${docData.storeName} ${address || ''}`);
      docData.province = guessed.province;
      docData.city = guessed.city;
      docData.district = '';
    }
  }
  if (autoApprove) {
    docData.approveTime = db.serverDate();
  }

  // 🏛️ 新建门店一键自审：
  // ① 已有大家长/店长权限的用户新建门店——门店自治，免审直接建店兼任大家长与店长
  // ② 全新用户申请成为新门店首任大家长（requestedRole === 'store_patriarch'）——
  //    自裂变架构核心：无需超管审批，任何人都可以创建新门店并成为首任大家长，
  //    彻底废除"需要超管手动添加门店/大家长"的旧瓶颈，实现自下而上自裂变
  // 超管走上方快速通道，此处只处理普通用户，配额校验在 resolveOrCreateStore 内部
  if (isCustom) {
    const callerRes = await db.collection('user_roles')
      .where({ _openid: OPENID, status: 'approved' })
      .limit(1)
      .get();
    const callerRec = callerRes.data && callerRes.data[0];
    const callerRole = callerRec && callerRec.role;

    if (requestedRole === 'store_patriarch' || callerRole === 'store_patriarch' || callerRole === 'store_manager') {
      // 🌐 多租户安全：tenantId 必须来自调用方已有角色记录（已属于某机构）或前端显式传入。
      // 全新用户（callerRec 为空）且未传 tenantId 时，拒绝兜底到 DEFAULT_TENANT_ID——
      // 那会把所有新建组织都归并进雨花斋账套，破坏多租户隔离。
      // 正确路径：前端引导用户先调用 createTenant 云函数创建新机构（携带 tenantId 返回），
      // 再加入时传递该 tenantId；或通过大家长发放的邀请码（已绑定 tenantId）加入现有机构。
      const resolvedTenantId = (callerRec && callerRec.tenantId) || tenantId;
      if (!resolvedTenantId) {
        return {
          success: false,
          error: '请先创建您的组织（使用"创建新组织"入口），或通过大家长提供的邀请码加入现有门店',
          needsOnboarding: true
        };
      }
      const newStoreName = String(customStoreName).trim();

      let resolved;
      try {
        resolved = await resolveOrCreateStore(resolvedTenantId, newStoreName, OPENID);
      } catch (quotaErr) {
        return { success: false, error: quotaErr.message || '建店失败' };
      }

      const now = db.serverDate();
      const baseDoc = {
        ...docData,
        storeId: resolved.storeId,
        storeName: resolved.storeName,
        tenantId: resolvedTenantId,
        status: 'approved',
        approveTime: now
      };

      // 同时写入大家长与店长两条记录，实现兼任效果
      // 🔐 建店初始密钥：前端传 initAdminKey（显式设置）或回退到手机号后 6 位，
      // 保证新门店一建好就有密钥保护，防止第三方冒名申请管理岗位
      const rawInitKey = sanitizeText(event.initAdminKey || adminKey || '').slice(0, 50);
      const fallbackKey = String(phone || '').slice(-6);
      const storeAdminKey = rawInitKey || fallbackKey;

      await Promise.all([
        db.collection('user_roles').add({ data: { ...baseDoc, role: 'store_patriarch', requestedRole: 'store_patriarch' } }),
        db.collection('user_roles').add({ data: { ...baseDoc, role: 'store_manager', requestedRole: 'store_manager' } }),
        db.collection('stores').doc(resolved.storeId).update({
          data: {
            patriarch: docData.realName || '',
            patriarchOpenId: OPENID,
            manager: docData.realName || '',
            managerOpenId: OPENID,
            address: docData.address || '',
            contactPhone: docData.contactPhone || '',
            storePhotos: Array.isArray(docData.storePhotos) ? docData.storePhotos : [],
            province: docData.province || '',
            city: docData.city || '',
            district: docData.district || '',
            orgType: docData.orgType || 'other',
            adminKey: storeAdminKey
          }
        }).catch(err => console.warn('[processRoleAudit] 回写新店档案失败（不影响建店）:', err))
      ]);

      return {
        success: true,
        autoApproved: true,
        storeId: resolved.storeId,
        storeName: resolved.storeName,
        message: '已自动建店，您已成为大家长兼店长'
      };
    }
  }

  // 🩺 诊断日志：待审批列表"提交后查不到"这类问题，根因几乎总是这里写入的
  // storeId 与审核者自己 user_roles 记录里的 storeId 值不完全相等（常见于测试
  // 环境里同名门店存在多条 stores 文档）——打出实际落库的 storeId/status/
  // requestedRole，配合 listPendingApplications 那侧打的 caller.storeId，
  // 云函数日志里直接比对两个 storeId 字符串是否一致，比靠猜快得多
  console.log('[submitRoleApply] 写入 user_roles:', {
    storeId: docData.storeId,
    storeName: docData.storeName,
    requestedRole: docData.requestedRole,
    status: docData.status,
    tenantId: docData.tenantId
  });
  const addRes = await db.collection('user_roles').add({ data: docData });

  return {
    success: true,
    autoApproved: autoApprove,
    applyId: addRes._id,
    message: autoApprove ? '已加入门店，即刻生效' : '申请已提交，请等待审核'
  };
}

const REQUESTED_ROLE_LABELS = {
  volunteer: '义工',
  finance: '财务',
  store_manager: '店长',
  store_patriarch: '家长'
};

// 🏛️ 分角色列出待审批申请：店长/家长只看本店的普通成员申请（义工/财务），
// 超管看全机构范围内的高阶角色（店长/家长）与新建门店申请——与 approve() 里
// isAuditorAllowed / isCustomStore 的权限判定口径完全对齐，谁能审谁就能看
// 🏛️ 门店全角色待审批查询：store_patriarch/store_manager 查自己门店时用，
// 现在超管指定 storeId 穿透查看某家门店时也复用同一份逻辑，两处结果结构
// 完全一致（queueType 统一为 'member'），避免前端为超管的门店穿透视图再
// 单独适配一套数据结构
async function queryStoreMemberQueue(storeId, pendingRoles) {
  console.log('[listPendingApplications] 查询参数:', { storeId, pendingRoles });
  const res = await db.collection('user_roles')
    .where({ storeId, status: 'pending', requestedRole: _.in(pendingRoles) })
    .orderBy('applyTime', 'desc')
    .limit(50)
    .get();
  console.log('[listPendingApplications] 查询结果条数:', (res.data || []).length);

  const data = (res.data || []).map((r) => ({
    applyId: r._id,
    realName: r.realName || '',
    phone: r.phone || '',
    requestedRole: r.requestedRole || '',
    requestedRoleLabel: REQUESTED_ROLE_LABELS[r.requestedRole] || r.requestedRole,
    applyTimeStr: formatCreateTime(r.applyTime)
  }));

  return { success: true, queueType: 'member', data };
}

async function listPendingApplications(event, OPENID) {
  const callerRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  const caller = callerRes.data && callerRes.data[0];
  if (!caller) {
    return { success: false, error: '无权限：未找到您的角色信息' };
  }

  if (caller.role === 'store_manager' || caller.role === 'store_patriarch') {
    if (!caller.storeId) {
      return { success: true, queueType: 'member', data: [] };
    }
    // 🏛️ 门店自治：大家长可见并有权审批本店全角色申请（含大家长任命）；
    // 店长仅可见/审批义工/财务/店长——大家长任命不由店长决定，防利益冲突
    const pendingRoles = caller.role === 'store_patriarch'
      ? ['volunteer', 'finance', 'store_manager', 'store_patriarch']
      : ['volunteer', 'finance', 'store_manager'];
    return await queryStoreMemberQueue(caller.storeId, pendingRoles);
  }

  if (caller.role === 'super_admin') {
    // 🆕 超管指定门店穿透查看：与 listAuditQueue 的 approved 分支对超管选中
    // 具体门店（scopeStoreId）时的处理方式保持一致——选中门店时视同该店的
    // 大家长视角，能看到全角色（含 finance/volunteer）待审批申请；未选中
    // 具体门店（全局大盘视角）时才走下面仅含店长/大家长任命与新建门店申请
    // 的 elevated 队列，不然超管一进来就是全租户所有门店的 finance/volunteer
    // 混在一起，反而没法用
    const scopeStoreId = (event && event.storeId) || '';
    if (scopeStoreId) {
      console.log('[listPendingApplications] 超管指定门店穿透查看:', scopeStoreId);
      return await queryStoreMemberQueue(scopeStoreId, ['volunteer', 'finance', 'store_manager', 'store_patriarch']);
    }

    // 🩺 诊断日志：与上面 member 分支同一个诉求——之前只有 member 分支打了
    // 日志，导致"用超管账号点开待审批弹窗查不到 finance/volunteer 申请"这类
    // 情况完全没有日志可查（超管走的是这条 elevated 分支，按设计本就不返回
    // finance/volunteer，见下方 isCustomStore || requestedRole==='store_manager'
    // || 'store_patriarch' 过滤），这里补上，一眼就能看出当前调用者其实是
    // 超管而不是店长/大家长
    console.log('[listPendingApplications] 走 super_admin 分支（elevated 队列，按设计只含店长/大家长任命与新建门店申请，不含 finance/volunteer）');
    const tenantId = await resolveAuditorTenantId(caller);
    // 🐛 修复"待审核列表漏单"：此前这里严格按 { tenantId, status: 'pending' } 精确匹配，
    // 但 submitRoleApply 落库的 tenantId 来自申请人客户端缓存的角色信息，账号从未
    // 缓存过角色（例如全新用户首次直接申请店长/家长）时会写成空字符串——与 approve()
    // 里 auditor.tenantId && applyData.tenantId && ... 的宽松校验口径不一致，导致这类
    // 申请在 approve() 里本可正常审批，却永远不会出现在 listPendingApplications 里，
    // 超管根本看不到、审不了。这里放宽为：tenantId 匹配当前机构，或申请记录本身
    // tenantId 缺失/为空（历史遗留 / 全新用户），两种都纳入
    const res = await db.collection('user_roles')
      .where(_.and([
        { status: 'pending' },
        _.or([{ tenantId }, { tenantId: '' }, { tenantId: _.exists(false) }])
      ]))
      .orderBy('applyTime', 'desc')
      .limit(50)
      .get();

    const elevated = (res.data || []).filter((r) => {
      const isCustomStore = r.storeSelectionType === 'custom' || !r.storeId;
      return isCustomStore || r.requestedRole === 'store_manager' || r.requestedRole === 'store_patriarch';
    });

    // 已有门店的高阶角色申请：目标门店已存在，附带其当前门店档案供超管审核参考；
    // 新建门店的申请：门店本身还不存在，直接用申请文档自带的档案字段
    const data = await Promise.all(elevated.map(async (r) => {
      const isCustomStore = r.storeSelectionType === 'custom' || !r.storeId;
      let storeProfile = {
        storeName: r.storeName || r.customStoreName || '',
        address: r.address || '',
        contactPhone: r.contactPhone || '',
        storePhotos: Array.isArray(r.storePhotos) ? r.storePhotos : []
      };

      if (!isCustomStore && r.storeId) {
        const storeRes = await db.collection('stores').doc(r.storeId).get().catch(() => null);
        const store = storeRes && storeRes.data;
        if (store) {
          storeProfile = {
            storeName: store.storeName || r.storeName || '',
            address: store.address || '',
            contactPhone: store.contactPhone || '',
            storePhotos: Array.isArray(store.storePhotos) ? store.storePhotos : []
          };
        }
      }

      return {
        applyId: r._id,
        realName: r.realName || '',
        phone: r.phone || '',
        requestedRole: r.requestedRole || '',
        requestedRoleLabel: REQUESTED_ROLE_LABELS[r.requestedRole] || r.requestedRole,
        applyTimeStr: formatCreateTime(r.applyTime),
        isCustomStore,
        storeProfile
      };
    }));

    return { success: true, queueType: 'elevated', data };
  }

  return { success: true, queueType: 'none', data: [] };
}

// 🏢 全国总览/全部门店等虚拟聚合选择，不是真实 storeId——与 statistics.ts
// NATIONAL_STORE_ID_SENTINELS 同一份哨兵值，超管传了这些值等同于"不按门店过滤"
const NATIONAL_STORE_ID_SENTINELS = ['national_overview', 'ALL_STORES', 'all', 'ALL'];

// 🛡️ 首页【门店审核】抽屉的统一列表查询：替代此前小程序端直接
// wx.cloud.database().collection('user_roles').where(...).get() 的客户端直连查询——
// 那种写法的门店/机构隔离完全依赖客户端缓存的 AuthService.getCachedRoleInfo()
// （可被篡改/滞后）+ 数据库安全规则（本仓库不可见、无法审计），与本项目其余所有
// 审核/审批类查询统一收拢进云函数、服务端按真实 openid 重新核验身份的既定架构
// 不一致。这里按调用者真实角色重新推导数据范围，客户端传入的 storeId 只在
// super_admin 分支下生效（用于"按选中门店过滤"），非超管一律强制忽略、只认
// 服务端查到的 caller.storeId，不给跨店越权留任何口子。
//
// tab: 'pending' | 'approved'；返回字段统一为 applyId（对应 user_roles 文档 _id，
// 与 approve/reject/manageVolunteerBinding 等下游调用需要的 id 完全一致）+
// role（pending 取 requestedRole，approved 取 role，两个 tab 前端按同一个字段名
// 过滤/展示，不用再分别处理两种字段名）
async function listAuditQueue(event, OPENID) {
  const { tab, storeId: requestedStoreId } = event;
  const status = tab === 'approved' ? 'approved' : 'pending';
  const timeField = status === 'approved' ? 'approveTime' : 'applyTime';

  const callerRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  const caller = callerRes.data && callerRes.data[0];
  if (!caller) {
    return { success: false, error: '无权限：未找到您的角色信息' };
  }

  let query;
  if (caller.role === 'super_admin') {
    const tenantId = await resolveAuditorTenantId(caller);
    const scopeStoreId = (requestedStoreId && !NATIONAL_STORE_ID_SENTINELS.includes(requestedStoreId)) ? requestedStoreId : '';

    if (scopeStoreId) {
      // 超管按选中门店过滤：只看该店，与非超管的单店视角字段完全一致
      query = db.collection('user_roles').where({ storeId: scopeStoreId, status });
    } else if (status === 'pending') {
      // 🐛 与 listPendingApplications 同一处修复：申请记录的 tenantId 可能因申请人
      // 从未缓存过角色而写成空字符串，这里同样放宽兼容缺失/空值，避免超管全国视角
      // 漏看这类申请
      query = db.collection('user_roles').where(_.and([
        { status },
        _.or([{ tenantId }, { tenantId: '' }, { tenantId: _.exists(false) }])
      ]));
    } else {
      query = db.collection('user_roles').where({ status, tenantId });
    }
  } else if (caller.role === 'store_manager' || caller.role === 'store_patriarch') {
    // 🏛️ 大家长与店长兼任并集逻辑：两者审核权限对等，与 listPendingApplications /
    // approve 分支口径完全一致。
    // 🛡️ 严格门店隔离：非超管无论客户端传了什么 storeId，一律强制收敛到调用者
    // 自己服务端记录的 storeId，绝不可能跨店拉取/审核他店的申请记录
    if (!caller.storeId) {
      return { success: true, data: [] };
    }
    if (status === 'pending') {
      // 门店自治：大家长可见/审批本店全角色申请（含大家长任命）；
      // 店长仅可见/审批义工/财务/店长，大家长任命不由店长决定
      const pendingRoles = caller.role === 'store_patriarch'
        ? ['volunteer', 'finance', 'store_manager', 'store_patriarch']
        : ['volunteer', 'finance', 'store_manager'];
      query = db.collection('user_roles').where({
        storeId: caller.storeId,
        status,
        requestedRole: _.in(pendingRoles)
      });
    } else {
      // approved 队列：展示门店全量已授权成员（含义工），但排除 super_admin——
      // 超管是平台全局角色，不是某家门店的驻店成员，理论上其 user_roles 记录
      // 不该带 storeId，但历史脏数据/账号变更路径不排除这种可能，这里显式
      // 收窄，不依赖"数据本就不会命中"这个假设
      query = db.collection('user_roles').where({
        storeId: caller.storeId,
        status,
        role: _.neq('super_admin')
      });
    }
  } else {
    // finance/volunteer/family 等角色本就无审核权限，不返回任何数据
    return { success: true, data: [] };
  }

  const res = await query.orderBy(timeField, 'desc').limit(50).get();

  const isSuperAdminCaller = caller.role === 'super_admin';
  const data = (res.data || []).map((r) => {
    const role = status === 'approved' ? (r.role || '') : (r.requestedRole || '');
    const isCustomStore = status === 'pending' && (r.storeSelectionType === 'custom' || !r.storeId);
    const item = {
      applyId: r._id,
      realName: r.realName || '',
      phone: r.phone || '',
      avatarUrl: r.avatarUrl || '',
      role,
      roleLabel: REQUESTED_ROLE_LABELS[role] || role,
      storeId: r.storeId || '',
      storeName: r.storeName || r.customStoreName || '',
      isCustomStore,
      timeStr: formatCreateTime(status === 'approved' ? r.approveTime : r.applyTime),
      // 🛡️ 供成员权限管理弹窗判断"这一行是不是我自己"，从而隐藏对自己的
      // 降级/移出按钮——只回传一个布尔值，不把 _openid 本身透出给普通管理员
      // （见下方 isSuperAdminCaller 分支同一处隐私边界注释）
      isSelf: r._openid === OPENID
    };
    // 🛡️ 超管专属：强制解绑操作需要知道目标 openId 或通过 applyId(=doc._id) 定位文档。
    // 普通管理员不应拿到其他成员的 openId，这里按调用者角色分层返回。
    if (isSuperAdminCaller) {
      item.openId = r._openid || '';
    }
    return item;
  });

  return { success: true, data };
}

// 🔒 申请人本人查询自己是否有正在 pending 的申请：供 store-picker "选择门店与身份"
// 弹窗锁定按钮、防止重复提交用，与 checkUserRole 那种 limit(1) 不保证取到哪条的
// 查询彻底分开——这里显式按 applyTime 倒序只取最新一条 pending 记录
async function getMyApplicationStatus(OPENID) {
  const res = await db.collection('user_roles')
    .where({ _openid: OPENID, status: 'pending' })
    .orderBy('applyTime', 'desc')
    .limit(1)
    .get();

  const pending = res.data && res.data[0];
  if (!pending) {
    return { success: true, hasPending: false };
  }

  return {
    success: true,
    hasPending: true,
    requestedRole: pending.requestedRole || '',
    storeId: pending.storeId || '',
    storeName: pending.storeName || pending.customStoreName || '',
    storeSelectionType: pending.storeSelectionType || 'existing'
  };
}

// 邀请码目标角色（大写）-> user_roles.role 应写入的值；FAMILY 不是独立 role 值，
// 仍落在 volunteer，靠 status !== 'approved' 区分"家人"展示态——与
// manageStoreInviteCode 的 TARGET_ROLE_TO_PRIMARY 同一份映射
const RELEASE_ROLE_TO_PRIMARY = {
  STORE_PATRIARCH: 'store_patriarch',
  STORE_MANAGER: 'store_manager',
  FINANCE: 'finance',
  VOLUNTEER: 'volunteer',
  FAMILY: 'volunteer'
};
// 身份阶梯排名：剥离目标角色后，若还持有其他身份，取剩余身份里权限最高的一档
// 作为退出后展示的身份——与 manageStoreInviteCode 的 ROLE_RANK 同一份口径
const RELEASE_ROLE_RANK = {
  FAMILY: 0,
  VOLUNTEER: 1,
  FINANCE: 2,
  STORE_MANAGER: 3,
  STORE_PATRIARCH: 3
};

// 🛡️ 根因修复："卸任特权 / 退出当前绑定"（profile.ts onConfirmReleaseRole）此前只清
// 本地 storage、从未调用任何云函数——服务端 user_roles 记录里的 role/storeId/status
// 原封不动，checkUserRole 是纯粹按 _openid 查这条记录直接回传，不认本地缓存。于是
// "已卸任"只是客户端的一次性错觉：下次任意页面 onLoad/onShow 触发 fetchUserRole()
// 重新查询，服务端返回的仍是卸任前的角色，权限原样复活，用户完全不知情地仍持有
// 门店的写账/审账权限——与弹窗文案"该操作不可逆"背道而驰。这里补上真正的服务端
// 撤销。
//
// 🏛️ 多角色兼任（manageStoreInviteCode 的 redeem 动作核销邀请码时往 roles 数组
// 追加身份，如 ['STORE_MANAGER','FINANCE']）：退出时只应剥离客户端当前选中/展示
// 的那一档身份，不能像早期版本那样无条件把整条记录清空成 volunteer——那样会把
// 用户明明还持有、且是另一次合法核销授予的身份也一并抹掉。targetRole 由客户端
// 传入（对应"当前正在查看的身份"），服务端强制校验其确实在调用者自己的 roles
// 清单内，不信任任何客户端可篡改的字符串。
async function releaseSelf(event, OPENID) {
  const callerRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  const caller = callerRes.data && callerRes.data[0];
  if (!caller) {
    return { success: false, error: '未找到您的角色信息，无需卸任' };
  }

  // 🛡️ 超级管理员不支持自助卸任：与 setupSuperAdmin 只能由平台方线下开通的原则对称——
  // 如果机构恰好只有这一位超管，自助卸任会导致该机构再无人能审批高权限申请/新建门店，
  // 陷入无人可管理的死锁，必须走人工线下流程处理
  if (caller.role === 'super_admin') {
    return { success: false, error: '超级管理员身份不支持自助卸任，请联系平台管理员处理' };
  }

  // 🛡️ roles 数组是权威的"当前持有哪些身份"清单；早于多角色兼任功能上线的历史
  // 记录没有这个字段，按主 role 字段单值兜底重建，保证老账号也能正常卸任
  const currentRoles = Array.isArray(caller.roles) && caller.roles.length > 0
    ? caller.roles
    : (caller.role && caller.role !== 'volunteer' ? [String(caller.role).toUpperCase()] : []);

  if (currentRoles.length === 0) {
    return { success: false, error: '当前身份无需卸任' };
  }

  const requestedTargetRole = event && event.targetRole ? String(event.targetRole).toUpperCase() : '';
  // 未传 targetRole 时兜底按主 role 字段释放，兼容尚未升级的旧客户端调用
  const targetRole = requestedTargetRole || (caller.role ? String(caller.role).toUpperCase() : '');
  if (!currentRoles.includes(targetRole)) {
    return { success: false, error: '无权限：您当前并未持有该身份，无法卸任' };
  }

  const remainingRoles = currentRoles.filter((r) => r !== targetRole);

  let finalRole = 'volunteer';
  let finalStatus = 'approved';
  let finalStoreId = '';
  let finalStoreName = '';

  if (remainingRoles.length > 0) {
    // 🌟 降级兜底：仍持有其他身份时，平滑切回剩余身份里权限最高的一档展示，
    // 门店绑定保留（仍然属于这家门店的某个身份），不清空 storeId/storeName
    const topRemaining = remainingRoles.reduce((best, r) =>
      (RELEASE_ROLE_RANK[r] || 0) > (RELEASE_ROLE_RANK[best] || 0) ? r : best, remainingRoles[0]);
    finalRole = RELEASE_ROLE_TO_PRIMARY[topRemaining] || 'volunteer';
    finalStatus = topRemaining === 'FAMILY' ? 'guest' : 'approved';
    finalStoreId = caller.storeId || '';
    finalStoreName = caller.storeName || '';
  }
  // remainingRoles 为空：无其他身份，finalRole/finalStatus/finalStoreId/
  // finalStoreName 维持上面声明的初始值——彻底重置为未绑定门店状态

  // 🛡️ 工时数据无缝保留：与 manageStoreInviteCode 的 redeem 同一原则，update() 只
  // 写下面这几个字段，完全不触碰 volunteer_hours/my_checkin_* 等打卡工时相关字段，
  // 退出/降级不会以任何形式抹除用户原有的护持工时数据
  await db.collection('user_roles').doc(caller._id).update({
    data: {
      role: finalRole,
      status: finalStatus,
      storeId: finalStoreId,
      storeName: finalStoreName,
      roles: remainingRoles,
      releasedFrom: targetRole,
      releasedAt: db.serverDate()
    }
  });

  // 🛡️ 审计留痕：记录退出的具体角色、目标门店与操作时间，供后续追溯
  await db.collection('audit_logs').add({
    data: {
      operator_id: OPENID,
      action: 'release_self_role',
      released_role: targetRole,
      remaining_roles: remainingRoles,
      target_store_id: caller.storeId || '',
      target_store_name: caller.storeName || '',
      operate_time: db.serverDate()
    }
  }).catch((err) => console.warn('[processRoleAudit] 写入退出审计日志失败（不影响卸任本身）:', err));

  return {
    success: true,
    message: '已成功卸任',
    remainingRole: finalRole,
    remainingStatus: finalStatus,
    hasRemainingRoles: remainingRoles.length > 0
  };
}

// 🛡️ 超级管理员强制解绑：将指定用户的门店角色（store_patriarch/store_manager/finance）
// 强制重置为 volunteer，并清除 storeId/storeName 绑定，阻断其继续以该门店身份操作。
// 仅限 super_admin 调用；被操作者是 super_admin 时拒绝（防止超管互相降级）。
// 工时/打卡数据按"最小破坏"原则完全保留，与 releaseSelf 一致。
async function superAdminForceUnbind(event, OPENID) {
  // 1. 校验操作者是 super_admin
  const callerRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  const caller = callerRes.data && callerRes.data[0];
  if (!caller || caller.role !== 'super_admin') {
    return { success: false, error: '无权限：仅超级管理员可执行强制解绑' };
  }

  // 2. 解析目标用户标识：优先用 targetDocId（直接定位文档），否则按 targetOpenId 查
  const targetOpenId = String(event.targetOpenId || '').trim();
  const targetDocId = String(event.targetDocId || '').trim();

  if (!targetOpenId && !targetDocId) {
    return { success: false, error: '请提供目标用户的 openId 或文档 ID' };
  }

  let target;
  if (targetDocId) {
    const docRes = await db.collection('user_roles').doc(targetDocId).get().catch(() => null);
    target = docRes && docRes.data;
  } else {
    const res = await db.collection('user_roles').where({ _openid: targetOpenId }).limit(1).get();
    target = res.data && res.data[0];
  }

  if (!target) {
    return { success: false, error: '未找到目标用户的角色记录' };
  }

  // 3. 防止降级另一位 super_admin
  if (target.role === 'super_admin') {
    return { success: false, error: '不可强制解绑超级管理员身份' };
  }

  // 4. 若当前已是 volunteer/无门店绑定，认为已是干净状态
  const isBoundRole = ['store_patriarch', 'store_manager', 'finance'].includes(target.role);
  if (!isBoundRole) {
    return { success: false, error: `该用户当前角色为 ${target.role || 'volunteer'}，无需强制解绑` };
  }

  const prevRole = target.role;
  const prevStoreId = target.storeId || '';
  const prevStoreName = target.storeName || '';

  // 5. 重置为 volunteer（保留 volunteer_hours / my_checkin_* 等工时字段）
  await db.collection('user_roles').doc(target._id).update({
    data: {
      role: 'volunteer',
      status: 'approved',
      storeId: '',
      storeName: '',
      roles: [],
      revokedAt: db.serverDate(),
      revokedBy: OPENID,
      forceUnbindBy: OPENID,
      forceUnbindAt: db.serverDate()
    }
  });

  // 6. 审计留痕
  await db.collection('audit_logs').add({
    data: {
      operator_id: OPENID,
      action: 'super_admin_force_unbind',
      target_openid: target._openid || targetOpenId,
      target_doc_id: target._id,
      prev_role: prevRole,
      prev_store_id: prevStoreId,
      prev_store_name: prevStoreName,
      operate_time: db.serverDate()
    }
  }).catch((err) => console.warn('[processRoleAudit] 写入强制解绑审计日志失败（不影响解绑本身）:', err));

  return {
    success: true,
    message: `已将 ${prevRole} 强制解绑，用户角色已重置为 volunteer`,
    prevRole,
    prevStoreId,
    prevStoreName
  };
}

exports.main = async (event, context) => {
  const { applyId, action } = event;
  const { OPENID } = cloud.getWXContext();

  if (!OPENID) {
    return { success: false, error: '无法获取用户身份' };
  }

  if (action === 'apply') {
    try {
      return await submitRoleApply(event, OPENID);
    } catch (err) {
      console.error('processRoleAudit submitRoleApply error:', err);
      return { success: false, error: err.message || '提交失败' };
    }
  }

  if (action === 'listAuditQueue') {
    try {
      return await listAuditQueue(event, OPENID);
    } catch (err) {
      console.error('processRoleAudit listAuditQueue error:', err);
      return { success: false, error: err.message || '查询失败' };
    }
  }

  if (action === 'listPendingApplications') {
    try {
      return await listPendingApplications(event, OPENID);
    } catch (err) {
      console.error('processRoleAudit listPendingApplications error:', err);
      return { success: false, error: err.message || '查询失败' };
    }
  }

  if (action === 'getMyApplicationStatus') {
    try {
      return await getMyApplicationStatus(OPENID);
    } catch (err) {
      console.error('processRoleAudit getMyApplicationStatus error:', err);
      return { success: false, error: err.message || '查询失败' };
    }
  }

  if (action === 'releaseSelf') {
    try {
      return await releaseSelf(event, OPENID);
    } catch (err) {
      console.error('processRoleAudit releaseSelf error:', err);
      return { success: false, error: err.message || '卸任失败' };
    }
  }

  if (action === 'superAdminForceUnbind') {
    try {
      return await superAdminForceUnbind(event, OPENID);
    } catch (err) {
      console.error('processRoleAudit superAdminForceUnbind error:', err);
      return { success: false, error: err.message || '强制解绑失败' };
    }
  }

  if (!applyId || !action) {
    return { success: false, error: '参数不完整' };
  }

  try {
    // 1. 审核人身份
    const auditorRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
    const auditor = auditorRes.data && auditorRes.data[0];
    if (!auditor) {
      return { success: false, error: '无权限：未找到您的角色信息' };
    }

    // 2. 申请记录：以服务端存储数据为唯一依据，不再信任客户端传入的 storeId/storeName
    const applyRes = await db.collection('user_roles').doc(applyId).get();
    const applyData = applyRes.data;

    if (!applyData) {
      return { success: false, error: '申请记录不存在' };
    }
    if (applyData.status !== 'pending') {
      return { success: false, error: '该申请已处理' };
    }

    // 🏢 多租户边界：审核人与申请人必须同属一个机构
    if (auditor.tenantId && applyData.tenantId && auditor.tenantId !== applyData.tenantId) {
      return { success: false, error: '无权限：该申请不属于您所在的机构' };
    }

    // 🛡️ 权限统一前置：同意与驳回本质都是"对这条待审批记录下裁决"，必须用同一套
    // 授权判断——此前这套检查只挂在 approve 分支，reject 分支完全没做任何门店/
    // 角色归属校验，只要跟申请人同一个机构（雨花斋这类共享 tenantId 的场景下
    // 几乎等于"全体成员"）任何账号都能驳回其它门店的待审批申请，是一个真实的
    // 越权漏洞，这里把检查收拢到 reject/approve 分支之前，两个动作共用同一份
    // 结果，不再各走各的
    // 🏛️ 门店自治：大家长任命由本店现任大家长或超管审批（"谁管这家店，谁决定新家长"）；
    // 店长不得审批大家长——家长本是监督店长的角色，反向任命存在明显利益冲突；
    // 新建门店的大家长申请始终仅限超管（isCustomStore 分支在下方另行把关）
    const canApprovePatriarch = auditor.role === 'super_admin' ||
      (auditor.role === 'store_patriarch' && auditor.storeId === applyData.storeId);
    if (applyData.requestedRole === 'store_patriarch' && !canApprovePatriarch) {
      return { success: false, error: '无权限：大家长任命仅限本店现任大家长或超级管理员审批' };
    }

    const isCustomStore = applyData.storeSelectionType === 'custom' || !applyData.storeId;
    if (isCustomStore) {
      // 🛡️ 新建门店的申请仅限超级管理员审批/驳回：新门店尚无店长人选，店长权限无从谈起
      if (auditor.role !== 'super_admin') {
        return { success: false, error: '无权限：新建门店的申请仅限超级管理员审批' };
      }
    } else {
      // 🏛️ 已有门店的义工/财务/店长申请：大家长与店长兼任并集逻辑——
      // 本门店大家长、本门店店长、超级管理员均可审核；大家长与店长为同一人时天然具备双重权限
      const isAuditorAllowed = auditor.role === 'super_admin' ||
        ((auditor.role === 'store_patriarch' || auditor.role === 'store_manager') && auditor.storeId === applyData.storeId);
      if (!isAuditorAllowed) {
        return { success: false, error: '无权限：仅本门店大家长/店长或超级管理员可审核角色申请' };
      }
    }

    if (action === 'reject') {
      // 🛡️ 驳回必须说明原因：申请人才知道下次该补什么材料，也避免审核人随手一点就拒绝
      const rejectReason = sanitizeText(event.rejectReason);
      if (!rejectReason) {
        return { success: false, error: '请填写驳回原因' };
      }
      await db.collection('user_roles').doc(applyId).update({
        data: {
          status: 'rejected',
          rejectReason,
          approveTime: db.serverDate()
        }
      });
      return { success: true, message: '已拒绝申请' };
    }

    if (action !== 'approve') {
      return { success: false, error: '无效操作' };
    }

    let targetStoreId = applyData.storeId;
    let targetStoreName = applyData.storeName;
    let resolvedTenantId = applyData.tenantId || auditor.tenantId || '';

    if (isCustomStore) {
      const auditorTenantId = await resolveAuditorTenantId(auditor);
      resolvedTenantId = applyData.tenantId || auditorTenantId;

      const customName = (applyData.customStoreName || applyData.storeName || '').trim();
      if (!customName) {
        return { success: false, error: '申请记录缺少新门店名称' };
      }

      try {
        const resolved = await resolveOrCreateStore(auditorTenantId, customName, OPENID);
        targetStoreId = resolved.storeId;
        targetStoreName = resolved.storeName;

        // 🏪 把申请阶段收集的门店档案（补全校验已在 submitRoleApply 里强制要求）
        // 一并写入新建/复用的门店文档，避免新店档案永远空白。🆕 province/city/
        // district 已在 submitRoleApply 里落地到 applyData（申请人手选或已做过
        // 一次文本提取兜底），这里原样带过去，不重复猜测
        await db.collection('stores').doc(targetStoreId).update({
          data: {
            address: applyData.address || '',
            contactPhone: applyData.contactPhone || '',
            storePhotos: Array.isArray(applyData.storePhotos) ? applyData.storePhotos : [],
            province: applyData.province || '',
            city: applyData.city || '',
            district: applyData.district || ''
          }
        }).catch((err) => console.warn('[processRoleAudit] 回写新店档案失败（不影响审批本身）:', err));
      } catch (storeErr) {
        return { success: false, error: storeErr.message || '建店失败' };
      }
    }
    // 已有门店分支的 isAuditorAllowed 校验已在上面（reject/approve 分支之前）
    // 统一做过，这里不再重复判断

    // 3. 写入权限表：openid（申请记录本身即绑定 _openid）、role、tenantId、storeId 一并落地
    await db.collection('user_roles').doc(applyId).update({
      data: {
        role: applyData.requestedRole || 'volunteer',
        status: 'approved',
        approveTime: db.serverDate(),
        storeId: targetStoreId,
        storeName: targetStoreName,
        tenantId: resolvedTenantId
      }
    });

    // 🏛️ 家长/店长姓名回写到 stores 文档：海报落款、验真页、家长大盘展示姓名的唯一
    // 数据来源，避免每次展示都要另起 user_roles 联表查询
    if (applyData.requestedRole === 'store_patriarch') {
      await db.collection('stores').doc(targetStoreId).update({
        data: { patriarch: applyData.realName || '', patriarchOpenId: applyData._openid || '' }
      }).catch((err) => console.warn('[processRoleAudit] 回写门店家长姓名失败（不影响审批本身）:', err));
    } else if (applyData.requestedRole === 'store_manager') {
      await db.collection('stores').doc(targetStoreId).update({
        data: { manager: applyData.realName || '', managerOpenId: applyData._openid || '' }
      }).catch((err) => console.warn('[processRoleAudit] 回写门店店长姓名失败（不影响审批本身）:', err));
    }

    return {
      success: true,
      message: isCustomStore ? '已自动建店并授权通过' : '授权通过',
      storeId: targetStoreId,
      storeName: targetStoreName
    };
  } catch (err) {
    console.error('processRoleAudit error:', err);
    return { success: false, error: err.message || '审核失败' };
  }
};
