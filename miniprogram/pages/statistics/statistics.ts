import { DataService, formatMoney, sanitizeReportForVolunteer } from '../../utils/dataService';
import { AuthService, ROLE_LABELS } from '../../utils/authService';
import { getSelectedStore, setSelectedStore } from '../../utils/storeManager';
import { formatGratitudeReportText, GratitudeReportData } from '../../utils/reportFormatter';
import { calculateEmaRunway, RunwayResult } from '../../utils/calculateRunway';
import { createNavGuard, NavGuardInstance } from '../../utils/navGuard';
import { recordRecentVisit } from '../../utils/recentPages';
import { drawVolunteerHonorCard, VolunteerHonorData } from '../../utils/posterGenerator';
import { getSafeSystemInfo } from '../../utils/util';
import { isVirtualStoreName, resolveHonorCardStoreName } from '../../utils/storeIdentity';
import { checkTenantPermission, FEATURE_KEYS } from '../../utils/tenantPermission';

// 🌾 大米/食用油库存状态展示口径：与"爱心续航看板"健康卡片、material-usage-modal
// 组件的三档选择器共用同一套 sufficient/normal/urgent 语义，提炼成模块级常量供
// calculateStatistics（历史 report_logs 兜底）与 fetchLatestMaterialStockStatus
// （单轨制改造后的真实数据源）共用同一份文案/颜色映射
const STOCK_STATUS_DISPLAY_MAP: Record<string, { text: string; color: string; icon: string; className: string }> = {
  sufficient: { text: '充足', color: '#4CAF50', icon: '🟢', className: 'success' },
  normal: { text: '一般', color: '#FF9800', icon: '🟡', className: 'warning' },
  urgent: { text: '告急', color: '#E53935', icon: '🔴', className: 'danger' }
};

function parseDate(dateStr: string): Date {
  return new Date(String(dateStr).replace(/-/g, '/'));
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 🆕 2x2 核心指标摘要区「同比变化」：把 'YYYY-MM-DD' 整体平移若干年，用于算出
// "去年同期"日期区间。复用 extractDateMeta 同款 '-' → '/' 归一化，避免 iOS
// Safari/JSCore 对连字符日期字符串的 new Date() 解析不稳定
function shiftDateByYears(dateStr: string, deltaYears: number): string {
  const normalized = String(dateStr || '').replace(/-/g, '/');
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return dateStr;
  d.setFullYear(d.getFullYear() + deltaYears);
  return formatDate(d);
}

// 🆕 同比百分比：prev 为 0/缺失时视为"无可比基数"，返回 null 让 wxml 隐藏徽标，
// 而不是误导性地显示 "+∞%"/"+100%"
function computePctChange(curr: number, prev: number): number | null {
  if (!prev) return null;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

// 🆕 2x2 核心指标摘要区无数据兜底态：与 data.coreMetrics 初始值同一份形状，
// loadStatistics() 里查无当期记录/云端调用失败两个分支复用，保持结构不塌陷
const EMPTY_CORE_METRICS = {
  hasData: false,
  diningCount: 0,
  volunteerCount: 0,
  expenseTotalStr: '--',
  perMealCostStr: '--',
  diningCountYoy: null as number | null,
  volunteerCountYoy: null as number | null,
  expenseTotalYoy: null as number | null,
  perMealCostYoy: null as number | null
};

function normalizeStoreName(str: string): string {
  return (str || '').replace(/[区市省店\s]/g, '').trim();
}

function isStoreNameFuzzyMatch(recordStore: string, filterStore: string): boolean {
  if (!recordStore || !filterStore) return false;
  const cleanRecord = normalizeStoreName(recordStore);
  const cleanFilter = normalizeStoreName(filterStore);
  return cleanRecord.includes(cleanFilter) || cleanFilter.includes(cleanRecord);
}

function toStandardIsoDate(dateStr: string): string {
  if (!dateStr) return '';
  let str = String(dateStr).trim();
  if (/^\d{2}年/.test(str)) str = '20' + str;
  const match = str.match(/(\d{4})[\-\/年\.](\d{1,2})[\-\/月\.](\d{1,2})/);
  if (match) {
    return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  }
  return str;
}

function isAllStoresMode(storeName: string): boolean {
  const cleanStr = (s: string) => String(s || '').replace(/\s+/g, '').trim();
  const clean = cleanStr(storeName);
  return !storeName || storeName === 'ALL' || clean === '全部门店';
}

// 🛡️ "全国总览"/"全部门店" 是 store-picker 里仅供 super_admin 选用的虚拟聚合
// 门店名（见 components/store-picker/store-picker.ts 的 national_overview 条目），
// 一旦被写进 app.globalData.currentStore/本地 selectedStore 缓存，任何页面直接用
// getSelectedStore() 兜底门店名时都可能把它带出来。非超管账号可以把 getSelectedStore()
// 当成"用户刚手动切换过去的真实门店名"这一正常场景的兜底来源（例如 store-picker
// 切身份后 fetchUserRole() 还没落地的窗口期），但必须先过滤掉这个虚拟聚合名，
// 绝不能把它当成自己门店展示/查询——定义提炼进 utils/storeIdentity.ts 供本文件与
// journey.ts 等其余"个人荣誉卡"生成逻辑共用，不再各自维护一份

// 🛡️ 与 VIRTUAL_STORE_NAMES 同一件事的 storeId 哨兵值形态（见
// cloudfunctions/getReports 的 wantsAllStores 判断、history.ts 的
// NATIONAL_STORE_IDS），本地 Storage 里的 current_store_id/active_store_id
// 兜底读取时同样要排除，不能当真实门店 id 使用
const NATIONAL_STORE_ID_SENTINELS = ['national_overview', 'ALL_STORES', 'all', 'ALL', 'yuhuazhai_national'];

// 🐛 修复"成功解析日期 0 条"根因之一：此前 reportDate/createTime 等字段排在 dateString 之前，
// 一旦某条记录的 reportDate 缺失但 createTime 是云端 db.serverDate() 读回的原生 Date 对象，
// 该 Date 对象会被当作"提交时间"误用为"汇报日期"（语义错误，且经字符串往返在 iOS 下极易解析失败）。
// dateString 是本项目云函数与提交逻辑统一写入的规范字段（纯 'YYYY-MM-DD'），必须优先命中。
function deepExtractDate(item: any): any {
  if (!item) return null;

  const fieldCandidates = [
    'dateString', 'reportDate', 'date', 'report_date', 'day', 'reportDay',
    'created_at', 'createTime', 'report_time', 'time', 'updated_at'
  ];

  for (const field of fieldCandidates) {
    if (item[field]) return item[field];
  }
  
  if (item.formData && typeof item.formData === 'object') {
    for (const field of fieldCandidates) {
      if (item.formData[field]) return item.formData[field];
    }
  }
  
  if (item.data && typeof item.data === 'object') {
    for (const field of fieldCandidates) {
      if (item.data[field]) return item.data[field];
    }
  }
  
  return null;
}

function deepExtractStoreName(item: any): string {
  if (!item) return '';
  
  const fieldCandidates = ['shopName', 'storeName', 'store', 'shop', 'store_name', 'shop_name'];
  
  for (const field of fieldCandidates) {
    if (item[field]) return String(item[field]);
  }
  
  if (item.formData && typeof item.formData === 'object') {
    for (const field of fieldCandidates) {
      if (item.formData[field]) return String(item.formData[field]);
    }
  }

  return '';
}

// 🐛 硬性根治：门店名文本可能因历史改名/录入差异而与 currentUserStoreId 对应的
// 真实门店名对不上，即便记录本就属于该门店，导致下面 filterRecordsByPeriodAndStore
// 的模糊文本匹配把它误判掉、算出"最终匹配笔数=0"。report_logs 记录本身带
// storeId 字段（见 cloudfunctions/getReports 的 whereConditions.storeId），
// 这才是门店身份的权威标识，能取到时必须优先按它精确匹配，而不是退回易错的
// 文本模糊匹配
function deepExtractStoreId(item: any): string {
  if (!item) return '';

  const fieldCandidates = ['storeId', 'store_id'];

  for (const field of fieldCandidates) {
    if (item[field]) return String(item[field]);
  }

  if (item.formData && typeof item.formData === 'object') {
    for (const field of fieldCandidates) {
      if (item.formData[field]) return String(item.formData[field]);
    }
  }

  return '';
}

function extractDateMeta(rawDate: any): { y: number; m: number; d: number; isoStr: string } | null {
  if (!rawDate) return null;

  // 🛡️ 云端 db.serverDate() 字段读回客户端时是原生 Date 对象：直接取字段，不做字符串往返，
  // 避免 String(dateObj) -> new Date(str) 二次解析在 iOS JavaScriptCore 环境下失败
  if (rawDate instanceof Date) {
    if (isNaN(rawDate.getTime())) return null;
    const y = rawDate.getFullYear();
    const m = rawDate.getMonth() + 1;
    const d = rawDate.getDate();
    return { y, m, d, isoStr: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
  }

  let str = String(rawDate).trim();

  if (/^\d{10,13}$/.test(str)) {
    const d = new Date(parseInt(str, 10));
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const isoStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { y, m, d: day, isoStr };
  }

  if (/^\d{2}年/.test(str)) {
    str = '20' + str;
  }

  const match = str.match(/(\d{4})[\-\/年\.](\d{1,2})[\-\/月\.](\d{1,2})/);
  if (match) {
    const y = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const d = parseInt(match[3], 10);
    const isoStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return { y, m, d, isoStr };
  }

  const matchChinese = str.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (matchChinese) {
    const y = parseInt(matchChinese[1], 10);
    const m = parseInt(matchChinese[2], 10);
    const d = parseInt(matchChinese[3], 10);
    const isoStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return { y, m, d, isoStr };
  }

  try {
    // 🛡️ 兜底解析前统一把 '-' 替换为 '/'：iOS Safari/JSCore 对 'YYYY-MM-DD' 这类连字符日期
    // 字符串的 new Date() 解析不稳定（部分版本直接返回 Invalid Date），'/' 分隔格式兼容性更好
    const normalized = str.replace(/-/g, '/');
    const dateObj = new Date(normalized);
    if (!isNaN(dateObj.getTime())) {
      const y = dateObj.getFullYear();
      const m = dateObj.getMonth() + 1;
      const day = dateObj.getDate();
      const isoStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { y, m, d: day, isoStr };
    }
  } catch (e) {
    console.warn('[Statistics] Date parse fallback failed:', str, e);
  }

  return null;
}

function filterRecordsByPeriodAndStore(
  records: any[],
  startIso: string,
  endIso: string,
  targetStore: string,
  allowAllStores: boolean,
  targetStoreId: string = ''
): any[] {
  if (!Array.isArray(records) || records.length === 0) return [];

  const cleanStore = (s: string) => String(s || '').replace(/[区市省店\s]/g, '').trim();
  const targetStoreClean = cleanStore(targetStore);
  // 🛡️ 严禁非 super_admin 触发"全部门店"聚合模式：targetStore 在调用方可能因为
  // onLoad 里 initUserRole()/reloadShopListAndStats() 的并行加载时序，短暂拿到
  // 空字符串（isAllStoresMode() 的 !storeName 分支会把它误判为"全部门店"）——
  // allowAllStores 由调用方传入 canViewAllStoresDropdown（严格收窄到 super_admin），
  // 哪怕 targetStore 真的是空/"全部门店"，非超管也强制走"按门店名匹配"分支
  const isAll = allowAllStores && isAllStoresMode(targetStore);

  const startMeta = extractDateMeta(startIso);
  const endMeta = extractDateMeta(endIso);
  if (!startMeta || !endMeta) return [];

  const isDateInRange = (meta: { y: number; m: number; d: number }) => {
    if (meta.y < startMeta.y || meta.y > endMeta.y) return false;
    if (meta.y === startMeta.y && meta.y === endMeta.y) {
      if (meta.m < startMeta.m || meta.m > endMeta.m) return false;
      if (meta.m === startMeta.m && meta.m === endMeta.m) {
        return meta.d >= startMeta.d && meta.d <= endMeta.d;
      }
      if (meta.m === startMeta.m) return meta.d >= startMeta.d;
      if (meta.m === endMeta.m) return meta.d <= endMeta.d;
      return true;
    }
    if (meta.y === startMeta.y) {
      if (meta.m < startMeta.m) return false;
      if (meta.m > startMeta.m) return true;
      return meta.d >= startMeta.d;
    }
    if (meta.y === endMeta.y) {
      if (meta.m > endMeta.m) return false;
      if (meta.m < endMeta.m) return true;
      return meta.d <= endMeta.d;
    }
    return true;
  };

  let parseSuccessCount = 0;
  let storeMatchCount = 0;

  const filtered = records.filter((item) => {
    if (!isAll) {
      // 🐛 硬性根治：storeId 精确匹配与门店名模糊匹配是【或】的关系，而非二选一
      // 互斥——此前改成"两边都有 storeId 就只认 storeId、否则才退回名称匹配"，
      // 一旦 user_roles.storeId 与该条 report_logs.storeId 因历史数据迁移/口径
      // 不一致而对不上（哪怕门店名明明相同），会把这条本该匹配的记录错误剔除，
      // 导致门店匹配数被压成 0。现在只要 storeId 命中或门店名模糊命中任意一个，
      // 就判定为匹配，只会比原先的纯名称匹配匹配到更多，不会更少
      const itemStoreId = deepExtractStoreId(item);
      const idMatch = !!(targetStoreId && itemStoreId && itemStoreId === targetStoreId);
      const itemStoreRaw = deepExtractStoreName(item);
      const itemStoreClean = cleanStore(itemStoreRaw);
      const nameMatch = itemStoreClean.includes(targetStoreClean) || targetStoreClean.includes(itemStoreClean);
      const matchStore = idMatch || nameMatch;
      if (!matchStore) return false;
      storeMatchCount++;
    }

    const itemDateRaw = deepExtractDate(item);
    const meta = extractDateMeta(itemDateRaw);

    if (!meta) return false;
    parseSuccessCount++;

    return isDateInRange(meta);
  });

  // 汇总日志仅保留一行，供开发者排查用；不再逐条打印（大数据量下性能浪费），
  // 也不再向终端用户 UI 暴露这些计数（见 smart-empty-card 的精简重构）
  console.log(`[Statistics] 记录总数=${records.length}, 日期解析成功=${parseSuccessCount}, 门店匹配=${isAll ? 'N/A(全部门店)' : storeMatchCount}, 最终匹配=${filtered.length}`);

  (filtered as any).totalRawCount = records.length;
  (filtered as any).parseSuccessCount = parseSuccessCount;

  return filtered;
}

Page({
  _navGuard: null as NavGuardInstance | null,
  // 🐛 见 data.roleReady 注释：reloadShopListAndStats() 在角色尚未就绪时把这次
  // 请求记成待办，不放进 data（不需要驱动渲染），applyRolePermissions() 落地后读取
  _pendingStatsReload: false,
  // 🌟 首页「Excel 账本导出」带 ?autoShowExport=true 跳转过来时置位，等
  // loadStatistics() 首次把 statistics 灌好后自动触发一次 exportToExcel()，
  // 免去用户落地后还要再手动点一次「导出表格」；消费一次后立即清零，不随
  // onShow/切 Tab 反复重放
  _autoShowExportPending: false,

  data: {
    watermarkIdentity: '',
    currentTab: 'week',
    // 🐛 根因修复：默认值绝不能是"全部门店"这种超管专属聚合占位——角色尚未解析
    // 完成的加载窗口期，非超管账号会先看到这个默认值（模板兜底文案已改成
    // '当前门店'，见 statistics.wxml），等 applyRolePermissions()/loadShopList()
    // 解析出真实角色后再被覆盖为具体门店名（或超管才会覆盖回"全部门店"）
    shopName: '',
    shopList: [] as string[],
    selectedShopIndex: 0,
    selectedYear: new Date().getFullYear(),
    selectedMonth: new Date().getMonth() + 1,
    // 🌟 周报「◀ 上一期/下一期 ▶」快捷翻页：相对本周的偏移量（0=本周，-1=上一周），
    // 月报/年报复用已有的 selectedYear/selectedMonth 字段翻页，无需单独 offset
    weekOffset: 0,
    // 🌟 周报专属：本周（或翻页后目标周）的日期范围展示文案，如 "08/25 - 08/31"，
    // 由 getWeekRange() 每次计算时一并写入，供 period-nav-row 展示（月报/年报
    // 直接复用已有 picker-pill-btn 展示 selectedYear/selectedMonth，无需此字段）
    weekRangeLabel: '',
    customStartDate: '',
    customEndDate: '',
    statistics: null,
    // 🆕 2x2 核心经营指标骨架卡：与 statistics 是否有数据解耦，无论当期是否有
    // 记录都固定渲染这四格，避免"无数据=页面结构直接塌陷"，见 statistics.wxml
    // core-metrics-card 与 loadStatistics() 里的计算逻辑
    coreMetrics: EMPTY_CORE_METRICS,
    // 🆕 引导型空状态「查看有数据月份」：loadStatistics() 在当期查无记录、但
    // 该门店存在历史记录（currentStoreTotalCount>0）时，从已拉取到手的
    // storeAllRecords 里找出最近一条记录所在的年/月，供空状态按钮一键跳转
    latestDataYear: null as number | null,
    latestDataMonth: null as number | null,
    latestDataLabel: '',
    navTop: 0,
    contentTop: 0,
    // 🛡️ 自定义导航栏避让官方胶囊菜单：capsuleLeft/windowWidth 用于计算刷新按钮的右侧安全内边距
    capsuleLeft: 0,
    windowWidth: 0,
    isAdmin: false,
    canViewNationalDashboard: false,
    canViewCrossStoreCost: false,
    canViewAllStoresDropdown: false,
    // 🌟 志工只读全国大屏：可查看汇总大屏，但门店选择器强制锁定为"全部门店"且禁用，
    // 且成本类敏感数据在下方门店矩阵表中做屏蔽展示
    isVolunteerNationalView: false,
    // 店长/财务/超管（非志工）—— 用于精细化管理视图的条件渲染，如 wx:if="{{isManager}}"
    isManager: false,
    // 🆕 精细化单店角色：三者互斥（同一账号的 role 只会命中其中一个），各自渲染
    // 专属卡片与专属海报按钮文案，取代此前"isManager 就都看同一份通用单店视图"
    isStoreAdmin: false,
    isFinance: false,
    isPatriarch: false,
    dashboardTitle: '🌐 雨花斋全国爱心矩阵数据大屏',
    dashboardRoleTag: '',

    // 🆕 家长专属：资源储备/资金物资兜底/续航预警，复用 getPatriarchDashboard
    // 云函数（该函数早已对 store_patriarch 做 storeId 硬隔离，见该云函数
    // resolveTarget，无需在这里额外传角色声明）
    patriarchStatsLoading: false,
    patriarchStats: {
      storeName: '',
      monthLabel: '',
      monthDiners: 0,
      monthIncome: 0,
      monthExpense: 0,
      monthNet: 0,
      monthNetPositive: true,
      auditedCount: 0,
      totalCount: 0,
      pendingVoidCount: 0,
      pendingProfileUpdate: false
    },

    // 🆕 个人视角：非管理角色（普通义工/无角色账号）打开本页时，不再看精简版的
    // 全国/门店治理大屏，改看只属于自己的护持数据——与 isManager 互斥
    showPersonalView: false,
    personalStatsLoading: false,
    personalStats: {
      totalDays: 0,
      totalHours: 0,
      totalCount: 0,
      diningCount: 0
    } as { totalDays: number; totalHours: number; totalCount: number; diningCount: number },
    personalMonthlyTrend: [] as Array<{ monthLabel: string; count: number; barPercent: number }>,
    isGeneratingPersonalPoster: false,
    showPersonalPosterModal: false,
    personalPosterImage: '',
    isSavingPersonalPoster: false,
    // 🛡️ 防抖：刷新数据与导出预览此前均无重入守卫
    isRefreshingData: false,
    isExportPreviewLoading: false,
    viewMode: 'all' as 'all' | 'personal',
    // 🛡️ 预默认必须是 false：这是页面刚加载、角色尚未解析完成前的初始值，若默认
    // true，非超管账号会在 initUserRole()/reloadShopListAndStats() 并行请求的
    // 窗口期内短暂（甚至持续，如果角色解析本身就慢）处于"全部门店"聚合状态——
    // 与 canViewAllStoresDropdown（默认同样是 false，严格收窄到 super_admin）
    // 保持同一条口径，只有确认是 super_admin 才允许被置为 true
    isAllStoresMode: false,
    // 🏠 门店人员与服务人群画像：仅单店视角下有值，来自 manageStoreProfile 云函数
    storeProfile: null as any,
    hasOtherStoreData: false,
    showAllStoresOption: false,
    currentStoreTotalCount: 0,
    totalRawCount: 0,
    parseSuccessCount: 0,
    showBatchDinerModal: false,
    missingDinerRecords: [] as any[],
    showPosterModal: false,
    posterTempFilePath: '',
    showEditMajorModal: false,
    editingTargetRecord: null as any,
    editingInputText: '',
    currentUserRole: '' as string,
    currentUserStoreName: '',
    currentUserStoreId: '',
    // 🐛 根因修复：initUserRole() 是异步的（缓存命中时同步落地，缓存缺失时要等
    // AuthService.fetchUserRole() 网络往返完成）——onLoad/onShow 此前无条件立即
    // 调用 reloadShopListAndStats()，冷缓存场景下会在角色/storeId 尚未解析出来
    // 时就发起 getReports/getStatisticsData 请求（见 loadStatistics 日志里的
    // "viewMode: undefined, storeId: undefined"），之后角色解析完成也不会自动
    // 补一次刷新，导致界面停留在这次无效请求的兜底结果上。roleReady 标记角色是否
    // 已至少完整解析过一轮（见 applyRolePermissions 末尾），reloadShopListAndStats
    // 在它为 false 时改为记录待办（this._pendingStatsReload），等 applyRolePermissions
    // 落地后自动补触发一次，不再凭空打空请求
    roleReady: false,
    // 🐛 防抖锁：给实际发起 getStatisticsData 云调用的 fetchStatistics() 加锁，
    // 避免 onLoad/onShow 前后脚各触发一次 reloadShopListAndStats()（或用户快速
    // 切换 Tab/年月）导致同一时刻并发打出多个重复云函数请求
    statisticsFetchLoading: false,
    // 🐛 防抖锁：给单店周/月/年报的 loadStatistics() 同样加锁——它内部有
    // wx.showLoading/hideLoading 配对，onLoad/onShow 前后脚并发触发时后完成的
    // 那次会在没有对应 showLoading 的情况下调用 hideLoading，触发开发者工具
    // "showLoading、hideLoading 必须配对使用" 告警，见该方法内的详细说明
    statisticsLoadLoading: false,
    roleLabelMap: ROLE_LABELS,
    // 🆕 超管专属门店切换 Picker 数据源：第一项固定为"🌐 全国总览"虚拟聚合项
    // （storeId 用 'ALL' 哨兵值标记，仅供 onSuperAdminSelectStore 内部判断选中项
    // 是否为聚合视图用，不直接写入 this.data.shopName——后者仍需保持 '全部门店'
    // 这个后端 getStatisticsData 云函数认识的字面量，见该函数 wantsAllStores 判断），
    // 后续项为当前租户下的真实门店
    storePickerArray: [] as any[],
    nationalData: {} as any,
    nationalMatrixList: [] as any[],
    // 🆕 多店排行榜：全国各门店"报表活跃度"（openDays 降序）与"餐饮服务人次"
    // （totalDiners 降序）Top 5，纯客户端从 nationalMatrixList 派生，见
    // loadNationalDashboard() 末尾计算
    nationalTopDinersStores: [] as any[],
    nationalTopActiveStores: [] as any[],
    showNationalDashboard: false,
    // 🐛 根因修复：wxml 容器此前用 nationalData.nationalTotalDiners !== undefined
    // 作为"是否已加载好"的隐式判据——loadNationalDashboard() 云调用还在飞行中，
    // 或者失败/报错时，这个字段永远是 undefined，容器就一直不渲染。而此时
    // showNationalDashboard 已经是 true，下方 stats-content 又已经因为
    // !showNationalDashboard 被隐藏，两边都不出内容，界面表现为"点了全国总览
    // 但什么反应都没有"。改为容器本身只认 showNationalDashboard，内部用这两个
    // 状态显式区分"正在加载"与"加载失败"，不再用数据字段反推加载状态
    nationalDashboardLoading: false,
    nationalDashboardError: '',

    // 🌟 超管专属高阶治理看板：核心指标/时间切片/离线门店预警/CSV 报表导出，见 getNationalDashboard
    // 云函数 superAdminInsights（服务端已按 role==='super_admin' 二次校验，非超管拿到的字段恒为 null）
    superAdminInsights: null as any,
    nationalRangeType: 'all' as 'all' | '7d' | 'month' | 'quarter',
    nationalRangeOptions: [
      { value: 'all', label: '全部时间' },
      { value: '7d', label: '近7天' },
      { value: 'month', label: '本月' },
      { value: 'quarter', label: '本季度' }
    ],
    // 一键快筛：门店矩阵表按"正常运营/需关注预警"二选一展示，见 nationalMatrixList wx:if
    storeMatrixFilter: 'normal' as 'normal' | 'risk',
    showNationalReportModal: false,
    nationalReportSelection: { operations: true, financeAudit: false },
    generatingNationalReport: false,
    showGratitudeModal: false,
    gratitudeTempFilePath: '',
    gratitudeReportData: {} as GratitudeReportData,
    gratitudeIncomeStr: '0.00',
    gratitudeExpenseStr: '0.00',
    gratitudeBalanceStr: '0.00',
    isPreparingPhase: false,
    gratitudeReportText: '',
    yearsList: ['2024', '2025', '2026'],
    monthsList: ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'],
    statsData: {} as any,
    monthlyAggregatedList: [] as any[],
    expandedMonthSet: {} as Record<string, boolean>,
    // 🌟「先核对、再确认、后导出」导出预览核对弹窗
    showExportPreviewModal: false,
    exportPreviewSummary: {} as any,
    exportPreviewRecords: [] as any[],
    // 🔐 专业版功能拦截弹窗：替代原生 wx.showModal（原生弹窗按钮无法用 WXSS
    // 定制样式，见 onOpenPlanUpgradeModal 处注释）
    showPlanUpgradeModal: false
  },

  onLoad(options: any) {
    recordRecentVisit('/pages/statistics/statistics', '统计分析');
    if (options && options.shopName) {
      this.setData({ shopName: options.shopName });
    }
    if (options && options.autoShowExport === 'true') {
      this._autoShowExportPending = true;
    }

    this.sanitizeDateVariables();
    this.calculateNavBarHeight();
    this.initCustomDates();
    this.initUserRole();
    this.reloadShopListAndStats();
    this.initWatermarkIdentity();

    // 🐛 DEBUG：initUserRole() 是异步的，onLoad 执行到这里时角色信息大概率还没解析
    // 回来，这里打印的是【调用发起前】的初始态（currentUserRole 此时通常还是空
    // 字符串，showNationalDashboard 还是默认 false）；真正解析完成后的值要看下面
    // applyRolePermissions() 末尾的那条日志
    console.log('[DEBUG] onLoad 时刻 currentUserRole（角色解析可能仍在进行中）：', this.data.currentUserRole);
    console.log('[DEBUG] onLoad 时刻 showNationalDashboard 状态：', this.data.showNationalDashboard);

    // 注入物理返回键兜底拦截
    this._navGuard = createNavGuard({
      homePath: '/pages/index/index',
      alertMessage: '即将退出雨花爱心餐报助手，是否返回首页继续使用？'
    });
    this._navGuard.setupOnLoad();
  },

  onUnload() {
    if (this._navGuard) {
      this._navGuard.teardown();
      this._navGuard = null;
    }
  },

  onShow() {
    // navGuard 状态刷新
    if (this._navGuard) {
      this._navGuard.setupOnShow();
    }

    // 🐛 硬性根治：getSelectedStore()/app.globalData.currentStore 是超管在门店
    // 选择器里的浏览态，可能残留"全国总览"虚拟选择——非超管分支绝对不读取它，
    // 门店名只能来自 applyRolePermissions() 已锁死的 currentUserStoreName/
    // shopName（真实绑定门店）。只有已核验的 super_admin 才允许跟随这个全局
    // 态在切 Tab 后同步（这是超管主动切换的展示状态，理应跟随），且仅在当前不
    // 处于"全部门店/全国矩阵"聚合视图时才同步（那是用户主动选择的展示状态，
    // 不该被切 Tab 静默打断）
    if (this.data.canViewAllStoresDropdown && !this.data.isAllStoresMode) {
      const activeStore = getSelectedStore();
      if (activeStore && activeStore.storeName !== this.data.shopName) {
        this.setData({
          shopName: activeStore.storeName
        });
      }
    }
    this.sanitizeDateVariables();
    DataService.syncLocalDataToCloud();
    this.reloadShopListAndStats();
  },

  sanitizeDateVariables() {
    const now = new Date();
    let { selectedYear, selectedMonth } = this.data;

    selectedYear = parseInt(selectedYear as any, 10);
    if (isNaN(selectedYear) || selectedYear < 2020 || selectedYear > 2030) {
      selectedYear = now.getFullYear();
    }

    let m = parseInt(selectedMonth as any, 10);
    if (isNaN(m) || m < 1 || m > 12) {
      m = now.getMonth() + 1;
    }

    if (selectedYear !== this.data.selectedYear || m !== this.data.selectedMonth) {
      this.setData({
        selectedYear,
        selectedMonth: m
      });
    }
  },

  // 🛡️ 防截图/防外传水印：叠加当前操作者身份标识，用于追溯截图外传来源
  initWatermarkIdentity() {
    const openid = AuthService.getOpenid() || '';
    const tail = openid ? openid.slice(-6) : '未登录';
    this.setData({ watermarkIdentity: `操作人 ***${tail}` });
  },

  async initUserRole() {
    const cachedRole = AuthService.getCachedRoleInfo();
    if (cachedRole) {
      const identity = this.resolveEffectiveStoreIdentity(cachedRole);
      this.applyRolePermissions(this.resolveEffectiveRole(cachedRole.role), identity.storeName, identity.storeId);
    }

    const result = await AuthService.fetchUserRole();
    if (result.success && result.roleInfo) {
      const info = result.roleInfo;
      const identity = this.resolveEffectiveStoreIdentity(info);
      this.applyRolePermissions(this.resolveEffectiveRole(info.role), identity.storeName, identity.storeId);
    } else if (!cachedRole) {
      // 🛡️ 兜底：既没有缓存角色、这次网络请求又失败/未拿到角色信息（例如彻底离线），
      // applyRolePermissions() 全程不会被调用，roleReady 会永远停在 false，
      // reloadShopListAndStats() 的待办也就永远无法被补触发，页面彻底空白。
      // 这种"确实解析不出角色"的场景下，退回原有行为——直接放行一次待触发的
      // 刷新，让 loadStatistics 走它自己"按 openid 兜底收敛"的服务端降级路径，
      // 而不是让用户在弱网下看着空白页面干等
      this.setData({ roleReady: true });
      if (this._pendingStatsReload) {
        this._pendingStatsReload = false;
        this.reloadShopListAndStats();
      }
    }
  },

  // 🐛 多重兼容读取：角色信息里的门店 id/名偶发缺失（历史数据/字段命名差异），
  // 这里依次尝试 roleInfo 上的几种可能字段名，缺失时再退回本机其他几处也会
  // 写入"当前门店"的本地态兜底（getSelectedStore() 汇总了 app.globalData.
  // currentStore 与 selectedStore 缓存；current_store_id/current_store_name
  // 是 index.ts/store-picker 写入切店结果的原始 Storage key）。
  // 🛡️ 无论从哪个来源读到，都严禁把"全国总览"/"全部门店"这类超管专属虚拟聚合名
  // 当成非超管的真实门店——命中就当作没读到，交给下面的空值兜底处理
  resolveEffectiveStoreIdentity(roleInfo: any): { storeId: string; storeName: string } {
    let storeId = (roleInfo && (roleInfo.storeId || roleInfo.shopId || roleInfo.store_id)) || '';
    let storeName = (roleInfo && (roleInfo.storeName || roleInfo.shopName)) || '';

    if (isVirtualStoreName(storeName)) {
      storeName = '';
    }

    if (!storeId || !storeName) {
      const activeStore = getSelectedStore();
      const activeStoreName = (activeStore && activeStore.storeName) || '';
      const activeStoreIsVirtual = isVirtualStoreName(activeStoreName);
      if (!storeName && activeStoreName && !activeStoreIsVirtual) {
        storeName = activeStoreName;
      }
      if (!storeId && activeStore && activeStore.storeId && !activeStoreIsVirtual) {
        storeId = activeStore.storeId;
      }
    }

    if (!storeId) {
      // 🛡️ "national_overview"/"ALL_STORES"/"all" 是全国总览虚拟条目的 storeId
      // 哨兵值（见 components/store-picker/store-picker.ts），与门店名的
      // "全国总览"/"全部门店" 是同一件事的两种表现形式，同样不能当真实门店 id
      const storedId = wx.getStorageSync('current_store_id') || wx.getStorageSync('active_store_id') || '';
      storeId = NATIONAL_STORE_ID_SENTINELS.includes(storedId) ? '' : storedId;
    }
    if (!storeName) {
      const storedName = wx.getStorageSync('current_store_name') || '';
      storeName = isVirtualStoreName(storedName) ? '' : storedName;
    }

    return { storeId, storeName };
  },

  // 🐛 根因修复：cachedRole/服务端下发的角色只是"最近一次校验/查询到的角色"，
  // 手动切换身份时写入的 current_user_role 才是真正的生效角色（同一套口径见
  // profile.ts initMinePage）——一旦存在就必须以它为准，严禁在 isSuperAdmin/
  // canViewAllStoresDropdown 的判定里直接使用未经这层校验的 cachedRole.role，
  // 否则残留的旧 super_admin 缓存会让"全部门店"权限位在这里被错误地放行
  resolveEffectiveRole(cachedRole: string): string {
    const storageRole = wx.getStorageSync('current_user_role');
    if (storageRole) {
      const normalized = String(storageRole).toLowerCase();
      // store_family 只是个人中心用来区分"家人视角"的展示态，不在真实角色枚举里，
      // 对应的真实底层角色就是 volunteer，这里按真实角色归一化
      return normalized === 'store_family' ? 'volunteer' : normalized;
    }
    return cachedRole;
  },

  // 🛡️ 三级角色权限卡口：单店财务 / 总部财务 / 超级管理员 / 志工（只读全国大屏）
  applyRolePermissions(role: string, storeName: string, storeId: string = '') {
    const isSuperAdmin = role === 'super_admin';

    // 🐛 根因修复："超级管理员看全国大屏却渲染单店界面"，日志显示
    // showNationalDashboard 状态：false：入参 storeName/storeId 来自
    // resolveEffectiveStoreIdentity(roleInfo)，其优先级是"角色文档里持久化的
    // storeName/storeId 字段"——这只是账号创建/最近一次核验时的历史快照（例如
    // 该超管账号曾是某具体门店的店长后被提权，user_roles.storeName 遗留着旧
    // 门店名），完全可能与超管当前在店铺选择器里实际选中的门店不一致。此前一旦
    // 这个历史快照非空，就会被当成"当前正在浏览某具体门店"直接采用，完全不会去看
    // getSelectedStore()（全局态，反映用户最近一次真实的门店切换操作，例如已经在
    // 首页手动切到了"全国总览"）——最终表现就是超管明明选的是全国总览，这里却把
    // showNationalDashboard 算成 false，渲染出一个跟当前操作脱节的单店界面。
    // 🛡️ 只对 super_admin 生效：一旦当前全局选中态（storeId 或 storeName）命中
    // 全国总览哨兵值，视为"用户当前明确处于全国总览"，让入参 storeName/storeId
    // 失效（清空），交由下方既有的 shouldDefaultToNational 走向全国大屏分支——
    // 不改变非超管、以及超管已经真实选中某个具体门店时的既有行为
    if (isSuperAdmin) {
      const liveSelected = getSelectedStore();
      const liveStoreId = (liveSelected && liveSelected.storeId) || '';
      const liveStoreName = (liveSelected && liveSelected.storeName) || '';
      if (NATIONAL_STORE_ID_SENTINELS.includes(liveStoreId) || isVirtualStoreName(liveStoreName)) {
        storeName = '';
        storeId = '';
      }
    }

    const isHQFinance = role === 'hq_finance' || role === 'regional_finance';
    const isVolunteer = role === 'volunteer';
    // 精细化管理视角：店长/财务/大家长/超管（非志工）均属于"管理者"，用于 wx:if="{{isManager}}"
    // 🏛️ 权限向下继承：大家长天然拥有店长 + 财务的全套日常管理权限
    const isManager = role === 'store_manager' || role === 'finance' || role === 'store_patriarch' || isSuperAdmin || isHQFinance;
    // 🆕 精细化单店角色：三者互斥，各自决定渲染哪一张专属卡片/哪一个海报按钮文案
    const isStoreAdmin = role === 'store_manager';
    const isFinance = role === 'finance';
    const isPatriarch = role === 'store_patriarch';

    // 权限 A："全国大屏"/"跨店成本比对"/门店选择器里的"全部门店"选项，严格收窄到
    // 真正的超级管理员——hq_finance/regional_finance 不在项目实际角色枚举
    // （super_admin/store_manager/store_patriarch/finance/volunteer/platform_admin）
    // 之内，checkUserRole 云函数永远不会下发这两个值，此前写在这里是永远不会命中的
    // 死判断，一并按明确要求收紧为仅 SUPER_ADMIN
    // 🆕 志工/无角色个人不再放行"全国数据大屏"（哪怕是脱敏只读版）——改为下方
    // showPersonalView 分支的专属个人视角，数据范围收窄到"只有我自己的"，
    // 既满足阳光账本的知情诉求，又不再让个人账号看到任何跨门店/治理类信息
    const canViewNationalDashboard = isSuperAdmin;
    const canViewCrossStoreCost = isSuperAdmin;
    const canViewAllStoresDropdown = isSuperAdmin;
    const isVolunteerNationalView = isVolunteer;
    // 🆕 个人视角：非管理角色（包含 volunteer，也兜底覆盖角色查询失败/未识别的
    // 情况）——与 isManager 互斥，isManager 已经把 store_manager/finance/
    // store_patriarch/super_admin/hq_finance 全部纳入，这里取反即可
    const showPersonalView = !isManager;

    // 🐛 硬性根治：storeName/storeId 入参在调用前已经过 resolveEffectiveStoreIdentity()
    // 多源兼容解析+虚拟聚合名过滤（见 initUserRole），这里只需要在其为空时退回
    // this.data 里上一次已解析出的值。【绝对禁止】非超管的门店名是"全国总览"/
    // "全部门店"——哪怕万一入参真的带着这类脏值（例如服务端 user_roles.storeName
    // 历史脏数据），这里也要再兜底剔除一次，双重保险。effectiveStoreName/Id 到此为止
    // 只可能是"真实门店"或"空"这两种状态，不掺任何占位文案——干净的值才能安全
    // 写回 setSelectedStore() 同步进全局态，不会把占位文案污染出去
    let effectiveStoreName = isSuperAdmin ? storeName : (storeName || this.data.currentUserStoreName || '');
    const effectiveStoreId = isSuperAdmin ? storeId : (storeId || this.data.currentUserStoreId || '');
    if (!isSuperAdmin && isVirtualStoreName(effectiveStoreName)) {
      effectiveStoreName = '';
    }

    this.setData({
      isAdmin: isSuperAdmin,
      isManager,
      isStoreAdmin,
      isFinance,
      isPatriarch,
      currentUserRole: role,
      // 🛡️ 硬性回退文字：非超管账号真实门店名确实解析不出来时（本地/服务端都
      // 没有任何来源能提供），展示层只允许回退成中性占位文案"当前门店"，绝不
      // 允许是空字符串继续在 UI 上裸露、更绝不允许是任何"全部门店/全国总览"
      // 聚合文案——门店身份的实际数据隔离由 currentUserStoreId 驱动（见
      // loadStatistics 的 storeId 精确匹配），这里只是保证胶囊/空态文案不裸露
      // 空白；只在 setData 这一步才落这个占位文案，不影响上面 effectiveStoreName
      // 这个"干净值"去同步全局态
      currentUserStoreName: (!isSuperAdmin && !effectiveStoreName) ? '当前门店' : effectiveStoreName,
      currentUserStoreId: effectiveStoreId,
      canViewNationalDashboard,
      canViewCrossStoreCost,
      canViewAllStoresDropdown,
      isVolunteerNationalView,
      showPersonalView,
      dashboardTitle: '🌐 雨花斋全国爱心矩阵数据大屏',
      dashboardRoleTag: ''
    });

    // 🛡️ 双保险：生效role 一旦不是 super_admin，强制清空/重置"全部门店"权限位与
    // 当前视图模式，不依赖下面 showPersonalView/else 分支各自都覆盖到——例如
    // showPersonalView 分支完全不触碰 isAllStoresMode，一个账号从 super_admin
    // （isAllStoresMode 可能残留 true）切换/降级为志工后，这个旧值不会在那个
    // 分支里被清掉，后续任何复用它的入口都会被误判成仍处于"全部门店"聚合视图
    if (!isSuperAdmin) {
      this.setData({ canViewAllStoresDropdown: false, isAllStoresMode: false });

      // 🧹 清洗全域污染：把 app.globalData.currentStore / 本地 selectedStore
      // 缓存强制同步为这个账号真实绑定的门店——防止其他任何复用
      // getSelectedStore() 的页面/组件继续读到超管视角下残留的"全国总览"。只用
      // 上面还没套用占位文案的 effectiveStoreName（干净值）同步，绝不能把
      // "当前门店"这个占位文案也写进全局态污染其他页面
      if (effectiveStoreName) {
        setSelectedStore({ storeId: effectiveStoreId, storeName: effectiveStoreName });
      }
    }

    if (showPersonalView) {
      // 个人视角：不触碰门店选择器/全国大屏那套状态，只加载属于自己的数据
      this.loadPersonalDashboard();
    } else {
      // 🐛 根因修复："统计分析页预设显示全国数据"：此前 canViewAllStoresDropdown
      // 为 true（超管）时，页面初始化会无条件直接 loadNationalDashboard()，
      // 完全不看当前实际切换到的是哪家门店——哪怕超管刚刚在首页把门店切到了
      // 具体某一家，一进统计页看到的还是全国大屏。全部门店/全国矩阵只应该是
      // 用户在门店选择器里主动选择的结果（见 onSuperAdminSelectStore），不应该是
      // 页面初始化的默认行为。现在不论角色是否具备"全部门店"切换权限，初始化都
      // 统一默认展示当前切换门店（仅超管才兜底读取 getSelectedStore()，覆盖
      // storeName 参数为空的情况——超管在 user_roles 里未必绑定固定门店；非超管
      // 已在上面用 effectiveStoreName 锁死为真实绑定门店，这里不再重复处理）的数据
      // 🐛 根因修复：上一版注释误以为 resolveEffectiveStoreIdentity() 已经把
      // "全国总览"/"全部门店" 这类虚拟聚合名从 getSelectedStore() 里过滤干净了——
      // 但那是另一次独立的 getSelectedStore() 调用（在 initUserRole 里，结果只
      // 落进 storeName/storeId 入参），这里是全新发起的第二次 getSelectedStore()
      // 调用，从未经过任何过滤。超管此前在别的页面（如 store-picker 组件，见其
      // storeId:'national_overview'/storeName:'全国总览' 虚拟条目）选过"全国总览"
      // 时，这里会原样把 '全国总览' 当成一个真实门店名传下去——非空字符串，
      // 导致下面 shouldDefaultToNational 被误判为 false，showNationalDashboard
      // 也就永远不会被置为 true，单店查询又查不到名叫"全国总览"的门店，最终两边
      // 都没有数据可展示。这里补上与本文件其余各处一致的 isVirtualStoreName 过滤
      const rawSelectedStore = getSelectedStore();
      const rawSelectedStoreName = (rawSelectedStore && rawSelectedStore.storeName) || '';
      const rawSelectedStoreId = (rawSelectedStore && rawSelectedStore.storeId) || '';
      // 🐛 补上 storeId 哨兵值判断：不能只看店名——'all'/'ALL_STORES'/
      // 'national_overview'/'yuhuazhai_national' 这类聚合 storeId 哪怕店名字段
      // 因为某种原因缺失/未同步，只要 storeId 命中就必须视为"当前选中全国总览"
      const rawSelectedIsNational = isVirtualStoreName(rawSelectedStoreName) || NATIONAL_STORE_ID_SENTINELS.includes(rawSelectedStoreId);
      const cleanSelectedStoreName = rawSelectedIsNational ? '' : rawSelectedStoreName;
      const finalShopName = isSuperAdmin
        ? (effectiveStoreName || cleanSelectedStoreName)
        : effectiveStoreName;

      // 超管账号在角色缓存/服务端/全局态/本地存储任何来源都解析不出一个真实门店时
      // ——典型场景是从未在任何页面手动选过具体门店，或者上次选的就是"全国总览"/
      // "全部门店"这类虚拟聚合名（现已在上面被过滤成空）——finalShopName 会是
      // 空字符串。只在这种"压根没有可展示的具体门店"时才回退到全国总览，不会
      // 重新引入此前"无条件默认全国大屏"的旧 Bug——那个 Bug 是不看实际选择、
      // 永远默认全国；这里只在无从选择时才兜底。
      // 🐛 显式全国总览信号：storeId 为空≠明确选了全国总览，也可能只是压根没
      // 选过任何门店——但 rawSelectedIsNational 为 true 时是用户/店铺选择器
      // 明确写入的聚合哨兵值，必须强制兜底为全国大屏，即便 finalShopName 因为
      // 上面某个环节还残留着旧值也不能让它逃逸成单店界面
      const shouldDefaultToNational = isSuperAdmin && (!finalShopName || rawSelectedIsNational);

      this.setData({
        shopName: shouldDefaultToNational ? '全部门店' : finalShopName,
        isAllStoresMode: shouldDefaultToNational
      });
      this.fetchStoreProfile();
      if (isPatriarch) {
        // 🆕 家长专属：资源储备/资金物资兜底/续航预警——与店长/财务共用的
        // 单店营运卡片是两套不同的数据源，单独加载
        this.loadPatriarchResourceStats();
      }
      if (shouldDefaultToNational) {
        this.setData({ showNationalDashboard: true });
        this.loadNationalDashboard();
      }
    }

    // 🐛 根因修复：角色（含 storeId）到这里已经完整解析落地，标记 roleReady 并把
    // reloadShopListAndStats() 之前记下的待办（见该方法与 data.roleReady 注释）
    // 补触发一次——覆盖"冷缓存时 onLoad/onShow 抢跑在角色解析完成之前"的时序窗口
    this.setData({ roleReady: true });
    if (this._pendingStatsReload) {
      this._pendingStatsReload = false;
      this.reloadShopListAndStats();
    }

    // 🐛 DEBUG：本函数内的多次 setData 都是同步写入 this.data 的，这里读到的已经
    // 是本轮角色解析结束后的最终值（不存在 userRole 这个字段，项目里的等价字段是
    // currentUserRole，见上面 setData 里的 currentUserRole: role）
    console.log('[DEBUG] applyRolePermissions 结束时 currentUserRole 权限数据：', this.data.currentUserRole);
    console.log('[DEBUG] applyRolePermissions 结束时 showNationalDashboard 状态：', this.data.showNationalDashboard);
  },

  // 🆕 家长专属资源续航看板：复用 getPatriarchDashboard 云函数（该函数早已把
  // store_patriarch 的 storeId 硬锁定为调用者自己绑定的门店，见其 resolveTarget，
  // 不接受客户端传参指定查其他门店），只在本页面重新映射展示字段，不重复实现
  // 权限校验逻辑
  async loadPatriarchResourceStats() {
    this.setData({ patriarchStatsLoading: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'getPatriarchDashboard',
        data: {}
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '加载资源续航数据失败', icon: 'none' });
        return;
      }
      const data = result.data;
      this.setData({
        patriarchStats: {
          storeName: data.storeName || '',
          monthLabel: data.monthLabel || '',
          monthDiners: data.monthDiners || 0,
          monthIncome: data.monthIncome || 0,
          monthExpense: data.monthExpense || 0,
          monthNet: data.monthNet || 0,
          monthNetPositive: (data.monthNet || 0) >= 0,
          auditedCount: data.auditedCount || 0,
          totalCount: data.totalCount || 0,
          pendingVoidCount: (data.pendingVoidList || []).length,
          pendingProfileUpdate: !!data.pendingProfileUpdate
        }
      });
    } catch (err) {
      console.error('[loadPatriarchResourceStats] 加载家长资源续航数据异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ patriarchStatsLoading: false });
    }
  },

  // 🆕 个人视角：加载"只属于我自己"的护持数据——累计天数/工时来自本地打卡统计
  // （与 pages/journey 同一份 my_checkin_days/my_service_hours/my_checkin_logs，
  // 全项目统一口径，不重复定义一套"服务天数"），服务人次（诚信提交的餐报人次）
  // 改由 getVolunteerHonorStats 云函数按调用者 _openid 查真实值——该云函数服务端
  // 硬编码用 cloud.getWXContext().OPENID 查询，不接受客户端传参指定查谁的数据，
  // 天然满足"非超管角色仅能查到自己的统计数据"的隔离要求
  async loadPersonalDashboard() {
    this.setData({ personalStatsLoading: true });
    try {
      const totalDays = wx.getStorageSync('my_checkin_days') || 0;
      const totalHours = wx.getStorageSync('my_service_hours') || 0;
      const logs: Array<{ date?: string }> = wx.getStorageSync('my_checkin_logs') || [];

      let diningCount = 0;
      try {
        const statsRes: any = await wx.cloud.callFunction({ name: 'getVolunteerHonorStats' });
        const statsResult = statsRes.result;
        if (statsResult && statsResult.success) {
          diningCount = statsResult.diningCount || 0;
        }
      } catch (statsErr) {
        console.warn('[loadPersonalDashboard] 个人荣誉数据查询失败，展示为 0:', statsErr);
      }

      // 近 6 个月护持频次趋势：按月分组统计打卡次数，月份分组口径与
      // pages/journey.ts loadTimelineData 的 monthKey 一致（YYYY-MM）
      const monthMap = new Map<string, number>();
      const now = new Date();
      const monthKeys: string[] = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        monthKeys.push(key);
        monthMap.set(key, 0);
      }
      logs.forEach((log) => {
        const dateStr = log && log.date;
        if (!dateStr) return;
        const key = String(dateStr).slice(0, 7);
        if (monthMap.has(key)) {
          monthMap.set(key, (monthMap.get(key) || 0) + 1);
        }
      });
      const maxCount = Math.max(1, ...Array.from(monthMap.values()));
      const personalMonthlyTrend = monthKeys.map((key) => {
        const monthNum = parseInt(key.split('-')[1], 10);
        const count = monthMap.get(key) || 0;
        return {
          monthLabel: `${monthNum}月`,
          count,
          barPercent: Math.round((count / maxCount) * 100)
        };
      });

      this.setData({
        personalStats: { totalDays, totalHours, totalCount: logs.length, diningCount },
        personalMonthlyTrend
      });
    } catch (err) {
      console.error('[loadPersonalDashboard] 个人数据加载异常:', err);
    } finally {
      this.setData({ personalStatsLoading: false });
    }
  },

  // 🆕 生成我的个人爱心海报：直接复用 utils/posterGenerator.ts 的 drawVolunteerHonorCard
  // （与 pages/journey.ts「生成我的爱心荣誉卡」同一张卡片同一套绘制/兜底逻辑），
  // 避免为同一种"个人荣誉卡"在项目里维护第二份画图代码
  async onGeneratePersonalPoster() {
    if (this.data.isGeneratingPersonalPoster) return;
    // 与 journey.ts 同款体验修复：立刻打开弹窗展示加载态，而不是等全流程跑完
    // 才 setData，避免用户以为点击没反应
    this.setData({
      isGeneratingPersonalPoster: true,
      showPersonalPosterModal: true,
      personalPosterImage: ''
    });

    try {
      const roleInfo = AuthService.getCachedRoleInfo();
      const storeId = (roleInfo && roleInfo.storeId) || '';
      // 🐛 根因修复：此前直接取 roleInfo.storeName，账号一旦曾经是 super_admin
      // 后被降级、服务端 user_roles.storeName 字段没跟着重置，就会把历史脏值
      // "全国总览"原样印上海报——改用 resolveHonorCardStoreName 统一口径
      // （非超管过滤虚拟聚合名 + getSelectedStore 兜底），见 utils/storeIdentity.ts
      const isSuperAdmin = !!roleInfo && roleInfo.role === 'super_admin';
      const storeName = resolveHonorCardStoreName(roleInfo && roleInfo.storeName, isSuperAdmin);
      const nickName = (roleInfo && roleInfo.nickName) || '';
      const avatarUrl = (roleInfo && roleInfo.avatarUrl) || '';

      // 邀请二维码：未绑定具体门店时跳过生成，降级为占位框，不强行传空 storeId 请求云函数
      let qrLocalPath = '';
      if (storeId) {
        try {
          const qrRes: any = await wx.cloud.callFunction({
            name: 'getStoreQRCode',
            data: { storeId, storeName, purpose: 'certificate' }
          });
          const qrResult = qrRes.result;
          if (qrResult && qrResult.success && qrResult.fileID) {
            const downRes = await wx.cloud.downloadFile({ fileID: qrResult.fileID });
            qrLocalPath = (downRes && downRes.tempFilePath) || '';
          }
        } catch (qrErr) {
          console.warn('[onGeneratePersonalPoster] 邀请二维码生成/下载失败，降级为占位:', qrErr);
        }
      }

      const { totalDays, totalHours, totalCount, diningCount } = this.data.personalStats;
      const honorData: VolunteerHonorData = {
        storeName,
        nickName,
        avatarUrl,
        serviceDays: totalDays,
        reportCount: totalCount,
        diningCount,
        totalHours,
        qrLocalPath
      };

      const personalPosterImage = await drawVolunteerHonorCard(this, honorData);
      this.setData({ personalPosterImage });
    } catch (err: any) {
      console.error('[onGeneratePersonalPoster] 生成失败:', err);
      wx.showToast({ title: err.message || '海报生成失败，请重试', icon: 'none' });
      this.setData({ showPersonalPosterModal: false });
    } finally {
      this.setData({ isGeneratingPersonalPoster: false });
    }
  },

  onClosePersonalPosterModal() {
    if (this.data.isSavingPersonalPoster) return;
    this.setData({ showPersonalPosterModal: false });
  },

  onSavePersonalPoster() {
    if (this.data.isSavingPersonalPoster || !this.data.personalPosterImage) return;
    this.setData({ isSavingPersonalPoster: true });

    wx.saveImageToPhotosAlbum({
      filePath: this.data.personalPosterImage,
      success: () => {
        wx.showToast({ title: '已保存至相册', icon: 'success' });
      },
      fail: (err: any) => {
        console.error('[onSavePersonalPoster] 保存失败:', err);
        if (err.errMsg && err.errMsg.includes('auth')) {
          wx.showModal({
            title: '提示',
            content: '请授权允许保存图片到相册',
            confirmText: '去授权',
            success: (res) => {
              if (res.confirm) {
                wx.openSetting();
              }
            }
          });
        } else if (!(err.errMsg && err.errMsg.includes('cancel'))) {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      },
      complete: () => {
        this.setData({ isSavingPersonalPoster: false });
      }
    });
  },

  // 🏠 门店人员与服务人群画像：仅单店视角下展示，切到全部门店/尚未选定门店时清空。
  // 传 storeName 而非 storeId——本页面从未维护过任何真实门店的 storeId（storePickerArray
  // 里普通门店项的 storeId 恒为空串，见 loadShopList），manageStoreProfile 服务端会按角色
  // 分别处理：店长/财务自动按自身绑定门店解析（忽略传入的 storeName），
  // super_admin/hq_finance/regional_finance 才会真正用 storeName 反查门店
  async fetchStoreProfile() {
    if (this.data.isAllStoresMode || !this.data.shopName) {
      this.setData({ storeProfile: null });
      return;
    }
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreProfile',
        data: { action: 'get', storeName: this.data.shopName }
      });
      const result = res.result;
      if (result && result.success) {
        this.setData({ storeProfile: result.data });
      } else {
        this.setData({ storeProfile: null });
      }
    } catch (err) {
      console.error('[fetchStoreProfile] 获取门店人员画像失败:', err);
      this.setData({ storeProfile: null });
    }
  },

  async loadNationalDashboard() {
    console.log('[NationalDashboard] 开始拉取全国大屏数据...');
    if (!this.data.canViewNationalDashboard) return;
    if (!this.data.isAllStoresMode) return;

    // 🔐 多门店汇总看板为专业版专属功能：与角色卡口（canViewNationalDashboard，
    // 严格收窄到 super_admin 等）是两条独立的准入条件——免费版租户即使账号是
    // super_admin 也拦在这里。服务端 getNationalDashboard 云函数内部有一份
    // 完全相同的判断兜底，这里只是提前拦截，避免真发起云调用才被拒绝。
    // 🐛 调用方 onSuperAdminSelectStore 在触发本函数前已经把 isAllStoresMode/
    // shopName 切到"全部门店"聚合态——被拦截时如果只 return，页面会卡在一个
    // 已经切换成聚合视图、却永远没有数据回来的空白状态（与海报生成白屏是同一
    // 类根因）。这里把状态退回到用户自己的实际门店，并重新拉一遍单店数据，
    // 而不是留一块空白
    const permission = await checkTenantPermission(FEATURE_KEYS.MULTI_STORE_DASHBOARD);
    if (!permission.allowed) {
      const ownStore = getSelectedStore();
      this.setData({
        isAllStoresMode: false,
        showNationalDashboard: false,
        shopName: ownStore.storeName || '',
        currentUserStoreName: ownStore.storeName || '',
        currentUserStoreId: ownStore.storeId || ''
      });
      this.onOpenPlanUpgradeModal();
      this.calculateStats();
      this.fetchStatistics();
      return;
    }

    this.setData({ showNationalDashboard: true, nationalDashboardLoading: true, nationalDashboardError: '' });

    try {
      // 🛡️ rangeType 仅超管高阶面板使用；云函数侧会再次校验调用者角色，非 super_admin
      // 传了也会被服务端忽略，这里传参不代表前端信任该参数会生效
      const callParams = { rangeType: this.data.nationalRangeType };
      console.log('[DEBUG] 准备调用 getNationalDashboard，传入参数：', callParams);

      const result = await wx.cloud.callFunction({
        name: 'getNationalDashboard',
        data: callParams
      });

      console.log('[DEBUG] getNationalDashboard 返回原始结果：', result);

      const r = result.result as any;
      // 🐛 DEBUG：本云函数的响应体没有 data/errMsg 字段（见 cloudfunctions/
      // getNationalDashboard/index.js 的 return 语句），成功时是 nationalSummary/
      // storeMatrix/superAdminInsights，失败时业务错误信息在 r.error（result.errMsg
      // 是 wx.cloud.callFunction 这层 SDK 调用失败才会有的字段，业务上的失败走的是
      // success:false + error，这里按真实响应结构打印，不按不存在的字段名瞎打）
      console.log('[DEBUG] getNationalDashboard 业务数据 result.nationalSummary/storeMatrix：', r && r.nationalSummary, r && r.storeMatrix);
      console.log('[DEBUG] getNationalDashboard 业务报错信息 result.error：', r && r.error);

      if (r && r.success) {
        // 🛡️ 客户端第二层脱敏防线：云函数出口已按角色做过服务端脱敏，
        // 这里对拿到的数据再跑一遍同名 sanitizeReportForVolunteer，双重兜底
        const role = this.data.currentUserRole;
        const sanitizedSummary = sanitizeReportForVolunteer(r.nationalSummary || {}, role);
        const sanitizedMatrix = sanitizeReportForVolunteer(r.storeMatrix || [], role);
        const cleanedMatrix = this.formatNationalMatrixData(sanitizedMatrix);
        // 🆕 多店排行榜：storeMatrix 服务端已按 totalDiners 降序返回（见
        // getNationalDashboard），这里再显式排一次序（不依赖调用方约定不变）+
        // 按 openDays（本次统计窗口内实际提交过餐报的天数，即"报表活跃度"）
        // 单独排一份——两份榜单都是纯客户端对已拿到手的同一份 matrix 数据重新
        // 排序取 Top 5，不需要为此再发一次云函数请求
        const topDinersStores = cleanedMatrix.slice().sort((a: any, b: any) => (b.totalDiners || 0) - (a.totalDiners || 0)).slice(0, 5);
        const topActiveStores = cleanedMatrix.slice().sort((a: any, b: any) => (b.openDays || 0) - (a.openDays || 0)).slice(0, 5);
        this.setData({
          nationalData: sanitizedSummary,
          nationalMatrixList: cleanedMatrix,
          nationalTopDinersStores: topDinersStores,
          nationalTopActiveStores: topActiveStores,
          // 非超管时云函数恒返回 null，这里原样落地，高阶面板 wx:if 会自动不渲染
          superAdminInsights: this.formatSuperAdminInsights(r.superAdminInsights, sanitizedSummary)
        });
      } else {
        // 🐛 根因修复：此前云函数返回 success:false（例如账号缺 tenantId、无权限）
        // 时什么反馈都没有，容器又靠 nationalData 是否有值来决定渲不渲染，
        // 用户只会看到点了"全部门店"后界面空白，不知道发生了什么
        const errMsg = (r && r.error) || '全国总览加载失败，请重试';
        this.setData({ nationalDashboardError: errMsg });
        wx.showToast({ title: errMsg, icon: 'none', duration: 4000 });
      }
    } catch (err: any) {
      console.error('[loadNationalDashboard] 加载失败:', err);
      const errMsg = (err && err.errMsg) || '网络异常，全国总览加载失败';
      this.setData({ nationalDashboardError: errMsg });
      wx.showToast({ title: errMsg, icon: 'none', duration: 4000 });
    } finally {
      this.setData({ nationalDashboardLoading: false });
    }
  },

  // 🔐 专业版功能拦截弹窗：utils/tenantPermission.ts 原来的 promptTenantUpgrade()
  // 用的是原生 wx.showModal——原生弹窗按钮完全渲染在 webview/WXML 之外，没有
  // 任何 class/id 可挂，WXSS 对它的按钮布局零控制力。这里改为页面自有的自定义
  // 半屏卡片弹窗，"知道了"/"去反馈"两个按钮才能真正用 flex 强制居中重构样式
  onOpenPlanUpgradeModal() {
    this.setData({ showPlanUpgradeModal: true });
  },

  onClosePlanUpgradeModal() {
    this.setData({ showPlanUpgradeModal: false });
  },

  // ✅ 与原生弹窗的"确认"分支保持一致的引导行为：跳去个人中心联系客服/反馈，
  // 而不是链到一个并不存在的自助收银台
  onGoFeedbackFromPlanUpgrade() {
    this.setData({ showPlanUpgradeModal: false });
    wx.switchTab({ url: '/pages/profile/profile' });
  },

  // 🐛 修复"全国平均单餐成本"异常金额：云函数已按 nationalTotalDiners>0 兜底过一次，
  // 但活跃门店数为 0（例如切到"近7天"等窄区间恰好全员离线）时同样不该展示一个具体金额——
  // 分母门店数为 0 时哪怕算出的数值本身不是 NaN，也不代表"真实的单餐成本"，这里补上
  // activeStoreCount 维度的兜底，并统一格式化成两位小数字符串，避免 wxml 直接吐出裸数字 0
  formatSuperAdminInsights(insights: any, summary: any): any {
    if (!insights) return null;

    const totalDiners = Number(summary && summary.nationalTotalDiners) || 0;
    const activeStoreCount = Number(insights.activeStoreCount) || 0;
    const rawAvgCost = Number(insights.avgCostPerMeal);

    const avgCostPerMealStr = (activeStoreCount <= 0 || totalDiners <= 0 || !isFinite(rawAvgCost))
      ? '—'
      : formatMoney(rawAvgCost);

    return {
      ...insights,
      avgCostPerMealStr
    };
  },

  // 超管高阶面板：切换"近7天/本月/本季度/全部时间"，重新拉取云函数聚合数据
  onSwitchNationalRange(e: any) {
    const rangeType = e.currentTarget.dataset.range;
    if (!rangeType || rangeType === this.data.nationalRangeType) return;
    this.setData({ nationalRangeType: rangeType });
    this.loadNationalDashboard();
  },

  // 一键快筛：正常运营门店 / 需关注预警门店——纯本地过滤 wx:if，数据已在 nationalMatrixList 里，不重新请求
  onSwitchMatrixFilter(e: any) {
    const filter = e.currentTarget.dataset.filter;
    if (!filter || filter === this.data.storeMatrixFilter) return;
    this.setData({ storeMatrixFilter: filter });
  },

  formatNationalMatrixData(rawStores: any[]): any[] {
    return rawStores.map((store: any) => {
      const diners = parseInt(store.totalDiners || store.diningCount || 0);

      // 🌟 志工只读脱敏视角：服务端已将 costPerMeal 等成本字段置空并标记 isCostRestricted，
      // 此时不再尝试用（同样被脱敏的）收支字段反推成本，直接展示统一遮罩文案
      let costPerMealStr = '';
      let isCostValid = false;

      if (store.isCostRestricted) {
        costPerMealStr = '***（仅店长可见）';
        isCostValid = false;
      } else {
        const foodExpense = parseFloat(store.foodExpense || store.dailyExpenseTotal || store.ingredientExpense || 0);
        if (diners > 0 && foodExpense > 0) {
          costPerMealStr = `¥${(foodExpense / diners).toFixed(2)}/餐`;
          isCostValid = true;
        } else if (foodExpense === 0) {
          // 🌟 去内卷文案：不用带背景框的"无日常开销"标签制造"这家店有问题"的观感，
          // 统一改成中性、不带底色徽章的"暂无支出"——见 statistics.wxml 里
          // isCostValid 为 false 且 costPerMealStr 命中这个值时不再套 .cost-badge 底色
          costPerMealStr = '暂无支出';
        } else {
          costPerMealStr = '筹备中';
        }
      }

      let statusLevel: 'ample' | 'warning' | 'urgent' | 'nodata' = 'nodata';
      let statusText = '';

      // 🌟 精确续航天数属于可反推资金余额的财务隐私：志工脱敏响应中 runwayDays 已被
      // 服务端置空，但定性的 healthStatus 标签依然保留——因此这里优先按 healthStatus
      // 判断状态标签，仅当 runwayDays 是真实数字时才在文案里附上具体天数（管理者视角）
      const hasExactDays = typeof store.runwayDays === 'number';

      if (store.healthStatus === 'nodata') {
        // 🐛 "告急(0天)"误报修复：门店压根没有日常开销/收支数据时，服务端已经把
        // healthStatus 明确标成 'nodata'（而不是拿默认值 0 硬算出一个假的"资金告急"），
        // 这里对应展示中性灰色的"数据建设中"，不制造不必要的焦虑感
        statusLevel = 'nodata';
        statusText = '⚪ 数据建设中';
      } else if (store.healthStatus === 'healthy') {
        statusLevel = 'ample';
        statusText = hasExactDays ? `🟢 充足(${store.runwayDays}天)` : '🟢 充足';
      } else if (store.healthStatus === 'warning') {
        statusLevel = 'warning';
        statusText = hasExactDays ? `🟡 注意(${store.runwayDays}天)` : '🟡 注意';
      } else if (store.healthStatus) {
        // 'danger' 及其他未识别取值，一律按告急处理（历史即有的兜底口径，不改变含义）
        statusLevel = 'urgent';
        statusText = hasExactDays ? `🔴 告急(${store.runwayDays}天)` : '🔴 告急';
      } else {
        // 兼容旧数据：既无 healthStatus 也无 runwayDays 时，退回用余额/日均开销就地反推
        // （仅管理者视角会走到这里——志工响应即使字段缺失也不会误算出虚假的告急状态）
        // 🐛 同一个"告急(0天)"误报根因：balance/foodExpense/days 全部缺失时会被 parseFloat/parseInt
        // 兜底成 0，估算出的 estimatedDays 也是 0，会被当成"资金见底"而不是"没有数据"。
        // 先判断是否真的有任何一项原始字段存在，完全没有时展示中性的"数据建设中"
        const hasBalanceField = store.balance != null || store.latestBalance != null;
        const hasExpenseField = store.foodExpense != null || store.dailyExpenseTotal != null;
        const hasDaysField = store.openDays != null || store.days != null;

        if (!hasBalanceField && !hasExpenseField && !hasDaysField) {
          statusLevel = 'nodata';
          statusText = '⚪ 数据建设中';
        } else {
          const balance = parseFloat(store.balance || store.latestBalance || 0);
          const foodExpense = parseFloat(store.foodExpense || store.dailyExpenseTotal || 0);
          const days = parseInt(store.openDays || store.days || 0);
          let dailyCostEstimate = foodExpense > 0 && days > 0 ? (foodExpense / days) : 100;
          if (dailyCostEstimate < 50) dailyCostEstimate = 100;
          const estimatedDays = Math.floor(balance / dailyCostEstimate);

          if (estimatedDays >= 10) {
            statusLevel = 'ample';
            statusText = `🟢 充足(${estimatedDays}天)`;
          } else if (estimatedDays >= 5) {
            statusLevel = 'warning';
            statusText = `🟡 注意(${estimatedDays}天)`;
          } else {
            statusLevel = 'urgent';
            statusText = `🔴 告急(${estimatedDays}天)`;
          }
        }
      }

      return {
        ...store,
        costPerMealStr,
        isCostValid,
        statusLevel,
        statusText
      };
    });
  },

  switchViewMode(e: any) {
    const mode = e.currentTarget.dataset.mode as 'all' | 'personal';
    this.setData({ viewMode: mode });
    this.calculateStats();
  },

  // 🛡️ 紧急修复 UI 重叠 Bug：自定义导航栏的刷新胶囊此前用 position:absolute; right:24rpx
  // 固定贴右，在部分机型上会与微信官方胶囊菜单按钮重叠遮挡。现动态读取官方胶囊的左边界
  // (wx.getMenuButtonBoundingClientRect().left) 与屏幕宽度，换算出安全右内边距传给 WXML，
  // 让自定义刷新按钮自动避让，不再依赖写死的固定像素值。
  calculateNavBarHeight() {
    const sysInfo = getSafeSystemInfo();
    const windowWidth = sysInfo.windowWidth || 375;

    const menuButton = wx.getMenuButtonBoundingClientRect();
    if (!menuButton) {
      this.setData({
        navTop: 44,
        contentTop: 88,
        windowWidth,
        capsuleLeft: windowWidth - 87 // 官方胶囊默认宽度约 87px 的兜底估算，避免 API 不可用时右侧完全不避让
      });
      return;
    }

    const navTop = menuButton.top;
    const contentTop = menuButton.top + menuButton.height + 20;

    this.setData({
      navTop: navTop,
      contentTop: contentTop,
      windowWidth,
      capsuleLeft: menuButton.left
    });
  },

  async loadShopList() {
    try {
      let allRecords: any[] = [];
      
      try {
        // 🛡️ 二级审核门槛：门店列表/记录条数这类统计入口同样只应该看到已归档
        // （店长核对确认/财务稽核封账）的数据，PENDING 待审草稿不该出现在这里
        const result = await DataService.getReports({ limit: 1000, approvedOnly: true });
        if (result.success && result.data && result.data.length > 0) {
          allRecords = result.data;
        }
      } catch (cloudError) {
        console.warn('[Statistics] 云端查询门店列表失败:', cloudError);
      }
      
      if (allRecords.length === 0) {
        try {
          const localData = wx.getStorageSync('local_report_logs');
          if (localData && Array.isArray(localData)) {
            allRecords = localData;
          }
          // 🛡️ 二级审核门槛：同一条口径，绕开 approvedOnly 过滤的本地兜底直读
          // 也必须重新套用一遍
          allRecords = allRecords.filter((r: any) => r && (r.approvalStatus === 'APPROVED' || r.approvalStatus === 'AUDITED_LOCKED'));
        } catch (localError) {
          console.warn('[Statistics] 本地缓存读取失败:', localError);
        }
      }

      if (allRecords.length > 0) {
        const shopCountMap = new Map<string, number>();
        allRecords.forEach((item: any) => {
          if (item.shopName && item.shopName.trim()) {
            const name = item.shopName.trim();
            shopCountMap.set(name, (shopCountMap.get(name) || 0) + 1);
          }
        });

        // 🛡️ 门店隔离：仅 super_admin 才允许在下拉里看到/选到"全部门店"聚合选项，
        // 与 canViewAllStoresDropdown（严格收窄到 super_admin）保持同一条权限口径。
        // 非超管的 shopNames 强制收窄为自己绑定的门店——不信任 allRecords 里可能
        // 混进来的其他门店名（哪怕 getReports 云函数已经做了服务端强隔离，本地缓存
        // local_report_logs 仍可能是共享设备上残留的旧数据），只用 applyRolePermissions
        // 已经从服务端角色信息里解析出的 currentUserStoreName 作为唯一权威来源
        const isSuperAdmin = this.data.canViewAllStoresDropdown;
        let shopNames = Array.from(shopCountMap.keys());
        if (!isSuperAdmin) {
          const ownStoreName = this.data.currentUserStoreName || this.data.shopName || '';
          shopNames = ownStoreName ? [ownStoreName] : [];
        }

        let shopList = shopNames.map(name => {
          const count = shopCountMap.get(name) || 0;
          return count > 0 ? `${name} (${count}条记录)` : name;
        });

        if (shopList.length > 0) {
          if (isSuperAdmin) {
            shopList.unshift('全部门店');
          }

          // 同时构建 storePickerArray（用于超级管理员门店切换 picker），非超管不含
          // "🌐 全国总览"聚合项
          const storePickerArray = (isSuperAdmin ? [{ shopName: '🌐 全国总览', storeId: 'ALL' }] : []).concat(
            shopNames.map(name => ({ shopName: name, storeId: '', recordCount: shopCountMap.get(name) || 0 }))
          );

          const currentShopName = this.data.shopName;
          let selectedIndex = 0;
          if (isSuperAdmin && currentShopName) {
            const exactIdx = shopList.findIndex(shop => {
              const cleanName = shop.replace(/\s*\(\d+条记录\)$/, '');
              return cleanName === currentShopName;
            });
            if (exactIdx !== -1) {
              selectedIndex = exactIdx;
            } else {
              const fuzzyIdx = shopList.findIndex(shop =>
                shop !== '全部门店' && isStoreNameFuzzyMatch(shop.replace(/\s*\(\d+条记录\)$/, ''), currentShopName)
              );
              if (fuzzyIdx !== -1) selectedIndex = fuzzyIdx;
            }
          }
          // 🛡️ 非超管强制锁定选中自己的门店：shopList 此时只包含这一项（index 0），
          // 不走上面的"全部门店"匹配逻辑，永远不会误选到聚合视图
          if (!isSuperAdmin) {
            selectedIndex = 0;
          }
          this.setData({
            shopList,
            selectedShopIndex: selectedIndex,
            shopName: (isSuperAdmin && selectedIndex === 0) ? '全部门店' : shopList[selectedIndex].replace(/\s*\(\d+条记录\)$/, ''),
            showAllStoresOption: isSuperAdmin && shopList.length > 1,
            storePickerArray
          });
        }
      }
    } catch (error) {
      console.warn('[Statistics] 加载门店列表失败:', error);
    }
  },

  async reloadShopListAndStats() {
    // 🐛 根因修复：角色/storeId 还没解析出来时（见上面 roleReady 字段注释），
    // 先记一笔"待办"就返回，不发起任何请求；applyRolePermissions() 落地后会
    // 自动读到这个待办并补触发一次真正带着正确 storeId 的刷新
    if (!this.data.roleReady) {
      this._pendingStatsReload = true;
      return;
    }
    await this.loadShopList();
    this.calculateStats();
  },

  onSuperAdminSelectStore(e: any) {
    const index = parseInt(e.detail.value);
    const storePickerArray = this.data.storePickerArray;
    if (!storePickerArray || storePickerArray.length === 0) return;

    const selected = storePickerArray[index];
    if (!selected) return;

    // 🛡️ 'ALL' 只是 storePickerArray 条目自带的哨兵值，用于判断本次选中的是否为
    // "🌐 全国总览"聚合项——this.data.shopName 一旦真正切到聚合视图，仍必须落回
    // '全部门店' 这个字面量（getStatisticsData 云函数的 wantsAllStores 判断认的
    // 就是这个值，见 fetchStatistics 的调用参数），不能直接写成 'ALL'
    const isAll = selected.storeId === 'ALL';

    this.setData({
      shopName: isAll ? '全部门店' : selected.shopName,
      currentUserStoreName: isAll ? '🌐 全国总览' : selected.shopName,
      currentUserStoreId: isAll ? '' : (selected.storeId || ''),
      isAllStoresMode: isAll,
      hasOtherStoreData: false,
      statistics: null,
      showNationalDashboard: isAll
    });

    if (!isAll && selected.shopName) {
      setSelectedStore({ storeId: selected.storeId || '', storeName: selected.shopName });
    }

    if (isAll) {
      this.loadNationalDashboard();
    } else {
      this.calculateStats();
      this.fetchStatistics();
    }
    this.fetchStoreProfile();
  },

  switchTab(e: any) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({
      currentTab: tab,
      statistics: null
    });
    this.calculateStats();
    this.fetchStatistics();
  },

  // 拉取后端真实过滤数据（严格按时间区间隔离）
  // 🐛 根因修复："全国总览"聚合视图曾在这里被无条件跳过，压根不会调用
  // getStatisticsData——但该云函数早在 beb3e25（先于本 return 加入）就已经支持
  // wantsAllStores（super_admin 传 shopName='全部门店' 或不传时聚合本机构全部
  // 门店），这个 return 是当年更早那次改动遗留的过时防御，从未跟进删除。直接
  // 后果：财务合规大屏的单餐成本/记账笔数/已稽核笔数/凭证合规率（statsData.*，
  // 无 statistics.* 兜底，见 wxml finance-metric-cell）在"全国总览"下永远停留
  // 在初始占位值，哪怕数据库里其实有数据
  async fetchStatistics() {
    // 🐛 根因修复：全国总览大屏（showNationalDashboard=true）有自己专属、已经
    // 按全租户聚合好的 getNationalDashboard 云函数数据源（nationalData/
    // nationalMatrixList），不该也不需要再叠加一次 getStatisticsData 单店口径
    // 的调用——万一本方法在这个状态下被意外触发（例如某个旧的直接调用点未经过
    // calculateStats() 的 showNationalDashboard 守卫），必须重新导向全局聚合
    // 入口，而不是拿着可能残留的单店 shopName 悄悄查出一份"看似全局、实则被
    // 收窄到某一家门店"的假数据
    if (this.data.showNationalDashboard) {
      console.log('[Statistics][fetchStatistics] 当前处于全国总览大屏，改为触发 loadNationalDashboard()');
      this.loadNationalDashboard();
      return;
    }
    // 🐛 根因修复：onLoad/onShow 前后脚各触发一次 reloadShopListAndStats()（或
    // 用户手快连点 Tab/年月切换）会让本方法在上一次云调用还没返回时又并发发起
    // 一次，同一屏 statsData 被 2~4 个并发请求的返回顺序竞争覆盖。isLoading 式
    // 防抖锁：已有请求在途时直接跳过，等它自己的 finally 解锁后由触发方自然收敛
    if (this.data.statisticsFetchLoading) {
      console.log('[Statistics][fetchStatistics] 已有请求在途，跳过本次重复调用');
      return;
    }
    const { currentTab, selectedYear, selectedMonth, customStartDate, customEndDate } = this.data;
    const tabMap: Record<string, string> = { week: 'week', month: 'month', year: 'year', custom: 'custom' };
    const tabType = tabMap[currentTab] || 'week';

    // 🐛 全局维度参数：isAllStoresMode（"全店汇总"聚合视图，与 showNationalDashboard
    // 是两套并行但都可能生效的聚合态）下必须显式传 '全部门店' 字面量 + viewMode:'all'，
    // 不能信任 this.data.shopName 当时是否已经同步——getStatisticsData 的
    // wantsAllStores 判断认的就是 shopName 空值/'全部门店' 这两种取值，这里补一层
    // 显式兜底，避免时序问题下把聚合请求误发成单店查询
    const shopName = this.data.isAllStoresMode ? '全部门店' : this.data.shopName;

    const statisticsCallData = {
      shopName: shopName || 'default',
      tabType,
      selectedYear: String(selectedYear),
      selectedMonth: String(selectedMonth).padStart(2, '0'),
      viewMode: this.data.isAllStoresMode ? 'all' : undefined,
      startDate: customStartDate,
      endDate: customEndDate
    };

    // 🪵 Debug 日志：定位"门店匹配=0"类问题时，确认 getStatisticsData 云函数调用
    // 前 effectiveRole/门店 id/名与实际传参是否一致（该云函数服务端会按
    // userStoreId/userStoreName 自行收敛，这里的 shopName 仅供展示分组用）
    console.log('[Statistics][fetchStatistics] effectiveRole=', this.data.currentUserRole,
      'currentUserStoreId=', this.data.currentUserStoreId,
      'currentUserStoreName=', this.data.currentUserStoreName,
      'getStatisticsData调用参数=', statisticsCallData);

    this.setData({ statisticsFetchLoading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'getStatisticsData',
        data: statisticsCallData
      });

      const result = (res.result || {}) as any;
      if (result.success) {
        this.setData({ statsData: result });
      } else {
        console.warn('[fetchStatistics] 云函数返回失败:', result.errMsg);
      }
    } catch (err) {
      console.error('[fetchStatistics] 调用失败:', err);
    } finally {
      this.setData({ statisticsFetchLoading: false });
    }
  },

  initCustomDates() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    
    this.setData({
      customEndDate: `${year}-${month}-${day}`,
      customStartDate: `${year}-${month}-01`
    });
  },

  onCustomStartDateChange(e: any) {
    this.setData({
      customStartDate: e.detail.value,
      statistics: null
    });
  },

  onCustomEndDateChange(e: any) {
    this.setData({
      customEndDate: e.detail.value,
      statistics: null
    });
  },

  loadCustomStatistics() {
    const { customStartDate, customEndDate } = this.data;
    if (!customStartDate || !customEndDate) {
      wx.showToast({ title: '请选择起止日期', icon: 'none' });
      return;
    }
    this.loadStatistics(customStartDate, customEndDate);
  },

  getWeekRange() {
    // 🌟 「◀ 上一期/下一期 ▶」翻页：weekOffset 是相对本周的偏移量（0=本周，
    // -1=上一周），叠加进 diff 里即可平移整周，不影响原有"本周一至本周日"算法
    const offset = this.data.weekOffset || 0;
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1) + offset * 7;
    const startDate = new Date(now.setDate(diff));
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);

    const mmdd = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    this.setData({ weekRangeLabel: `${mmdd(startDate)} - ${mmdd(endDate)}` });

    return {
      startDate: formatDate(startDate),
      endDate: formatDate(endDate)
    };
  },

  getMonthRange() {
    const { selectedYear, selectedMonth } = this.data;
    const startDate = new Date(selectedYear, selectedMonth - 1, 1);
    const endDate = new Date(selectedYear, selectedMonth, 0);
    
    return {
      startDate: formatDate(startDate),
      endDate: formatDate(endDate)
    };
  },

  getYearRange() {
    const { selectedYear } = this.data;
    const startDate = new Date(selectedYear, 0, 1);
    const endDate = new Date(selectedYear, 11, 31);
    
    return {
      startDate: formatDate(startDate),
      endDate: formatDate(endDate)
    };
  },

  onYearChange(e: any) {
    let yearVal = parseInt(e.detail.value);
    if (isNaN(yearVal) || yearVal < 2020 || yearVal > 2030) {
      yearVal = new Date().getFullYear();
    }
    this.setData({
      selectedYear: yearVal,
      statistics: null
    });
    if (this.data.currentTab === 'year') {
      this.calculateStats();
      this.fetchStatistics();
    }
  },

  onMonthChange(e: any) {
    const rawValue = e.detail.value || '';
    let yearVal = this.data.selectedYear;
    let monthVal: number;

    if (rawValue.includes('-')) {
      const parts = rawValue.split('-');
      yearVal = parseInt(parts[0], 10);
      monthVal = parseInt(parts[1], 10);
    } else {
      monthVal = parseInt(rawValue, 10);
    }

    if (isNaN(monthVal) || monthVal < 1 || monthVal > 12) {
      monthVal = new Date().getMonth() + 1;
    }

    this.setData({
      selectedYear: yearVal,
      selectedMonth: monthVal,
      statistics: null
    });
    if (this.data.currentTab === 'month') {
      this.calculateStats();
      this.fetchStatistics();
    }
  },

  loadWeekStatistics() {
    const range = this.getWeekRange();
    this.loadStatistics(range.startDate, range.endDate);
  },

  loadMonthStatistics() {
    const range = this.getMonthRange();
    this.loadStatistics(range.startDate, range.endDate);
  },

  loadYearStatistics() {
    const range = this.getYearRange();
    this.loadStatistics(range.startDate, range.endDate);
  },

  // 🌟 时间周期「◀ 上一期/下一期 ▶」快捷翻页：财务人员无需反复打开 Picker 弹窗
  // 即可连续前后查看不同周期。按 currentTab 语义分别平移 weekOffset/
  // selectedYear+selectedMonth/selectedYear/customStartDate+customEndDate，
  // 复用各 tab 已有的 calculateStats()+fetchStatistics()（或 custom 专属的
  // loadCustomStatistics()）触发真正的数据刷新，与 switchTab()/onYearChange()/
  // onMonthChange() 同一条口径
  onPeriodNav(e: any) {
    const dir = parseInt(e.currentTarget.dataset.dir, 10) || 0;
    if (!dir) return;
    const { currentTab, selectedYear, selectedMonth, weekOffset, customStartDate, customEndDate } = this.data;

    if (currentTab === 'week') {
      this.setData({ weekOffset: (weekOffset || 0) + dir, statistics: null });
    } else if (currentTab === 'month') {
      let year = selectedYear;
      let month = selectedMonth + dir;
      if (month < 1) { month = 12; year -= 1; }
      else if (month > 12) { month = 1; year += 1; }
      if (year < 2020 || year > 2030) {
        wx.showToast({ title: '已到可查询周期边界', icon: 'none' });
        return;
      }
      this.setData({ selectedYear: year, selectedMonth: month, statistics: null });
    } else if (currentTab === 'year') {
      const year = selectedYear + dir;
      if (year < 2020 || year > 2030) {
        wx.showToast({ title: '已到可查询周期边界', icon: 'none' });
        return;
      }
      this.setData({ selectedYear: year, statistics: null });
    } else if (currentTab === 'custom') {
      if (!customStartDate || !customEndDate) {
        wx.showToast({ title: '请先选择起止日期', icon: 'none' });
        return;
      }
      const normalize = (s: string) => new Date(String(s).replace(/-/g, '/'));
      const start = normalize(customStartDate);
      const end = normalize(customEndDate);
      const spanDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
      const shiftDays = spanDays * dir;
      const newStart = new Date(start);
      newStart.setDate(newStart.getDate() + shiftDays);
      const newEnd = new Date(end);
      newEnd.setDate(newEnd.getDate() + shiftDays);
      this.setData({
        customStartDate: formatDate(newStart),
        customEndDate: formatDate(newEnd),
        statistics: null
      });
      this.loadCustomStatistics();
      return;
    } else {
      return;
    }

    this.calculateStats();
    this.fetchStatistics();
  },

  calculateStats() {
    // 🐛 根因修复：reloadShopListAndStats()（onLoad/onShow 都会触发）此前无条件
    // 调用本方法，哪怕当前正展示的是全国大屏（showNationalDashboard=true，走
    // getNationalDashboard 单独的数据源）——单店周/月/年报的 loadStatistics/
    // fetchStatistics(getStatisticsData/getReports) 结果根本不会被渲染（stats-content
    // 整块被 wx:if="{{!showNationalDashboard}}" 隐藏），纯属浪费一次云函数调用
    if (this.data.showNationalDashboard) return;
    switch (this.data.currentTab) {
      case 'week':
        this.loadWeekStatistics();
        break;
      case 'month':
        this.loadMonthStatistics();
        break;
      case 'year':
        this.loadYearStatistics();
        break;
      case 'custom':
        this.initCustomDates();
        break;
    }
    // 同步拉取云函数严格过滤数据
    this.fetchStatistics();
  },

  async loadStatistics(startDate: string, endDate: string) {
    // 🐛 根因修复：与 fetchStatistics() 同一条口径——全国总览大屏有自己专属的
    // getNationalDashboard 全局聚合数据源，本方法（getReports 单店/全店口径）
    // 不该在这个状态下被触发，意外触发时重新导向全局聚合入口
    if (this.data.showNationalDashboard) {
      console.log('[Statistics][loadStatistics] 当前处于全国总览大屏，改为触发 loadNationalDashboard()');
      this.loadNationalDashboard();
      return;
    }
    // 🐛 防抖锁：onLoad/onShow 前后脚并发触发时，先返回的那次调用 wx.hideLoading()
    // 后，后返回的那次仍会再调用一次 wx.hideLoading()——此时已无对应的 showLoading
    // 在途，触发开发者工具"showLoading、hideLoading 必须配对使用"告警。早退发生
    // 在 wx.showLoading() 之前，不会留下未关闭的 loading
    if (this.data.statisticsLoadLoading) {
      console.log('[Statistics][loadStatistics] 已有请求在途，跳过本次重复调用');
      return;
    }
    this.setData({ statisticsLoadLoading: true });
    wx.showLoading({ title: '加载中...' });

    // 🛡️ 门店隔离根因修复：this.data.shopName 在 onLoad 触发的 initUserRole()/
    // reloadShopListAndStats() 两个并行异步请求之间的窗口期可能仍是初始空值——
    // isAllStoresMode('') 会把空字符串误判为"全部门店"模式，导致非超管账号仅仅
    // 因为加载时序问题就被打上"全部门店"标记（见 statistics.ts 原 227 行日志
    // "门店匹配=N/A(全部门店)"）。这里优先用 applyRolePermissions() 已解析出的
    // currentUserStoreName（服务端角色信息的权威来源）兜底；isSuperAdmin 再加
    // 一道硬性闸门——哪怕 shopName 真的等于"全部门店"/空，非超管也绝不允许进入
    // 聚合模式，与 canViewAllStoresDropdown（严格收窄到 super_admin）同一条口径
    const isSuperAdmin = this.data.canViewAllStoresDropdown;
    const shopName = isSuperAdmin
      ? this.data.shopName
      : (this.data.currentUserStoreName || this.data.shopName || '');
    const isAll = isSuperAdmin && isAllStoresMode(shopName);
    // 🐛 硬性根治：非超管绝对不能把 'national_overview'/'all' 这类聚合哨兵值当
    // 查询条件传下去——这里只可能是空字符串或账号真实绑定的 storeId，两者都是
    // 安全值；super_admin 需要跨店浏览整个机构数据集用于客户端筛选，不传 storeId
    const shopStoreId = isSuperAdmin ? '' : (this.data.currentUserStoreId || '');
    // 🐛 硬性根治：非超管绝不能把 this.data.viewMode 的默认值 'all' 原样传给
    // getReports——viewMode==='all' 这个字面量容易被误解成"查全部门店"（实际
    // 云函数里 viewMode 只用来决定是否额外收窄到"仅我自己提交的记录"，真正的
    // 门店隔离始终由 storeId 驱动），但字面上包含"all"就是这个 BUG 反复出现的
    // 根源之一，索性非超管一律不传这个字段，只让 storeId 决定查询范围；
    // 切页面里"全店汇总/个人统计"这个开关本身也只对 super_admin 渲染（wx:if=
    // "{{canViewAllStoresDropdown}}"），非超管永远不会主动把它切到 'personal'，
    // 所以这里不传等价于原先的"全店"语义，行为不变
    // 🐛 全局维度参数：isAll（"全部门店"聚合视图）下必须强制传 'all'，不能沿用
    // this.data.viewMode 当前的取值——超管此前若曾把「查看模式」切到"个人统计"
    // （viewMode==='personal'），一旦紧接着又切到"全部门店"，viewMode 不会自动
    // 复位，会把本该聚合全店的查询悄悄收窄成"仅超管自己提交的记录"，与"全部门店"
    // 这个选择的语义完全不符
    const reportsViewMode = isSuperAdmin ? (isAll ? 'all' : this.data.viewMode) : undefined;
    if (!isSuperAdmin && !shopStoreId) {
      console.warn('[Statistics][loadStatistics] 非超管账号 storeId 仍未解析出来，本次查询将退回服务端按 openid 兜底收敛，请检查该账号 user_roles.storeId 是否缺失');
    }

    // 🪵 Debug 日志：定位"门店匹配=0"类问题时，直接从这行日志确认 effectiveRole
    // 与门店 id/名是否已正确解析，以及最终传给 getReports 的过滤参数是什么
    console.log('[Statistics][loadStatistics] effectiveRole=', this.data.currentUserRole,
      'currentUserStoreId=', this.data.currentUserStoreId,
      'currentUserStoreName=', this.data.currentUserStoreName,
      'isSuperAdmin=', isSuperAdmin,
      'getReports过滤参数=', { viewMode: reportsViewMode, storeId: shopStoreId || undefined, limit: 1000, approvedOnly: true });

    try {
      let allRecords: any[] = [];

      try {
        // 🛡️ 二级审核门槛：待店长核对确认/财务稽核封账（approvalStatus 至少
        // 达到 APPROVED）之前，义工/店长刚提交的 PENDING 草稿绝不能计入统计分析
        const allResult = await DataService.getReports({
          viewMode: reportsViewMode,
          limit: 1000,
          storeId: shopStoreId || undefined,
          approvedOnly: true
        });

        allRecords = allResult.success && allResult.data ? allResult.data : [];
        // 🐛 根因排查配套：allResult.error 只在真正的云端报错（非离线降级）时才有值
        // （见 dataService.ts getReports），例如超管账号缺 tenantId 导致"全国总览"
        // 查询被拒绝——这种情况下面会呈现的"暂无统计数据"空状态具有强烈误导性
        // （看起来像是真的没数据），必须把真实原因喊出来，而不是让用户以为门店
        // 真的没开餐
        if (allResult.error) {
          wx.showToast({ title: allResult.error, icon: 'none', duration: 4000 });
          console.error('[Statistics][loadStatistics] getReports 返回明确错误（非静默降级）:', allResult.error);
        }
      } catch (cloudError) {
        console.warn('[Statistics] 云端查询失败:', cloudError);
      }

      if (allRecords.length === 0) {
        try {
          const localData = wx.getStorageSync('local_report_logs');
          if (localData) {
            if (Array.isArray(localData)) {
              allRecords = localData;
            } else if (typeof localData === 'string') {
              allRecords = JSON.parse(localData);
            }
          }
          // 🛡️ 二级审核门槛：这是绕开 DataService.getReports()（已经过
          // approvedOnly 过滤）的最后兜底直读，同一条口径必须在这里重新套用一遍，
          // 否则还没被店长核对确认的本地草稿会在云端查询失败时抢先计入统计
          allRecords = allRecords.filter((r: any) => r && (r.approvalStatus === 'APPROVED' || r.approvalStatus === 'AUDITED_LOCKED'));
        } catch (localError) {
          console.warn('[Statistics] 本地缓存读取失败:', localError);
        }
      }

      const cleanStore = (s: string) => String(s || '').replace(/[区市省店\s]/g, '').trim();
      const targetStoreClean = cleanStore(shopName);

      const storeAllRecords = isAll
        ? allRecords
        : allRecords.filter(item => {
            // 🐛 硬性根治：与 filterRecordsByPeriodAndStore 同一条口径——storeId
            // 精确匹配和门店名模糊匹配是"或"的关系，任一命中即视为本店记录，
            // 避免 storeId 因历史数据不一致对不上时把真实属于本店的记录漏算
            const itemStoreId = deepExtractStoreId(item);
            const idMatch = !!(shopStoreId && itemStoreId && itemStoreId === shopStoreId);
            const itemStoreClean = cleanStore(item.shopName || item.store || item.storeName || '');
            const nameMatch = itemStoreClean.includes(targetStoreClean) || targetStoreClean.includes(itemStoreClean);
            return idMatch || nameMatch;
          });

      const currentStoreTotalCount = storeAllRecords.length;

      // 🆕 引导型空状态「查看有数据月份」：无论当期是否有数据，都从
      // storeAllRecords（本店全部历史记录，与 currentStoreTotalCount 同源）里
      // 找出最近一条记录所在的年/月，供空状态按钮一键跳转（仅当确有历史记录时
      // latestDataLabel 才非空，wxml 据此决定是否渲染该按钮）
      let latestDataYear: number | null = null;
      let latestDataMonth: number | null = null;
      let latestDataLabel = '';
      if (currentStoreTotalCount > 0) {
        let latestIso = '';
        storeAllRecords.forEach((rec: any) => {
          const meta = extractDateMeta(deepExtractDate(rec));
          if (meta && meta.isoStr > latestIso) {
            latestIso = meta.isoStr;
            latestDataYear = meta.y;
            latestDataMonth = meta.m;
          }
        });
        if (latestDataYear && latestDataMonth) {
          latestDataLabel = `${latestDataYear}年${latestDataMonth}月`;
        }
      }

      const filteredData = filterRecordsByPeriodAndStore(allRecords, startDate, endDate, shopName, isSuperAdmin, shopStoreId);
      const totalRawCount = (filteredData as any).totalRawCount || allRecords.length;
      const parseSuccessCount = (filteredData as any).parseSuccessCount || 0;

      let hasOtherStoreData = false;
      // 🛡️ "查看全部门店汇总"提示仅对 super_admin 有意义（只有他们能真正切换过去，
      // 见 showAllStoresOption/onSwitchToAllStores 的同一条权限口径），非超管即使
      // 本店当期无数据也不该被引导去查"全部门店"
      if (isSuperAdmin && !isAll && filteredData.length === 0) {
        const allStoreFiltered = filterRecordsByPeriodAndStore(allRecords, startDate, endDate, '全部门店', isSuperAdmin);
        hasOtherStoreData = allStoreFiltered.length > 0;
      }

      if (filteredData.length > 0) {
        const statistics = this.calculateStatistics(filteredData, startDate, endDate);

        // 🆕 2x2 核心指标摘要区「同比变化」：直接复用本次已拉取到手的 allRecords
        // （1000 条上限内的全量数据），按"去年同期"重新跑一遍同一套
        // filterRecordsByPeriodAndStore + calculateStatistics 算出对比基数，
        // 不需要为对比数据额外发起一次云函数调用
        let prevYearStats: any = null;
        try {
          const prevStart = shiftDateByYears(startDate, -1);
          const prevEnd = shiftDateByYears(endDate, -1);
          const prevFiltered = filterRecordsByPeriodAndStore(allRecords, prevStart, prevEnd, shopName, isSuperAdmin, shopStoreId);
          if (prevFiltered.length > 0) {
            prevYearStats = this.calculateStatistics(prevFiltered, prevStart, prevEnd);
          }
        } catch (yoyError) {
          console.warn('[Statistics] 同比对比数据计算失败，本次仅展示当期数值:', yoyError);
        }

        const coreMetrics = {
          hasData: true,
          diningCount: statistics.totalDiningCount || 0,
          volunteerCount: statistics.totalVolunteerCount || 0,
          expenseTotalStr: '¥' + formatMoney(statistics.dailyExpenseTotal),
          perMealCostStr: statistics.perMealCost > 0 ? '¥' + formatMoney(statistics.perMealCost) : '--',
          diningCountYoy: prevYearStats ? computePctChange(statistics.totalDiningCount, prevYearStats.totalDiningCount) : null,
          volunteerCountYoy: prevYearStats ? computePctChange(statistics.totalVolunteerCount, prevYearStats.totalVolunteerCount) : null,
          expenseTotalYoy: prevYearStats ? computePctChange(statistics.dailyExpenseTotal, prevYearStats.dailyExpenseTotal) : null,
          perMealCostYoy: prevYearStats ? computePctChange(statistics.perMealCost, prevYearStats.perMealCost) : null
        };

        const netAccumulation = statistics.netAccumulation;
        const netAccumulationStr = (netAccumulation >= 0 ? '+' : '-') + formatMoney(Math.abs(netAccumulation));
        
        const totalExpenseForPercent = statistics.dailyExpenseTotal + statistics.largeExpenseTotal;
        const dailyExpensePercent = totalExpenseForPercent > 0 
          ? Math.round((statistics.dailyExpenseTotal / totalExpenseForPercent) * 100) 
          : 100;
        const largeExpensePercent = totalExpenseForPercent > 0 
          ? Math.round((statistics.largeExpenseTotal / totalExpenseForPercent) * 100) 
          : 0;

        const riceStatus = STOCK_STATUS_DISPLAY_MAP[statistics.latestRiceStatus] || STOCK_STATUS_DISPLAY_MAP.sufficient;
        const oilStatus = STOCK_STATUS_DISPLAY_MAP[statistics.latestOilStatus] || STOCK_STATUS_DISPLAY_MAP.sufficient;

        let healthGradientFrom = '#4CAF50';
        let healthGradientTo = '#66BB6A';
        if (statistics.healthStatus === 'nodata') {
          // 🐛 "告急(0天)"误报修复的配套样式：无数据时用中性灰渐变，
          // 不落入默认的绿色分支（那会显得像"已核实运行正常"，同样是不实信息）
          healthGradientFrom = '#9E9E9E';
          healthGradientTo = '#BDBDBD';
        } else if (statistics.healthStatus === 'fundUrgent') {
          healthGradientFrom = '#E53935';
          healthGradientTo = '#EF5350';
        } else if (statistics.healthStatus === 'materialWarning') {
          healthGradientFrom = '#FF9800';
          healthGradientTo = '#FFB74D';
        } else if (statistics.healthStatus === 'preparing' || statistics.healthStatus === 'largeExpenseInfo') {
          healthGradientFrom = '#F5A623';
          healthGradientTo = '#FFCC33';
        }

        const formattedStats = {
          ...statistics,
          totalIncomeStr: formatMoney(statistics.totalIncome),
          totalExpenseStr: formatMoney(statistics.totalExpense),
          totalListDonationStr: formatMoney(statistics.totalListDonation),
          totalOtherDonationStr: formatMoney(statistics.totalOtherDonation),
          dailyExpenseTotalStr: formatMoney(statistics.dailyExpenseTotal),
          largeExpenseTotalStr: formatMoney(statistics.largeExpenseTotal),
          netAccumulationStr,
          netAccumulationClass: netAccumulation >= 0 ? 'text-success' : 'text-danger',
          showLargeExpenseTip: netAccumulation < 0 && statistics.largeExpenseTotal > 0,
          largeExpenseTotalForTip: statistics.largeExpenseTotal,
          avgDailyExpenseStr: formatMoney(statistics.avgDailyExpense),
          avgDailyExpenseMA14Str: formatMoney(statistics.avgDailyExpenseMA14),
          perMealCostStr: statistics.perMealCost < 0.5 && statistics.perMealCost > 0 
            ? `${formatMoney(statistics.perMealCost)} (含物资)` 
            : formatMoney(statistics.perMealCost),
          showPerMealCost: (statistics.totalDiningCount + statistics.totalVolunteerCount) > 0 && statistics.dailyExpenseTotal > 0,
          latestBalanceStr: formatMoney(statistics.latestBalance),
          runwayDaysStr: statistics.runwayDaysRange,
          dailyExpensePercent,
          largeExpensePercent,
          riceStatusText: riceStatus.text,
          riceStatusColor: riceStatus.color,
          riceStatusIcon: riceStatus.icon,
          riceStatusClass: riceStatus.className,
          oilStatusText: oilStatus.text,
          oilStatusColor: oilStatus.color,
          oilStatusIcon: oilStatus.icon,
          oilStatusClass: oilStatus.className,
          healthGradientFrom,
          healthGradientTo,
          donationDays: statistics.donationDays,
          missingCount: statistics.missingCount,
          dailyRecords: statistics.dailyRecords.map((item: any) => ({
            ...item,
            _id: item._id,
            _localId: item._localId,
            incomeStr: formatMoney(item.income),
            expenseStr: formatMoney(item.expense),
            balanceStr: formatMoney(item.balance),
            balanceClass: item.balance <= 0 ? 'text-danger' : '',
            dailyExpenseStr: formatMoney(item.dailyExpense),
            largeExpenseStr: formatMoney(item.largeExpense),
            hasLargeExpense: item.largeExpense > 0,
            perMealCostStr: item.perMealCost < 0.5 && item.perMealCost > 0
              ? `${formatMoney(item.perMealCost)} (含物资)`
              : formatMoney(item.perMealCost),
            showPerMeal: (item.diningCount + (item.volunteerCount || 0)) > 0 && item.dailyExpense > 0,
            diningCount: item.diningCount || 0,
            volunteerCount: item.volunteerCount || 0,
            netChange: item.netChange,
            netChangeStr: formatMoney(Math.abs(item.netChange)),
            netChangeClass: item.netChange >= 0 ? 'plus' : 'minus',
            hasMaterials: item.hasMaterials,
            materialsSummary: item.materialsSummary,
            statusTag: item.statusTag,
            statusLabel: item.statusLabel
          }))
        };
        const monthlyAggregated = this.aggregateMonthlyStats(statistics.dailyRecords || [], this.data.selectedYear);

        this.setData({
          statistics: formattedStats,
          isAllStoresMode: isAll,
          hasOtherStoreData: hasOtherStoreData,
          currentStoreTotalCount,
          totalRawCount: totalRawCount,
          parseSuccessCount: parseSuccessCount,
          monthlyAggregatedList: monthlyAggregated,
          coreMetrics,
          latestDataYear,
          latestDataMonth,
          latestDataLabel
        });

        // 🌟 单轨制：上面 riceStatus/oilStatus 是从历史 report_logs.stapleRiceStatus
        // 兜底算出来的（老字段，店长表单里的选择器已移除，新报告不会再手动填这个值）。
        // 这里再用本店最近一次"🌾 登记物资消耗与报损"提交的真实状态覆盖一次，
        // 具体门店（非全部门店聚合视角）才有意义覆盖
        if (!isAll && shopStoreId) {
          this.fetchLatestMaterialStockStatus(shopStoreId);
        }
      } else {
        this.setData({
          statistics: null,
          isAllStoresMode: isAll,
          hasOtherStoreData: hasOtherStoreData,
          currentStoreTotalCount,
          totalRawCount,
          parseSuccessCount,
          coreMetrics: EMPTY_CORE_METRICS,
          latestDataYear,
          latestDataMonth,
          latestDataLabel
        });
      }
    } catch (error) {
      console.error('[Statistics] 加载统计数据失败:', error);
      this.setData({
        statistics: null,
        isAllStoresMode: isAll,
        hasOtherStoreData: false,
        currentStoreTotalCount: 0,
        coreMetrics: EMPTY_CORE_METRICS
      });
    } finally {
      // 🐛 与函数开头的防抖锁配套：wx.showLoading/wx.hideLoading 严格一对一，
      // 无论正常返回还是抛出异常都统一在这里收尾，不再在 try 中段提前 hide
      wx.hideLoading();
      this.setData({ statisticsLoadLoading: false });
    }

    // 🌟 首页「Excel 账本导出」带 ?autoShowExport=true 跳转过来时，本函数是
    // statistics 首次被真正灌好数据的地方——消费一次待办标记后立即清零，避免
    // onShow/切换 Tab/年月再次触发本函数时重复弹出核对弹窗
    if (this._autoShowExportPending) {
      this._autoShowExportPending = false;
      this.exportToExcel();
    }
  },

  // 🌾 大米/食用油库存状态单轨制改造：与首页 index.ts fetchLatestMaterialStatus
  // 同理，不再信任 report_logs.stapleRiceStatus/stapleOilStatus（店长表单里的
  // 重复选择器已移除，老字段今后只会停留在默认值），改为直接查询
  // manageVolunteerSubmission statsSummary 返回的"本店最近一次物资消耗提交"里
  // 录入的真实状态，覆盖 calculateStatistics 从历史报告兜底算出的展示字段
  async fetchLatestMaterialStockStatus(storeId: string) {
    if (!this.data.statistics) return;
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageVolunteerSubmission',
        data: { action: 'statsSummary', storeId }
      });
      const result = res.result;
      if (!result || !result.success || !result.data) return;

      const riceStatus = STOCK_STATUS_DISPLAY_MAP[result.data.latestRiceStatus] || STOCK_STATUS_DISPLAY_MAP.sufficient;
      const oilStatus = STOCK_STATUS_DISPLAY_MAP[result.data.latestOilStatus] || STOCK_STATUS_DISPLAY_MAP.sufficient;

      this.setData({
        'statistics.riceStatusText': riceStatus.text,
        'statistics.riceStatusColor': riceStatus.color,
        'statistics.riceStatusIcon': riceStatus.icon,
        'statistics.riceStatusClass': riceStatus.className,
        'statistics.oilStatusText': oilStatus.text,
        'statistics.oilStatusColor': oilStatus.color,
        'statistics.oilStatusIcon': oilStatus.icon,
        'statistics.oilStatusClass': oilStatus.className
      });
    } catch (err) {
      console.warn('[fetchLatestMaterialStockStatus] 查询最新物资库存状态失败，保留历史兜底值:', err);
    }
  },

  aggregateMonthlyStats(dailyRecords: any[], year: number): any[] {
    const monthMap: Record<string, {
      month: string;
      monthName: string;
      income: number;
      foodExpense: number;
      majorExpense: number;
      totalExpense: number;
      diners: number;
      volunteers: number;
      volunteerHours: number;
      recordCount: number;
      days: any[];
    }> = {};

    for (let m = 1; m <= 12; m++) {
      const monthStr = String(m).padStart(2, '0');
      monthMap[monthStr] = {
        month: monthStr,
        monthName: `${year}年${m}月`,
        income: 0,
        foodExpense: 0,
        majorExpense: 0,
        totalExpense: 0,
        diners: 0,
        volunteers: 0,
        volunteerHours: 0,
        recordCount: 0,
        days: []
      };
    }

    dailyRecords.forEach((item: any) => {
      const dateStr = item.date || item.dateString || '';
      const match = String(dateStr).match(/^(\d{4})-(\d{2})/);
      if (!match) return;
      const itemYear = match[1];
      const monthStr = match[2];
      if (String(itemYear) !== String(year)) return;

      const m = monthMap[monthStr];
      if (!m) return;

      const income = parseFloat(item.income || 0);
      const foodExp = parseFloat(item.dailyExpense || 0);
      const majorExp = parseFloat(item.largeExpense || 0);
      const totalExp = parseFloat(item.expense || 0);

      m.income += income;
      m.foodExpense += foodExp;
      m.majorExpense += majorExp;
      m.totalExpense += totalExp;
      m.diners += parseFloat(item.diningCount || 0);
      m.volunteers += parseFloat(item.volunteerCount || 0);
      m.volunteerHours += parseFloat(item.volunteerHours || 0);
      m.recordCount += 1;
      m.days.push(item);
    });

    const result: any[] = [];
    for (let m = 12; m >= 1; m--) {
      const monthStr = String(m).padStart(2, '0');
      const data = monthMap[monthStr];
      if (data && data.recordCount > 0) {
        result.push({
          ...data,
          incomeStr: formatMoney(data.income),
          foodExpenseStr: formatMoney(data.foodExpense),
          majorExpenseStr: formatMoney(data.majorExpense),
          totalExpenseStr: formatMoney(data.totalExpense),
          netStr: formatMoney(data.income - data.totalExpense),
          netClass: (data.income - data.totalExpense) >= 0 ? 'text-success' : 'text-danger'
        });
      }
    }

    return result;
  },

  toggleMonthExpand(e: any) {
    const month = e.currentTarget.dataset.month;
    if (!month) return;
    const expanded = { ...this.data.expandedMonthSet };
    expanded[month] = !expanded[month];
    this.setData({ expandedMonthSet: expanded });
  },

  onSwitchToAllStores() {
    // 🛡️ 与 loadShopList() 同一条权限口径：非超管的 shopList 现在已经不会再包含
    // "全部门店"这一项，这里额外加一道角色校验做防御性冗余
    if (!this.data.canViewAllStoresDropdown) return;
    const shopList = this.data.shopList;
    const allIndex = shopList.indexOf('全部门店');
    if (allIndex !== -1) {
      this.setData({
        selectedShopIndex: allIndex,
        shopName: '全部门店',
        isAllStoresMode: true,
        hasOtherStoreData: false,
        currentStoreTotalCount: 0
      });
      this.calculateStats();
    }
  },

  // 🆕 空状态防呆引导："切回全国总览大屏"——与 onSwitchToAllStores 不同，那个
  // 方法只是把本店切到 getStatisticsData/getReports 口径的"全部门店"聚合视图
  // （仍留在单店风格的 stats-content 里），这里要跳的是真正的 national-dashboard-
  // container 大屏，与 onSuperAdminSelectStore 选中"🌐 全国总览"时完全同一套
  // 状态变更（含刻意不调用 setSelectedStore()——'全国总览'是仅供本页内部判断用
  // 的虚拟聚合项，不能写进其他页面也会读取的全局门店缓存，否则会把"全国总览"
  // 污染成好像是一个真实门店），直接触发 loadNationalDashboard() 拉取全租户聚合数据
  onGoToNationalDashboard() {
    if (!this.data.canViewAllStoresDropdown) return;
    this.setData({
      shopName: '全部门店',
      currentUserStoreName: '🌐 全国总览',
      currentUserStoreId: '',
      isAllStoresMode: true,
      hasOtherStoreData: false,
      statistics: null,
      showNationalDashboard: true
    });
    this.loadNationalDashboard();
  },

  onShowAllStoreRecords() {
    const { shopName } = this.data;

    const now = new Date();
    const startDate = `1970-01-01`;
    const endDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    this.loadStatistics(startDate, endDate);
  },

  // 🆕 引导型空状态「查看有数据月份」：latestDataYear/latestDataMonth 由
  // loadStatistics() 从本店全部历史记录里找出的最近一条记录年月，直接切到
  // 月报 tab 定位过去，不需要用户自己一个个月份试错翻页
  onJumpToLatestDataPeriod() {
    const { latestDataYear, latestDataMonth } = this.data;
    if (!latestDataYear || !latestDataMonth) {
      wx.showToast({ title: '未找到有数据的历史周期', icon: 'none' });
      return;
    }
    this.setData({
      currentTab: 'month',
      selectedYear: latestDataYear,
      selectedMonth: latestDataMonth,
      statistics: null
    });
    this.calculateStats();
    this.fetchStatistics();
  },

  parseAmountFromText(textStr: string): number {
    if (!textStr) return 0;
    const matches = String(textStr).match(/\d+(\.\d+)?/g);
    if (!matches) return 0;
    return matches.reduce((sum, num) => sum + parseFloat(num), 0);
  },

  parseSubExpenseItems(textStr: string, fallbackAmount: number, dateStr: string): any[] {
    if (!textStr || !String(textStr).trim()) {
      if (fallbackAmount > 0) {
        return [{ date: dateStr, title: '专项大额开支', amount: fallbackAmount.toFixed(2) }];
      }
      return [];
    }

    const rawLines = String(textStr)
      .split(/[\r\n;；,，、]+/)
      .map(s => s.trim())
      .filter(Boolean);

    let parsedResults: any[] = [];

    rawLines.forEach(line => {
      const match = line.match(/^([\u4e00-\u9fa5a-zA-Z0-9\(\)\（\）\s]+?)[\s:：等于=]*(\d+(?:\.\d+)?)\s*元?$/);

      if (match) {
        let titleName = match[1].replace(/[\d\s]/g, '').trim();
        let numVal = parseFloat(match[2]);

        if (titleName && !isNaN(numVal) && numVal > 0) {
          parsedResults.push({
            date: dateStr,
            title: titleName,
            amount: numVal.toFixed(2)
          });
        }
      } else {
        const innerRegex = /([\u4e00-\u9fa5a-zA-Z]+)[\s:：]*(\d+(?:\.\d+)?)/g;
        let innerMatch;
        let foundInner = false;
        while ((innerMatch = innerRegex.exec(line)) !== null) {
          let tName = innerMatch[1].trim();
          let nVal = parseFloat(innerMatch[2]);
          if (tName && !isNaN(nVal) && nVal > 0) {
            parsedResults.push({
              date: dateStr,
              title: tName,
              amount: nVal.toFixed(2)
            });
            foundInner = true;
          }
        }
        if (!foundInner && line.length > 0 && fallbackAmount > 0) {
          parsedResults.push({
            date: dateStr,
            title: line,
            amount: fallbackAmount.toFixed(2)
          });
        }
      }
    });

    if (parsedResults.length === 0 && fallbackAmount > 0) {
      parsedResults.push({
        date: dateStr,
        title: String(textStr).trim() || '专项大额开支',
        amount: fallbackAmount.toFixed(2)
      });
    }

    return parsedResults;
  },

  calculateStatistics(records: any[], startDate: string, endDate: string): any {
    const FIXED_EXPENSE_KEYWORDS = ['租金', '房租', '服装', '义工服', '设备', '装修', '采购', '大件', '空调', '冰箱', '冰柜', '桌椅', '改造', '维修', '购置', '大额', '专项'];

    const uniqueMap = new Map();
    records.forEach((item: any) => {
      const dateStr = item.dateString || item.reportDate || item.date || '';
      const storeStr = item.shopName || item.storeName || item.store || 'ALL';
      const key = `${storeStr}_${dateStr}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, item);
      }
    });
    const dedupedRecords = Array.from(uniqueMap.values());

    let statistics = {
      totalIncome: 0,
      totalOtherDonation: 0,
      totalListDonation: 0,
      totalExpense: 0,
      dailyExpenseTotal: 0,
      largeExpenseTotal: 0,
      recordCount: dedupedRecords.length,
      openDays: 0,
      donationDays: 0,
      missingCount: 0,
      netAccumulation: 0,
      avgDailyExpense: 0,
      avgDailyExpenseMA14: 0,
      latestBalance: 0,
      runwayDays: 0,
      runwayDaysRange: '',
      emaDailyCost: '0.00',
      runwayStatusLevel: 'ample' as 'ample' | 'warning' | 'urgent' | 'nodata',
      healthStatus: '' as 'healthy' | 'materialWarning' | 'fundUrgent' | 'fundWarning' | 'preparing' | 'largeExpenseInfo' | 'nodata',
      healthStatusText: '',
      healthStatusColor: '',
      healthIcon: '',
      perMealCost: 0,
      totalDiningCount: 0,
      // 🍱 用餐与服务总人次的堂食/送餐/打包细分：数据源是 report_logs 里
      // dineInSeniors/deliverySeniors/dineInVolunteers/deliveryVolunteers/
      // takeawayCount 这几个字段（首页 recalcDiningStats() 算好后随 diningCount
      // 一并落库，见 dataService.ts saveReport），totalDiningCount 本身已经是
      // 三者之和（同源镜像），这里只是额外拆出细分供卡片展示，不是另一套口径
      totalDineInCount: 0,
      totalDeliveryCount: 0,
      totalTakeawayCount: 0,
      totalVolunteerCount: 0,
      totalVolunteerHours: 0,
      totalDonorCount: 0,
      startDate: startDate,
      endDate: endDate,
      dailyRecords: [] as any[],
      materialsSummary: [] as any[],
      latestRiceStatus: 'normal' as string,
      latestOilStatus: 'sufficient' as string,
      majorExpenseList: [] as any[]
    };

    const validOpenDaysSet = new Set<string>();
    const validDonationDaysSet = new Set<string>();
    const missingCountSet = new Set<string>();

    const materialsMap = new Map<string, { item: string; unit: string; totalQty: number }>();

    const sortedRecords = [...dedupedRecords].sort((a, b) =>
      parseDate(a.dateString).getTime() - parseDate(b.dateString).getTime()
    );

    // 修复"显示全部记录"时的 1970-01-01 问题：动态替换为实际最早记录日期
    if (startDate === '1970-01-01' && sortedRecords.length > 0) {
      const earliest = sortedRecords[0];
      const earliestDateRaw = earliest.dateString || earliest.reportDate || earliest.date || '';
      if (earliestDateRaw) {
        const standardized = toStandardIsoDate(earliestDateRaw);
        if (standardized) {
          statistics.startDate = standardized;
        }
      }
    }

    sortedRecords.forEach((item: any) => {
      const otherDonation = parseFloat(item.otherDonation) || 0;
      const listDonationTotal = parseFloat(item.listDonationTotal) || 0;
      const expenseAmount = parseFloat(item.expenseAmount) || 0;
      const expensesText = item.expenses || '';
      let dailyExpenseText = item.dailyExpenseText || item.dailyIngredientText || '';
      let fixedExpenseText = item.fixedExpenseText || item.fixedMajorText || item.remark || '';

      if (item.reportText) {
        if (!dailyExpenseText) {
          const dailyMatch = item.reportText.match(/开餐支出（食材）：([^\n]+)/);
          if (dailyMatch && dailyMatch[1]) {
            dailyExpenseText = dailyMatch[1].replace(/元$/, '').trim();
          }
        }
        if (!fixedExpenseText) {
          const fixedMatch = item.reportText.match(/专项支出（房租\/设备）：([^\n]+)/);
          if (fixedMatch && fixedMatch[1]) {
            fixedExpenseText = fixedMatch[1].replace(/元$/, '').trim();
          }
        }
      }
      const donorCount = (item.donationItems && Array.isArray(item.donationItems)) ? item.donationItems.length : 0;
      const diningCount = parseFloat(item.diningCount) || 0;

      const volunteerCount = parseFloat(item.volunteerCount) || 0;
      const totalMeals = diningCount + volunteerCount;
      statistics.totalVolunteerHours += parseFloat(item.volunteerHours) || 0;
      statistics.totalDiningCount += diningCount;
      statistics.totalVolunteerCount += volunteerCount;
      statistics.totalDineInCount += (parseFloat(item.dineInSeniors) || 0) + (parseFloat(item.dineInVolunteers) || 0);
      statistics.totalDeliveryCount += (parseFloat(item.deliverySeniors) || 0) + (parseFloat(item.deliveryVolunteers) || 0);
      statistics.totalTakeawayCount += parseFloat(item.takeawayCount) || 0;

      const dailyIncome = otherDonation + listDonationTotal;
      const hasIncome = dailyIncome > 0;
      const hasExpense = expenseAmount > 0;
      const hasDiners = diningCount > 0;

      if (hasDiners && item.dateString) {
        validOpenDaysSet.add(item.dateString);
      } else if (hasIncome && !hasDiners && item.dateString) {
        validDonationDaysSet.add(item.dateString);
        missingCountSet.add(item.dateString);
      } else if (hasExpense && !hasDiners && item.dateString) {
        validOpenDaysSet.add(item.dateString);
      }

      if (item.materials && Array.isArray(item.materials) && item.materials.length > 0) {
        item.materials.forEach((m: any) => {
          const key = `${m.item}_${m.unit || ''}`;
          const qty = parseFloat(m.quantity) || 0;
          if (materialsMap.has(key)) {
            const existing = materialsMap.get(key)!;
            existing.totalQty += qty;
          } else {
            materialsMap.set(key, {
              item: m.item || '未知物资',
              unit: m.unit || '',
              totalQty: qty
            });
          }
        });
      }

      let dailyExpense = parseFloat(item.dailyExpenseTotal) || 0;
      let fixedExpense = parseFloat(item.fixedExpenseTotal) || 0;

      if (dailyExpense === 0 && dailyExpenseText) {
        dailyExpense = this.parseAmountFromText(dailyExpenseText);
      }

      if (fixedExpense === 0 && fixedExpenseText) {
        fixedExpense = this.parseAmountFromText(fixedExpenseText);
      }

      const totalItemExpense = expenseAmount;
      if (dailyExpense === 0 && fixedExpense === 0 && totalItemExpense > 0) {
        const textContext = fixedExpenseText || expensesText || item.remark || '';
        const hasFixedKeyword = FIXED_EXPENSE_KEYWORDS.some(kw => textContext.includes(kw));
        if (hasFixedKeyword) {
          fixedExpense = totalItemExpense;
        } else {
          dailyExpense = totalItemExpense;
        }
      }

      statistics.totalOtherDonation += otherDonation;
      statistics.totalListDonation += listDonationTotal;
      statistics.totalExpense += expenseAmount;
      statistics.dailyExpenseTotal += dailyExpense;
      statistics.largeExpenseTotal += fixedExpense;
      statistics.totalDonorCount += donorCount;

      if (fixedExpense > 0 || (fixedExpenseText && fixedExpenseText.trim() !== '') || (item.majorExpenseItems && item.majorExpenseItems.length > 0)) {
        const fallbackAmt = fixedExpense > 0 ? fixedExpense : totalItemExpense;
        let subItems: any[] = [];

        const recordId = item._id || item.id;
        const dateStr = item.dateString || '近期';

        if (item.majorExpenseItems && item.majorExpenseItems.length > 0) {
          subItems = item.majorExpenseItems.map((mi: any) => ({
            recordId: recordId,
            date: mi.date || dateStr,
            title: mi.title || mi.name || mi.detailText || '专项大额开支',
            amount: mi.amount ? String(mi.amount) : '0.00',
            isMissingRemark: false
          }));
        } else {
          const genericTexts = ['专项大额开支', '大额支出', '专项支出'];
          const isGeneric = fixedExpenseText && genericTexts.includes(fixedExpenseText.trim());

          if (!fixedExpenseText || fixedExpenseText.trim() === '' || isGeneric) {
            subItems.push({
              recordId: recordId,
              date: dateStr,
              title: '专项大额开支',
              amount: fallbackAmt.toFixed(2),
              isMissingRemark: true
            });
          } else {
            subItems = this.parseSubExpenseItems(fixedExpenseText || '', fallbackAmt, dateStr);
            subItems.forEach(s => {
              s.recordId = recordId;
              s.isMissingRemark = false;
            });
          }
        }

        subItems.forEach((sub: any) => {
          statistics.majorExpenseList.push({
            recordId: sub.recordId,
            date: sub.date,
            storeName: item.shopName || '',
            detailText: sub.title,
            amount: sub.amount,
            isMissingRemark: sub.isMissingRemark || false
          });
        });
      }

      const todayBalance = parseFloat(item.todayBalance) || 0;
      statistics.latestBalance = todayBalance;

      if (item.stapleRiceStatus) {
        statistics.latestRiceStatus = item.stapleRiceStatus;
      }
      if (item.stapleOilStatus) {
        statistics.latestOilStatus = item.stapleOilStatus;
      }

      const netChange = dailyIncome - expenseAmount;
      
      const materials = item.materials || [];
      const hasMaterials = Array.isArray(materials) && materials.length > 0;
      const materialsSummary = hasMaterials 
        ? materials.map((m: any) => `${m.item || '物资'} ${m.quantity || ''}${m.unit || ''}`).join('、')
        : '';

      let statusTag = 'donation';
      let statusLabel = '服务汇入';

      if (hasDiners || (hasExpense && !hasIncome)) {
        statusTag = 'meal';
        statusLabel = '正常开餐';
      } else if (hasIncome && !hasDiners) {
        statusTag = 'donation';
        statusLabel = '服务汇入';
      }

      statistics.dailyRecords.push({
        _id: item._id,
        _localId: item._localId,
        date: item.dateString,
        shopName: item.shopName,
        otherDonation: otherDonation,
        listDonation: listDonationTotal,
        expense: expenseAmount,
        dailyExpense: dailyExpense,
        largeExpense: fixedExpense,
        income: dailyIncome,
        balance: todayBalance,
        donorCount: donorCount,
        diningCount: diningCount,
        volunteerCount: volunteerCount,
        perMealCost: (totalMeals > 0 && dailyExpense > 0)
          ? Math.round((dailyExpense / totalMeals) * 100) / 100
          : 0,
        netChange: netChange,
        hasMaterials: hasMaterials,
        materialsSummary: materialsSummary,
        statusTag,
        statusLabel
      });
    });

    statistics.totalIncome = statistics.totalOtherDonation + statistics.totalListDonation;
    statistics.netAccumulation = statistics.totalIncome - statistics.totalExpense;
    statistics.openDays = validOpenDaysSet.size;
    statistics.donationDays = validDonationDaysSet.size;
    statistics.missingCount = missingCountSet.size;

    const days = records.length > 0 ? records.length : 1;
    statistics.avgDailyExpense = Math.round((statistics.dailyExpenseTotal / days) * 100) / 100;

    const endDateObj = parseDate(endDate);
    const ma14Start = new Date(endDateObj);
    ma14Start.setDate(endDateObj.getDate() - 13);
    const ma14StartStr = formatDate(ma14Start);

    const last14DaysRecords = sortedRecords.filter(r => r.dateString >= ma14StartStr && r.dateString <= endDate);
    const ma14Days = last14DaysRecords.length;
    if (ma14Days > 0) {
      const ma14ExpenseTotal = last14DaysRecords.reduce((sum: number, r: any) => {
        let daily = parseFloat(r.dailyExpenseTotal) || 0;
        if (daily === 0 && r.dailyExpenseText) {
          daily = this.parseAmountFromText(r.dailyExpenseText);
        }
        return sum + daily;
      }, 0);
      statistics.avgDailyExpenseMA14 = Math.round((ma14ExpenseTotal / ma14Days) * 100) / 100;
    } else {
      statistics.avgDailyExpenseMA14 = statistics.avgDailyExpense;
    }

    const runwayResult: RunwayResult = calculateEmaRunway(sortedRecords, statistics.latestBalance);
    statistics.runwayDays = runwayResult.runwayDays;
    statistics.emaDailyCost = runwayResult.emaDailyCost;
    statistics.runwayStatusLevel = runwayResult.statusLevel;

    if (runwayResult.runwayDays >= 999) {
      statistics.runwayDaysRange = '资金充裕，持续开餐';
    } else {
      statistics.runwayDaysRange = runwayResult.statusText.replace(/^[🟢🟡🔴⚪]\s/, '').replace(/^资金/, '').replace(/^预警：/, '').replace(/^告急：/, '');
    }

    const totalMeals = statistics.totalDiningCount + statistics.totalVolunteerCount;
    if (totalMeals > 0 && statistics.dailyExpenseTotal > 0) {
      statistics.perMealCost = Math.round((statistics.dailyExpenseTotal / totalMeals) * 100) / 100;
    } else {
      statistics.perMealCost = 0;
    }

    const isRiceUrgent = statistics.latestRiceStatus === 'urgent';
    const isOilUrgent = statistics.latestOilStatus === 'urgent';
    const isNetNegative = statistics.netAccumulation < 0;

    if (runwayResult.statusLevel === 'nodata') {
      // 🐛 "告急(0天)"误报修复：门店尚未提交任何记账数据，展示中性灰色提示，
      // 不套用红色告急/绿色健康的强烈色彩，避免无中生有制造焦虑或过早报平安
      statistics.healthStatus = 'nodata';
      statistics.healthStatusText = '⚪ 暂无记账数据，运行状况建设中';
      statistics.healthStatusColor = '#9E9E9E';
      statistics.healthIcon = '⚪';
    } else if (runwayResult.statusLevel === 'urgent' && statistics.runwayDays < 999) {
      statistics.healthStatus = 'fundUrgent';
      statistics.healthStatusText = runwayResult.statusText;
      statistics.healthStatusColor = '#E53935';
      statistics.healthIcon = '🔴';
    } else if (runwayResult.statusLevel === 'warning' && statistics.runwayDays < 999) {
      statistics.healthStatus = 'fundWarning';
      statistics.healthStatusText = runwayResult.statusText;
      statistics.healthStatusColor = '#F59E0B';
      statistics.healthIcon = '🟡';
    } else if (statistics.dailyExpenseTotal === 0 && statistics.largeExpenseTotal > 0 && statistics.netAccumulation < 0) {
      // 筹备期/休餐期：仅有固定资产或房租投入，无日常开餐食材支出
      statistics.healthStatus = 'preparing';
      statistics.healthStatusText = `💡 本期包含筹备/固定资产投入 ¥${formatMoney(statistics.largeExpenseTotal)}，当前结余 ¥${formatMoney(statistics.latestBalance)}，运转正常`;
      statistics.healthStatusColor = '#F5A623';
      statistics.healthIcon = '💡';
    } else if (isNetNegative) {
      // 真实运营赤字：余额较低才警告，大额房租但余额充足时降级
      if (statistics.latestBalance < 500) {
        statistics.healthStatus = 'fundUrgent';
        statistics.healthStatusText = `⚠️ 账户结余较低 (¥${formatMoney(statistics.latestBalance)})，请留意后续服务资金筹备`;
        statistics.healthStatusColor = '#E53935';
        statistics.healthIcon = '🔴';
      } else if (statistics.largeExpenseTotal > 0) {
        statistics.healthStatus = 'largeExpenseInfo';
        statistics.healthStatusText = `💡 本期包含房租/专项大额支出 ¥${formatMoney(statistics.largeExpenseTotal)}，账户结余仍可支撑`;
        statistics.healthStatusColor = '#F5A623';
        statistics.healthIcon = '💡';
      } else {
        statistics.healthStatus = 'fundUrgent';
        statistics.healthStatusText = '⚠️ 本期支出大于服务汇入，请留意资金筹备';
        statistics.healthStatusColor = '#E53935';
        statistics.healthIcon = '🔴';
      }
    } else if (isRiceUrgent || isOilUrgent) {
      const urgentItems = [];
      if (isRiceUrgent) urgentItems.push('大米');
      if (isOilUrgent) urgentItems.push('食用油');
      statistics.healthStatus = 'materialWarning';
      statistics.healthStatusText = `资金充裕，但${urgentItems.join('/')}储备告急，期待物资接力`;
      statistics.healthStatusColor = '#FF9800';
      statistics.healthIcon = '🟡';
    } else {
      statistics.healthStatus = 'healthy';
      statistics.healthStatusText = '服务资金与物资充足，平稳运行中';
      statistics.healthStatusColor = '#4CAF50';
      statistics.healthIcon = '🟢';
    }

    statistics.materialsSummary = Array.from(materialsMap.values()).map(m => ({
      item: m.item,
      unit: m.unit,
      totalQty: Number.isInteger(m.totalQty) ? m.totalQty : Math.round(m.totalQty * 10) / 10
    }));

    statistics.dailyRecords.sort((a, b) => {
      return parseDate(b.date).getTime() - parseDate(a.date).getTime();
    });

    return statistics;
  },

  // 🌟「先核对、再确认、后导出」安全闭环：点击「导出表格」不再直接生成文件，
  // 而是先用 previewOnly 调一次 exportAccountExcel 取回同一份 date range 解析出
  // 的明细/汇总供用户核对，确认无误后才在 onExportPreviewConfirm 里发起真正的
  // 导出调用——保证「核对的」与「导出的」严格是同一份数据
  buildExportCallData() {
    const { shopName, selectedYear, selectedMonth, currentTab, customStartDate, customEndDate } = this.data;
    return {
      shopName: shopName || 'default',
      tabType: currentTab,
      selectedYear: String(selectedYear),
      selectedMonth: String(selectedMonth).padStart(2, '0'),
      startDate: customStartDate,
      endDate: customEndDate
    };
  },

  // 🛡️ 防抖：两个入口（tool-btn export / btn-export-shortcut）都可能绑同一个
  // exportToExcel，双击/连点会并发打出两个 previewOnly 云函数请求，晚到的结果
  // 覆盖先到的没什么害处，但重复请求本身是浪费，且与 onRefreshData 同款
  // wx.showLoading 全局单例问题——先加个守卫
  async exportToExcel() {
    if (this.data.isExportPreviewLoading) return;

    const { statistics } = this.data;

    if (!statistics || !statistics.dailyRecords || statistics.dailyRecords.length === 0) {
      wx.showToast({ title: '当前周期无明细可导出', icon: 'none' });
      return;
    }

    // 🔐 Excel 批量导出为专业版专属功能：这是纯前端拦截——exportAccountExcel
    // 云函数本身没有加同款服务端硬校验，因为 performExcelExport 云调用失败时
    // 会自动降级走本地 CSV（exportLocalCSV），如果只在云函数里拒绝会被这条
    // 降级路径悄悄绕过，要彻底堵住还需要额外区分"云端主动拒绝"与"云端故障"
    // 两种失败、且让降级逻辑认识这个新错误码——这部分改动本次不做，此处的前端
    // 拦截是当前唯一的把关点
    const permission = await checkTenantPermission(FEATURE_KEYS.EXCEL_EXPORT);
    if (!permission.allowed) {
      this.onOpenPlanUpgradeModal();
      return;
    }

    this.setData({ isExportPreviewLoading: true });
    wx.showLoading({ title: '正在核对数据...', mask: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'exportAccountExcel',
        data: { ...this.buildExportCallData(), previewOnly: true }
      });
      const result = (res.result || {}) as any;
      wx.hideLoading();

      if (result.success) {
        this.setData({
          showExportPreviewModal: true,
          exportPreviewSummary: result.summary || {},
          exportPreviewRecords: result.records || []
        });
      } else {
        wx.showToast({ title: result.errMsg || '核对数据加载失败，请重试', icon: 'none' });
      }
    } catch (err: any) {
      wx.hideLoading();
      console.error('[exportToExcel] 核对数据加载失败:', err);
      wx.showToast({ title: '核对数据加载失败，请重试', icon: 'none' });
    } finally {
      this.setData({ isExportPreviewLoading: false });
    }
  },

  onCloseExportPreviewModal() {
    this.setData({ showExportPreviewModal: false });
  },

  // 「发现异常，前去处理」：关闭预览弹窗，跳转账本页核实/处理
  onExportPreviewGoFix() {
    this.setData({ showExportPreviewModal: false });
    wx.navigateTo({ url: '/pages/history/history' });
  },

  // 「数据无误，确认并导出」：关闭预览弹窗，发起真正的 xlsx 生成
  async onExportPreviewConfirm() {
    this.setData({ showExportPreviewModal: false });
    await this.performExcelExport();
  },

  async performExcelExport() {
    wx.showLoading({ title: '正在生成 Excel 表格...', mask: true });

    try {
      // 优先使用云函数生成带样式的 xlsx
      const res = await wx.cloud.callFunction({
        name: 'exportAccountExcel',
        data: this.buildExportCallData()
      });

      const result = (res.result || {}) as any;

      if (result.success && result.tempFileURL) {
        wx.hideLoading();
        this.downloadAndOpenExcel(result.tempFileURL, result.fileName || '收支明细.xlsx');
      } else {
        throw new Error(result.errMsg || '云函数导出失败');
      }
    } catch (cloudErr: any) {
      console.warn('[Export] 云函数导出失败，降级为本地 CSV:', cloudErr.errMsg || cloudErr.message);
      // 降级：本地生成 CSV
      this.exportLocalCSV();
    }
  },

  downloadAndOpenExcel(tempFileURL: string, fileName: string) {
    wx.showLoading({ title: '正在下载表格...', mask: true });

    wx.downloadFile({
      url: tempFileURL,
      success: (downloadRes) => {
        wx.hideLoading();
        const filePath = downloadRes.tempFilePath;

        // 优先使用 shareFileMessage 发送给文件
        if (wx.shareFileMessage) {
          wx.shareFileMessage({
            filePath: filePath,
            fileName: fileName,
            success: () => {
              wx.showToast({ title: '表格已导出成功', icon: 'success' });
            },
            fail: (shareErr) => {
              if (!shareErr.errMsg || !shareErr.errMsg.includes('cancel')) {
                wx.openDocument({
                  filePath: filePath,
                  fileType: 'xlsx',
                  showMenu: true,
                  fail: () => {
                    wx.showModal({
                      title: '已生成表格文件',
                      content: '请重新点击"导出表格"，在微信列表中选择【文件传输助手】保存到手机即可查看！',
                      showCancel: false
                    });
                  }
                });
              }
            }
          });
        } else {
          wx.openDocument({
            filePath: filePath,
            fileType: 'xlsx',
            showMenu: true,
            fail: () => {
              wx.showToast({ title: '打开失败，请重试', icon: 'none' });
            }
          });
        }
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '下载失败，请重试', icon: 'none' });
      }
    });
  },

  exportLocalCSV() {
    const { statistics, shopName, selectedYear, selectedMonth, currentTab } = this.data;
    if (!statistics) return;

    wx.showLoading({ title: '正在生成表格...', mask: true });

    try {
      const csvContent = '\ufeff' + this.buildCSV(statistics.dailyRecords, shopName || '全部门店');
      const fs = wx.getFileSystemManager();

      let periodLabel = '';
      if (currentTab === 'week') {
        periodLabel = `${selectedYear}年${selectedMonth}月周报`;
      } else if (currentTab === 'month') {
        periodLabel = `${selectedYear}年${selectedMonth}月`;
      } else if (currentTab === 'year') {
        periodLabel = `${selectedYear}年度`;
      } else {
        periodLabel = '自定义周期';
      }

      const safeStoreName = String(shopName || '全部门店').replace(/[\\/:*?"<>|]/g, '');
      const fileName = `${safeStoreName}_收支明细_${periodLabel}.csv`;
      const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`;

      fs.writeFileSync(filePath, csvContent, 'utf8');
      wx.hideLoading();

      if (wx.shareFileMessage) {
        wx.shareFileMessage({
          filePath: filePath,
          fileName: fileName,
          success: () => {
            wx.showToast({ title: '表格已成功导出并发送！', icon: 'success' });
          },
          fail: (err) => {
            if (!err.errMsg || !err.errMsg.includes('cancel')) {
              this.tryOpenDocumentFallback(filePath);
            }
          }
        });
      } else {
        this.tryOpenDocumentFallback(filePath);
      }
    } catch (error) {
      wx.hideLoading();
      console.error('[Export] CSV 导出失败:', error);
      wx.showToast({ title: '导出失败，请重试', icon: 'none' });
    }
  },

  // 降级预览方案（当 shareFileMessage 不可用时回退）
  tryOpenDocumentFallback(filePath: string) {
    wx.openDocument({
      filePath: filePath,
      fileType: 'csv',
      showMenu: true,
      fail: () => {
        wx.showModal({
          title: '已准备好表格文件',
          content: '请重新点击"导出表格"，并在弹出的微信列表中选择【文件传输助手】即可保存到手机！',
          showCancel: false
        });
      }
    });
  },

  fallbackCopyToClipboard(csvText: string) {
    wx.setClipboardData({
      data: csvText,
      success: () => {
        wx.showModal({
          title: '已复制表格文本',
          content: '手机端无法直接写本地文件，已将 CSV 表格内容复制到剪贴板，您可以直接粘贴到微信聊天框或 Excel 中！',
          showCancel: false
        });
      }
    });
  },

  // ========== 🌟 超管专属：全国运营/财务报表 CSV 导出 ==========

  onOpenNationalReportModal() {
    if (!this.data.isAdmin) return;
    this.setData({ showNationalReportModal: true });
  },

  onCloseNationalReportModal() {
    if (this.data.generatingNationalReport) return;
    this.setData({ showNationalReportModal: false });
  },

  onToggleReportSelection(e: any) {
    const key = e.currentTarget.dataset.key as 'operations' | 'financeAudit';
    this.setData({ [`nationalReportSelection.${key}`]: !this.data.nationalReportSelection[key] });
  },

  // 《全国门店运营汇总表》：服务人次/开餐天数/单餐成本/续航与离线预警，取自已加载的 nationalMatrixList
  buildNationalOperationsCSV(): string {
    let csv = '门店名称,城市,服务人次,开餐天数,单餐成本,续航预警,是否离线,最近记账日期\n';
    (this.data.nationalMatrixList || []).forEach((s: any) => {
      const name = String(s.storeName || '').replace(/"/g, '""');
      const city = String(s.city || '未知').replace(/"/g, '""');
      const costPerMeal = s.isCostRestricted ? '***' : (s.costPerMealStr || '');
      const isOfflineText = s.isOffline === undefined ? '' : (s.isOffline ? '是' : '否');
      csv += `"${name}","${city}",${s.totalDiners || 0},${s.openDays || 0},"${costPerMeal}","${s.statusText || ''}","${isOfflineText}","${s.lastReportDate || ''}"\n`;
    });
    return csv;
  },

  // 《全国财务与凭证审计表》：收支/结余 + 凭证合规率，凭证合规率为超管专属字段（普通角色恒为空）
  buildNationalFinanceAuditCSV(): string {
    let csv = '门店名称,服务汇入(元),开餐总支出(元),食材支出(元),账户结余(元),凭证合规率\n';
    (this.data.nationalMatrixList || []).forEach((s: any) => {
      const name = String(s.storeName || '').replace(/"/g, '""');
      const complianceText = (s.receiptComplianceRate === null || s.receiptComplianceRate === undefined)
        ? ''
        : `${s.receiptComplianceRate}%`;
      csv += `"${name}",${s.totalIncome || 0},${s.totalExpense || 0},${s.ingredientExpense || 0},${s.latestBalance || 0},"${complianceText}"\n`;
    });

    const insights = this.data.superAdminInsights;
    if (insights) {
      csv += `\n全国汇总（${insights.rangeLabel || ''}）\n`;
      csv += `全国平均单餐成本(元),${insights.avgCostPerMealStr || '—'}\n`;
      csv += `全国凭证合规率,${insights.complianceRate === null ? '' : insights.complianceRate + '%'}\n`;
      csv += `超过${insights.offlineAlertThresholdDays}天未记账门店数,${insights.offlineStoreCount}\n`;
    }
    return csv;
  },

  buildSelectedNationalReportCSV(): { csv: string; label: string } | null {
    const { operations, financeAudit } = this.data.nationalReportSelection;
    if (!operations && !financeAudit) return null;

    const parts: string[] = [];
    const labels: string[] = [];
    if (operations) {
      parts.push('《全国门店运营汇总表》\n' + this.buildNationalOperationsCSV());
      labels.push('运营汇总表');
    }
    if (financeAudit) {
      parts.push('《全国财务与凭证审计表》\n' + this.buildNationalFinanceAuditCSV());
      labels.push('财务审计表');
    }
    return { csv: parts.join('\n\n'), label: labels.join('+') };
  },

  onCopyNationalReport() {
    if (!this.data.isAdmin) return;
    const built = this.buildSelectedNationalReportCSV();
    if (!built) {
      wx.showToast({ title: '请至少勾选一种报表', icon: 'none' });
      return;
    }
    this.fallbackCopyToClipboard(built.csv);
  },

  onExportNationalReport() {
    if (!this.data.isAdmin) return;
    const built = this.buildSelectedNationalReportCSV();
    if (!built) {
      wx.showToast({ title: '请至少勾选一种报表', icon: 'none' });
      return;
    }

    this.setData({ generatingNationalReport: true });
    wx.showLoading({ title: '正在生成表格...', mask: true });

    try {
      const csvContent = '﻿' + built.csv;
      const fs = wx.getFileSystemManager();
      const rangeLabel = (this.data.superAdminInsights && this.data.superAdminInsights.rangeLabel) || '全部时间';
      const fileName = `全国${built.label}_${rangeLabel}.csv`;
      const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`;

      fs.writeFileSync(filePath, csvContent, 'utf8');
      wx.hideLoading();
      this.setData({ generatingNationalReport: false, showNationalReportModal: false });

      if (wx.shareFileMessage) {
        wx.shareFileMessage({
          filePath: filePath,
          fileName: fileName,
          success: () => {
            wx.showToast({ title: '报表已成功导出并发送！', icon: 'success' });
          },
          fail: (err) => {
            if (!err.errMsg || !err.errMsg.includes('cancel')) {
              this.tryOpenDocumentFallback(filePath);
            }
          }
        });
      } else {
        this.tryOpenDocumentFallback(filePath);
      }
    } catch (error) {
      wx.hideLoading();
      this.setData({ generatingNationalReport: false });
      console.error('[NationalReport] CSV 导出失败:', error);
      wx.showToast({ title: '导出失败，请重试', icon: 'none' });
    }
  },

  async onGenerateGratitudeReport() {
    const { statistics, shopName, selectedYear, selectedMonth, currentTab } = this.data;
    if (!statistics) {
      wx.showToast({ title: '暂无数据', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在生成汇报卡片...', mask: true });

    let periodText = '';
    if (currentTab === 'week') {
      periodText = `${selectedYear}年${selectedMonth}月 第${Math.ceil(new Date().getDate() / 7)}周`;
    } else if (currentTab === 'month') {
      periodText = `${selectedYear}年${selectedMonth}月`;
    } else if (currentTab === 'year') {
      periodText = `${selectedYear}年度`;
    } else {
      periodText = `${statistics.startDate} ~ ${statistics.endDate}`;
    }

    const statsData: GratitudeReportData = {
      periodTitle: periodText,
      storeName: shopName || '海沧区雨花斋',
      diningDays: statistics.openDays || 0,
      incomeDays: statistics.donationDays || 0,
      totalDiners: statistics.totalDiningCount || 0,
      volunteerCount: statistics.totalVolunteerCount || 0,
      volunteerHours: statistics.totalVolunteerHours || 0,
      totalIncome: parseFloat(statistics.totalIncomeStr) || 0,
      totalExpense: parseFloat(statistics.totalExpenseStr) || 0,
      dailyFoodExpense: parseFloat(statistics.dailyExpenseTotalStr) || 0,
      totalBalance: parseFloat(statistics.latestBalanceStr) || 0,
      estimatedDays: statistics.runwayDaysStr || '—',
      riceStatus: statistics.riceStatusText || '一般',
      oilStatus: statistics.oilStatusText || '充足'
    };

    const reportText = formatGratitudeReportText(statsData);
    const isPreparing = statsData.diningDays === 0 && statsData.totalIncome > 0;

    const incomeStr = (statsData.totalIncome || 0).toFixed(2);
    const expenseStr = (statsData.totalExpense || 0).toFixed(2);
    const balanceStr = (statsData.totalBalance || 0).toFixed(2);

    this.setData({ 
      gratitudeReportText: reportText, 
      showGratitudeModal: true,
      gratitudeReportData: statsData,
      gratitudeIncomeStr: incomeStr,
      gratitudeExpenseStr: expenseStr,
      gratitudeBalanceStr: balanceStr,
      gratitudeTempFilePath: '',
      isPreparingPhase: isPreparing
    });

    wx.hideLoading();

    // 同时复制纯文本到剪贴板，方便直接粘贴到微信群
    wx.setClipboardData({
      data: reportText,
      success: () => {
        wx.showToast({ title: '汇报文案已复制', icon: 'success' });
      },
      fail: () => {
        console.warn('[onGenerateGratitudeReport] 剪贴板复制失败');
      }
    });

    setTimeout(() => {
      this.drawGratitudeCanvasCard(statsData);
    }, 300);
  },

  onCopyGratitudeText() {
    const reportText = this.data.gratitudeReportText;
    if (!reportText) return;
    wx.setClipboardData({
      data: reportText,
      success: () => {
        wx.showToast({ title: '文案已复制', icon: 'success' });
      }
    });
  },

  drawGratitudeCanvasCard(data: GratitudeReportData) {
    const query = wx.createSelectorQuery();
    query.select('#gratitudeReportCanvas')
      .fields({ node: true, size: true })
      .exec((res: any) => {
        if (!res[0] || !res[0].node) {
          console.warn('Canvas 节点未找到');
          return;
        }

        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2;

        const w = 320;
        const h = 605;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);

        const drawRoundRect = (x: number, y: number, rw: number, rh: number, r: number, fill: boolean, stroke: boolean) => {
          ctx.beginPath();
          ctx.moveTo(x + r, y);
          ctx.lineTo(x + rw - r, y);
          ctx.arc(x + rw - r, y + r, r, -Math.PI / 2, 0);
          ctx.lineTo(x + rw, y + rh - r);
          ctx.arc(x + rw - r, y + rh - r, r, 0, Math.PI / 2);
          ctx.lineTo(x + r, y + rh);
          ctx.arc(x + r, y + rh - r, r, Math.PI / 2, Math.PI);
          ctx.lineTo(x, y + r);
          ctx.arc(x + r, y + r, r, Math.PI, -Math.PI / 2);
          ctx.closePath();
          if (fill) ctx.fill();
          if (stroke) ctx.stroke();
        };

        ctx.fillStyle = '#FBF9F5';
        ctx.fillRect(0, 0, w, h);

        ctx.fillStyle = '#8C1D18';
        ctx.fillRect(0, 0, w, 70);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 18px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('❤️ 雨花斋感恩汇报', w / 2, 42);

        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#F0E6D2';
        ctx.lineWidth = 2;
        drawRoundRect(16, 86, w - 32, h - 102, 16, true, true);

        ctx.fillStyle = '#8C1D18';
        ctx.font = 'bold 18px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('吃素一日 健康一天', w / 2, 125);

        ctx.fillStyle = '#8C7355';
        ctx.font = '12px sans-serif';
        ctx.fillText(`📍 ${data.storeName} · ${data.periodTitle}`, w / 2, 148);

        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#E8DCC4';
        ctx.lineWidth = 1;
        ctx.moveTo(32, 165);
        ctx.lineTo(w - 32, 165);
        ctx.stroke();
        ctx.setLineDash([]);

        const isPreparing = data.diningDays === 0 && data.totalIncome > 0;
        let badgeY = 180;
        if (isPreparing) {
          ctx.fillStyle = '#FFF8EE';
          ctx.strokeStyle = '#FFE0B2';
          ctx.lineWidth = 1;
          drawRoundRect(32, badgeY, w - 64, 36, 18, true, true);
          ctx.fillStyle = '#D32F2F';
          ctx.font = 'bold 12px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('🌱 试运营统筹阶段 · 资金与场地筹备中', w / 2, badgeY + 23);
        } else {
          ctx.fillStyle = '#E8F5E9';
          ctx.strokeStyle = '#C8E6C9';
          ctx.lineWidth = 1;
          drawRoundRect(32, badgeY, w - 64, 36, 18, true, true);
          ctx.fillStyle = '#2E7D32';
          ctx.font = 'bold 12px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('✨ 顺利开餐运营中 · 温暖爱心传递', w / 2, badgeY + 23);
        }

        const sectionStartY = badgeY + 50;
        ctx.fillStyle = '#8C1D18';
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('🧡 爱心护持成果', 32, sectionStartY);

        const gridStartY = sectionStartY + 20;
        const gridW = (w - 64) / 2 - 4;
        const gridH = 60;
        const gridGap = 8;

        const drawGridItem = (x: number, y: number, label: string, value: string, highlight: boolean = false) => {
          ctx.fillStyle = '#FFFDF8';
          ctx.strokeStyle = '#F2E9D8';
          ctx.lineWidth = 1;
          drawRoundRect(x, y, gridW, gridH, 8, true, true);

          ctx.fillStyle = '#888888';
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(label, x + gridW / 2, y + 18);

          ctx.fillStyle = highlight ? '#8C1D18' : '#333333';
          ctx.font = 'bold 14px sans-serif';
          ctx.fillText(value, x + gridW / 2, y + 42);
        };

        const diningDaysText = data.diningDays > 0 ? data.diningDays + ' 天' : '筹备期';
        drawGridItem(32, gridStartY, '累计开餐', diningDaysText);
        drawGridItem(32 + gridW + gridGap, gridStartY, '服务用餐', data.totalDiners + ' 人次', true);
        drawGridItem(32, gridStartY + gridH + gridGap, '义工护持', data.volunteerCount + ' 人次');
        drawGridItem(32 + gridW + gridGap, gridStartY + gridH + gridGap, '无偿工时', data.volunteerHours + ' 小时');

        const financeStartY = gridStartY + gridH * 2 + gridGap * 3;
        ctx.fillStyle = '#8C1D18';
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('💰 收支透明账本', 32, financeStartY);

        const financeBoxY = financeStartY + 16;
        ctx.fillStyle = '#FFFDF8';
        ctx.strokeStyle = '#F2E9D8';
        ctx.lineWidth = 1;
        drawRoundRect(32, financeBoxY, w - 64, 90, 10, true, true);

        ctx.font = '12px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#666666';
        ctx.fillText('服务汇入：', 48, financeBoxY + 24);
        ctx.fillStyle = '#2E7D32';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('+¥' + (data.totalIncome || 0).toFixed(2), w - 48, financeBoxY + 24);

        ctx.fillStyle = '#666666';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('运营支出：', 48, financeBoxY + 48);
        ctx.fillStyle = '#C62828';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('-¥' + (data.totalExpense || 0).toFixed(2), w - 48, financeBoxY + 48);

        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#E0D5C1';
        ctx.lineWidth = 1;
        ctx.moveTo(48, financeBoxY + 62);
        ctx.lineTo(w - 48, financeBoxY + 62);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#333333';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('账户实时总结余：', 48, financeBoxY + 82);
        ctx.fillStyle = '#8C1D18';
        ctx.font = 'bold 16px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('¥' + (data.totalBalance || 0).toFixed(2), w - 48, financeBoxY + 82);

        const materialStartY = financeBoxY + 110;
        ctx.fillStyle = '#FFFDF8';
        drawRoundRect(32, materialStartY, w - 64, 36, 8, true, false);
        ctx.fillStyle = '#666666';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('📦 主食物资：', 44, materialStartY + 24);

        const drawTag = (x: number, text: string, urgent: boolean) => {
          const tagW = ctx.measureText(text).width + 24;
          ctx.fillStyle = urgent ? '#FFEBEE' : '#F5F5F5';
          drawRoundRect(x, materialStartY + 6, tagW, 24, 12, true, false);
          ctx.fillStyle = urgent ? '#C62828' : '#666666';
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(text, x + tagW / 2, materialStartY + 21);
          return x + tagW + 8;
        };

        let tagX = 110;
        tagX = drawTag(tagX, '大米 [' + data.riceStatus + ']', data.riceStatus === '告急');
        drawTag(tagX, '食用油 [' + data.oilStatus + ']', data.oilStatus === '告急');

        const footerStartY = materialStartY + 50;
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#E8DCC4';
        ctx.lineWidth = 1;
        ctx.moveTo(32, footerStartY);
        ctx.lineTo(w - 32, footerStartY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#8C7355';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('感恩各位爱心人士护持与义工团队无私付出！', w / 2, footerStartY + 28);

        ctx.fillStyle = '#ADB5BD';
        ctx.font = '10px sans-serif';
        ctx.fillText('透明账本 · 实时可查', w / 2, footerStartY + 46);

        ctx.fillStyle = '#C4C4C4';
        ctx.font = '9px sans-serif';
        ctx.fillText('本平台仅用于爱心餐报与志愿服务记录，不直接面向公众发起公开募捐', w / 2, footerStartY + 64);

        wx.canvasToTempFilePath({
          canvas,
          success: (res: any) => {
            this.setData({ gratitudeTempFilePath: res.tempFilePath });
          },
          fail: () => {
            console.warn('Canvas 导出图片失败');
          }
        });
      });
  },

  onSaveGratitudeCardToAlbum() {
    const path = this.data.gratitudeTempFilePath;
    if (!path) {
      wx.showLoading({ title: '卡片生成中...', mask: true });
      this.drawGratitudeCanvasCard(this.data.gratitudeReportData);
      setTimeout(() => {
        wx.hideLoading();
        if (this.data.gratitudeTempFilePath) {
          this.onSaveGratitudeCardToAlbum();
        } else {
          wx.showToast({ title: '卡片生成失败，请重试', icon: 'none' });
        }
      }, 1500);
      return;
    }

    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: () => {
        wx.showToast({ title: '感恩卡片已保存至相册！', icon: 'success' });
        this.setData({ showGratitudeModal: false });
      },
      fail: (err: any) => {
        if (err.errMsg && err.errMsg.includes('auth deny')) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中允许小程序保存图片到相册',
            success: (r: any) => { if (r.confirm) wx.openSetting(); }
          });
        }
      }
    });
  },

  onForwardGratitudeToWeChat() {
    const path = this.data.gratitudeTempFilePath;
    const reportText = this.data.gratitudeReportText;
    const storeName = this.data.shopName || '雨花斋';

    if (!path) {
      wx.showLoading({ title: '卡片生成中...', mask: true });
      this.drawGratitudeCanvasCard(this.data.gratitudeReportData);
      setTimeout(() => {
        wx.hideLoading();
        if (this.data.gratitudeTempFilePath) {
          this.onForwardGratitudeToWeChat();
        } else {
          wx.showToast({ title: '卡片生成失败，请重试', icon: 'none' });
        }
      }, 1500);
      return;
    }

    if (wx.showShareImageMenu) {
      wx.showShareImageMenu({
        path: path,
        fail: () => {
          wx.previewImage({ current: path, urls: [path] });
        }
      });
    } else if (wx.shareFileMessage) {
      wx.shareFileMessage({
        filePath: path,
        fileName: `${storeName}_感恩汇报.png`,
        success: () => {
          wx.showToast({ title: '分享成功！', icon: 'success' });
        }
      });
    } else {
      wx.setClipboardData({
        data: reportText,
        success: () => {
          wx.showToast({ title: '汇报文案已复制，可直接发群', icon: 'none' });
        }
      });
    }
  },

  onCloseGratitudeModal() {
    this.setData({ showGratitudeModal: false });
  },

  onGeneratePoster() {
    const { statistics, shopName, selectedYear, selectedMonth, currentTab } = this.data;
    if (!statistics) {
      wx.showToast({ title: '暂无数据', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在合成公示海报...', mask: true });

    try {
      const query = wx.createSelectorQuery();
      query.select('#posterCanvas')
        .fields({ node: true, size: true })
        .exec((res: any) => {
          if (!res[0] || !res[0].node) {
            wx.hideLoading();
            wx.showToast({ title: 'Canvas 初始化失败', icon: 'none' });
            return;
          }

          const canvas = res[0].node;
          const ctx = canvas.getContext('2d');
          const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2) || 2;

          const W = 600;
          const H = 1030;
          canvas.width = W * dpr;
          canvas.height = H * dpr;
          ctx.scale(dpr, dpr);

          ctx.fillStyle = '#FAF6F0';
          ctx.fillRect(0, 0, W, H);

          ctx.fillStyle = '#8C1D18';
          ctx.fillRect(0, 0, W, 140);

          ctx.fillStyle = '#FFFFFF';
          ctx.font = 'bold 28px "PingFang SC", sans-serif';
          ctx.fillText(`${shopName || '雨花斋'} · 收支公示海报`, 40, 60);

          ctx.font = '18px sans-serif';
          let periodText = '';
          if (currentTab === 'week') {
            periodText = `${selectedYear}年${selectedMonth}月 周报`;
          } else if (currentTab === 'month') {
            periodText = `${selectedYear}年${selectedMonth}月 月报`;
          } else if (currentTab === 'year') {
            periodText = `${selectedYear}年度 年报`;
          } else {
            periodText = `${statistics.startDate} ~ ${statistics.endDate}`;
          }
          ctx.fillText(`统计周期: ${periodText}`, 40, 100);

          ctx.fillStyle = '#FFFFFF';
          ctx.shadowColor = 'rgba(0, 0, 0, 0.05)';
          ctx.shadowBlur = 10;
          ctx.fillRect(30, 160, 540, 780);
          ctx.shadowBlur = 0;

          ctx.fillStyle = '#212529';
          ctx.font = 'bold 22px sans-serif';
          ctx.fillText(`服务汇入总额: +¥${statistics.totalIncomeStr}`, 60, 220);
          ctx.fillText(`开餐支出总额: -¥${statistics.totalExpenseStr}`, 60, 270);
          ctx.fillText(`本期服务积累: ${statistics.netAccumulationStr}`, 60, 320);

          ctx.fillStyle = '#495057';
          ctx.font = '18px sans-serif';
          ctx.fillText(`• 日常食材支出: ¥${statistics.dailyExpenseTotalStr}`, 80, 370);
          ctx.fillText(`• 房租/专项固定: ¥${statistics.largeExpenseTotalStr}`, 80, 405);

          // 绘制 2x2 数据卡片矩阵
          const cardStartY = 440;
          const cardW = (W - 100) / 2;
          const cardH = 75;
          const cardGapX = 20;
          const cardGapY = 15;

          const dataCards = [
            { label: '累计开餐天数', value: `${statistics.openDays} 天`, color: '#8C1D18' },
            { label: '服务用餐人次', value: `${statistics.totalDiningCount} 人`, color: '#8C1D18' },
            { label: '义工服务工时', value: `${statistics.totalVolunteerHours} 小时`, color: '#8C1D18' },
            { label: '每餐服务投入', value: statistics.showPerMealCost ? `¥${statistics.perMealCostStr}` : '-', color: '#2E7D32' }
          ];

          dataCards.forEach((card, index) => {
            const col = index % 2;
            const row = Math.floor(index / 2);
            const x = 40 + col * (cardW + cardGapX);
            const y = cardStartY + row * (cardH + cardGapY);

            ctx.fillStyle = '#FFF8EE';
            this.roundRect(ctx, x, y, cardW, cardH, 10, true);

            ctx.fillStyle = '#8C7355';
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(card.label, x + cardW / 2, y + 25);

            ctx.fillStyle = card.color;
            ctx.font = 'bold 18px sans-serif';
            ctx.fillText(card.value, x + cardW / 2, y + 55);
          });
          ctx.textAlign = 'left';

          const coreStartY = cardStartY + 2 * (cardH + cardGapY) + 20;
          ctx.fillStyle = '#FFFDF8';
          this.roundRect(ctx, 40, coreStartY, W - 80, 70, 10, true);

          ctx.fillStyle = '#8C1D18';
          ctx.font = 'bold 18px sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(`🍲 本期累计服务用餐：${statistics.totalDiningCount} 人次`, 60, coreStartY + 30);

          ctx.fillStyle = '#495057';
          ctx.font = '15px sans-serif';
          ctx.fillText(`每餐爱心食材折算：${statistics.showPerMealCost ? `¥${statistics.perMealCostStr} / 人` : '数据计算中'}`, 60, coreStartY + 58);

          ctx.fillStyle = '#868E96';
          ctx.font = '16px sans-serif';

          const balanceNum = Number(statistics.latestBalance || 0);
          const avgExpense = Number(statistics.avgDailyExpenseMA14 || statistics.avgDailyExpense || 0);
          const isPrep = Number(statistics.dailyExpenseTotal || 0) === 0;
          const daysStatusText = this.getPosterDaysText(balanceNum, avgExpense, isPrep);
          const posterFooterText = `账户结余: ¥${balanceNum.toFixed(2)} (${daysStatusText})`;

          ctx.fillText(posterFooterText, 60, coreStartY + 110);
          ctx.fillText(`核心物资: 大米[${statistics.riceStatusText}] / 食用油[${statistics.oilStatusText}]`, 60, coreStartY + 145);

          const netAccumulation = parseFloat(statistics.netAccumulation) || 0;
          let statusBannerBg = '#FAB005';
          let statusBannerBorder = '';
          let statusBannerTextColor = '#FFFFFF';
          let statusBannerText = '服务资金与物资充足，平稳运行中';
          if (netAccumulation < 0) {
            // 🛡️ 合规脱敏：避免刺眼深红警报色与"恳请关注支持"类劝募嫌疑文案，
            // 改为中性浅橙/浅黄暖色的"财务分析提示卡"风格，而非"紧急筹款呼吁"
            statusBannerBg = '#FFFBE6';
            statusBannerBorder = '#FFE58F';
            statusBannerTextColor = '#D48806';
            statusBannerText = '⚠️ 本期支出大于汇入，请注意收支平衡';
          }

          ctx.fillStyle = statusBannerBg;
          ctx.fillRect(30, H - 100, 540, 50);
          if (statusBannerBorder) {
            ctx.strokeStyle = statusBannerBorder;
            ctx.lineWidth = 2;
            ctx.strokeRect(30, H - 100, 540, 50);
          }
          ctx.fillStyle = statusBannerTextColor;
          ctx.font = 'bold 20px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(statusBannerText, W / 2, H - 65);
          ctx.textAlign = 'left';

          ctx.fillStyle = '#868E96';
          ctx.font = '12px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('扫码查看透明账本', W / 2, H - 45);

          ctx.fillStyle = '#ADB5BD';
          ctx.font = '10px sans-serif';
          ctx.fillText('本海报仅用于内部爱心服务与账目信息公示，不提供任何形式的网络公开筹款服务。', W / 2, H - 20);
          ctx.textAlign = 'left';

          wx.canvasToTempFilePath({
            canvas: canvas,
            success: (tempRes: any) => {
              wx.hideLoading();
              this.setData({
                posterTempFilePath: tempRes.tempFilePath,
                showPosterModal: true
              });
            },
            fail: () => {
              wx.hideLoading();
              wx.showToast({ title: '海报生成失败', icon: 'none' });
            }
          });
        });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '海报生成异常', icon: 'none' });
    }
  },

  // 🆕 超管专属：全国公示海报——与 onGeneratePoster（单店收支海报）复用同一个
  // #posterCanvas 节点与 showPosterModal 预览弹窗，数据源换成 nationalData
  // （全国口径），版式简化为一屏核心数字，不逐项照搬单店海报的历史字段
  onGenerateNationalPoster() {
    const { nationalData } = this.data;
    if (!nationalData || nationalData.nationalTotalDiners === undefined) {
      wx.showToast({ title: '暂无数据', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在合成全国公示海报...', mask: true });

    try {
      const query = wx.createSelectorQuery();
      query.select('#posterCanvas')
        .fields({ node: true, size: true })
        .exec((res: any) => {
          if (!res[0] || !res[0].node) {
            wx.hideLoading();
            wx.showToast({ title: 'Canvas 初始化失败', icon: 'none' });
            return;
          }

          const canvas = res[0].node;
          const ctx = canvas.getContext('2d');
          // 🌟 复用项目已有的 getSafeSystemInfo（已经把 wx.getWindowInfo 缺失时的兜底
          // 封装好了），不再新增一处 wx.getWindowInfo 直接调用的已知类型缺口实例
          const dpr = getSafeSystemInfo().pixelRatio || 2;

          const W = 600;
          const H = 820;
          canvas.width = W * dpr;
          canvas.height = H * dpr;
          ctx.scale(dpr, dpr);

          ctx.fillStyle = '#FAF6F0';
          ctx.fillRect(0, 0, W, H);

          ctx.fillStyle = '#1C7ED6';
          ctx.fillRect(0, 0, W, 140);

          ctx.fillStyle = '#FFFFFF';
          ctx.font = 'bold 26px "PingFang SC", sans-serif';
          ctx.fillText('🌐 雨花斋全国爱心矩阵 · 公示海报', 40, 60);
          ctx.font = '18px sans-serif';
          ctx.fillText(`已覆盖 ${nationalData.totalStores || 0} 家门店`, 40, 100);

          ctx.fillStyle = '#FFFFFF';
          ctx.shadowColor = 'rgba(0, 0, 0, 0.05)';
          ctx.shadowBlur = 10;
          ctx.fillRect(30, 160, 540, 540);
          ctx.shadowBlur = 0;

          ctx.fillStyle = '#212529';
          ctx.font = 'bold 20px sans-serif';
          ctx.fillText('全国累计服务用餐人次', 60, 210);
          ctx.fillStyle = '#1C7ED6';
          ctx.font = 'bold 44px sans-serif';
          ctx.fillText(`${nationalData.nationalTotalDiners}`, 60, 265);
          ctx.font = '16px sans-serif';
          ctx.fillStyle = '#868E96';
          ctx.fillText('人次', 60 + ctx.measureText(`${nationalData.nationalTotalDiners}`).width + 12, 262);

          const cardStartY = 320;
          const cardW = (W - 100) / 2;
          const cardH = 90;
          const cardGapX = 20;
          const dataCards = [
            { label: '全国服务汇入', value: `+¥${nationalData.nationalTotalIncome}`, color: '#2B8A3E' },
            { label: '全国开餐总支出', value: `-¥${nationalData.nationalTotalExpense}`, color: '#C62828' },
            { label: '全国累计开餐天数', value: `${nationalData.nationalOpenDays} 天`, color: '#8C1D18' },
            { label: '覆盖门店数量', value: `${nationalData.totalStores || 0} 家`, color: '#8C1D18' }
          ];
          dataCards.forEach((card, index) => {
            const col = index % 2;
            const row = Math.floor(index / 2);
            const x = 40 + col * (cardW + cardGapX);
            const y = cardStartY + row * (cardH + 16);

            ctx.fillStyle = '#F8F9FA';
            this.roundRect(ctx, x, y, cardW, cardH, 10, true);

            ctx.fillStyle = '#868E96';
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(card.label, x + cardW / 2, y + 30);

            ctx.fillStyle = card.color;
            ctx.font = 'bold 22px sans-serif';
            ctx.fillText(card.value, x + cardW / 2, y + 65);
          });
          ctx.textAlign = 'left';

          const footerY = cardStartY + 2 * (cardH + 16) + 30;
          ctx.fillStyle = '#8C7355';
          ctx.font = '14px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('感恩各位爱心人士护持与全国义工团队无私付出！', W / 2, footerY);
          ctx.fillStyle = '#ADB5BD';
          ctx.font = '10px sans-serif';
          ctx.fillText('本平台仅用于爱心餐报与志愿服务记录，不直接面向公众发起公开募捐', W / 2, footerY + 24);
          ctx.textAlign = 'left';

          wx.canvasToTempFilePath({
            canvas: canvas,
            success: (tempRes: any) => {
              wx.hideLoading();
              this.setData({
                posterTempFilePath: tempRes.tempFilePath,
                showPosterModal: true
              });
            },
            fail: () => {
              wx.hideLoading();
              wx.showToast({ title: '海报生成失败', icon: 'none' });
            }
          });
        });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '海报生成异常', icon: 'none' });
    }
  },

  roundRect(ctx: any, x: number, y: number, w: number, h: number, r: number, fill: boolean) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    ctx.lineTo(x + w, y + h - r);
    ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    ctx.lineTo(x + r, y + h);
    ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    ctx.lineTo(x, y + r);
    ctx.arc(x + r, y + r, r, Math.PI, -Math.PI / 2);
    ctx.closePath();
    if (fill) ctx.fill();
  },

  // 智能格式化海报天数/状态文案，避免“预计可支撑”与状态文本硬拼接产生语病
  getPosterDaysText(totalBalance: number, avgDailyExpense: number, isPreparingPeriod: boolean) {
    if (totalBalance <= 0) {
      // 🛡️ 合规脱敏：与上方赤字提示条同一口径，避免"恳请社会各界"类劝募嫌疑措辞
      return '资金结余较低，请注意收支平衡';
    }

    // 休餐/筹备期（食材支出为 0）
    if (isPreparingPeriod || avgDailyExpense <= 0) {
      const estimatedDays = Math.floor(totalBalance / 150);
      if (estimatedDays > 99) {
        return '预计可平稳开餐 99+ 天';
      }
      return `预计可平稳开餐约 ${estimatedDays} 天`;
    }

    // 正常运营期：用实际结余 ÷ 实际日均食材费
    const realDays = Math.floor(totalBalance / avgDailyExpense);
    if (realDays > 99) {
      return '预计可平稳开餐 99+ 天';
    } else if (realDays > 0) {
      return `预计可平稳开餐约 ${realDays} 天`;
    } else {
      return '资金即刻告急，亟需补充';
    }
  },

  onClosePosterModal() {
    this.setData({ showPosterModal: false });
  },

  onOpenEditMajorModal(e: any) {
    const item = e.currentTarget.dataset.item;
    this.setData({
      editingTargetRecord: item,
      editingInputText: '',
      showEditMajorModal: true
    });
  },

  onCloseEditMajorModal() {
    this.setData({ showEditMajorModal: false });
  },

  onMajorInputBlur(e: any) {
    this.setData({ editingInputText: e.detail.value });
  },

  async onSubmitPatchMajorText() {
    const { editingTargetRecord, editingInputText } = this.data;

    if (!editingInputText || !editingInputText.trim()) {
      wx.showToast({ title: '请输入具体事由和金额', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在更新账目...', mask: true });

    const targetId = editingTargetRecord.recordId;
    const patchText = editingInputText.trim();

    try {
      if (targetId) {
        const result = await wx.cloud.callFunction({
          name: 'updateReportLog',
          data: {
            recordId: targetId,
            updateData: {
              fixedMajorText: patchText,
              fixedExpenseText: patchText,
              remark: patchText
            }
          }
        });
        const res = result.result as any;
        if (!(res && res.success)) {
          console.warn('[PatchMajor] 云函数更新失败:', res && res.error);
        }
      }

      const localRecords = wx.getStorageSync('local_report_logs') || [];
      const targetLocal = localRecords.find((r: any) => (r._id === targetId || r.reportDate === editingTargetRecord.date));
      if (targetLocal) {
        targetLocal.fixedMajorText = patchText;
        targetLocal.fixedExpenseText = patchText;
        targetLocal.remark = patchText;
        wx.setStorageSync('local_report_logs', localRecords);
      }

      wx.hideLoading();
      wx.showToast({ title: '明细已成功拆解！', icon: 'success' });

      this.setData({ showEditMajorModal: false });
      this.reloadShopListAndStats();

    } catch (err: any) {
      wx.hideLoading();
      console.error('Patch error:', err);
      wx.showToast({ title: '更新失败，请重试', icon: 'none' });
    }
  },

  onSharePosterToWeChat() {
    const filePath = this.data.posterTempFilePath;
    if (!filePath) {
      wx.showToast({ title: '海报生成中，请稍后', icon: 'none' });
      return;
    }

    if (wx.showShareImageMenu) {
      wx.showShareImageMenu({
        path: filePath,
        fail: (err: any) => {
          console.warn('唤起分享菜单失败，降级为预览模式:', err);
          wx.previewImage({ current: filePath, urls: [filePath] });
        }
      });
    } else {
      wx.previewImage({ current: filePath, urls: [filePath] });
    }
  },

  async onSavePosterToAlbum() {
    const filePath = this.data.posterTempFilePath;
    if (!filePath) {
      wx.showToast({ title: '海报尚未生成', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中...', mask: true });

    try {
      await wx.saveImageToPhotosAlbum({ filePath });
      wx.hideLoading();
      wx.showToast({
        title: '🎉 已保存到相册',
        icon: 'success',
        duration: 2000
      });
    } catch (err: any) {
      wx.hideLoading();
      if (err.errMsg && (err.errMsg.includes('auth deny') || err.errMsg.includes('auth denied') || err.errMsg.includes('not authorized'))) {
        wx.showModal({
          title: '提示',
          content: '需要允许保存图片到相册权限，请在设置中开启',
          confirmText: '去设置',
          success: (res: any) => {
            if (res.confirm) {
              wx.openSetting();
            }
          }
        });
      } else {
        wx.showToast({ title: '保存失败，可长按海报保存', icon: 'none' });
      }
    }
  },

  buildCSV(data: any[], storeName: string): string {
    let csv = '日期,门店名称,服务收入(元),日常食材开销(元),房租专项大额(元),总支出(元),净盈亏(元),用餐人次,到岗义工(人),大额备注/说明\n';

    data.forEach(item => {
      const date = item.date || '';
      const store = storeName || '雨花斋';
      const income = parseFloat(item.income || 0).toFixed(2);
      const dailyExp = parseFloat(item.dailyExpense || 0).toFixed(2);
      const largeExp = parseFloat(item.largeExpense || 0).toFixed(2);
      const totalExp = parseFloat(item.expense || 0).toFixed(2);
      const net = (parseFloat(income) - parseFloat(totalExp)).toFixed(2);
      const diners = item.diningCount || 0;
      const volunteers = item.volunteerCount || 0;
      const remark = String(item.materialsSummary || '').replace(/[\r\n,]/g, ' ');

      csv += `"${date}","${store}",${income},${dailyExp},${largeExp},${totalExp},${net},${diners},${volunteers},"${remark}"\n`;
    });

    return csv;
  },

  // 🛡️ 防抖：wx.showLoading/hideLoading 是全局单例，不是按调用配对——重复点击会
  // 打出两轮并发的 loading 序列，先完成的那次 hideLoading 会把还没跑完的第二轮
  // loading 蒙层一并关掉，出现"看起来刷新完了其实还在跑"的错觉
  onRefreshData() {
    if (this.data.isRefreshingData) return;
    this.setData({ isRefreshingData: true });
    wx.showLoading({ title: '刷新中...' });
    DataService.syncLocalDataToCloud().then(() => {
      // 🐛 根因修复：导航栏"刷新数据"此前无条件调用 calculateStats()——该方法
      // 一旦发现 showNationalDashboard 为 true 会直接 return（单店查询结果不会
      // 被渲染，见 calculateStats 注释），全国总览大屏点"刷新数据"实际上什么都
      // 没有刷新。现在按当前所处的大屏模式分别路由到各自真正的数据源
      if (this.data.showNationalDashboard) {
        this.loadNationalDashboard();
      } else {
        this.loadShopList();
        this.calculateStats();
      }
      wx.hideLoading();
      wx.showToast({ title: '数据已刷新', icon: 'success' });
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '刷新失败', icon: 'none' });
    }).finally(() => {
      this.setData({ isRefreshingData: false });
    });
  },

  onQuickEditDiners(e: any) {
    const idx = e.currentTarget.dataset.index;
    const records = this.data.statistics.dailyRecords;
    const item = records[idx];
    if (!item) return;

    wx.showModal({
      title: `补录【${item.date}】用餐人数`,
      editable: true,
      placeholderText: '请输入实际用餐人次（如：120）',
      success: async (res: any) => {
        if (res.confirm && res.content) {
          const count = parseInt(res.content, 10);
          if (!isNaN(count) && count >= 0) {
            wx.showLoading({ title: '更新中...', mask: true });
            try {
              if (item._id) {
                const result = await wx.cloud.callFunction({
                  name: 'updateReportLog',
                  data: {
                    recordId: item._id,
                    updateData: { diningCount: count }
                  }
                });
                const res = result.result as any;
                if (!(res && res.success)) {
                  console.warn('[DinerUpdate] 云函数更新失败:', res && res.error);
                }
              } else if (item._localId) {
                const localReports = wx.getStorageSync('local_report_logs') || [];
                const localIdx = localReports.findIndex((r: any) => r._localId === item._localId);
                if (localIdx >= 0) {
                  localReports[localIdx].diningCount = count;
                  wx.setStorageSync('local_report_logs', localReports);
                }
              }
              wx.hideLoading();
              wx.showToast({ title: '更新成功', icon: 'success' });
              this.calculateStats();
            } catch (err) {
              wx.hideLoading();
              wx.showToast({ title: '更新失败', icon: 'none' });
            }
          }
        }
      }
    });
  },

  onOpenBatchDinerModal() {
    const { statistics } = this.data;
    if (!statistics || !statistics.dailyRecords || statistics.dailyRecords.length === 0) {
      wx.showToast({ title: '暂无记录', icon: 'none' });
      return;
    }

    const missing = statistics.dailyRecords
      .filter((item: any) => !item.diningCount || item.diningCount === 0)
      .map((item: any) => ({ ...item, tempDiners: '' }));

    if (missing.length === 0) {
      wx.showToast({ title: '所有记录用餐人数均已填妥', icon: 'none' });
      return;
    }

    this.setData({
      missingDinerRecords: missing,
      showBatchDinerModal: true
    });
  },

  onCloseBatchDinerModal() {
    this.setData({ showBatchDinerModal: false });
  },

  onBatchDinerInput(e: any) {
    const idx = e.currentTarget.dataset.index;
    const val = e.detail.value;
    const missing = this.data.missingDinerRecords;
    missing[idx].tempDiners = val;
    this.setData({ missingDinerRecords: missing });
  },

  async onSubmitBatchDiners() {
    const { missingDinerRecords } = this.data;
    wx.showLoading({ title: '正在更新记录...', mask: true });

    try {
      let updatedCount = 0;
      const db = wx.cloud.database();

      for (const item of missingDinerRecords) {
        if (item.tempDiners && parseInt(item.tempDiners, 10) > 0) {
          const dinersVal = parseInt(item.tempDiners, 10);
          const recordId = item._id;
          
          if (recordId) {
            try {
              const result = await wx.cloud.callFunction({
                name: 'updateReportLog',
                data: {
                  recordId,
                  updateData: { diningCount: dinersVal }
                }
              });
              const res = result.result as any;
              if (res && res.success) {
                updatedCount++;
              } else if (res && res.error && res.error.includes('doc not found')) {
                const localReports = wx.getStorageSync('local_report_logs') || [];
                const idx = localReports.findIndex((r: any) => r._localId === item._localId || r._id === recordId);
                if (idx >= 0) {
                  localReports[idx].diningCount = dinersVal;
                  wx.setStorageSync('local_report_logs', localReports);
                  updatedCount++;
                }
              } else {
                console.warn('[BatchDiner] 云端更新失败:', res && res.error);
              }
            } catch (callErr) {
              console.warn('[BatchDiner] 云函数调用失败:', callErr);
            }
          } else if (item._localId) {
            const localReports = wx.getStorageSync('local_report_logs') || [];
            const idx = localReports.findIndex((r: any) => r._localId === item._localId);
            if (idx >= 0) {
              localReports[idx].diningCount = dinersVal;
              wx.setStorageSync('local_report_logs', localReports);
              updatedCount++;
            }
          }
        }
      }

      wx.hideLoading();

      if (updatedCount > 0) {
        wx.showToast({
          title: `已成功补录 ${updatedCount} 笔数据`,
          icon: 'success'
        });
      } else {
        wx.showToast({ title: '未填写有效人数', icon: 'none' });
      }

      this.setData({ showBatchDinerModal: false });
      this.calculateStats();
    } catch (err) {
      wx.hideLoading();
      console.error('[BatchDiner] 批量更新异常:', err);
      wx.showToast({ title: '更新失败，请重试', icon: 'none' });
    }
  },

  // 🛡️ 全局返回逻辑排查修复：goHome() 是给分享直入场景的物理返回键设计的，不该
  // 挪用给自定义导航栏的"←"按钮——那会导致不管从哪个页面点进来都被强制跳回首页，
  // 注释此前写的"智能跳转"其实从未按 pages.length 真正判断过
  goBackHome() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
  }
});
