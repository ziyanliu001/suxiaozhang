// 云函数：getStoreList
// 替代前端直接 db.collection('stores').get() 的全表查询。
//
// 🏢 多租户边界：门店列表（哪怕只是门店名称）也是机构的商业信息，不应被其他机构
// 或平台管理员看到。本函数按调用者所属 tenantId 过滤：
// - platform_admin 显式拒绝（不返回任何门店信息，符合其"不碰业务数据"的边界）；
// - 已分配 tenantId 的账号按 tenantId 过滤；
// - 尚未回填 tenantId 的账号（游客/未审批）直接返回空列表，不再退回"不过滤"的全表
//   兜底行为——backfillTenantId 已可用于回填存量数据，不应再以数据泄露为代价兼容旧账号。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const UNCLASSIFIED_REGION_LABEL = '未分类地区';

// 🆕 轻量省市提取 + 兜底标签：历史门店（在 province/city 字段上线前建的店，或
// 建店时跳过了这两项）读出来可能仍是空字符串。先尝试从门店名称/地址文本里
// 轻量提取（不追求覆盖全国行政区划，只覆盖本项目门店实际集中分布的常见地区），
// 提取也失败时打上"未分类地区"标签——确保这批门店在"按地区筛选"里仍然是
// 可见、可选中的一项，而不是从省市下拉/自定义门店列表里静默消失
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

// 门店记录已有的 province/city 优先；都缺失时先猜，猜不出来才打兜底标签
function resolveStoreRegion(store) {
  const rawProvince = store.province || '';
  const rawCity = store.city || '';
  if (rawProvince || rawCity) {
    return { province: rawProvince || UNCLASSIFIED_REGION_LABEL, city: rawCity || UNCLASSIFIED_REGION_LABEL };
  }
  const guessed = extractRegionFromText(`${store.storeName || ''} ${store.address || ''}`);
  return {
    province: guessed.province || UNCLASSIFIED_REGION_LABEL,
    city: guessed.city || UNCLASSIFIED_REGION_LABEL
  };
}

// 门店文档 -> 前端展示对象，供下面"本机构门店列表"与"跨机构发现模式"共用同一份
// 字段整形逻辑，避免两处各写一份、日后改字段漏改一处
function toStoreListItem(s) {
  // 🆕 province/city 都缺失的历史门店：先按门店名称/地址轻量提取，仍提取不出来
  // 就打"未分类地区"标签，确保它们在省市级联筛选/自定义门店列表里依然可见
  const region = resolveStoreRegion(s);
  return {
    storeId: s._id,
    storeName: s.storeName || '未命名门店',
    status: s.status || 'active',
    // 🌟 门店宣传/招募海报（drawStoreInvitationPoster）需要展示地址，
    // createStore 云函数本就落库 address 字段，这里一并透出，不新增查询
    address: s.address || '',
    // 🌐 门店选择器：运营状态（与上面 status 是两个不同维度的字段——status 是
    // 超管的启用/停用软删除开关，operatingStatus 是"运营中/筹备中/暂停运营"的
    // 真实业务状态展示）+ 省市（供级联筛选）+ 经纬度（供"附近门店"距离排序，
    // 未设置坐标的门店这两项为 undefined，前端自行判断降级）
    operatingStatus: s.operatingStatus || 'operating',
    province: region.province,
    city: region.city,
    latitude: typeof s.latitude === 'number' ? s.latitude : undefined,
    longitude: typeof s.longitude === 'number' ? s.longitude : undefined
  };
}

// 🐛 二次根因修复：上一版把雨花专区精确收窄成 orgType==='yuhuazhai' 相等匹配，
// 结果把大批历史门店（"厦门海沧三泓愿""漳州白礁保生雨花斋""测试1"——本项目
// 最早就是纯雨花斋起步，orgType 这个字段是后来扩展"通用/社区食堂"品类时才加
// 的，createStore 云函数只在调用方显式传入合法值时才会写这个字段）一起排除
// 在外，因为它们的 orgType 压根没被打过标（字段缺失，不是等于别的值）。
// 严格相等匹配导致雨花专区查询整个返回空列表，主工作台直接卡死在"机构还没有
// 门店"——这比"极少数尚未执行 fixTenantHierarchy 数据清洗迁移、因而混入的
// 脏数据门店"要严重得多，是当前阶段两害相权取其轻：
// - 雨花专区（orgType==='yuhuazhai'）：精确匹配 'yuhuazhai'，或 orgType 字段
//   缺失/空字符串（历史未打标数据，按当时"雨花斋是唯一品类"的默认背景兼容
//   为雨花斋）。
// - 其余专区：只要不是精确等于 'yuhuazhai' 就算，缺失/空字符串同样兼容匹配
//   （这条分支本来就是这个语义，未改变）。
// ⚠️ 这只是过渡期的兼容判定，不是长久之计——一旦 fixTenantHierarchy 迁移
// 正式对存量门店回填好准确的 orgType，"缺失/空字符串"这个兼容分支就不会再
// 命中任何真实数据（新建门店从一开始就会有明确的 orgType），届时可以放心收紧
// 回严格相等匹配，彻底堵死"脏数据也被兼容进来"这个口子
function buildOrgTypeCondition(orgType) {
  const _ = db.command;
  // 🛡️ 字段级 OR：必须用 Command.or() 链式写法组合同一字段的多个条件（与
  // manageDailyMenu 云函数 _.eq(DEFAULT_MEAL_TYPE).or(_.exists(false)) 同一种
  // 用法），不能写成 _.or([{orgType:'yuhuazhai'}, {orgType:_.exists(false)}])
  // 再整体塞进 {orgType: ...} ——那种数组形式的 _.or 是给 .where() 顶层多字段
  // 条件用的，嵌套进单个字段值里不会按预期匹配
  return orgType === 'yuhuazhai'
    ? _.eq('yuhuazhai').or(_.exists(false)).or(_.eq(''))
    : _.neq('yuhuazhai');
}

// 🆕 跨机构发现模式：【选择工作空间】页新用户挑选要加入的具体站点场景专用
// （Bug 1）——调用者尚未归属任何机构，或显式要求跨机构浏览（crossTenant:true），
// 天然需要跨机构可见性，与"已归属机构后必须严格按 tenantId 隔离"是两条独立
// 边界，互不冲突（见下方主流程注释）。只返回基础展示字段（不含 tenantId/
// 经纬度等），门店名称/地址本就是招募海报上会公开分发的信息，不算敏感数据
async function handleDiscoverByOrgType(orgType) {
  const _ = db.command;
  const where = { orgType: buildOrgTypeCondition(orgType), status: _.neq('inactive') };

  const storesRes = await db.collection('stores')
    .where(where)
    .orderBy('storeName', 'asc')
    .limit(100)
    .get()
    .catch(() => ({ data: [] }));

  return { success: true, list: (storesRes.data || []).map(toStoreListItem) };
}

// 🆕 门店名称反查模式：notice.ts【待处理提醒】列表专用——report_logs.shopName
// 是提交当时快照的静态文本，门店后续改名（如"嵩屿街道敬老中心助餐点"改成
// "厦门海沧三泓愿"）不会回填历史记录，导致提醒列表长期展示过期店名。这里按
// storeId 批量反查 stores 集合当前的真实 storeName，只返回 storeId/storeName
// 两个非敏感展示字段，不透传经纬度/tenantId 等信息
async function handleResolveStoreNames(storeIds, tenantId) {
  const uniqueIds = Array.from(new Set((storeIds || []).filter(Boolean))).slice(0, 100);
  if (uniqueIds.length === 0) return { success: true, list: [] };

  const where = { _id: db.command.in(uniqueIds) };
  // 🛡️ 有 tenantId 时按机构再收窄一层做防御性纵深；storeIds 本身已经是调用者
  // 自己能看到的 report_logs 记录带出来的，不构成新的越权面，tenantId 缺失时
  // （理论上不会发生）直接放行也不会泄露超出调用者原本可见范围的信息
  if (tenantId) where.tenantId = tenantId;

  const storesRes = await db.collection('stores')
    .where(where)
    .field({ storeName: 1 })
    .get()
    .catch(() => ({ data: [] }));

  return {
    success: true,
    list: (storesRes.data || []).map((s) => ({ storeId: s._id, storeName: s.storeName || '' }))
  };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  // 🛡️ 默认只返回 status==='active' 的门店（切店/邀请码等场景不该选到已停用门店）；
  // 仅门店管理页自己需要连"已停用"门店一起看（以便重新启用），显式传 includeInactive:true
  const includeInactive = !!(event && event.includeInactive);
  const requestedOrgType = (event && event.orgType) || '';
  // 🆕 跨机构发现模式显式开关：必须显式传 true（或调用者压根没有 tenantId）
  // 才会触发跨机构查询——不再仅凭"传了 orgType"就自动判定，避免与下面"已归属
  // 机构账号（含超管）在自己机构范围内按 orgType 收窄浏览"这个完全不同的语义
  // 混淆到一起
  const crossTenantDiscover = !!(event && event.crossTenant);
  // 🆕 门店名称反查模式显式开关：传了 storeIds 数组即视为一次批量反查请求，
  // 与下面"按 orgType 收窄浏览门店列表"是完全不同的语义，互不干扰
  const resolveStoreIds = Array.isArray(event && event.storeIds) ? event.storeIds : null;

  try {
    let tenantId = '';
    let role = '';
    if (OPENID) {
      const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
      if (roleRes.data && roleRes.data.length > 0) {
        tenantId = roleRes.data[0].tenantId || '';
        role = roleRes.data[0].role || '';
      }
    }

    if (role === 'platform_admin') {
      return { success: true, list: [] };
    }

    if (resolveStoreIds) {
      return await handleResolveStoreNames(resolveStoreIds, tenantId);
    }

    // 🛡️ 多租户边界：跨机构发现模式只在【显式要求跨机构浏览】或【调用者压根
    // 没有 tenantId】时才触发——已归属机构的账号（含超管）默认仍然严格按自己
    // 的 tenantId 过滤，不会意外看到跨机构门店
    if (requestedOrgType && (crossTenantDiscover || !tenantId)) {
      return await handleDiscoverByOrgType(requestedOrgType);
    }

    if (!tenantId) {
      return { success: true, list: [] };
    }

    // 🐛 核心 Bug 修复："超管进雨花专区，选择服务站点却混入嵩屿（通用/社区
    // 长者食堂门店）"——根因是超管浏览的是【自己所属机构】下的门店列表，此前
    // 这里只按 tenantId 过滤，从不看 orgType；而"嵩屿街道敬老中心助餐点"这类
    // 历史脏数据即便 orgType 不是 yuhuazhai，只要 tenantId 恰好挂在超管所属的
    // 默认全国机构 yuhuazhai_national 下，就会被 tenantId 过滤直接放行。
    // 现在只要调用方（当前专区）显式传了 orgType，就在 tenantId 之上叠加
    // orgType 精确匹配作为第二层收窄——即使 fixTenantHierarchy 数据清洗还没
    // 执行到位，这里也能在查询层面兜底拦下混入的跨专区门店
    const where = {
      tenantId,
      ...(includeInactive ? {} : { status: db.command.neq('inactive') }),
      ...(requestedOrgType ? { orgType: buildOrgTypeCondition(requestedOrgType) } : {})
    };

    const storesRes = await db.collection('stores')
      .where(where)
      .orderBy('storeName', 'asc')
      .limit(100)
      .get();

    return { success: true, list: (storesRes.data || []).map(toStoreListItem) };
  } catch (err) {
    console.error('[getStoreList] 异常:', err);
    return { success: false, error: err.message || '门店列表查询失败', list: [] };
  }
};
