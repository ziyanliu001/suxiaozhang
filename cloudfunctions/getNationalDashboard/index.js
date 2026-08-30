const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const MASK_TEXT = '***（仅店长可见）';

// 🌐 多租户默认账套：仅雨花斋历史数据的遗留兜底标识，新机构不使用此值。
// 在查询中用于区分"是否需要兼容无 tenantId 字段的旧数据"（见 makeTenantFilter）。
const LEGACY_TENANT_ID = 'yuhuazhai_national';

// 🛡️ 租户感知查询条件构建器：
//   - 原始账套（yuhuazhai_national）：多租户改造前的历史记录可能无 tenantId 字段，
//     查询时兼容"tenantId 存在且匹配"与"tenantId 字段不存在"两种情况，避免历史数据丢失。
//   - 新机构账套：严格等值匹配，绝不返回其他机构（包括雨花斋历史遗留）数据，
//     100% 隔离，防止跨租户数据污染。
function makeTenantFilter(tenantId) {
  if (tenantId === LEGACY_TENANT_ID) {
    return _.or([{ tenantId }, { tenantId: _.exists(false) }]);
  }
  return { tenantId };
}

// 🌟 超管专属高阶治理看板：时间维度切片 + 离线门店预警阈值
const RANGE_DAYS = { '7d': 7, 'month': 30, 'quarter': 90, 'year': 365 };
const RANGE_LABELS = { '7d': '近7天', 'month': '本月', 'quarter': '本季度', 'year': '本年', 'all': '全部时间' };
// 🆕 门店健康度告警中心（2026-08-30 动态续航预测引擎）：离线判定改为两档——
// 超过 3 天未提交视为需要留意的 OFFLINE，超过 7 天升级为更紧急的
// SERIOUS_OFFLINE（失联），与资金续航（fundingDays）是两个独立维度，
// 不再合并成一个笼统的 healthStatus 枚举值，见下方 storeMatrix 构建处
const OFFLINE_ALERT_DAYS = 3;
const SERIOUS_OFFLINE_ALERT_DAYS = 7;
// 🆕 新店爬坡中判定阈值：查询窗口内实际开餐天数 < 3 天时，样本量太小，任何
// 续航天数推算都不可信（比如只开了 1 天、当天恰好没什么支出，会算出一个
// 虚高的续航天数），统一归为 NEW_STORE，不参与资金健康度评级
const NEW_STORE_MIN_OPEN_DAYS = 3;
// 🆕 日均支出兜底基数：开餐天数不足以计算真实日均支出时的保守估算值，
// 与此前 avgDailyExpense 的兜底值保持一致，不凭空拍一个新数字
const DEFAULT_DAILY_EXPENSE_FALLBACK = 150;

function isoDateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysBetween(dateStr, todayStr) {
  if (!dateStr) return Infinity;
  const a = new Date(dateStr).getTime();
  const b = new Date(todayStr).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}

// 🐛 根因修复（2026-08-30 全平台脱敏专项）：全国大屏的"爱心滚动墙"
// （publicDonorEntries/latestPublicDonors）此前原样吐出捐赠人真实姓名，且
// 只按报告级 log.isAnonymous 一刀切要么整份收要么整份跳过——"item 本身没有
// 独立的匿名标记"这条旧注释已经过时：逐条阳善/阴德区分功能（见
// utils/parser.ts DonorItem.isAnonymous）允许单条捐赠显式覆盖报告级默认值，
// 报告级阳善里单独标记阴德的一条不该被当成阳善展示真实姓名。现在统一：
// ①姓名一律脱敏展示（不再原样吐出全名），②按每一条自己的 isAnonymous
// 判断（未标记的才继承报告级默认值），阴德统一展示"爱心善士"占位，阳善
// 展示脱敏后的姓名而不是直接跳过整份报表——与
// cloudfunctions/getSunshineLedger、miniprogram/utils/privacy.ts 同一套
// 规则（各云函数/前端独立部署，无共享模块机制，需要手动同步这几处拷贝）
function maskName(name) {
  if (!name) return '';
  const str = String(name).trim();
  if (str.length <= 1) return str + '*';
  if (str.length === 2) return str.charAt(0) + '*';
  return str.charAt(0) + '*'.repeat(str.length - 2) + str.charAt(str.length - 1);
}

function resolveItemAnonymous(item, reportLevelAnonymous) {
  return item && item.isAnonymous !== undefined ? !!item.isAnonymous : !!reportLevelAnonymous;
}

function formatDonorDisplayName(name, isAnonymous) {
  if (isAnonymous || !name || !String(name).trim()) return '爱心善士';
  return maskName(name);
}

// 🆕 按地区筛选：province/city 是门店档案里的自由文本字段（见 manageStoreProfile
// TEXT_PROFILE_FIELDS），实际录入可能带"省/市"后缀也可能不带（如"福建省"/"福建"，
// "厦门市"/"厦门"）。只做末尾后缀剥离 + 去空白的轻量归一化，与前端 statistics.ts
// normalizeStoreName（剥离"区市省店"等字符）是同一类防御性容错思路，不引入分词
// /行政区划字典等重量级方案
function normalizeRegionText(str) {
  return String(str || '').trim().replace(/(省|市|自治区|特别行政区|地区)$/, '');
}

const UNCLASSIFIED_REGION_LABEL = '未分类地区';

// 🆕 轻量省市提取 + 兜底标签：历史门店（province/city 字段上线前建的店）读出来
// 可能仍是空字符串。先尝试从门店名称/地址文本里轻量提取（不追求覆盖全国行政
// 区划，只覆盖本项目门店实际集中分布的常见地区），提取也失败时打上"未分类
// 地区"标签——确保这批门店在"按地区筛选"/门店矩阵里依然可见、可被选中，
// 而不是从统计里静默消失
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

// 门店记录已有的 province/city 优先；都缺失时先猜，猜不出来才打兜底标签。
// 传入的 s 只要求有 storeName/address/province/city 字段，report_logs 的兜底
// 门店（无 address）与 stores 集合的正式门店都能直接复用
function resolveStoreRegion(s) {
  const rawProvince = (s && s.province) || '';
  const rawCity = (s && s.city) || '';
  if (rawProvince || rawCity) {
    return { province: rawProvince || UNCLASSIFIED_REGION_LABEL, city: rawCity || UNCLASSIFIED_REGION_LABEL };
  }
  const guessed = extractRegionFromText(`${(s && s.storeName) || ''} ${(s && s.address) || ''}`);
  return {
    province: guessed.province || UNCLASSIFIED_REGION_LABEL,
    city: guessed.city || UNCLASSIFIED_REGION_LABEL
  };
}

// 🆕 环比趋势百分比：prev 为 0/缺失时视为"无可比基数"，返回 null 让前端隐藏徽标，
// 而不是误导性地显示 "+∞%"/"+100%"——与前端 statistics.ts 的 computePctChange
// 是同一条口径（服务端/客户端各自独立实现，本项目各云函数间无共享运行时模块）
function computePctChange(curr, prev) {
  if (!prev) return null;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

// 🛡️ 统一数据脱敏处理函数：分层开放、数据脱敏
// 志工（VOLUNTEER）只应看到"集体荣誉"类服务成果（服务人次、开餐天数、续航状态标签），
// 单餐成本、收支金额、结余、精确续航天数等运营/财务隐私字段一律在服务端就地清除，
// 而不是依赖前端隐藏——即使抓包/调试也不会拿到这些数据，从源头规避合规风险。
function sanitizeReportForVolunteer(data, userRole) {
  const isVolunteer = String(userRole || '').toLowerCase() === 'volunteer';
  if (!isVolunteer) {
    return data;
  }

  const SENSITIVE_KEYS = [
    'singleMealCost', 'costPerMeal', 'avgMealCost',
    'totalIncome', 'totalExpense', 'ingredientExpense',
    'nationalTotalIncome', 'nationalTotalExpense', 'nationalNetAccumulation',
    'latestBalance', 'balance', 'todayBalance', 'yesterdayBalance',
    // 精确续航天数属于可反推资金余额的财务隐私，志工只保留 healthStatus 状态标签。
    // 🆕 alertTags 文本里直接拼了 fundingDays/离线天数等具体数字（如"资金告急
    // (仅剩5天)"），同样需要整体遮罩，否则 SENSITIVE_KEYS 这份按字段名清空的
    // 机制会漏掉"数字被嵌进文本"这种间接泄露
    'fundingDays', 'alertTags',
    // 🆕 跨店调拨建议里点名了具体门店的续航天数（candidateStores[].fundingDays）
    // 与文案（suggestion 里嵌了店名+"充裕"字样），同属财务隐私，一并脱敏
    'supportSuggestions',
    // 🆕 支出环比趋势会暴露"运营规模是在扩张还是收缩"这类财务动向，与它所描述的
    // 原始支出金额同一档隐私级别，一并脱敏；服务人次环比不涉及财务，不需要遮罩
    'nationalTotalExpenseTrend',
    // 🆕 阳善/阴德总金额：与 nationalTotalIncome 同一档财务隐私，服务端直接脱敏
    // （而不是只靠客户端 dataService.ts 的第二层防线）；人次字段（yangshanCount/
    // yindeCount/totalSupportCount）不涉及绝对金额，不在此黑名单内
    'yangshanAmount', 'yindeAmount'
  ];

  const maskOne = (item) => {
    if (!item || typeof item !== 'object') return item;
    const masked = { ...item };
    SENSITIVE_KEYS.forEach((key) => {
      if (key in masked) {
        masked[key] = null;
      }
    });
    if ('costPerMeal' in item) {
      masked.costPerMealMasked = MASK_TEXT;
    }
    masked.isCostRestricted = true;
    return masked;
  };

  return Array.isArray(data) ? data.map(maskOne) : maskOne(data);
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();

  try {
    const roleRes = await db.collection('user_roles')
      .where({ _openid: OPENID })
      .limit(1)
      .get();

    let userRole = 'volunteer';
    let tenantId = '';
    if (roleRes.data && roleRes.data.length > 0) {
      userRole = roleRes.data[0].role || 'volunteer';
      tenantId = roleRes.data[0].tenantId || '';
    } else {
      const userRes = await db.collection('users')
        .where({ _openid: OPENID })
        .limit(1)
        .get();
      if (userRes.data && userRes.data.length > 0) {
        userRole = userRes.data[0].role === 'admin' ? 'super_admin' : 'volunteer';
      }
    }

    // 🛡️ 权限卡口：超管 / 大家长 / 总部财务 / 志工均可访问本机构大屏。
    // 大家长已是门店自治最高负责人，有权查看全机构汇总大盘（订阅套餐检查在下方）。
    // 志工侧为只读脱敏视图；platform_admin 不在名单——大屏是机构内部财务数据，平台运维方无需访问。
    const ALLOWED_ROLES = ['super_admin', 'store_patriarch', 'hq_finance', 'regional_finance', 'volunteer'];
    if (!ALLOWED_ROLES.includes(userRole)) {
      return { success: false, error: '无权限访问本机构数据大屏' };
    }

    // 🛡️ 无法解析出所属机构（游客/未分配角色账号）时直接拒绝，绝不退化为跨机构全量聚合。
    // 此前 tenantId 为空时下面两处查询会直接变成 `{}`（无过滤条件），等于把全平台所有
    // 机构的门店与餐报都聚合进同一张"大屏"返回给调用者，是最严重的一类跨租户数据泄露。
    if (!tenantId) {
      return { success: false, error: '无法确认您所属的机构，暂不支持访问数据大屏' };
    }

    // 🆕 机构名称：供前端全国大屏顶部横幅"📊 爱心网络总览 · [机构名称]"展示，
    // 与 checkTenantPermission 云函数同款只读 name 字段查法（不新增权限面，
    // tenantId 本就只从调用者自己的 user_roles 反查，与上面的隔离判断同一条
    // 安全边界）
    const tenantRes = await db.collection('tenants').doc(tenantId).field({ name: true }).get().catch(() => null);
    const tenantName = (tenantRes && tenantRes.data && tenantRes.data.name) || '';

    // 🏛️ 架构共识（工作空间 vs 全国大屏双轨制，见 CLAUDE.md）：本大屏属于
    // 「全国大屏 / 透视台」维度——社会公信力与透明公开账目总览，查看权限不
    // 挂钩租户订阅套餐，与「工作空间 / 生产台」维度（多店连锁管理、Excel
    // 批量导出等私有功能深度，见 utils/tenantPermission.ts FEATURE_KEYS）
    // 彻底解耦。此前这里有一道 tenant_subscriptions 订阅拦截（非 pro/enterprise
    // 直接拒绝并返回 PLAN_UPGRADE_REQUIRED），导致基础版租户的大家长/财务/志工
    // 切换组织类型 Tab 时每次请求都被拒，界面表现为"点了没反应"——本质是把
    // 该看的公开数据也锁进了付费墙。现在查看权限只保留 ALLOWED_ROLES 角色卡口
    // + tenantId 硬隔离两道防线；财务类敏感字段的访问仍按角色脱敏
    // （sanitizeReportForVolunteer/前端 isManager），付费墙只保留在 Excel
    // 批量导出等真正的深度功能上，不在这里拦截
    const isSuperAdmin = userRole === 'super_admin';

    // 🛡️ 超管专属高阶治理看板：时间维度切片仅对已核验的 super_admin 生效——即使
    // hq_finance/regional_finance/volunteer 在 event 里传了 rangeType，也一律忽略，
    // 继续走原有的全量聚合，不额外扩大这些角色的数据访问范围（见需求4：后端二次校验）
    // （isSuperAdmin 已在上方声明，此处直接复用）
    const requestedRangeType = (event && event.rangeType) || '';
    const rangeType = (isSuperAdmin && RANGE_DAYS[requestedRangeType]) ? requestedRangeType : 'all';
    const rangeStartDate = RANGE_DAYS[rangeType] ? isoDateNDaysAgo(RANGE_DAYS[rangeType]) : null;
    const todayStr = isoDateNDaysAgo(0);

    // 1. 获取本机构下的门店列表（🏢 多租户严格隔离：仅返回本机构门店，绝不跨机构聚合）
    // 🛡️ makeTenantFilter 处理历史兼容：原始账套（yuhuazhai_national）兼容无 tenantId 字段
    // 的旧记录；新机构账套严格等值匹配，100% 隔离，杜绝跨租户数据污染（见函数注释）
    const storesQuery = makeTenantFilter(tenantId);
    const storesRes = await db.collection('stores').where(storesQuery).get();
    let allStores = storesRes.data || [];

    // 🏢 平台类型筛选（orgType）：在 tenantId 隔离之后、filterMode 收窄之前做第一层过滤，
    // 两者可独立叠加——例如"雨花斋 + 按地区筛选"同时生效。
    // 没有 orgType 字段的历史门店（建站前录入）在"全部平台"模式下正常计入；选定具体类型
    // 后，历史门店因 orgType 字段缺失而被排除——预期行为，驱动门店完善档案录入。
    // 🐛 根因修复（专区外分类污染）：雨花公益食堂专区的大屏此前接受任意 orgType
    // 字符串作为筛选参数，前端 Tab 列表历史上也曾出现过不属于本专区的分类
    // （救援队/同心儿童院/其他组织等，来自早期跨业态探索、并未真正落地成
    // createStore 表单可选项），选中后台无法归属任何真实门店的筛选值直接
    // 产生一个空数据大屏，界面表现为"点了这个分类什么都没有"。服务端现在
    // 只认食堂专区实际合规的三个业态分类，客户端传入的其余任何值一律静默
    // 退回"全部平台"（不筛选），不是报错拒绝——与本文件一贯的防御性降级
    // 风格一致（宁可退回安全默认值也不中断请求）
    const SUPPORTED_ORG_TYPES = ['yuhuazhai', 'elderly_canteen', 'volunteer_station'];
    const requestedOrgType = (event && event.orgType && SUPPORTED_ORG_TYPES.includes(event.orgType))
      ? String(event.orgType) : null;
    if (requestedOrgType) {
      allStores = allStores.filter(s => s.orgType === requestedOrgType);
    }

    // 🏮 品牌矩阵筛选（platformFamily）：与 orgType 筛选互斥——选了矩阵就按 platformFamily
    // 过滤，覆盖旗下所有 orgType（如"同心慈善会矩阵"涵盖 tongxin_children + tongxin_cancer_care）。
    // orgType 已经过滤过则跳过（两者不叠加，避免结果集为空）。
    const requestedPlatformFamily = (event && event.platformFamily && event.platformFamily !== 'all')
      ? String(event.platformFamily) : null;
    if (requestedPlatformFamily && !requestedOrgType) {
      allStores = allStores.filter(s => s.platformFamily === requestedPlatformFamily);
    }

    // 品牌矩阵标签：用于 nationalSummary 回传，供前端计算大屏标题
    const PLATFORM_FAMILY_LABELS = { tongxin: '同心慈善会矩阵', yuhuazhai: '雨花矩阵' };
    const brandMatrixLabel = requestedPlatformFamily
      ? (PLATFORM_FAMILY_LABELS[requestedPlatformFamily] || requestedPlatformFamily)
      : null;

    // 🆕 全国大屏门店选择范围：filterMode 决定本次聚合的门店集合，默认 'national'
    // （本机构全量门店，与升级前行为完全一致，老调用方不传该参数不受影响）。
    // 'region' 按 province/city 分组筛选；'custom' 按调用方勾选的 storeIds 精确聚合。
    // 🛡️ 与前面 tenantId 硬隔离是两层独立卡口：这里的筛选只在"已确认属于本机构"的
    // allStores 范围内做子集收窄，绝不会扩大到其他机构的门店
    const filterMode = (event && (event.filterMode === 'region' || event.filterMode === 'custom'))
      ? event.filterMode
      : 'national';
    let targetStores = allStores;
    // 🛡️ 只有"确实收窄了门店范围"才需要在下面丢弃无法归属的兜底日志——
    // 'region' 模式下省份/城市都留空（前端文案"留空表示不限地区"）时，效果必须
    // 与 'national' 完全一致，包括历史遗留、未在 stores 集合注册的兜底门店数据
    // 也要计入，不能因为选了"按地区筛选"入口就悄悄比"全国总览"少算一部分数据
    // 🐛 根因修复（切换组织类型 Tab 后数据不刷新）：此前 isScopedFilter 只在
    // filterMode 为 'region'/'custom' 时才置 true，orgType/platformFamily 筛选
    // 虽然已经正确收窄了 allStores/targetStores，却完全没有让 isScopedFilter
    // 跟着变 true。下面按 storeId/门店名匹配不到 targetStores 里任何一家的
    // report_logs（即"被 orgType 筛掉的门店"产生的记账记录）在 isScopedFilter
    // 为 false 时，会走"兜底门店"分支被重新捡回 storeStatsMap（见下方
    // `if (isScopedFilter) { return; }` 之后的 fallback 逻辑）——相当于筛了个寂寞，
    // 全国核心 KPI 仍然是全平台口径，只有 totalStores 这类直接读 targetStores.length
    // 的字段才会变化，这正是"切换 Tab 后大部分数字不刷新"的真正原因。
    // orgType/platformFamily 只要生效就必须收窄，与 region/custom 一样对待
    let isScopedFilter = !!(requestedOrgType || requestedPlatformFamily);
    if (filterMode === 'region') {
      const provinceFilter = normalizeRegionText(event && event.province);
      const cityFilter = normalizeRegionText(event && event.city);
      if (provinceFilter || cityFilter) {
        // 🆕 按解析后的地区（resolveStoreRegion，含"未分类地区"兜底/文本提取猜测）
        // 匹配，而不是只认门店文档里的原始 province/city 字段——否则历史门店
        // 永远无法通过地区筛选被选中，只能困在"全国总览"里
        targetStores = allStores.filter((s) => {
          const region = resolveStoreRegion(s);
          if (provinceFilter && normalizeRegionText(region.province) !== provinceFilter) return false;
          if (cityFilter && normalizeRegionText(region.city) !== cityFilter) return false;
          return true;
        });
        isScopedFilter = true;
      }
    } else if (filterMode === 'custom') {
      const requestedIds = Array.isArray(event && event.storeIds)
        ? event.storeIds.map(String).filter(Boolean)
        : [];
      // 未勾选任何门店时聚合范围就是空集，不回退到全量门店——防止前端传参异常
      // （如误传空数组）时意外把"自定义"悄悄扩大成"全部门店"
      const idSet = new Set(requestedIds);
      targetStores = allStores.filter((s) => idSet.has(s._id));
      isScopedFilter = true;
    }
    // 🛡️ 筛选态下，report_logs 里无法归属到 targetStores 任何一家的记录（storeId
    // 与门店名均未命中）一律视为"不在本次聚合范围内"直接丢弃，而不是像 'national'
    // 模式那样退回创建兜底门店条目——否则筛选范围外的门店数据会通过兜底分支泄漏
    // 回聚合结果

    // 2. 抓取本机构餐报日志（分页累加）
    let allLogs = [];
    const batchLimit = 100;
    let skip = 0;
    const logsQueryConditions = [
      makeTenantFilter(tenantId),
      { isVoid: _.neq(true) },
      // 🐛 二级审核门槛缺失：本函数此前唯独没有套用 getReports(approvedOnly)/
      // getStatisticsData 全站统一的 approvalStatus 过滤，义工/店长刚提交、店长
      // 还没核对确认的 PENDING 草稿会直接计入"全国总览"的人次/收支汇总，与
      // 单店视角（走 getStatisticsData，已过滤）口径不一致，数字对不上
      { approvalStatus: _.in(['APPROVED', 'AUDITED_LOCKED']) }
    ];
    if (rangeStartDate) {
      logsQueryConditions.push({ dateString: _.gte(rangeStartDate) });
    }
    const logsQueryWhere = _.and(logsQueryConditions);
    while (true) {
      const batch = await db.collection('report_logs')
        .where(logsQueryWhere)
        .orderBy('dateString', 'desc')
        .skip(skip)
        .limit(batchLimit)
        .get();
      if (!batch.data || batch.data.length === 0) break;
      allLogs = allLogs.concat(batch.data);
      if (batch.data.length < batchLimit) break;
      skip += batchLimit;
      if (skip >= 1000) break;
    }

    // 🆕 核心 KPI 环比趋势：只在选择了具体时间粒度（非"全部时间"）时才有自然的
    // "上一个同长度周期"可比较——'all' 没有可比周期，prevTotalDiners/prevTotalExpense
    // 保持默认值 0，下面 computePctChange 遇到 prev=0 会自动返回 null，前端据此
    // 隐藏趋势徽标，不会显示误导性的 "+∞%"。与主查询共用同一套 tenantId/isVoid/
    // approvalStatus 过滤条件，并套用同一个 isScopedFilter/targetStores 范围
    // （按地区/自定义门店筛选时，环比也必须收窄到同一个门店集合，否则趋势对比的
    // 是两个不同范围的数字，没有意义）
    let prevTotalDiners = 0;
    let prevTotalExpense = 0;
    if (rangeStartDate && RANGE_DAYS[rangeType]) {
      const prevRangeStartDate = isoDateNDaysAgo(RANGE_DAYS[rangeType] * 2);
      const targetStoreIdSet = new Set(targetStores.map(s => s._id));
      const targetStoreNameSet = new Set(targetStores.map(s => s.storeName));
      try {
        let allPrevLogs = [];
        let prevSkip = 0;
        const prevLogsQueryWhere = _.and([
          makeTenantFilter(tenantId),
          { isVoid: _.neq(true) },
          { approvalStatus: _.in(['APPROVED', 'AUDITED_LOCKED']) },
          { dateString: _.gte(prevRangeStartDate) },
          { dateString: _.lt(rangeStartDate) }
        ]);
        while (true) {
          const batch = await db.collection('report_logs')
            .where(prevLogsQueryWhere)
            .skip(prevSkip)
            .limit(batchLimit)
            .get();
          if (!batch.data || batch.data.length === 0) break;
          allPrevLogs = allPrevLogs.concat(batch.data);
          if (batch.data.length < batchLimit) break;
          prevSkip += batchLimit;
          if (prevSkip >= 1000) break;
        }
        allPrevLogs.forEach((log) => {
          if (isScopedFilter) {
            const matched = (log.storeId && targetStoreIdSet.has(log.storeId)) ||
              (log.shopName && targetStoreNameSet.has(log.shopName));
            if (!matched) return;
          }
          prevTotalDiners += parseInt(log.diningCount || log.diners || 0, 10) || 0;
          prevTotalExpense += parseFloat(log.expense || log.todayExpense || log.expenseAmount || 0) || 0;
        });
      } catch (err) {
        // 环比查询失败不影响主统计，趋势字段按 0 基数处理，computePctChange 自动
        // 返回 null，前端隐藏徽标即可，不抛出影响整个大屏加载
      }
    }

    // 🌾 全国核心物资消耗总量：大米/面粉/食用油/蔬菜累计斤数，来自 material_logs——
    // 与 getStatisticsData 单店视角同一张表、同一套字段，这里只是把门店范围放宽到
    // 本机构全部门店，时间范围复用上面已经算好的 rangeStartDate（近7天/本月/
    // 本季度/全部时间）
    let nationalRiceTotal = 0;
    let nationalFlourTotal = 0;
    let nationalOilTotal = 0;
    let nationalVegetableTotal = 0;
    try {
      const materialConditions = [makeTenantFilter(tenantId)];
      if (rangeStartDate) {
        materialConditions.push({ dateString: _.gte(rangeStartDate) });
      }
      // 🆕 按地区/自定义门店筛选时，物资消耗总量也要收窄到同一个门店范围，不能
      // 一边门店矩阵/餐次汇总已经按筛选范围收窄、一边物资总量仍是全机构口径。
      // material_logs 是全新集合（见 manageVolunteerSubmission materialDoc），
      // 写入时必定带 storeId，可直接下推到查询条件，无需像 report_logs 那样
      // 再做门店名兜底匹配
      if (isScopedFilter) {
        materialConditions.push({ storeId: _.in(targetStores.map(s => s._id)) });
      }
      let allMaterialLogs = [];
      let materialSkip = 0;
      while (true) {
        const batch = await db.collection('material_logs')
          .where(_.and(materialConditions))
          .skip(materialSkip)
          .limit(batchLimit)
          .get();
        if (!batch.data || batch.data.length === 0) break;
        allMaterialLogs = allMaterialLogs.concat(batch.data);
        if (batch.data.length < batchLimit) break;
        materialSkip += batchLimit;
        if (materialSkip >= 1000) break;
      }
      allMaterialLogs.forEach((m) => {
        nationalRiceTotal += parseFloat(m.riceCount) || 0;
        nationalFlourTotal += parseFloat(m.flourCount) || 0;
        nationalOilTotal += parseFloat(m.oilCount) || 0;
        nationalVegetableTotal += parseFloat(m.vegetableCount) || 0;
      });
    } catch (err) {
      // material_logs 集合可能尚未创建（该机构还没有任何一条物资消耗提交被采纳过），
      // 视为总量 0，不影响主统计
    }

    let nationalTotalDiners = 0;
    let nationalTotalIncome = 0;
    let nationalTotalExpense = 0;
    let nationalOpenDays = 0;
    // 🌟 全国志愿服务：到岗人次与工时，与 getStatisticsData 单店视角同一套
    // report_logs.volunteerCount/volunteerHours 字段来源
    let nationalTotalVolunteers = 0;
    let nationalTotalVolunteerHours = 0;
    // 👵 全国长者关怀细分维度：与首页填报字段一一对应
    //   dineInSeniors   → 堂食长者人次
    //   deliverySeniors → 送餐长者人次
    //   listeningSeniors→ 倾听陪伴长者人次（独立关怀指标，不计入用餐总数）
    //   takeawayCount   → 打包份数
    //   deliveryVolunteers → 送餐志愿者人次
    // 缺失字段（早期数据未填报）一律兜底 0，不影响聚合结果
    let nationalDineInSeniors = 0;
    let nationalDeliverySeniors = 0;
    let nationalListeningSeniors = 0;
    let nationalTakeawayCount = 0;
    let nationalDeliveryVolunteers = 0;
    // 💖 全网爱心支持与善缘统计：
    //   nationalOfflineIncome   → 全网"现场爱心随喜"总额（report_logs.otherDonation 之和）
    //   nationalSponsorCount / totalSupportCount → 全网爱心支持总人次
    //     （所有 donationItems 条目数量之和，两个字段同值，totalSupportCount
    //     是给"全网爱心支持与善缘墙"面板用的统一命名）
    //   yangshanCount / yangshanAmount → 阳善（公开姓名）支持人次与金额
    //   yindeCount / yindeAmount       → 积阴德（匿名）支持人次与金额
    //   🐛 统计口径修正：yangshanCount/yindeCount 必须与 totalSupportCount 同一个
    //   计量单位——按"每一条 donationItems 明细"计数（一份报表可能有多条支持
    //   记录），而不是按"报表份数"计数（一份报表无论有几条明细都只算一次）。
    //   此前误用了报表份数口径，会导致 yangshanCount + yindeCount ≠
    //   totalSupportCount，两组数字对不上
    //   publicDonorEntries → 最新 20 条公开（阳善）捐赠记录，供爱心滚动墙展示
    let nationalOfflineIncome = 0;
    let nationalSponsorCount = 0;
    let yangshanCount = 0;
    let yindeCount = 0;
    let yangshanAmount = 0;
    let yindeAmount = 0;
    const publicDonorEntries = [];   // 积累后取最多 40 条，最终截取 20 条返回

    // 🌟 全国凭证合规率：有支出金额的记录中，附带小票/发票凭证图片的占比
    let nationalExpenseRecordCount = 0;
    let nationalReceiptRecordCount = 0;
    // 📸 全国影像卷宗：来自 report_logs 的凭证图片张数（来自 daily_menus/activity_logs 在 forEach 后并行查询）
    let totalReceiptPhotos = 0;
    // 🌍 多业态受众统计：按门店 orgType 汇聚用餐/送餐人次，用于大屏"全网受助群体人次"分维度展示
    const dineInByOrgType = {};   // { [orgType]: totalDineIn }
    const deliveryByOrgType = {}; // { [orgType]: totalDelivery }

    const storeStatsMap = {};

    targetStores.forEach(s => {
      const region = resolveStoreRegion(s);
      storeStatsMap[s._id] = {
        storeId: s._id,
        storeName: s.storeName || '未命名门店',
        // 🏢 orgType 落入统计结构，供多业态受众分维度累加使用
        orgType: s.orgType || 'other',
        city: region.city,
        province: region.province,
        totalDiners: 0,
        totalIncome: 0,
        totalExpense: 0,
        ingredientExpense: 0,
        openDays: 0,
        latestBalance: 0,
        lastReportDate: '',
        expenseRecordCount: 0,
        receiptRecordCount: 0,
        // 🆕 主料（大米/食用油）库存状态：取窗口内最新一条记录，与
        // pages/index/index.ts "充足/一般/告急"三档口径一致（stapleRiceStatus/
        // stapleOilStatus 是 report_logs 上的枚举字段，见 publicVerifyReport
        // 头部注释），供跨店爱心调拨建议引擎判断"紧缺门店"用
        stapleUrgent: false
      };
    });

    // 兜底门店（stores 集合中未注册但有日志的门店）
    const fallbackStoreMap = {};

    allLogs.forEach(log => {
      const logStoreName = log.shopName || '';
      const sId = log.storeId || logStoreName || '_unclassified_store_';

      // 尝试匹配 storeStatsMap
      let matchedKey = null;
      if (log.storeId && storeStatsMap[log.storeId]) {
        matchedKey = log.storeId;
      } else if (logStoreName) {
        for (const key of Object.keys(storeStatsMap)) {
          if (storeStatsMap[key].storeName === logStoreName) {
            matchedKey = key;
            break;
          }
        }
      }

      // 若未匹配到门店，创建兜底条目
      if (!matchedKey) {
        if (isScopedFilter) {
          return;
        }
        if (!fallbackStoreMap[sId]) {
          const fallbackRegion = resolveStoreRegion({ storeName: logStoreName });
          fallbackStoreMap[sId] = {
            storeId: sId,
            storeName: logStoreName || '未分类门店',
            city: fallbackRegion.city,
            province: fallbackRegion.province,
            totalDiners: 0,
            totalIncome: 0,
            totalExpense: 0,
            ingredientExpense: 0,
            openDays: 0,
            latestBalance: 0,
            lastReportDate: '',
            expenseRecordCount: 0,
            receiptRecordCount: 0,
            stapleUrgent: false
          };
        }
        matchedKey = sId;
        if (!storeStatsMap[matchedKey]) {
          storeStatsMap[matchedKey] = fallbackStoreMap[sId];
        }
      }

      const diners = parseInt(log.diningCount || log.diners || 0, 10);
      const income = parseFloat(log.income || log.loveIncome || log.totalDonation || 0) || 0;
      const expense = parseFloat(log.expense || log.todayExpense || log.expenseAmount || 0) || 0;
      const dailyExpense = parseFloat(log.dailyExpense || log.ingredientCost || log.dailyIngredientText || 0) || 0;

      nationalTotalDiners += diners;
      nationalTotalIncome += income;
      nationalTotalExpense += expense;
      nationalTotalVolunteers += parseFloat(log.volunteerCount) || 0;
      nationalTotalVolunteerHours += parseFloat(log.volunteerHours) || 0;
      // 👵 长者关怀细分维度累加（缺失字段兜底 0）
      nationalDineInSeniors    += parseInt(log.dineInSeniors, 10)     || 0;
      nationalDeliverySeniors  += parseInt(log.deliverySeniors, 10)   || 0;
      nationalListeningSeniors += parseInt(log.listeningSeniors, 10)  || 0;
      nationalTakeawayCount    += parseInt(log.takeawayCount, 10)     || 0;
      nationalDeliveryVolunteers += parseInt(log.deliveryVolunteers, 10) || 0;
      if (diners > 0 || dailyExpense > 0) nationalOpenDays++;

      // 💖 爱心支持明细汇总：现场随喜总额 + 支持人次 + 阳善/积阴德分布 + 爱心滚动墙
      nationalOfflineIncome += parseFloat(log.otherDonation) || 0;
      const donationItems = Array.isArray(log.donationItems) ? log.donationItems : [];
      nationalSponsorCount += donationItems.length;
      // 🆕 阳善/阴德人次与金额分流：按明细条目（donationItems，每条=一位支持者）
      // 计数与求和，不受 publicDonorEntries 40 条展示缓冲上限影响——总量统计
      // 必须覆盖全部记录，展示列表只是"最新几条"的截断快照。两组累加完全
      // 覆盖 nationalSponsorCount 的全集，故 yangshanCount + yindeCount 恒等于
      // nationalSponsorCount（totalSupportCount）
      const logDonationAmount = donationItems.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
      if (log.isAnonymous) {
        yindeCount += donationItems.length;
        yindeAmount += logDonationAmount;
      } else {
        yangshanCount += donationItems.length;
        yangshanAmount += logDonationAmount;
      }
      // 收集公开捐赠条目：logs 已按 dateString 降序取，所以最先遇到的就是最新的。
      // 不再按报告级 log.isAnonymous 一刀切决定整份收不收——每条自己的匿名状态由
      // resolveItemAnonymous 逐条判断，阴德的条目仍然入列，只是姓名展示为"爱心善士"
      if (donationItems.length > 0 && publicDonorEntries.length < 40) {
        const entryStoreName = (storeStatsMap[matchedKey] && storeStatsMap[matchedKey].storeName)
          || log.shopName || '爱心站点';
        // 🆕 平台类型透传：与下方 logOrgType（698行左右）同一个 matchedKey 查法，
        // 只是那里算得晚——爱心滚动墙需要在这里（比 logOrgType 早）就用上，
        // 不改变任何已有统计口径，纯新增字段供前端"全部平台"视角渲染来源徽章
        const entryOrgType = (storeStatsMap[matchedKey] && storeStatsMap[matchedKey].orgType) || 'other';
        const dayDiff = log.dateString ? daysBetween(log.dateString, todayStr) : null;
        const timeLabel = dayDiff === null ? ''
          : dayDiff === 0 ? '今天'
          : dayDiff === 1 ? '昨天'
          : dayDiff < 7  ? dayDiff + '天前'
          : dayDiff < 30 ? Math.floor(dayDiff / 7) + '周前'
          : Math.floor(dayDiff / 30) + '个月前';
        donationItems.forEach(item => {
          if (publicDonorEntries.length >= 40) return;
          publicDonorEntries.push({
            name:      formatDonorDisplayName(item.name, resolveItemAnonymous(item, log.isAnonymous)),
            amount:    parseFloat(item.amount) || 0,
            storeName: entryStoreName,
            orgType:   entryOrgType,
            timeLabel
          });
        });
      }

      // 🌟 凭证合规率统计：与 getRiskAlerts 同款判定口径（expenseAmount>0 且无
      // receiptImages/receiptImageList 视为缺失凭证），这里只做计数不生成明细告警
      const expenseAmount = parseFloat(log.expenseAmount || 0) || 0;
      const receiptImagesArr = Array.isArray(log.receiptImages) ? log.receiptImages : [];
      const receiptImageListArr = Array.isArray(log.receiptImageList) ? log.receiptImageList : [];
      const hasReceipt = receiptImagesArr.length > 0 || receiptImageListArr.length > 0;
      if (expenseAmount > 0) {
        nationalExpenseRecordCount++;
        if (hasReceipt) nationalReceiptRecordCount++;
      }
      // 📸 累计凭证图片总张数（无论是否有支出金额，只要有图就计入）
      totalReceiptPhotos += receiptImagesArr.length + receiptImageListArr.length;

      // 🌍 多业态受众分维度累加：读 storeStatsMap 里已记录的 orgType
      const logOrgType = (storeStatsMap[matchedKey] && storeStatsMap[matchedKey].orgType) || 'other';
      const logDineIn = parseInt(log.dineInSeniors, 10) || 0;
      const logDelivery = parseInt(log.deliverySeniors, 10) || 0;
      dineInByOrgType[logOrgType] = (dineInByOrgType[logOrgType] || 0) + logDineIn;
      deliveryByOrgType[logOrgType] = (deliveryByOrgType[logOrgType] || 0) + logDelivery;

      const entry = storeStatsMap[matchedKey];
      if (entry) {
        entry.totalDiners += diners;
        entry.totalIncome += income;
        entry.totalExpense += expense;
        entry.ingredientExpense += dailyExpense;
        if (diners > 0) entry.openDays++;
        if (expenseAmount > 0) {
          entry.expenseRecordCount++;
          if (hasReceipt) entry.receiptRecordCount++;
        }

        // dateString 降序抓取，第一次命中某门店即为其在本次查询范围内最新的一条
        // 记录——latestBalance/主料库存状态必须和 lastReportDate 在同一次"首次
        // 命中"里一起确定，不能分开各自判断
        // 🐛 根因修复（严重）：此前 latestBalance 用 `if (bal > 0) entry.latestBalance
        // = bal` 在整个窗口的所有记录上无差别覆盖——allLogs 按 dateString 降序
        // 排列，同一家店窗口内如果有多条记录，会一直覆盖到最后处理的最早一条，
        // "latestBalance" 实际落地的是"窗口内最早一条余额>0的记录"，而不是真正
        // 最新的一条；且 bal>0 这个判断本身会让"最新余额恰好是 0 或负数（透支）"
        // 的门店拿不到真实结余（停留在初始值 0），恰恰漏掉最需要预警的赤字门店。
        // 上一轮"动态续航预测引擎"改用 latestBalance 计算 fundingDays 后，这个
        // 潜藏 bug 的影响被放大——续航天数的准确性直接依赖这个字段。现在改为
        // 只在这里（真正的"首次命中"=最新一条记录）取值一次，且不再要求余额
        // 必须 > 0，0 或负数同样是真实账面结余，理应如实记录
        if (log.dateString && !entry.lastReportDate) {
          entry.lastReportDate = log.dateString;
          const bal = parseFloat(log.todayBalance ?? log.closingBalance ?? 0);
          entry.latestBalance = isNaN(bal) ? 0 : bal;
          // 🆕 跨店爱心调拨建议引擎：主料告急口径与 pages/index/index.ts 的
          // "充足/一般/告急"三档展示一致，取窗口内最新一条记录的枚举值
          // （report_logs.stapleRiceStatus/stapleOilStatus，'urgent' 即告急）
          entry.stapleUrgent = log.stapleRiceStatus === 'urgent' || log.stapleOilStatus === 'urgent';
        }
      }
    });

    // 📸 全国影像卷宗：并行查询 daily_menus / activity_logs，统计图片总张数并汇聚最新 12 张图
    // 只有 isSuperAdmin 才需要构建 nationalMediaGallery，普通角色跳过额外 DB 查询
    let totalMenuPhotos = 0;
    let totalLogPhotos = 0;
    const nationalMediaGallery = []; // 最多 12 条，供大屏影像墙展示

    if (isSuperAdmin) {
      // 🐛 根因修复（配套上面 isScopedFilter）：此前 daily_menus/activity_logs 只按
      // tenantId 过滤，完全没有收窄到 targetStores——orgType/地区/自定义门店筛选
      // 切换后，全网影像卷宗的凭证/食谱/日志照片统计纹丝不动，与核心 KPI 已经
      // isScopedFilter 收窄的口径不一致。isScopedFilter 生效时直接把 storeId 下推
      // 进查询条件（而不是查回来再在内存里过滤），与 material_logs 的既有写法一致
      const mediaQueryConditions = [makeTenantFilter(tenantId)];
      if (isScopedFilter) {
        mediaQueryConditions.push({ storeId: _.in(targetStores.map(s => s._id)) });
      }
      const mediaQueryWhere = _.and(mediaQueryConditions);

      const [menuRes, logRes] = await Promise.all([
        db.collection('daily_menus')
          .where(mediaQueryWhere)
          .orderBy('date', 'desc')
          .limit(200)
          .field({ _id: true, date: true, storeName: true, storeId: true, images: true })
          .get()
          .catch(() => ({ data: [] })),
        db.collection('activity_logs')
          .where(mediaQueryWhere)
          .orderBy('date', 'desc')
          .limit(200)
          .field({ _id: true, date: true, storeName: true, storeId: true, images: true })
          .get()
          .catch(() => ({ data: [] }))
      ]);

      // 🆕 平台类型透传：影像墙每张图各自挂上来源门店的 orgType，供前端"全部平台"
      // 视角渲染徽章。storeStatsMap 此时已由上面 allLogs.forEach 完整建好（含
      // fallback 兜底条目），这里只做只读查找，不影响任何已有聚合计算
      const lookupOrgType = (storeId) =>
        (storeId && storeStatsMap[storeId] && storeStatsMap[storeId].orgType) || 'other';

      // 🐛 同一处根因修复：report_logs（凭证照片来源）没有走数据库查询下推
      // （复用上面已经拉取好的 allLogs 分页结果），改为在内存里按 targetStores
      // 过滤——与 storeStatsMap 主聚合循环判定"是否属于本次筛选范围"用同一套
      // storeId 优先、门店名兜底的匹配口径
      const mediaTargetStoreIdSet = new Set(targetStores.map(s => s._id));
      const mediaTargetStoreNameSet = new Set(targetStores.map(s => s.storeName));
      const isLogInScope = (storeId, storeName) => {
        if (!isScopedFilter) return true;
        return (!!storeId && mediaTargetStoreIdSet.has(storeId)) || (!!storeName && mediaTargetStoreNameSet.has(storeName));
      };

      // 统计 daily_menus 图片总数，收集带 URL 的条目
      const menuPhotoEntries = [];
      (menuRes.data || []).forEach(doc => {
        const imgs = Array.isArray(doc.images) ? doc.images : [];
        totalMenuPhotos += imgs.length;
        imgs.forEach(img => {
          const url = (img && (img.url || img.thumbUrl)) || (typeof img === 'string' ? img : null);
          if (url) {
            menuPhotoEntries.push({ url, type: 'menu', date: doc.date || '', storeName: doc.storeName || '', orgType: lookupOrgType(doc.storeId) });
          }
        });
      });

      // 统计 activity_logs 图片总数，收集带 URL 的条目
      const logPhotoEntries = [];
      (logRes.data || []).forEach(doc => {
        const imgs = Array.isArray(doc.images) ? doc.images : [];
        totalLogPhotos += imgs.length;
        imgs.forEach(img => {
          const url = (img && (img.url || img.thumbUrl)) || (typeof img === 'string' ? img : null);
          if (url) {
            logPhotoEntries.push({ url, type: 'log', date: doc.date || '', storeName: doc.storeName || '', orgType: lookupOrgType(doc.storeId) });
          }
        });
      });

      // 从 allLogs 中抽取最新凭证图片（已按 dateString desc 取）。isScopedFilter
      // 时先跳过不在 targetStores 范围内的记录，再判断是否已凑够 50 张——不能反过来，
      // 否则 allLogs 前段刚好全是筛选范围外的门店时会提前 break，凑不满在范围内的图片
      const receiptPhotoEntries = [];
      for (const log of allLogs) {
        if (receiptPhotoEntries.length >= 50) break;
        if (!isLogInScope(log.storeId, log.shopName)) continue;
        const imgs = [...(Array.isArray(log.receiptImages) ? log.receiptImages : []),
                      ...(Array.isArray(log.receiptImageList) ? log.receiptImageList : [])];
        for (const img of imgs) {
          const url = (img && (img.url || img.fileID || img.thumbUrl)) || (typeof img === 'string' ? img : null);
          if (url) {
            receiptPhotoEntries.push({ url, type: 'receipt', date: log.dateString || '', storeName: log.shopName || '', orgType: lookupOrgType(log.storeId) });
          }
        }
      }

      // 合并三类图片，按 date 降序排列，取最新 12 张
      const allPhotoEntries = [...receiptPhotoEntries, ...menuPhotoEntries, ...logPhotoEntries];
      allPhotoEntries.sort((a, b) => {
        if (a.date > b.date) return -1;
        if (a.date < b.date) return 1;
        return 0;
      });
      nationalMediaGallery.push(...allPhotoEntries.slice(0, 12));
    }

    // 🆕 动态物资与资金续航预测引擎（2026-08-30）：计算各店单餐成本与资金续航预警
    const storeMatrix = Object.values(storeStatsMap).map(s => {
      // 🐛 根因修复（新店误报"告急(0天)"）：查询窗口内实际开餐天数 < 3 天时，
      // 样本量太小，任何续航天数推算都不可信（比如只开了 1 天、当天恰好没什么
      // 支出，会算出一个虚高或虚低的续航天数）。统一归为 NEW_STORE，不参与
      // 资金健康度评级，前端展示"新店筹备中"而不是一个具体但不可信的天数
      const isNewStore = (s.openDays || 0) < NEW_STORE_MIN_OPEN_DAYS;

      const costPerMeal = s.totalDiners > 0
        ? (s.ingredientExpense / s.totalDiners).toFixed(2)
        : '—';
      // 🆕 avgMealCost：costPerMeal 的数值版（供未来直接绑定展示用），语义与
      // costPerMeal 完全一致，costPerMeal 保留给既有的门店矩阵表格显示逻辑，
      // 两者不重复计算、只是一个是格式化字符串一个是原始数值
      const avgMealCost = s.totalDiners > 0
        ? Number((s.ingredientExpense / s.totalDiners).toFixed(2))
        : null;

      // 🐛 根因修复（续航天数系统性偏高）：日均支出此前只算食材成本
      // （ingredientExpense），续航天数本该回答"账上的钱还能撑几天门店整体
      // 运转"，只算食材成本会漏掉房租/人力等固定成本，系统性高估续航。改用
      // 总支出（totalExpense，即 dailyExpenseTotal + fixedExpenseTotal 的
      // report_logs 汇总口径）
      const avgDailyExpense = isNewStore
        ? DEFAULT_DAILY_EXPENSE_FALLBACK
        : (s.openDays > 0 ? (s.totalExpense / s.openDays) : DEFAULT_DAILY_EXPENSE_FALLBACK);

      // 🐛 根因修复（续航天数误判根源）：此前用"窗口内收入 - 窗口内支出"的净
      // 变化额反推续航，完全遗漏了窗口开始前结转的账面余额——一家店可能账上
      // 还有大笔结存，只是这段时间收入恰好没覆盖支出，就被误判成资金告急；
      // 反过来一家店可能这段时间收入亮眼，但账面早已透支，也会被误判成健康。
      // 改用真实账面结余（latestBalance，取自窗口内最新一条 report_logs 的
      // todayBalance，是"现在账上到底还有多少钱"的唯一权威数字）
      const hasBalanceData = !isNewStore && s.latestBalance !== undefined && s.latestBalance !== null;
      const fundingDays = (hasBalanceData && avgDailyExpense > 0)
        ? Math.floor(s.latestBalance / avgDailyExpense)
        : null;

      // 🆕 健康度评级阈值：≤7 天 CRITICAL（红色告急）、8~15 天 WARNING（黄色
      // 预警，建议爱心劝募/调拨）、>15 天 HEALTHY（绿色正常）；新店/无结余
      // 数据统一归为 NEW_STORE，不参与评级
      let healthStatus;
      if (isNewStore || fundingDays === null) {
        healthStatus = 'NEW_STORE';
      } else if (fundingDays <= 7) {
        healthStatus = 'CRITICAL';
      } else if (fundingDays <= 15) {
        healthStatus = 'WARNING';
      } else {
        healthStatus = 'HEALTHY';
      }

      // 🆕 资金维度告警文案：与 isSuperAdmin 专属的离线维度告警文案分开组装
      // （见下方），最终合并进同一个 alertTags 数组——资金维度对 hq_finance/
      // regional_finance/volunteer（脱敏后）同样可见，与 healthStatus/
      // fundingDays 保持同一条可见性口径，不因为拆分了两个维度就意外收窄
      // 了非超管角色原本就能看到的资金告警信息
      const fundingTags = [];
      if (isNewStore) {
        fundingTags.push('新店爬坡中');
      } else {
        if (healthStatus === 'CRITICAL') {
          fundingTags.push(`资金告急(仅剩${fundingDays}天)`);
        } else if (healthStatus === 'WARNING') {
          fundingTags.push(`资金预警(${fundingDays}天)`);
        }
        // 🆕 主料（大米/食用油）库存告急同样是需要关注的紧缺信号，与资金续航
        // 是两个独立维度，可以同时出现（资金健康但恰好断粮，或资金告急但
        // 米油还够）
        if (s.stapleUrgent) {
          fundingTags.push('主料库存告急');
        }
      }

      const item = {
        storeId: s.storeId,
        storeName: s.storeName,
        // 🆕 平台类型透传：与门店矩阵表/排行榜/待支援预警共用同一份 item，前端
        // formatNationalMatrixData 直接 {...store} 透传，"全部平台"视角下据此渲染徽章
        orgType: s.orgType || 'other',
        // s.city/s.province 已在 storeStatsMap/fallbackStoreMap 构建阶段经过
        // resolveStoreRegion 解析（含"未分类地区"兜底），此处直接透传
        city: s.city,
        province: s.province,
        totalDiners: s.totalDiners,
        openDays: s.openDays,
        fundingDays,
        healthStatus,
        stapleUrgent: !!s.stapleUrgent,
        alertTags: fundingTags,
        costPerMeal,
        avgMealCost,
        totalIncome: s.totalIncome,
        totalExpense: s.totalExpense,
        ingredientExpense: s.ingredientExpense,
        latestBalance: s.latestBalance,
        isCostRestricted: false
      };

      // 🛡️ 凭证合规率 + 离线天数属于"超管专属高阶治理"维度，只在服务端确认调用者
      // 确系 super_admin 时才附加，hq_finance/regional_finance/volunteer 拿到的
      // storeMatrix 结构与升级前完全一致，不额外扩大这些角色的数据可见范围
      if (isSuperAdmin) {
        item.receiptComplianceRate = s.expenseRecordCount > 0
          ? Number(((s.receiptRecordCount / s.expenseRecordCount) * 100).toFixed(1))
          : null;
        item.lastReportDate = s.lastReportDate || '';
        const daysSinceLastReport = s.lastReportDate ? daysBetween(s.lastReportDate, todayStr) : null;
        // 🆕 lastReportDaysAgo：与既有 daysSinceLastReport 同一个值，新增一个
        // 更贴合本次动态续航预测引擎交付规范的字段名，两个名字并存，避免
        // 强行改名牵连其他尚未涉及本次迭代的调用方
        item.daysSinceLastReport = daysSinceLastReport;
        item.lastReportDaysAgo = daysSinceLastReport;
        // 🆕 离线判定两档：新店从未提交报表是正常筹备状态，不算"离线"（离线
        // 描述的是"曾经在正常运转、突然停止上报"，不该扣在新店头上）
        item.isOffline = !isNewStore && (daysSinceLastReport === null || daysSinceLastReport > OFFLINE_ALERT_DAYS);
        item.isSeriouslyOffline = !isNewStore && (daysSinceLastReport === null || daysSinceLastReport > SERIOUS_OFFLINE_ALERT_DAYS);
        // 🌟 全局大屏"今日预警门店数"用：凭证合规率不满 100%（即扫描区间内有支出
        // 记录缺失小票）即视为需要关注，与 store-management 页 getRiskAlerts 的
        // missing_receipt 判定同一个口径，这里不重新发起 N 次单店查询，直接复用
        // 本函数已经在跑的同一份逐日志聚合结果
        item.hasRiskFlag = item.receiptComplianceRate !== null && item.receiptComplianceRate < 100;

        const offlineTags = [];
        if (!isNewStore) {
          if (item.isSeriouslyOffline) {
            offlineTags.push(daysSinceLastReport !== null ? `失联${daysSinceLastReport}天` : '从未提交报表');
          } else if (item.isOffline) {
            offlineTags.push(`离线${daysSinceLastReport}天`);
          }
          if (item.hasRiskFlag) {
            offlineTags.push('凭证合规率不足');
          }
        }
        // 离线/合规告警排在资金告警前面——运营中断/失联的紧迫性通常高于
        // 资金预警，与 statistics.ts deriveSupportNeededStores 的加分权重
        // 排序保持一致
        item.alertTags = [...offlineTags, ...fundingTags];
      }

      return item;
    });

    // 按服务人次降序排列
    storeMatrix.sort((a, b) => b.totalDiners - a.totalDiners);

    // 🆕 跨店爱心调拨建议引擎（2026-08-30）：在同一机构（storeMatrix 已经过
    // tenantId 硬隔离 + targetStores 范围收窄，见文件头/上方 isScopedFilter
    // 注释）名下，把"紧缺门店"与"充裕门店"撮合成轻量建议，帮大家长一眼看出
    // "该找哪家兄弟门店求助"，而不是空泛地告诉他"这家店缺钱"。
    // 紧缺：资金续航 ≤7 天（healthStatus==='CRITICAL'）或主料库存告急，
    // 二者满足其一即可——资金健康但恰好断粮、或账上有钱但青黄不接，都算
    // 需要外部支援。充裕：资金续航 >45 天，且暂不考虑主料库存（有钱不代表
    // 一定有多余的米油可以支援，只用资金侧筛"有没有余力"）
    const SURPLUS_FUNDING_DAYS_THRESHOLD = 45;
    const shortageStores = storeMatrix.filter(s =>
      s.healthStatus === 'CRITICAL' || s.stapleUrgent
    );
    const surplusStores = storeMatrix.filter(s =>
      typeof s.fundingDays === 'number' && s.fundingDays > SURPLUS_FUNDING_DAYS_THRESHOLD
    );
    const supportSuggestions = [];
    if (shortageStores.length > 0 && surplusStores.length > 0) {
      shortageStores.forEach(shortage => {
        // 优先撮合同城，同城没有充裕门店时退而求其次找同省——跨省调拨物流/
        // 人情成本都太高，不在轻量建议的范围内，宁可不建议也不瞎凑
        const sameCity = surplusStores.filter(s =>
          s.storeId !== shortage.storeId && shortage.city && s.city === shortage.city
        );
        const sameProvince = surplusStores.filter(s =>
          s.storeId !== shortage.storeId && shortage.province && s.province === shortage.province
        );
        const candidates = sameCity.length > 0 ? sameCity : sameProvince;
        if (candidates.length === 0) return;

        const picked = candidates
          .slice()
          .sort((a, b) => b.fundingDays - a.fundingDays)
          .slice(0, 2);
        const scopeLabel = sameCity.length > 0 ? '同城' : '同省';
        const reasonParts = [];
        if (shortage.healthStatus === 'CRITICAL') {
          reasonParts.push(`资金续航仅剩${shortage.fundingDays}天`);
        }
        if (shortage.stapleUrgent) {
          reasonParts.push('主料库存告急');
        }

        supportSuggestions.push({
          shortageStoreId: shortage.storeId,
          shortageStoreName: shortage.storeName,
          reason: reasonParts.join('、'),
          candidateStores: picked.map(p => ({ storeId: p.storeId, storeName: p.storeName, fundingDays: p.fundingDays })),
          suggestion: `建议${shortage.storeName}向${scopeLabel}充裕门店（${picked.map(p => p.storeName).join('、')}）申请物资协调/爱心平调`
        });
      });
    }

    const nationalSummary = {
      // 🆕 筛选态下，覆盖门店总数应反映当前筛选范围（targetStores），而不是本机构
      // 全量门店数——否则"按地区筛选"选中一个只有 2 家门店的城市，KPI 卡却仍显示
      // 全机构 20 家门店，数字与实际聚合范围自相矛盾
      totalStores: targetStores.length || Object.keys(storeStatsMap).length,
      nationalTotalDiners,
      nationalTotalIncome: nationalTotalIncome.toFixed(2),
      nationalTotalExpense: nationalTotalExpense.toFixed(2),
      nationalNetAccumulation: (nationalTotalIncome - nationalTotalExpense).toFixed(2),
      nationalOpenDays,
      nationalTotalVolunteers,
      nationalTotalVolunteerHours: Math.round(nationalTotalVolunteerHours * 10) / 10,
      // 👵 长者关怀细分维度
      nationalDineInSeniors,
      nationalDeliverySeniors,
      nationalListeningSeniors,
      nationalTakeawayCount,
      nationalDeliveryVolunteers,
      nationalRiceTotal: Math.round(nationalRiceTotal * 10) / 10,
      nationalFlourTotal: Math.round(nationalFlourTotal * 10) / 10,
      nationalOilTotal: Math.round(nationalOilTotal * 10) / 10,
      nationalVegetableTotal: Math.round(nationalVegetableTotal * 10) / 10,
      // 🆕 核心 KPI 环比趋势（vs 上一个同长度周期）：rangeType='all' 或查无
      // 可比基数时 prevTotal*=0，computePctChange 自动返回 null，前端隐藏徽标
      nationalTotalDinersTrend: computePctChange(nationalTotalDiners, prevTotalDiners),
      nationalTotalExpenseTrend: computePctChange(nationalTotalExpense, prevTotalExpense),
      // 💖 全网爱心支持与善缘墙：totalSupportCount 与 nationalSponsorCount 同值
      // （后者是历史字段名，前者是本面板统一使用的命名），yangshanCount +
      // yindeCount 恒等于 totalSupportCount
      nationalOfflineIncome: parseFloat(nationalOfflineIncome.toFixed(2)),
      nationalSponsorCount,
      totalSupportCount: nationalSponsorCount,
      yangshanCount,
      yindeCount,
      yangshanAmount: parseFloat(yangshanAmount.toFixed(2)),
      yindeAmount: parseFloat(yindeAmount.toFixed(2)),
      // 公开爱心支持墙：最多 20 条阳善（公开姓名）记录，logs 已降序所以就是最新的
      latestPublicDonors: publicDonorEntries.slice(0, 20),
      // 🆕 跨店爱心调拨建议：与 healthStatus/fundingDays 同一条可见性口径
      // （对 isPatriarch/hq_finance/regional_finance/super_admin 可见，志工
      // 视角走下方 SENSITIVE_KEYS 统一置空——建议文案里点名了其他门店的
      // 续航天数，属于同一档财务隐私）
      supportSuggestions,
      // 🏮 品牌矩阵标签：非 null 时大屏标题应使用此标签（如"同心慈善会矩阵"）
      brandMatrixLabel,
      // 🌍 多业态受助群体人次分维度：{ [orgType]: { dineIn, delivery, total } }[]
      // 用于全国大屏展示"长者 X 人 / 儿童 Y 人"等多受众维度数据
      targetAudienceBreakdown: Object.keys(dineInByOrgType).concat(
        Object.keys(deliveryByOrgType).filter(k => !dineInByOrgType[k])
      ).map(orgType => ({
        orgType,
        dineIn: dineInByOrgType[orgType] || 0,
        delivery: deliveryByOrgType[orgType] || 0,
        total: (dineInByOrgType[orgType] || 0) + (deliveryByOrgType[orgType] || 0)
      })).filter(item => item.total > 0)
        .sort((a, b) => b.total - a.total)
    };

    // 🌟 超管专属高阶治理看板：核心指标 + 时间切片 + 离线门店预警，见需求2/3
    let superAdminInsights = null;
    if (isSuperAdmin) {
      const offlineStores = storeMatrix
        .filter(s => s.isOffline)
        // 🆕 orgType 随 storeMatrix 一起透传（见 item.orgType 赋值处），供"全部平台"
        // 视角下离线门店预警列表渲染平台徽章
        .map(s => ({ storeId: s.storeId, storeName: s.storeName, lastReportDate: s.lastReportDate, daysSinceLastReport: s.daysSinceLastReport, orgType: s.orgType }));

      // 🌟 全局数据大屏：活跃门店数（未离线） + 今日预警门店数（离线 或 凭证合规率不满 100%）
      const riskStoreIds = new Set();
      storeMatrix.forEach(s => {
        if (s.isOffline || s.hasRiskFlag) riskStoreIds.add(s.storeId);
      });
      const totalStoreCount = targetStores.length || Object.keys(storeStatsMap).length;

      superAdminInsights = {
        rangeType,
        rangeLabel: RANGE_LABELS[rangeType] || RANGE_LABELS.all,
        avgCostPerMeal: nationalTotalDiners > 0
          ? Number((nationalTotalExpense / nationalTotalDiners).toFixed(2))
          : 0,
        complianceRate: nationalExpenseRecordCount > 0
          ? Number(((nationalReceiptRecordCount / nationalExpenseRecordCount) * 100).toFixed(1))
          : null,
        expenseRecordCount: nationalExpenseRecordCount,
        receiptRecordCount: nationalReceiptRecordCount,
        offlineAlertThresholdDays: OFFLINE_ALERT_DAYS,
        offlineStoreCount: offlineStores.length,
        offlineStores,
        activeStoreCount: Math.max(0, totalStoreCount - offlineStores.length),
        riskStoreCount: riskStoreIds.size,
        // 📸 全国影像卷宗统计
        totalReceiptPhotos,
        totalMenuPhotos,
        totalLogPhotos,
        nationalTotalPhotos: totalReceiptPhotos + totalMenuPhotos + totalLogPhotos,
        nationalMediaGallery
      };
    }

    // 🛡️ 统一在出口处做一次脱敏：志工角色下 storeMatrix 每一项与 nationalSummary
    // 中的收支/成本/结余/精确续航天数字段会被置空，其余角色原样返回
    return {
      success: true,
      nationalSummary: sanitizeReportForVolunteer(nationalSummary, userRole),
      storeMatrix: sanitizeReportForVolunteer(storeMatrix, userRole),
      superAdminInsights,
      tenantName
    };
  } catch (err) {
    console.error('[getNationalDashboard] 异常:', err);
    return { success: false, error: err.message || '全国大屏数据查询异常' };
  }
};
