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

// 🆕 发现模式：【选择工作空间】页专用——用户点击"雨花公益食堂专区"/"通用素食·
// 社区长者食堂专区"卡片时，挑选一个具体站点以家人/义工身份参与（Bug 1）。这里
// 天然需要跨机构可见性（帮用户从全平台范围内找到目标站点，不是"查看我自己机构
// 的门店"），与"已归属机构后必须严格按 tenantId 隔离"是两条独立边界，互不冲突：
// 只在调用方显式传入 orgType 时才触发（见下方主流程注释），不传 orgType 的既有
// 调用方（切店下拉框/邀请码申请等）行为完全不变，永远走 tenantId 过滤。只返回
// 基础展示字段（不含 tenantId/经纬度等），门店名称/地址本就是招募海报上会公开
// 分发的信息，不算敏感数据
async function handleDiscoverByOrgType(orgType) {
  const _ = db.command;
  // 🌐 通用素食/社区长者食堂专区：排除雨花斋门店即可覆盖 elderly_canteen/
  // volunteer_station/rescue_team/other 等其余全部机构类型，以及历史上从未
  // 设置过 orgType 字段的门店（$ne 天然匹配字段缺失的历史门店，视为"通用"）
  const where = orgType === 'yuhuazhai'
    ? { orgType: 'yuhuazhai', status: _.neq('inactive') }
    : { orgType: _.neq('yuhuazhai'), status: _.neq('inactive') };

  const storesRes = await db.collection('stores')
    .where(where)
    .orderBy('storeName', 'asc')
    .limit(100)
    .get()
    .catch(() => ({ data: [] }));

  return { success: true, list: (storesRes.data || []).map(toStoreListItem) };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  // 🛡️ 默认只返回 status==='active' 的门店（切店/邀请码等场景不该选到已停用门店）；
  // 仅门店管理页自己需要连"已停用"门店一起看（以便重新启用），显式传 includeInactive:true
  const includeInactive = !!(event && event.includeInactive);
  const requestedOrgType = (event && event.orgType) || '';

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

    // 🛡️ 多租户边界：发现模式只在调用方【显式传入 orgType】时才触发——不传
    // orgType 的既有调用方（切店下拉框/邀请码申请预填等）无论是否已归属机构，
    // 行为完全不变，永远走下面的 tenantId 过滤，不会意外看到跨机构门店。
    // 显式传了 orgType 才代表这是一次"选择工作空间"式的主动跨机构发现请求
    // （见 handleDiscoverByOrgType 注释），已归属机构的账号也允许使用——
    // 单账号目前只能绑定一个机构/门店，这类账号触发发现模式后即便选中了另一家
    // 机构的门店，走的也是 processRoleAudit 正常申请流程，不会绕过审批直接生效
    if (requestedOrgType) {
      return await handleDiscoverByOrgType(requestedOrgType);
    }

    if (!tenantId) {
      return { success: true, list: [] };
    }

    const where = includeInactive
      ? { tenantId }
      : { tenantId, status: db.command.neq('inactive') };

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
