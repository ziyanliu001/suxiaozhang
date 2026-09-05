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

// 🆕 机构套餐配额感知（2026-08-31）：与 checkTenantPermission 云函数同一份
// tenant_subscriptions 查询/降级逻辑的精简拷贝（各云函数独立部署，无共享
// 模块机制，需要手动同步这几处拷贝，见 checkTenantPermission 头部注释）。
// 🏛️ 这里只是"展示用量"，不做任何放行/拦截判断——与本文件"全国大屏查看
// 权限不挂钩订阅套餐"的双轨制原则（见 CLAUDE.md）不冲突
const PLAN_STORE_LIMITS = { basic: 2, pro: 10, enterprise: 30 };
const SUBSCRIPTION_GRACE_PERIOD_DAYS = 7;
// 🆕（2026-08-31 商业化权益中心）商业化展示口径：内部 planType 仍是
// 'basic'/'pro'/'enterprise'（tenant_subscriptions 唯一真源字段值，与
// PLAN_STORE_LIMITS/checkTenantPermission/profile.ts 等处一致，不重命名），
// planCode/planName 只是本次新增的"对外展示别名"，不引入新的底层数据模型
const PLAN_CODE_MAP = { basic: 'free', pro: 'pro', enterprise: 'enterprise' };
function buildPlanName(planType, maxStores) {
  if (planType === 'pro') return `专业版 (${maxStores}店)`;
  if (planType === 'enterprise') return `旗舰版 (${maxStores}店)`;
  return '基础免费版';
}
// 🆕 临期提醒阈值：与"续费宽限期"（SUBSCRIPTION_GRACE_PERIOD_DAYS，到期后
// 才生效）是两个不同方向的时间窗——这个是"还没到期，但快了"的提前预警
const EXPIRING_SOON_THRESHOLD_DAYS = 30;

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

// 🐛 根因修复（"爱**士"这类公用泛称被误脱敏）：捐赠人不填真实姓名、直接写
// "爱心人士"/"十方大众"这类公用泛称时，这条记录本身并没有勾选阴德匿名
// （isAnonymous 仍是 false，捐赠人的本意就是"我不报具体姓名，但这行字本身
// 就是公开展示用的占位说法"）——maskName() 却把它当成一个普通姓名字符串
// 按位置打码，"爱心人士"→"爱**士"，泛称本身反而被脱敏得面目全非，比直接
// 显示原文还奇怪。这里只对"看起来是具体个人姓名"的字符串做脱敏，命中已知
// 泛称关键词（含子串）的一律原样展示，不打码——与
// cloudfunctions/getSunshineLedger 同一套规则（各云函数独立部署，无共享
// 模块机制，需要手动同步这处拷贝）
const GENERIC_DONOR_NAME_KEYWORDS = ['爱心人士', '无名氏', '十方大众', '爱心同修', '义工', '大众随喜'];
function isGenericDonorName(name) {
  const str = String(name || '').trim();
  return !!str && GENERIC_DONOR_NAME_KEYWORDS.some((kw) => str.includes(kw));
}

function formatDonorDisplayName(name, isAnonymous) {
  if (isAnonymous || !name || !String(name).trim()) return '爱心善士';
  const trimmed = String(name).trim();
  if (isGenericDonorName(trimmed)) return trimmed;
  return maskName(trimmed);
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
    // 🆕 跨店调拨建议（rebalanceSuggestions）文案里点名了具体门店与"资金告急
    // (仅剩X天)"这类具体天数，同属财务隐私，一并脱敏
    'rebalanceSuggestions',
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

// 🌍（docs/GEO_STRATEGY.md 第 4.2 节已知风险的修复）完全匿名/未加入任何机构的
// 访客专属分支：与本文件其余"本机构大屏"逻辑是两条彻底独立的数据管线——本函数
// 天生就要跨全平台聚合，绝不能和 tenantId 相关的任何查询共用同一套代码路径，
// 本文件其余分支必须继续严格按 tenantId 隔离。这里只允许读到"计数/求和"这一级
// 聚合结果，不 get() 拉取任何一条 report_logs/stores/tenants 原始文档，从数据
// 访问层面杜绝把某个具体机构的门店名、地址、大家长/店长联系方式、捐赠人姓名、
// 小票图片等私密明细带出到这个无鉴权可达的分支（与 getPlatformOverview 的
// "只 count()、绝不读取记录内容"合规边界同一套设计哲学）。
// 🛡️ 口径：只暴露非金额的"社会影响力"指标（服务人次、机构/门店覆盖、义工
// 工时），不返回 totalIncome/totalExpense/nationalNetAccumulation 等金额汇总——
// 这几个字段是 sanitizeReportForVolunteer() 专门对着已经登录、归属某个真实
// 机构的志工都要脱敏隐藏的敏感字段（见 SENSITIVE_KEYS），没有理由反而对完全
// 陌生、连角色都没有的公众原样放开，也没有任何机构单独同意过自己的经营数据
// 被跨租户汇总对外公开。
async function buildPublicAggregateSummary() {
  async function safeCount(collectionQuery) {
    try {
      const res = await collectionQuery.count();
      return res.total || 0;
    } catch (err) {
      // 集合尚不存在（全新环境）按 0 处理，与 getPlatformOverview 的 safeCount 同一口径
      return 0;
    }
  }

  const [totalOrgs, totalStores, sumRes] = await Promise.all([
    safeCount(db.collection('tenants')),
    safeCount(db.collection('stores')),
    db.collection('report_logs')
      .aggregate()
      .match({ approvalStatus: _.in(['APPROVED', 'AUDITED_LOCKED']) })
      .group({
        _id: null,
        totalDineIn: _.aggregate.sum('dineInSeniors'),
        totalDelivery: _.aggregate.sum('deliverySeniors'),
        totalTakeaway: _.aggregate.sum('takeawayCount'),
        totalVolunteers: _.aggregate.sum('volunteerCount'),
        totalVolunteerHours: _.aggregate.sum('volunteerHours')
      })
      .end()
      .catch(() => ({ list: [] }))
  ]);

  const sums = (sumRes && sumRes.list && sumRes.list[0]) || {};
  const nationalTotalDiners = (sums.totalDineIn || 0) + (sums.totalDelivery || 0) + (sums.totalTakeaway || 0);

  return {
    success: true,
    isPublicAggregate: true,
    tenantName: '',
    nationalSummary: {
      totalOrgs,
      totalStores,
      nationalTotalDiners,
      nationalTotalVolunteers: Math.round(sums.totalVolunteers || 0),
      nationalTotalVolunteerHours: Math.round((sums.totalVolunteerHours || 0) * 10) / 10
    },
    storeMatrix: [],
    superAdminInsights: null
  };
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

    // 🛡️（2026-09-05 GEO 匿名可读性修复）无法解析出所属机构（游客/未分配角色账号）时，
    // 不再直接拒绝——但也绝不能让下面"本机构大屏"的查询流程带着空 tenantId 继续往下走，
    // 那会退化为 `{}`（无过滤条件），把全平台所有机构的门店与餐报聚合进同一张"大屏"
    // 返回给调用者，是最严重的一类跨租户数据泄露。改为在这里就分流：完全匿名的访客
    // 走 buildPublicAggregateSummary() 这条专门为跨租户聚合设计的独立安全分支（只读
    // 计数/求和，不返回任何机构可识别信息与金额字段，见该函数头部注释），下面所有
    // 依赖 tenantId 的查询与本次请求彻底无关
    if (!tenantId) {
      return await buildPublicAggregateSummary();
    }

    // 🆕 机构名称：供前端全国大屏顶部横幅"📊 爱心网络总览 · [机构名称]"展示，
    // 与 checkTenantPermission 云函数同款只读 name 字段查法（不新增权限面，
    // tenantId 本就只从调用者自己的 user_roles 反查，与上面的隔离判断同一条
    // 安全边界）
    const tenantRes = await db.collection('tenants').doc(tenantId).field({ name: true, currentStoreCount: true }).get().catch(() => null);
    const tenantName = (tenantRes && tenantRes.data && tenantRes.data.name) || '';
    // 🆕 已接入门店数：与 checkTenantPermission/profile.ts 同一个 tenants.currentStoreCount
    // 字段（createStore/manageTenantSubscription 原子自增写入的唯一真源）
    const usedStoreCount = (tenantRes && tenantRes.data && tenantRes.data.currentStoreCount) || 0;

    // 🆕（2026-08-31 商业化权益中心）机构套餐配额感知升级：默认兜底为
    // basic/free/永久有效——与 tenant_subscriptions 从未有过记录（该机构还
    // 没触发过任何订阅写入）时的语义一致。features 三项衍生能力（合并导出/
    // 调拨引擎/存证徽章）默认全部关闭，与"未订阅=free 档"一致
    let subscriptionQuota = {
      planCode: PLAN_CODE_MAP.basic,
      planName: buildPlanName('basic', PLAN_STORE_LIMITS.basic),
      activeStores: usedStoreCount,
      maxStores: PLAN_STORE_LIMITS.basic,
      usagePercent: PLAN_STORE_LIMITS.basic > 0 ? Math.round((usedStoreCount / PLAN_STORE_LIMITS.basic) * 100) : 0,
      isExpiringSoon: false,
      // 🆕（2026-08-31 订阅有效期动态化）从未触发过订阅写入的机构，天然不存在
      // "过期"这个概念，恒为 false
      isExpired: false,
      expireDateText: '永久有效',
      features: {
        canExportNationalExcel: false,
        canUseRebalanceEngine: false,
        canAccessAuditProof: false
      }
    };
    try {
      const subRes = await db.collection('tenant_subscriptions')
        .where({ tenantId })
        .orderBy('lastRenewedAt', 'desc')
        .limit(1)
        .get();
      const sub = subRes.data && subRes.data[0];
      if (sub) {
        const expireTime = sub.serviceExpireDate ? new Date(sub.serviceExpireDate).getTime() : NaN;
        const rawExpired = !Number.isNaN(expireTime) && expireTime < Date.now();
        const graceDeadline = rawExpired ? expireTime + SUBSCRIPTION_GRACE_PERIOD_DAYS * 24 * 3600 * 1000 : null;
        const isInGracePeriod = rawExpired && graceDeadline !== null && graceDeadline >= Date.now();
        const isExpired = rawExpired && !isInGracePeriod;
        // 🕊️ 宽限期内仍按到期前档位展示，与 checkTenantPermission 同一条口径，
        // 不因为财务同事晚了几天续费就让配额徽章当场显示"已降级为基础版"
        // 🆕（2026-08-31）originalPlanType 保留降级前的真实套餐，仅用于判断
        // "这个租户本来就是 basic" vs "这个租户是 pro/enterprise 过期被降级"——
        // 下面的 isPerpetual 必须用这个原始值，否则过期账号会被误判为"永久免费"
        const originalPlanType = sub.planType || 'basic';
        const planType = isExpired ? 'basic' : originalPlanType;
        let maxStores = (sub.cloudQuota && sub.cloudQuota.storeLimit) || PLAN_STORE_LIMITS[planType] || PLAN_STORE_LIMITS.basic;
        if (planType === 'basic') {
          maxStores = PLAN_STORE_LIMITS.basic;
        }
        // 🐛（2026-08-31 修复）此前用降级后的 planType 判断"永久有效"，导致
        // pro/enterprise 到期降级为 basic 的租户被误判为 isPerpetual=true，
        // expireDateText 恒显示"永久有效"，永远走不到"已于 X 到期"分支。
        // 改为用降级前的 originalPlanType 判断"是否本来就是免费档"
        const isPerpetual = originalPlanType === 'basic' || (!isExpired && !!sub.isLifetimeGrant);
        let expireDateText = '永久有效';
        let isExpiringSoon = false;
        if (!isPerpetual && sub.serviceExpireDate) {
          const d = new Date(sub.serviceExpireDate);
          if (!Number.isNaN(d.getFullYear())) {
            const formattedDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            // 🆕（2026-08-31）补全到"日"并加前缀文案，替代此前只到"月"且无
            // 语境前缀的 expireDateText，与 profile.ts formatTenantExpireText
            // 的"已于/有效期至"措辞保持一致
            expireDateText = isExpired ? `已于 ${formattedDate} 到期` : `有效期至 ${formattedDate}`;
            // 🆕 临期提醒：只在"尚未到期"这一侧生效（rawExpired 为 false），
            // 已过期/宽限期内走的是另一套"续费"提示语境，不叠加"即将到期"文案
            if (!rawExpired) {
              const daysUntilExpire = Math.floor((expireTime - Date.now()) / (24 * 3600 * 1000));
              isExpiringSoon = daysUntilExpire >= 0 && daysUntilExpire <= EXPIRING_SOON_THRESHOLD_DAYS;
            }
          } else {
            expireDateText = '到期日异常';
          }
        }
        // 🆕 衍生能力商业化鉴权：合并导出/调拨引擎/存证徽章统一按"是否
        // pro/enterprise 且未到期降级"判定，与 exportAccountExcel 的
        // isNationalExport 硬校验、本文件下方 rebalanceSuggestions/
        // auditProofSummary 的服务端强鉴权共用同一个 isAdvancedPlan 结果，
        // 三处判断逻辑不允许出现"前端显示能用、服务端却拒绝"或反过来的偏差
        const isAdvancedPlan = planType === 'pro' || planType === 'enterprise';
        subscriptionQuota = {
          planCode: PLAN_CODE_MAP[planType] || PLAN_CODE_MAP.basic,
          planName: buildPlanName(planType, maxStores),
          activeStores: usedStoreCount,
          maxStores,
          usagePercent: maxStores > 0 ? Math.round((usedStoreCount / maxStores) * 100) : 0,
          isExpiringSoon,
          isExpired,
          expireDateText,
          features: {
            canExportNationalExcel: isAdvancedPlan,
            canUseRebalanceEngine: isAdvancedPlan,
            canAccessAuditProof: isAdvancedPlan
          }
        };
      }
    } catch (err) {
      // tenant_subscriptions 集合可能尚未创建（该机构从未触发过任何订阅写入），
      // 沿用上面 basic/free 兜底值，不影响主统计
    }

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
    // 🆕（2026-08-31 失联告警一键督导触达）：门店离线判定与联系人信息此前
    // 只对 isSuperAdmin 下发，但「门店健康度告警中心」卡片本就对
    // store_patriarch 同样可见（见前端 wx:if="isPatriarch || isAdmin"）——
    // 大家长是本机构内部的最高负责人，理应拥有和超管同等的"自己机构内"
    // 运营治理视野，不该被挡在"离线了哪家店、该打给谁"这类信息之外。这条
    // 判断只加宽"离线检测+联系人"这一小块字段，receiptComplianceRate/
    // hasRiskFlag（凭证合规审计）仍严格保持 isSuperAdmin 专属，不一并放开
    const isPatriarchCaller = userRole === 'store_patriarch';

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
    // 🛡️ 已停用门店（status:'inactive'，本 schema 唯一的软删除标记，见
    // updateStoreStatus 云函数 VALID_STATUSES——没有 'CLOSED'/isDeleted 这类
    // 字段）不计入全国大盘：与 storeStatsMap 用 makeTenantFilter 时的 _.or
    // 顶层写法保持一致，用 _.and 组合而不是直接往同一个对象里塞 status 键——
    // makeTenantFilter 在兼容旧账套时返回的是顶层 _.or(...) 命令，不是普通对象，
    // 不能直接 { ...storesQuery, status: ... } 展开
    const storesQuery = _.and([makeTenantFilter(tenantId), { status: _.neq('inactive') }]);
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

    // 🌸 商业策略例外（docs/BUSINESS_MODEL.md 已回写）：雨花斋专区大屏的
    // 防篡改存证验真徽章（auditProofSummary，见下方计算处）是"查看类"公信力
    // 展示，不是深度功能，按 CLAUDE.md/BUSINESS_MODEL.md 一贯原则本就不该
    // 挂订阅套餐门槛——与"多店合并导出"（canExportNationalExcel）/"调拨引擎"
    // （canUseRebalanceEngine）这两项真正的深度功能严格区分，不因为这条豁免
    // 就连带放开那两项。这里在 subscriptionQuota 已经按套餐算好默认值之后
    // 单独覆盖这一个字段，不改动上面 isAdvancedPlan 的判定逻辑本身
    if (requestedOrgType === 'yuhuazhai') {
      subscriptionQuota.features.canAccessAuditProof = true;
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

    // 🆕 机构级食材消耗走势（2026-08-31 供应链集采预估）：与上面
    // nationalRiceTotal 等字段刻意分开、独立查询——上面那组是"当前所选
    // rangeType 时间片"的口径，会随大屏顶部 7天/本月/本季度/全部时间 切换
    // 而变化；而集采预估天然需要一个稳定的、不受用户当前切换的时间片
    // 干扰的固定窗口（近30天），否则大家长切到"本季度"或"全部时间"看到
    // 的"月度集采预估"会离谱地偏大，切到"近7天"又会偏小到不可用
    let ingredientStats30d = {
      riceKg: 0,
      flourKg: 0,
      oilKg: 0,
      veggieKg: 0,
      estimatedMonthlySupplyNeeds: ''
    };
    try {
      const ingredient30dStart = isoDateNDaysAgo(30);
      const ingredient30dConditions = [
        makeTenantFilter(tenantId),
        { dateString: _.gte(ingredient30dStart) }
      ];
      if (isScopedFilter) {
        ingredient30dConditions.push({ storeId: _.in(targetStores.map(s => s._id)) });
      }
      let ingredient30dLogs = [];
      let ingredient30dSkip = 0;
      while (true) {
        const batch = await db.collection('material_logs')
          .where(_.and(ingredient30dConditions))
          .skip(ingredient30dSkip)
          .limit(batchLimit)
          .get();
        if (!batch.data || batch.data.length === 0) break;
        ingredient30dLogs = ingredient30dLogs.concat(batch.data);
        if (batch.data.length < batchLimit) break;
        ingredient30dSkip += batchLimit;
        if (ingredient30dSkip >= 1000) break;
      }
      // 🐛 material_logs 的 riceCount/flourCount/oilCount/vegetableCount 历史上
      // 一律按"斤"（0.5kg）记录（对照 pages/index/index.ts 的填写占位提示
      // "大米50斤"），而这里对外输出的接口字段名是 riceKg 等公斤单位，必须
      // 显式做一次 ×0.5 换算，不能直接把"斤"数值套上 Kg 的字段名
      let rice30dJin = 0;
      let flour30dJin = 0;
      let oil30dJin = 0;
      let veggie30dJin = 0;
      ingredient30dLogs.forEach((m) => {
        rice30dJin += parseFloat(m.riceCount) || 0;
        flour30dJin += parseFloat(m.flourCount) || 0;
        oil30dJin += parseFloat(m.oilCount) || 0;
        veggie30dJin += parseFloat(m.vegetableCount) || 0;
      });
      const riceKg = Math.round(rice30dJin * 0.5 * 10) / 10;
      const flourKg = Math.round(flour30dJin * 0.5 * 10) / 10;
      const oilKg = Math.round(oil30dJin * 0.5 * 10) / 10;
      const veggieKg = Math.round(veggie30dJin * 0.5 * 10) / 10;

      // 🌟 月度集采预估：以近30天大米实际消耗量线性外推到"每月"口径（大米是
      // 雨花斋/助老食堂最核心、最需要提前备货的主食食材，故预估文案以大米为
      // 主角，其余品类仍在 riceKg/flourKg/oilKg/veggieKg 里原样暴露给前端自行
      // 展示），≥1000kg 时换算成"吨"展示更符合采购人员的直觉单位
      const estimatedMonthlyRiceKg = riceKg;
      let estimatedMonthlySupplyNeeds = '暂无近30天食材消耗数据';
      if (estimatedMonthlyRiceKg > 0) {
        if (estimatedMonthlyRiceKg >= 1000) {
          const tons = Math.round((estimatedMonthlyRiceKg / 1000) * 10) / 10;
          estimatedMonthlySupplyNeeds = `大米约需 ${tons} 吨/月`;
        } else {
          estimatedMonthlySupplyNeeds = `大米约需 ${Math.round(estimatedMonthlyRiceKg)} 公斤/月`;
        }
      }

      ingredientStats30d = { riceKg, flourKg, oilKg, veggieKg, estimatedMonthlySupplyNeeds };
    } catch (err) {
      // material_logs 集合可能尚未创建，视为近30天消耗为 0，不影响主统计
    }

    // 🌾（2026-08-31 商业化生态延伸）全网粮油集采测算：直接复用上面已经算好
    // 的 ingredientStats30d（近30天固定窗口，公斤单位），不重复发起一次
    // material_logs 查询——"月度大盘总需"与"近30天实际消耗"是同一份数据的
    // 两种叫法，即使 ingredientStats30d 因异常仍是初始的全 0 状态，这里也会
    // 如实展示 0，不额外编造一个兜底基准值
    const monthlyRiceEstimateKg = Math.round(ingredientStats30d.riceKg || 0);
    const monthlyFlourEstimateKg = Math.round(ingredientStats30d.flourKg || 0);
    const monthlyOilEstimateKg = Math.round(ingredientStats30d.oilKg || 0);
    // 🛡️ 经济测算口径（人工设定的行业经验基准，非实时议价结果）：大米每斤省
    // 0.4元（0.8元/kg）、面粉每斤省0.3元（0.6元/kg）、食用油每斤省1.5元（3.0元/kg）——
    // 这是"统谈统采"相比各门店零散采购的经验性溢价空间估算，不是任何一次
    // 真实询价/合同锁定的价格，前端展示措辞必须是"预计/预估节省"而不是
    // "保证节省"，避免构成事实上的价格承诺
    const RICE_SAVINGS_PER_KG = 0.8;
    const FLOUR_SAVINGS_PER_KG = 0.6;
    const OIL_SAVINGS_PER_KG = 3.0;
    const estimatedSavingsYuan = Math.round(
      monthlyRiceEstimateKg * RICE_SAVINGS_PER_KG +
      monthlyFlourEstimateKg * FLOUR_SAVINGS_PER_KG +
      monthlyOilEstimateKg * OIL_SAVINGS_PER_KG
    );
    const procurementSummary = {
      monthlyRiceEstimateKg,
      monthlyFlourEstimateKg,
      monthlyOilEstimateKg,
      estimatedSavingsYuan,
      // 🛡️ 诚实占位：这是产品原型阶段展示用的示例值，平台目前尚未真正签约
      // 任何粮油直供基地——上线真实合作基地后，需要改造成从一张真实的
      // "合作基地"配置表/集合里读取真实数量，不能继续硬编码这个 3
      partnerFarmCount: 3,
      status: 'active'
    };

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
        stapleUrgent: false,
        // 🆕 审计存证指纹：门店最新一条记录是否已财务稽核封账
        hasAuditProof: false
      };
    });

    // 兜底门店（stores 集合中未注册但有日志的门店）
    const fallbackStoreMap = {};

    // 🆕 阳光防篡改存证覆盖率统计（auditProofSummary）：totalReportsInScope 是
    // 本次聚合范围内全部生效报表（APPROVED + AUDITED_LOCKED，见 logsQueryConditions
    // 的 approvalStatus 过滤），totalAuditedLocked 是其中已财务稽核封账的部分，
    // totalAuditedWithProof 是"封账 且 确实带有 HMAC 防篡改签名"的部分——
    // stampReportChecksum 云函数才会写入 _checksum，理论上封账记录应该 100%
    // 带签名，覆盖率统计正是用来发现"封了账但签名缺失"这类数据完整性缺口
    let totalReportsInScope = 0;
    let totalAuditedLocked = 0;
    let totalAuditedWithProof = 0;

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
            stapleUrgent: false,
            hasAuditProof: false
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
      // 🐛 根因修复（单餐成本恒显示"暂无支出"）：dataService.ts saveReport() 唯一
      // 写入入口实际落库的字段名是 dailyExpenseTotal（每日食材/日常支出合计），
      // 这里此前读的 log.dailyExpense/log.ingredientCost/log.dailyIngredientText
      // 三个字段名在 report_logs 里从未真正存在过——entry.ingredientExpense 因此
      // 恒为 0，前端 formatNationalMatrixData() 的 costPerMealStr 计算链路
      // （foodExpense||dailyExpenseTotal||ingredientExpense，见该函数注释）
      // 实际上只有 ingredientExpense 这一个字段会被真正赋值，取到的却永远是 0，
      // 全站所有门店的"单餐成本"列因此都会误判成"暂无支出"，不是只有本次
      // 遇到的这一家门店才有问题
      const dailyExpense = parseFloat(log.dailyExpenseTotal || 0) || 0;

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
        // 🆕 审计存证指纹打标（2026-08-31）：记录本身是否已经过财务稽核封账
        // （report_logs.approvalStatus === 'AUDITED_LOCKED'）——APPROVED 只是
        // 店长/大家长核对确认过，AUDITED_LOCKED 是更进一步的财务复核锁定，
        // 公信力等级更高，供前端在善缘墙上展示"已稽核"合规标识，不代表未
        // 打标的记录不可信（本函数查询条件本就只认 APPROVED/AUDITED_LOCKED
        // 两档已生效数据，见文件头/logsQueryConditions 注释）
        const hasAuditProof = log.approvalStatus === 'AUDITED_LOCKED';
        donationItems.forEach(item => {
          if (publicDonorEntries.length >= 40) return;
          publicDonorEntries.push({
            name:      formatDonorDisplayName(item.name, resolveItemAnonymous(item, log.isAnonymous)),
            amount:    parseFloat(item.amount) || 0,
            storeName: entryStoreName,
            orgType:   entryOrgType,
            timeLabel,
            hasAuditProof
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
        // 🆕 阳光防篡改存证覆盖率：见上方 totalReportsInScope 声明处注释，
        // 按"这条记录是否真正计入本次聚合范围"（entry 命中即为在范围内）逐条
        // 计数，不受下方 isNewStore/fundingDays 等派生判断影响
        totalReportsInScope++;
        if (log.approvalStatus === 'AUDITED_LOCKED') {
          totalAuditedLocked++;
          if (log._checksum) {
            totalAuditedWithProof++;
          }
        }

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
          // 🆕 审计存证指纹打标：门店最新一条记录是否已财务稽核封账，供
          // 门店矩阵展示公信力合规标识（与 latestPublicDonors 每条记录各自
          // 独立打标的 hasAuditProof 同一套口径，这里是"门店当前状态"视角）
          entry.hasAuditProof = log.approvalStatus === 'AUDITED_LOCKED';
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

    // 🆕 跨店义工工时与荣誉榜聚合（2026-08-31）：数据来自 volunteer_duty_logs
    // （与 manageVolunteerCheckIn 的单店「爱心护持榜」leaderboard 同一张表，
    // 字段 {_openid, tenantId, storeId, dateString, hours, status:'active'}，
    // 这里不限 storeId、覆盖机构全部门店）。固定近30天窗口，与 ingredientStats30d
    // 同一设计动机——不随顶部 rangeType 联动，保持"荣誉榜"排名不因用户切换
    // 时间片 Tab 而大幅抖动。近7天出勤数据从同一批 30 天日志里按 dateString
    // 二次过滤取得，不再额外发起一次查询
    let volunteerSummary = {
      totalHours: 0,
      totalCheckIns: 0,
      activeVolunteersCount: 0,
      topVolunteers: []
    };
    // 🆕 义工缺口预警数据源：storeId -> Set("dateString_openid")，用于下方
    // storeMatrix 构建时判定"近7天日均出勤义工数 < 3 人"，与 healthStatus/
    // stapleUrgent 是并列的第三个健康度维度（资金-物资-义工）
    const volunteerAttendanceByStore = {};
    try {
      const volunteer30dStart = isoDateNDaysAgo(30);
      const volunteer7dStart = isoDateNDaysAgo(7);
      const dutyConditions = [{ tenantId, status: 'active', dateString: _.gte(volunteer30dStart) }];
      if (isScopedFilter) {
        dutyConditions.push({ storeId: _.in(targetStores.map(s => s._id)) });
      }
      let allDutyLogs = [];
      let dutySkip = 0;
      while (true) {
        const batch = await db.collection('volunteer_duty_logs')
          .where(_.and(dutyConditions))
          .field({ _openid: true, hours: true, dateString: true, storeId: true })
          .skip(dutySkip)
          .limit(batchLimit)
          .get();
        if (!batch.data || batch.data.length === 0) break;
        allDutyLogs = allDutyLogs.concat(batch.data);
        if (batch.data.length < batchLimit) break;
        dutySkip += batchLimit;
        if (dutySkip >= 2000) break;
      }

      const openidTotalHours = new Map();
      const openidStoreHours = new Map(); // openid -> Map(storeId -> hours)
      const openidSet = new Set();
      let totalHours30d = 0;
      let totalCheckIns30d = 0;

      allDutyLogs.forEach((log) => {
        const hours = parseFloat(log.hours) || 0;
        totalHours30d += hours;
        totalCheckIns30d++;
        if (!log._openid) return;
        openidSet.add(log._openid);
        openidTotalHours.set(log._openid, (openidTotalHours.get(log._openid) || 0) + hours);
        if (log.storeId) {
          if (!openidStoreHours.has(log._openid)) openidStoreHours.set(log._openid, new Map());
          const storeHoursMap = openidStoreHours.get(log._openid);
          storeHoursMap.set(log.storeId, (storeHoursMap.get(log.storeId) || 0) + hours);

          if (log.dateString && log.dateString >= volunteer7dStart) {
            if (!volunteerAttendanceByStore[log.storeId]) {
              volunteerAttendanceByStore[log.storeId] = new Set();
            }
            volunteerAttendanceByStore[log.storeId].add(`${log.dateString}_${log._openid}`);
          }
        }
      });

      // 🌟 全网义工奉献榜：按跨店累计工时降序取前5，姓名严格脱敏（maskName，
      // 与本文件"爱心滚动墙"同一条规则），不暴露任何可反查真实身份的原始信息
      const rankedOpenids = Array.from(openidTotalHours.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      let topVolunteers = [];
      if (rankedOpenids.length > 0) {
        const topOpenidList = rankedOpenids.map(([openid]) => openid);
        const nameRes = await db.collection('user_roles')
          .where({ tenantId, _openid: _.in(topOpenidList) })
          .field({ _openid: true, realName: true, nickName: true })
          .limit(100)
          .get()
          .catch(() => ({ data: [] }));
        const nameMap = {};
        (nameRes.data || []).forEach(r => {
          nameMap[r._openid] = r.realName || r.nickName || '';
        });

        topVolunteers = rankedOpenids.map(([openid, hours]) => {
          const storeHoursMap = openidStoreHours.get(openid) || new Map();
          const serviceStoreCount = storeHoursMap.size;
          // primaryStoreName：该义工投入工时最多的门店，供榜单展示"主要服务于XX店"
          let primaryStoreId = '';
          let primaryHours = -1;
          storeHoursMap.forEach((h, sId) => {
            if (h > primaryHours) {
              primaryHours = h;
              primaryStoreId = sId;
            }
          });
          const primaryStoreName = (storeStatsMap[primaryStoreId] && storeStatsMap[primaryStoreId].storeName) ||
            (fallbackStoreMap[primaryStoreId] && fallbackStoreMap[primaryStoreId].storeName) || '';
          return {
            maskedName: maskName(nameMap[openid] || '') || '匿名义工',
            totalHours: Math.round(hours * 10) / 10,
            serviceStoreCount,
            primaryStoreName
          };
        });
      }

      volunteerSummary = {
        totalHours: Math.round(totalHours30d * 10) / 10,
        totalCheckIns: totalCheckIns30d,
        activeVolunteersCount: openidSet.size,
        topVolunteers
      };
    } catch (err) {
      // volunteer_duty_logs 集合可能尚未创建（该机构还没有任何一条义工打卡被采纳过），
      // 视为无数据，不影响主统计
    }

    // 🆕 失联告警一键督导触达：CRITICAL/OFFLINE 门店的 storeId 集合，构建完
    // storeMatrix 后统一批量查一次 user_roles，不在下面的逐店 map 循环里各自
    // 发起查询
    const storeIdsNeedingContact = new Set();

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

      // 🆕 义工缺口预警：近7天日均出勤义工数（按 "dateString_openid" 去重，
      // 同一义工同天多个班次只算一次）< 3 人时追加提示，与资金/主料并列成为
      // "资金-物资-义工"三维健康度监控的第三个维度。只对已过爬坡期的门店生效
      // （isNewStore 分支已经把新店整体排除在健康度评级之外，义工缺口判定
      // 沿用同一个"是否处于正常开餐状态"的口径，不再单独定义一套新阈值）
      const attendanceSet = volunteerAttendanceByStore[s.storeId];
      const avgDailyVolunteers = attendanceSet ? attendanceSet.size / 7 : 0;
      const volunteerDeficit = !isNewStore && avgDailyVolunteers < 3;
      if (volunteerDeficit) {
        fundingTags.push('义工紧缺预警');
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
        volunteerDeficit,
        // 🆕 审计存证指纹打标：门店最新一条记录是否已财务稽核封账
        // （AUDITED_LOCKED），公信力等级高于普通 APPROVED，供前端展示合规标识。
        // 🏛️（2026-08-31 商业化权益中心）存证验真徽章是"审计增值服务"付费层，
        // 服务端按 subscriptionQuota.features.canAccessAuditProof 强鉴权——
        // 免费版门店哪怕自己确实已财务稽核封账，也不下发这个徽章标记，只是
        // 不展示"徽章"这一层商业化包装，不影响该门店 report_logs 里
        // approvalStatus/_checksum 本身的真实防篡改数据完整性
        hasAuditProof: subscriptionQuota.features.canAccessAuditProof ? !!s.hasAuditProof : false,
        alertTags: fundingTags,
        costPerMeal,
        avgMealCost,
        totalIncome: s.totalIncome,
        totalExpense: s.totalExpense,
        ingredientExpense: s.ingredientExpense,
        latestBalance: s.latestBalance,
        isCostRestricted: false
      };

      // 🛡️ 离线检测：此前只对 isSuperAdmin 下发，见 isPatriarchCaller 声明处
      // 注释——store_patriarch 是本机构最高负责人，理应拥有和超管同等的
      // "自己机构内"运营治理视野。hq_finance/regional_finance/volunteer 拿到
      // 的 storeMatrix 结构与升级前完全一致，不额外扩大这些角色的数据可见范围
      if (isSuperAdmin || isPatriarchCaller) {
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

        const offlineTags = [];
        if (!isNewStore) {
          if (item.isSeriouslyOffline) {
            offlineTags.push(daysSinceLastReport !== null ? `失联${daysSinceLastReport}天` : '从未提交报表');
          } else if (item.isOffline) {
            offlineTags.push(`离线${daysSinceLastReport}天`);
          }
        }

        // 🛡️ 凭证合规率仍严格保持 super_admin 专属——比"离线没记账"更细的
        // 财务审计维度，不属于大家长日常督导所需的最小信息集，不随上面这条
        // 放宽一并扩大
        if (isSuperAdmin) {
          item.receiptComplianceRate = s.expenseRecordCount > 0
            ? Number(((s.receiptRecordCount / s.expenseRecordCount) * 100).toFixed(1))
            : null;
          // 🌟 全局大屏"今日预警门店数"用：凭证合规率不满 100%（即扫描区间内有
          // 支出记录缺失小票）即视为需要关注，与 store-management 页
          // getRiskAlerts 的 missing_receipt 判定同一个口径，这里不重新发起
          // N 次单店查询，直接复用本函数已经在跑的同一份逐日志聚合结果
          item.hasRiskFlag = item.receiptComplianceRate !== null && item.receiptComplianceRate < 100;
          if (!isNewStore && item.hasRiskFlag) {
            offlineTags.push('凭证合规率不足');
          }
        }

        // 离线/合规告警排在资金告警前面——运营中断/失联的紧迫性通常高于
        // 资金预警，与 statistics.ts deriveSupportNeededStores 的加分权重
        // 排序保持一致
        item.alertTags = [...offlineTags, ...fundingTags];

        // 🆕 失联告警一键督导触达：CRITICAL/OFFLINE 门店才附带联系人信息，
        // 避免给运营健康的门店也塞一份不会被用到的字段；storeIdsNeedingContact
        // 收集后统一批量查询 user_roles，不在这层循环里逐店发起查询
        if (item.isOffline || healthStatus === 'CRITICAL') {
          storeIdsNeedingContact.add(s.storeId);
        }
      } else {
        item.alertTags = fundingTags;
      }

      return item;
    });

    // 按服务人次降序排列
    storeMatrix.sort((a, b) => b.totalDiners - a.totalDiners);

    // 🆕 失联告警一键督导触达：批量查询 CRITICAL/OFFLINE 门店的联系人信息
    // （店长优先，门店没有单独店长时退回大家长本人），一次查询覆盖所有
    // 需要联系人的门店，不对每家门店各自发起一次查询。tenantId 仍是硬隔离
    // 边界——只查本机构名下的 user_roles，不存在跨租户读到别的机构联系方式
    if (storeIdsNeedingContact.size > 0) {
      const contactRes = await db.collection('user_roles')
        .where({
          tenantId,
          storeId: _.in(Array.from(storeIdsNeedingContact)),
          role: _.in(['store_manager', 'store_patriarch'])
        })
        .field({ storeId: true, role: true, realName: true, phone: true })
        .limit(100)
        .get()
        .catch(() => ({ data: [] }));

      const contactMap = {};
      (contactRes.data || []).forEach(r => {
        if (!r.storeId) return;
        // 店长优先：同一门店若同时匹配到 store_manager 和 store_patriarch
        // （大家长直接兼管某家店的罕见情形），保留先遇到的 store_manager，
        // 不被后遇到的 patriarch 记录覆盖
        const existing = contactMap[r.storeId];
        if (!existing || (existing.role !== 'store_manager' && r.role === 'store_manager')) {
          contactMap[r.storeId] = r;
        }
      });

      storeMatrix.forEach(item => {
        if (!storeIdsNeedingContact.has(item.storeId)) return;
        const contact = contactMap[item.storeId];
        if (!contact) return;
        // managerName 无条件脱敏（即便对已经能看到 managerPhone 的大家长/超管
        // 也一样）——与本项目其余"内部展示同样默认脱敏"的口径一致，见
        // maskName/formatDonorDisplayName 头部注释；managerPhone 是原始号码，
        // 只在能走到这个分支（isSuperAdmin || isPatriarchCaller）时才会被
        // 赋值，义工等其余角色的 storeMatrix 条目上这个字段始终不存在
        item.managerName = maskName(contact.realName || '');
        item.managerPhone = contact.phone || '';
      });
    }

    // 🆕 跨店爱心调拨建议引擎（2026-08-30 首版，2026-08-31 升级为
    // rebalanceSuggestions 结构化撮合结果）：在同一机构（storeMatrix 已经过
    // tenantId 硬隔离 + targetStores 范围收窄，见文件头/上方 isScopedFilter
    // 注释）名下，把"受援门店"与"支援门店"撮合成轻量建议，帮大家长一眼看出
    // "该找哪家兄弟门店求助"，而不是空泛地告诉他"这家店缺钱"。
    // 受援（NeedSupport）：healthStatus==='CRITICAL'（资金续航≤7天，天然已
    // 排除 NEW_STORE——新店 healthStatus 恒为 'NEW_STORE'，见上方评级逻辑）
    // 或主料库存告急，二者满足其一即可——资金健康但恰好断粮、或账上有钱但
    // 青黄不接，都算需要外部支援。
    // 支援（CanSupport）：资金续航 ≥45 天，且排除"运营不稳定"的门店——
    // isSeriouslyOffline 只在超管视角下发，非超管响应里该字段是 undefined，
    // !undefined 恒为 true，不会误伤非超管视角下的可选门店范围
    const SURPLUS_FUNDING_DAYS_THRESHOLD = 45;
    const shortageStores = storeMatrix.filter(s =>
      s.healthStatus === 'CRITICAL' || s.stapleUrgent
    );
    const surplusStores = storeMatrix.filter(s =>
      typeof s.fundingDays === 'number' && s.fundingDays >= SURPLUS_FUNDING_DAYS_THRESHOLD && !s.isSeriouslyOffline
    );
    const rebalanceSuggestions = [];
    // 🏛️（2026-08-31 商业化权益中心）跨店智能调拨撮合是"审计增值服务"付费层的
    // 调拨引擎能力，服务端按 subscriptionQuota.features.canUseRebalanceEngine
    // 强鉴权——免费版机构哪怕确实存在受援/支援门店，也不撮合、不下发建议，
    // 与个人中心/大屏顶部套餐权益卡片描述的权益边界保持一致，不出现"前端说
    // 没有这个权益、服务端却照样算好数据"的偏差
    if (subscriptionQuota.features.canUseRebalanceEngine) {
    shortageStores.forEach(shortage => {
      // 优先撮合同城，同城没有充裕门店时退而求其次找同省——跨省调拨物流/
      // 人情成本都太高，不在轻量建议的范围内
      const sameCity = surplusStores.filter(s =>
        s.storeId !== shortage.storeId && shortage.city && s.city === shortage.city
      );
      const sameProvince = surplusStores.filter(s =>
        s.storeId !== shortage.storeId && shortage.province && s.province === shortage.province
      );
      const candidates = sameCity.length > 0 ? sameCity : sameProvince;
      // 🆕 与首版不同：即便同城/同省都找不到充裕门店，也不再直接丢弃这条
      // 受援记录——受援门店本身的"需要关注"信号不该因为撮合不到内部对象就
      // 消失不见，改为生成一条 sourceStoreId 缺省的建议，提示改走对外劝募
      const best = candidates.length > 0
        ? candidates.slice().sort((a, b) => b.fundingDays - a.fundingDays)[0]
        : null;
      const scopeLabel = sameCity.length > 0 ? '同城' : '同省';

      const isFundingCritical = shortage.healthStatus === 'CRITICAL';
      const urgency = isFundingCritical ? 'HIGH' : 'MEDIUM';

      let reasonCore;
      if (isFundingCritical && shortage.stapleUrgent) {
        reasonCore = `资金告急(仅剩${shortage.fundingDays}天)且主料库存告急`;
      } else if (isFundingCritical) {
        reasonCore = `资金告急(仅剩${shortage.fundingDays}天)`;
      } else {
        reasonCore = '主料（大米/食用油）库存告急';
      }

      rebalanceSuggestions.push({
        targetStoreId: shortage.storeId,
        targetStoreName: shortage.storeName,
        sourceStoreId: best ? best.storeId : undefined,
        sourceStoreName: best ? best.storeName : undefined,
        // 🆕 sourceFundingDays：撮合到的支援门店自身的资金续航天数，供前端
        // 文案"对方资金续航 X 天"直接展示，不撮合到时随 sourceStoreId 一起缺省
        sourceFundingDays: best ? best.fundingDays : undefined,
        reason: best
          ? `${reasonCore}，建议${scopeLabel}平调支援`
          : `${reasonCore}，同城/同省暂无充裕门店可平调，建议发起对外爱心劝募`,
        urgency
      });
    });
    }

    // 🐛 根因修复（覆盖率 0.0% 与"已存证"徽章矛盾）：此前覆盖率的分子用
    // totalAuditedWithProof（封账 且 _checksum 存在），但单条记录的"已存证"
    // 徽标（hasAuditProof，见上方逐条打标处与下方 storeMatrix/publicDonorEntries
    // 消费点）只看 approvalStatus==='AUDITED_LOCKED'，完全不检查 _checksum——
    // 两处对"算不算已存证"用了两套不同标准，一条已经财务稽核封账、界面上明明
    // 打着"已存证"徽章的记录，因为 stampReportChecksum 从未在它身上真正跑过
    // （多见于早于该功能上线的历史记录，或本身就缺 storeId 的孤儿数据），
    // 覆盖率却显示 0.0%，看起来像是"标了但没算进去"的矛盾。现在覆盖率分子
    // 统一改用 totalAuditedLocked，与徽章同一套口径（只认 approvalStatus）——
    // totalAuditedWithProof/_checksum 仍然照常统计，供下方 chainStatus 单独
    // 标记"已封账但签名缺失"这类数据完整性缺口，不再混进覆盖率百分比本身
    const auditCoverageRate = totalReportsInScope > 0
      ? ((totalAuditedLocked / totalReportsInScope) * 100).toFixed(1) + '%'
      : '0.0%';
    const chainStatus = (totalAuditedLocked === 0 || totalAuditedWithProof === totalAuditedLocked)
      ? 'SECURED'
      : 'VERIFYING';
    // 🏛️（2026-08-31 商业化权益中心）存证验真徽章是"审计增值服务"付费层，
    // 免费版机构不下发真实覆盖率/链路状态——只返回一个 locked 占位，前端据此
    // 展示"🔒 存证验真为专业版/旗舰版专享"引导，而不是把 0% 覆盖率误展示成
    // "这家机构完全没做财务核验"
    const auditProofSummary = subscriptionQuota.features.canAccessAuditProof
      ? { totalAuditedReports: totalAuditedLocked, auditCoverageRate, chainStatus, locked: false }
      : { totalAuditedReports: 0, auditCoverageRate: null, chainStatus: 'LOCKED', locked: true };

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
      // 🆕 机构级食材消耗走势（近30天固定窗口，不随 rangeType 联动，见上方
      // ingredientStats30d 计算处注释）：面向机构集采参考，非财务敏感字段，
      // 不加入下方 SENSITIVE_KEYS 脱敏名单
      ingredientStats30d,
      // 🌾（2026-08-31 商业化生态延伸）全网粮油集采测算：与 ingredientStats30d
      // 同源（复用同一份 riceKg/flourKg/oilKg），面向机构集采参考与商业化
      // 生态延伸，非财务敏感字段（不涉及本机构具体收支金额），不加入下方
      // SENSITIVE_KEYS 脱敏名单，全角色可见——刻意不做订阅套餐门禁：集采
      // 意向汇聚的本质是"越多门店参与、议价筹码越大"，对免费版机构设限
      // 反而削弱平台自己的集采规模效应，与 rebalanceSuggestions/合并导出等
      // "按订阅套餐分层的服务能力"不是同一类衍生能力，见智慧库本节说明
      procurementSummary,
      // 🆕 跨店义工工时与荣誉榜（近30天固定窗口，见上方 volunteerSummary 计算处
      // 注释）：全网奉献榜姓名已脱敏，非财务字段，不加入下方 SENSITIVE_KEYS
      volunteerSummary,
      // 🆕 机构套餐配额感知（见上方 subscriptionQuota 计算处注释）：与全国大屏
      // 查看权限彻底解耦（双轨制原则，见 CLAUDE.md）——这里只是把机构自己已经
      // 知道的用量展示出来，不做任何放行/拦截判断，也不属于财务敏感字段
      subscriptionQuota,
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
      rebalanceSuggestions,
      // 🆕 阳光防篡改存证覆盖率：这是公信力/合规展示指标，不是财务隐私数字
      // （不透露具体收支金额），对所有角色（含志工）一视同仁下发，不进
      // SENSITIVE_KEYS 脱敏名单
      auditProofSummary,
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
