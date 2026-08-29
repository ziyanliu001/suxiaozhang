// 云函数：manageStoreProfile - 门店档案（人员画像 7 项人数指标 + 品牌档案信息 +
// 运营状态/省市/坐标）的读取与编辑
//
// 权限模型：
// - 读（get）：任意已绑定门店的角色（店长/财务/义工）只读本店画像；super_admin/
//   hq_finance/regional_finance 可传 storeId 或 storeName（统计大屏门店下拉框
//   目前只掌握 storeName，没有 storeId，见 statistics.ts 调用处）查看本机构内
//   任意门店，两者都未传时按各自 caller.storeId 兜底。
// - 写（update）：仅 store_manager（限本店，storeId 强制取自身份记录，不信任客户端
//   传入值）或 super_admin（限本机构内任意门店，校验目标门店 tenantId）。
//   与 manageDailyMenu/manageExpenseTemplate/manageNotice 同款权限校验模式。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 🛡️ 服务端内容安全兜底：门店名/致谢词/宣传标语/简介等自由文本对外公开展示
// （公示海报、餐报文本），此前只在前端提交前查一次 msgSecCheck，绕过前端直接
// 调云函数即可跳过审核。落库前服务端强制再查一遍，API 抖动时降级放行。
async function checkContentSafe(text) {
  if (!text) return true;
  try {
    const res = await cloud.callFunction({
      name: 'msgSecCheck',
      data: { text, contentType: 'report' }
    });
    return !res.result || res.result.safe !== false;
  } catch (err) {
    console.warn('[manageStoreProfile] 服务端内容安全检测调用失败，降级放行:', err);
    return true;
  }
}

// 人员画像：7 项人数指标，走 clampCount（非负整数）
const PROFILE_FIELDS = [
  'partyMembers',
  'socialWorkers',
  'volunteersCount',
  'dineInSeniorsCount',
  'deliverySeniorsCount',
  'listeningSeniorsCount',
  'otherCount'
];

// 门店档案信息：文本/日期类字段，走 sanitizeText（裁剪长度），不走数字 clamp。
// address 此前只在 createStore 时写一次，这里补上编辑入口。contactPhone 是
// 申请高阶角色/新建门店前的档案补全校验（processRoleAudit）新增依赖的字段之一，
// 之前门店层级完全没有这个字段
const TEXT_PROFILE_FIELDS = ['address', 'contactPhone', 'openDate', 'registeredName', 'background', 'characteristics', 'province', 'city'];
const MAX_TEXT_FIELD_LENGTH = 500;
const MAX_STORE_PHOTOS = 9;
const VALID_OPERATING_STATUSES = ['operating', 'preparing', 'paused'];
// 🏢 平台类型允许值白名单：防止客户端写入任意字符串
// tongxin_children:     厦门同心慈善会儿童院（青少年/儿童关爱业态）
// tongxin_cancer_care:  厦门同心癌友关怀会（重疾/癌症患者关怀业态）
const VALID_ORG_TYPES = ['yuhuazhai', 'elderly_canteen', 'volunteer_station', 'rescue_team', 'tongxin_children', 'tongxin_cancer_care', 'other'];

// 🏮 品牌矩阵归属：一个机构可同时拥有多种 orgType 的站点，通过 platformFamily 将其
// 归并到同一品牌矩阵，用于全国大屏的"同心慈善会矩阵 / 雨花矩阵"聚合筛选
const VALID_PLATFORM_FAMILIES = ['tongxin', 'yuhuazhai', ''];

// 🍚 供餐餐次配置（meal_config.supported_meals）：绝大多数雨花斋只供午餐，默认单餐次；
// 部分社区助餐点/长者食堂会额外供应早餐或晚餐——打卡弹窗的"留店用餐"选项与岗位班次
// 列表、餐报文本/公示海报的供餐人数汇总，均按这里配置的餐次动态适配（见 index.ts
// loadStoreTargetConfig/refreshTodayShiftStatus 与 reportGenerator.ts/posterGenerator.ts）
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner'];
const DEFAULT_SUPPORTED_MEALS = ['lunch'];

// 白名单过滤 + 去重 + 兜底默认值：清洗后为空（未传/全部非法值）时回退单午餐默认档，
// 不允许写出"一个餐次都不支持"这种无意义的门店配置
function sanitizeSupportedMeals(v) {
  if (!Array.isArray(v)) return DEFAULT_SUPPORTED_MEALS.slice();
  const cleaned = Array.from(new Set(v.filter((m) => MEAL_TYPES.includes(m))));
  return cleaned.length > 0 ? cleaned : DEFAULT_SUPPORTED_MEALS.slice();
}

// 🏷️ 服务受众标签配置（serviceTargetConfig）：允许各机构自定义首页填报表单的文案标签，
// 实现"零代码适配同心儿童院"等新业态。targetLabels 中的字段名与首页表单字段一一对应。
const VALID_TARGET_LABEL_KEYS = ['dineInLabel', 'deliveryLabel', 'listenLabel', 'takeoutLabel'];
const MAX_TARGET_LABEL_LENGTH = 20;
const VALID_ENABLED_FEATURES = ['meals', 'education_care', 'volunteer_checkin', 'donations', 'activity_log'];

function sanitizeServiceTargetConfig(v) {
  if (!v || typeof v !== 'object') return null;
  const result = {};
  if (typeof v.platformBrand === 'string') {
    result.platformBrand = v.platformBrand.trim().slice(0, 50);
  }
  if (v.targetLabels && typeof v.targetLabels === 'object') {
    const labels = {};
    VALID_TARGET_LABEL_KEYS.forEach(key => {
      if (typeof v.targetLabels[key] === 'string') {
        const cleaned = v.targetLabels[key].trim().slice(0, MAX_TARGET_LABEL_LENGTH);
        if (cleaned) labels[key] = cleaned;
      }
    });
    if (Object.keys(labels).length > 0) result.targetLabels = labels;
  }
  if (Array.isArray(v.enabledFeatures)) {
    result.enabledFeatures = v.enabledFeatures.filter(f => VALID_ENABLED_FEATURES.includes(f));
  }
  return Object.keys(result).length > 0 ? result : null;
}

// 🏪 店铺模板自定义（首页"店铺模板自定义"卡片）：致谢词/宣传标语/公众号名称，
// 与人员画像字段一样落在 stores 集合，各自长度上限对齐前端 wxml 的 maxlength，
// 防止超长文本破坏餐报文本/公示海报排版
const TEMPLATE_FIELD_LIMITS = {
  thankText: 150,
  slogan1: 60,
  slogan2: 60,
  mpAccount: 100
};
const TEMPLATE_FIELDS = Object.keys(TEMPLATE_FIELD_LIMITS);

// 🏪 门店资质与实景公示：门头照/民政备案复印件/食品安全承诺，与原有的 storePhotos
// （门店环境照）是四个各自独立的照片分类，同走 sanitizePhotos 校验，只是分类
// 存储、上限各自更小——这几类通常只需要 1-2 张证件/门头照，不需要 9 张这么多
const CATEGORY_PHOTOS_MAX = 6;
const PHOTO_FIELDS = ['storePhotos', 'storefrontPhotos', 'civilAffairsPhotos', 'foodSafetyPledgePhotos'];

function sanitizeText(v, maxLength) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, maxLength || MAX_TEXT_FIELD_LENGTH);
}

// storePhotos：门店照片，云存储 fileID 数组，参考 activity-log 九宫格惯例上限 9 张
function sanitizePhotos(v, max) {
  if (!Array.isArray(v)) return [];
  return v.filter((item) => typeof item === 'string' && item.trim()).slice(0, max || MAX_STORE_PHOTOS);
}

function sanitizeCoord(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : undefined;
}

// 🆕 轻量省市提取：门店档案编辑时若 province/city 仍留空，尝试从门店名称/地址
// 文本里猜一猜。不追求覆盖全国行政区划，只覆盖本项目门店实际集中分布的常见
// 地区；猜不出来就返回空字符串，不编造数据
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

// 允许跨店查看（不限于自己绑定门店）的角色：与 getStatisticsData/getNationalDashboard
// 里"总部级只读汇总"的角色口径一致，仅用于本函数的 get（只读），不影响 update 权限
const CROSS_STORE_VIEW_ROLES = ['super_admin', 'hq_finance', 'regional_finance'];

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

// 读权限：本店任意角色只读；总部级角色可传 storeId 或 storeName 查看机构内任意门店
async function resolveReadTarget(caller, requestedStoreId, requestedStoreName) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  if (CROSS_STORE_VIEW_ROLES.includes(caller.role) && (requestedStoreId || requestedStoreName)) {
    let store = null;
    if (requestedStoreId) {
      const storeRes = await db.collection('stores').doc(requestedStoreId).get().catch(() => null);
      store = storeRes && storeRes.data;
    } else {
      const where = { storeName: requestedStoreName };
      if (caller.tenantId) where.tenantId = caller.tenantId;
      const listRes = await db.collection('stores').where(where).limit(1).get().catch(() => null);
      store = listRes && listRes.data && listRes.data[0];
    }
    if (!store) return { allowed: false, error: '目标门店不存在' };
    // 🛡️ 多租户越权修复：caller.tenantId 或 store.tenantId 任一缺失时不再放行——
    // 此前"两侧都有值才比对"的写法，会让尚未回填 tenantId 的总部级账号（早期
    // setupSuperAdmin 引导创建，见 createStore.js resolveCallerTenantId 同类场景）
    // 或尚未回填 tenantId 的历史门店记录跳过比对，读到 adminKey 等敏感字段（见
    // 下方 GET 分支）。两侧都必须存在且相等才放行，与 deleteMealReport 同类修复
    // 一致，宁可因迁移过渡期账号被拒绝也不放行跨机构读取。
    if (!caller.tenantId || !store.tenantId || caller.tenantId !== store.tenantId) {
      return { allowed: false, error: '无权限：目标门店不属于您所在的机构' };
    }
    // 🐛 性能修复：这里已经拿到完整 store 文档了，一并带出去给 action:'get' 复用，
    // 避免调用方紧接着再按 _id 查一次同一份文档——见下方 exports.main 的消费处
    return { allowed: true, storeId: store._id, store };
  }

  if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店' };
  return { allowed: true, storeId: caller.storeId };
}

// 写权限：仅店长（限本店）或超管（限本机构内任意门店）
async function resolveWriteTarget(caller, requestedStoreId) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  // 🏛️ 权限向下继承：大家长天然拥有店长的全套日常管理权限（自己发起的编辑直接生效，
  // 不会像普通店长那样被下面的家长风控锁挂起——见 update 分支里 caller.role ===
  // 'store_manager' 的判断，patriarch 自己编辑自己不需要"等自己确认"）
  if (caller.role === 'store_manager' || caller.role === 'store_patriarch') {
    if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店，无法编辑门店画像' };
    return { allowed: true, storeId: caller.storeId };
  }

  if (caller.role === 'super_admin') {
    if (!requestedStoreId) return { allowed: false, error: '请指定目标门店' };
    const storeRes = await db.collection('stores').doc(requestedStoreId).get().catch(() => null);
    const store = storeRes && storeRes.data;
    if (!store) return { allowed: false, error: '目标门店不存在' };
    // 🛡️ 多租户越权修复：同上 resolveReadTarget 处的修复说明，两侧 tenantId 都
    // 必须存在且相等才放行编辑，不因任一侧缺失就跳过比对。
    if (!caller.tenantId || !store.tenantId || caller.tenantId !== store.tenantId) {
      return { allowed: false, error: '无权限：目标门店不属于您所在的机构' };
    }
    return { allowed: true, storeId: requestedStoreId };
  }

  return { allowed: false, error: '无权限：仅店长或超级管理员可编辑门店人员与服务人群画像' };
}

function clampCount(v) {
  const n = parseInt(v, 10);
  if (!isFinite(n) || n < 0) return 0;
  return n;
}

// 🏛️ 家长风控锁：门店是否绑定了家长/督导——绑定了才需要走"店长发起、家长/超管
// 确认"的挂起流程；未绑定家长的门店，行为与升级前完全一致（店长直接生效）
function hasBoundPatriarch(store) {
  return !!(store && store.patriarchOpenId);
}

exports.main = async (event, context) => {
  const { action, storeId, storeName } = event;
  const { OPENID } = cloud.getWXContext();

  try {
    const caller = await resolveCaller(OPENID);

    if (action === 'get') {
      const target = await resolveReadTarget(caller, storeId, storeName);
      if (!target.allowed) return { success: false, error: target.error };

      // 🐛 超时根因修复（statistics.ts fetchStoreProfile 报 >8000ms 超时）：
      // 总部级角色（super_admin/hq_finance/regional_finance）传 storeName 查询时，
      // resolveReadTarget 内部已经用 db.collection('stores').where({storeName,
      // tenantId}) 查出了完整 store 文档才能做归属校验，此前这里又无条件按 _id
      // 重新查一次同一份文档——三次串行数据库往返（resolveCaller + storeName
      // 反查 + 按 _id 再查一次）叠加 stores 集合当时只有 storeName/tenantId 各自
      // 独立的单字段索引（没有覆盖这条双字段查询的复合索引，见 createIndexes 里
      // 新增的 storeName_tenantId 索引），在门店数增长后这条链路明显变慢，
      // 是统计大屏切换门店卡超时的根因之一。现在优先复用 resolveReadTarget 已经
      // 查到的文档，只有本店视角（未经过 storeName/storeId 反查分支）才需要真的
      // 按 _id 查一次。
      let store = target.store;
      if (!store) {
        const storeRes = await db.collection('stores').doc(target.storeId).get().catch(() => null);
        store = storeRes && storeRes.data;
      }
      if (!store) return { success: false, error: '门店不存在' };

      const profile = {};
      PROFILE_FIELDS.forEach((f) => { profile[f] = store[f] || 0; });
      TEXT_PROFILE_FIELDS.forEach((f) => { profile[f] = store[f] || ''; });
      TEMPLATE_FIELDS.forEach((f) => { profile[f] = store[f] || ''; });
      PHOTO_FIELDS.forEach((f) => { profile[f] = Array.isArray(store[f]) ? store[f] : []; });

      return {
        success: true,
        data: {
          storeId: target.storeId,
          storeName: store.storeName || '',
          canEdit: caller && (caller.role === 'store_manager' || caller.role === 'store_patriarch' || caller.role === 'super_admin'),
          // 🏛️ 家长/店长姓名：海报落款、验真页、家长大盘展示姓名的唯一数据来源
          patriarch: store.patriarch || '',
          manager: store.manager || '',
          // 🌐 运营状态（与门店启用/停用的 status 是两个不同维度）+ 坐标
          // （未设置时为 undefined，前端据此判断是否参与"附近门店"距离计算）
          operatingStatus: store.operatingStatus || 'operating',
          latitude: typeof store.latitude === 'number' ? store.latitude : undefined,
          longitude: typeof store.longitude === 'number' ? store.longitude : undefined,
          // 待审批的画像变更（若有）：供 store-profile 页展示"有一份更新正在等待审批"提示
          pendingProfileUpdate: store.pendingProfileUpdate || null,
          // 🔐 管理员密钥：非授权角色只知道"是否已设置"，不暴露原文；
          // 大家长/超管可读取以便核查/重置
          adminKeySet: !!(store.adminKey && String(store.adminKey).trim()),
          adminKey: (caller && (caller.role === 'store_patriarch' || caller.role === 'super_admin'))
            ? (store.adminKey || '') : undefined,
          // 🏷️ 服务受众标签配置：自定义填报表单文案，按需返回（无配置时为 null）
          serviceTargetConfig: store.serviceTargetConfig || null,
          // 🏮 品牌矩阵归属（'tongxin'/'yuhuazhai'/''）
          platformFamily: store.platformFamily || '',
          // 🌟 真实机构业态类型（VALID_ORG_TYPES 之一，见文件头），供前端驱动机构
          // 归属徽标/文化入口文案等展示，替代此前只能靠 tenantId 前缀粗猜的口径
          orgType: store.orgType || '',
          // 🍚 供餐餐次配置：未配置过（历史门店/新建门店尚未显式设置）时回退默认单午餐档
          mealConfig: { supportedMeals: sanitizeSupportedMeals(store.mealConfig && store.mealConfig.supportedMeals) },
          ...profile
        }
      };
    }

    if (action === 'update') {
      const target = await resolveWriteTarget(caller, storeId);
      if (!target.allowed) return { success: false, error: target.error };

      const updateFields = {};
      // 🐛 只在调用方真的传了这个字段时才写入——此前这里无条件对全部 7 项数字
      // 字段调用 clampCount(event[f])，而 clampCount(undefined) 会返回 0，导致
      // 任何"只想单独更新其他字段"的局部提交（例如资质公示照片管理弹窗只提交
      // 3 个照片字段，压根不带这 7 项数字字段）都会把人员与服务人群画像的真实
      // 数字静默清零。与下面 TEXT_PROFILE_FIELDS/PHOTO_FIELDS 已有的"只在提供时
      // 才写入"逻辑对齐，明确传 0 仍然会写入（0 !== undefined），只有完全不传
      // 这个字段才跳过
      PROFILE_FIELDS.forEach((f) => { if (event[f] !== undefined) updateFields[f] = clampCount(event[f]); });
      // 文本档案字段（地址/开业日期等）可能只想单独改其中一项，若不管有没有传都
      // 无条件塞 sanitizeText(undefined) === ''，会把没在本次请求里出现的字段
      // 静默清空，等于每次局部更新都顺带抹掉其余档案信息
      TEXT_PROFILE_FIELDS.forEach((f) => { if (event[f] !== undefined) updateFields[f] = sanitizeText(event[f]); });
      // 🏢 平台类型：白名单校验后写入，防止客户端传入任意字符串
      if (event.orgType !== undefined) {
        updateFields.orgType = VALID_ORG_TYPES.includes(event.orgType) ? event.orgType : '';
      }
      // 🏷️ 服务受众标签配置：自定义填报表单文案（platformBrand/targetLabels/enabledFeatures）
      // sanitizeServiceTargetConfig 返回 null 时表示无有效数据，写 null 清除旧配置
      if (event.serviceTargetConfig !== undefined) {
        updateFields.serviceTargetConfig = sanitizeServiceTargetConfig(event.serviceTargetConfig);
      }
      // 🏮 品牌矩阵归属：白名单校验，空字符串表示无归属
      if (event.platformFamily !== undefined) {
        const pf = String(event.platformFamily || '').trim();
        updateFields.platformFamily = VALID_PLATFORM_FAMILIES.includes(pf) ? pf : '';
      }
      // 🍚 供餐餐次配置：白名单校验 + 兜底默认单午餐档，不允许写出空数组
      if (event.supportedMeals !== undefined) {
        updateFields.mealConfig = { supportedMeals: sanitizeSupportedMeals(event.supportedMeals) };
      }
      // 🌟 店铺模板自定义字段：同样"只在调用方真的传了才写入"，只提交部分字段（如只改
      // 致谢词）时不会把没提交的宣传标语静默清空
      TEMPLATE_FIELDS.forEach((f) => { if (event[f] !== undefined) updateFields[f] = sanitizeText(event[f], TEMPLATE_FIELD_LIMITS[f]); });
      PHOTO_FIELDS.forEach((f) => {
        if (event[f] !== undefined) updateFields[f] = sanitizePhotos(event[f], f === 'storePhotos' ? MAX_STORE_PHOTOS : CATEGORY_PHOTOS_MAX);
      });
      if (VALID_OPERATING_STATUSES.includes(event.operatingStatus)) {
        updateFields.operatingStatus = event.operatingStatus;
      }
      const lat = sanitizeCoord(event.latitude);
      const lng = sanitizeCoord(event.longitude);
      if (lat !== undefined && lng !== undefined) {
        updateFields.latitude = lat;
        updateFields.longitude = lng;
      }

      // 🏷️ 门店主名称（storeName）：仅大家长/超管可直接修改，店长改名须经大家长审批走
      // pendingProfileUpdate 流程（由下面的风控锁处理）。清洗后限 60 字，空值不写入。
      if (event.storeName !== undefined) {
        if (caller.role === 'store_patriarch' || caller.role === 'super_admin') {
          const cleanedName = sanitizeText(event.storeName).slice(0, 60);
          if (cleanedName) {
            updateFields.storeName = cleanedName;
            // registeredName 同步保持一致，避免两个字段出现分叉
            updateFields.registeredName = updateFields.registeredName || cleanedName;
          }
        }
        // 店长传了 storeName 但本身无权直接改→静默忽略，让 registeredName 走审批流
      }

      // 🔐 管理员密钥：安全敏感字段，仅大家长/超管可设置/清空，店长无权限。
      // 直接写库，不经过家长风控锁（该字段本身就是大家长/超管级操作）
      if (event.adminKey !== undefined) {
        if (caller.role !== 'store_patriarch' && caller.role !== 'super_admin') {
          return { success: false, error: '无权限：仅大家长或超级管理员可设置/修改管理员密钥' };
        }
        updateFields.adminKey = sanitizeText(event.adminKey).slice(0, 50);
      }

      // 🛡️ 服务端内容安全检测：对本次实际会写入的公开展示类文本字段做一次统一
      // 检查（人员数字/坐标/密钥等非公开自由文本字段不需要过审）
      const textFieldsToCheck = [...TEXT_PROFILE_FIELDS, ...TEMPLATE_FIELDS, 'storeName']
        .map((f) => updateFields[f])
        .filter((v) => typeof v === 'string' && v);
      for (const text of textFieldsToCheck) {
        if (!(await checkContentSafe(text))) {
          return { success: false, error: '内容包含违规信息，请修改后重新提交' };
        }
      }

      // 🆕 保存时省市智能回填：调用方这次没有主动修改 province/city（未传这两个
      // 字段），且门店档案里目前这两项都还是空的，才尝试从门店名称/地址文本里
      // 轻量提取兜底——调用方明确改动这两个字段时（哪怕改成空值）不做任何猜测
      // 覆盖，只补"确实还没填过"的历史/新建门店
      if (updateFields.province === undefined && updateFields.city === undefined) {
        const storeRes = await db.collection('stores').doc(target.storeId).get().catch(() => null);
        const store = storeRes && storeRes.data;
        if (store && !store.province && !store.city) {
          const addressForGuess = updateFields.address !== undefined ? updateFields.address : (store.address || '');
          const guessed = extractRegionFromText(`${store.storeName || ''} ${addressForGuess}`);
          if (guessed.province || guessed.city) {
            updateFields.province = guessed.province;
            updateFields.city = guessed.city;
          }
        }
      }

      // 🏛️ 家长风控锁：店长发起且本店已绑定家长/督导时，不直接生效，改为存入
      // pendingProfileUpdate 挂起对象等待确认；超管发起或门店未绑定家长时，
      // 行为与升级前完全一致（直接生效）
      if (caller.role === 'store_manager') {
        const storeRes = await db.collection('stores').doc(target.storeId).get().catch(() => null);
        const store = storeRes && storeRes.data;
        if (hasBoundPatriarch(store)) {
          if (store.pendingProfileUpdate) {
            return { success: false, error: '已有一份画像更新正在等待家长/超管审批，请勿重复提交' };
          }
          await db.collection('stores').doc(target.storeId).update({
            data: {
              pendingProfileUpdate: {
                ...updateFields,
                requestedBy: OPENID,
                requestedAt: db.serverDate()
              }
            }
          });
          return { success: true, pending: true, message: '已提交家长/超管审批，确认后生效' };
        }
      }

      const updateData = { ...updateFields };
      updateData.lastProfileUpdatedBy = OPENID;
      updateData.lastProfileUpdatedAt = db.serverDate();

      await db.collection('stores').doc(target.storeId).update({ data: updateData });

      return { success: true, message: '门店人员与服务人群画像已更新', data: updateData };
    }

    if (action === 'approveProfileUpdate' || action === 'rejectProfileUpdate') {
      if (!caller || (caller.role !== 'store_patriarch' && caller.role !== 'super_admin')) {
        return { success: false, error: '无权限：仅家长或超级管理员可确认画像变更申请' };
      }
      if (!storeId) return { success: false, error: '缺少 storeId 参数' };

      const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
      const store = storeRes && storeRes.data;
      if (!store) return { success: false, error: '门店不存在' };
      // 🛡️ 多租户越权修复：同上 resolveReadTarget/resolveWriteTarget 处的修复
      // 说明，两侧 tenantId 都必须存在且相等才放行审批。
      if (!caller.tenantId || !store.tenantId || caller.tenantId !== store.tenantId) {
        return { success: false, error: '无权限：不能审批其他机构的门店' };
      }
      if (caller.role === 'store_patriarch' && caller.storeId !== storeId) {
        return { success: false, error: '无权限：不能审批其他门店的画像变更申请' };
      }
      if (!store.pendingProfileUpdate) {
        return { success: false, error: '该门店当前没有待确认的画像变更申请' };
      }

      if (action === 'rejectProfileUpdate') {
        await db.collection('stores').doc(storeId).update({ data: { pendingProfileUpdate: null } });
        return { success: true, message: '已驳回画像变更申请，数据保持原状' };
      }

      const pending = store.pendingProfileUpdate;
      const updateData = {};
      // 🐛 与 update 分支同一处修复：只在这份挂起申请当初真的提交过这个字段时
      // 才写入，避免只提交了资质公示照片的挂起申请，审批通过后把人员画像数字清零
      PROFILE_FIELDS.forEach((f) => { if (pending[f] !== undefined) updateData[f] = clampCount(pending[f]); });
      TEXT_PROFILE_FIELDS.forEach((f) => { if (pending[f] !== undefined) updateData[f] = sanitizeText(pending[f]); });
      TEMPLATE_FIELDS.forEach((f) => { if (pending[f] !== undefined) updateData[f] = sanitizeText(pending[f], TEMPLATE_FIELD_LIMITS[f]); });
      PHOTO_FIELDS.forEach((f) => {
        if (pending[f] !== undefined) updateData[f] = sanitizePhotos(pending[f], f === 'storePhotos' ? MAX_STORE_PHOTOS : CATEGORY_PHOTOS_MAX);
      });
      if (VALID_ORG_TYPES.includes(pending.orgType)) {
        updateData.orgType = pending.orgType;
      }
      if (pending.serviceTargetConfig !== undefined) {
        updateData.serviceTargetConfig = sanitizeServiceTargetConfig(pending.serviceTargetConfig);
      }
      if (pending.platformFamily !== undefined) {
        const pf = String(pending.platformFamily || '').trim();
        updateData.platformFamily = VALID_PLATFORM_FAMILIES.includes(pf) ? pf : '';
      }
      if (pending.mealConfig && pending.mealConfig.supportedMeals !== undefined) {
        updateData.mealConfig = { supportedMeals: sanitizeSupportedMeals(pending.mealConfig.supportedMeals) };
      }
      if (VALID_OPERATING_STATUSES.includes(pending.operatingStatus)) {
        updateData.operatingStatus = pending.operatingStatus;
      }
      if (typeof pending.latitude === 'number' && typeof pending.longitude === 'number') {
        updateData.latitude = pending.latitude;
        updateData.longitude = pending.longitude;
      }
      updateData.lastProfileUpdatedBy = pending.requestedBy || '';
      updateData.lastProfileUpdatedAt = db.serverDate();
      updateData.pendingProfileUpdate = null;

      await db.collection('stores').doc(storeId).update({ data: updateData });

      return { success: true, message: '已确认画像变更', data: updateData };
    }

    return { success: false, error: '未知操作: ' + action };
  } catch (err) {
    console.error('[manageStoreProfile] 异常:', err);
    return { success: false, error: err.message || '服务异常' };
  }
};
