import { DataService, formatMoney, getLocalReports } from '../../utils/dataService';
import { AuthService, ROLE_LABELS } from '../../utils/authService';
import { getSelectedStore, setSelectedStore } from '../../utils/storeManager';
import { formatGratitudeReportText, GratitudeReportData } from '../../utils/reportFormatter';
import { calculateEmaRunway, RunwayResult } from '../../utils/calculateRunway';
import { createNavGuard, NavGuardInstance } from '../../utils/navGuard';
import { safeNavigateTo } from '../../utils/navHelper';
import { recordRecentVisit } from '../../utils/recentPages';
import { drawVolunteerHonorCard, VolunteerHonorData } from '../../utils/posterGenerator';
import { getSafeSystemInfo } from '../../utils/util';
import { isVirtualStoreName, resolveHonorCardStoreName } from '../../utils/storeIdentity';
import { checkTenantPermission, FEATURE_KEYS } from '../../utils/tenantPermission';
import { reportCloudSdkErrorIfCorrupted } from '../../utils/cloudGuard';
import { callFunctionWithTimeout } from '../../utils/withTimeout';
import { writeLocalFileSafe } from '../../utils/localFileCache';
import { nationalDashboardHandlers, drillDownHandlers, procurementHandlers } from './enterprise/index';

// ☀️ 阳光账本理念弹窗文案：与 pages/index/index.ts 的 computeConceptCopy 是
// 同一份内容（按 getSunshineLedger 返回的真实 orgType 三档区分），未提炼成共享
// utils——这份纯文案函数很小，两个页面各自的阳光账本卡片/弹窗展示时机、周边
// 状态完全不同，硬拆共享模块换不来实际收益
function computeSunshineConceptCopy(orgType: string, storeName: string): { title: string; label: string; content: string } {
  const displayStoreName = storeName || '本站点';
  if (orgType === 'yuhuazhai') {
    return {
      title: '☀️ 阳光账本与雨花理念',
      label: '雨花精神',
      content: '雨花无家，家在雨花。雨花斋致力于推广素食护生、恭敬生命与公益互助。'
    };
  }
  if (orgType === 'elderly_canteen') {
    return {
      title: '☀️ 阳光账本与助老理念',
      label: '助老理念',
      content: '爱心助餐，敬老护生。致力于为社区长者提供公开透明、温暖放心的助餐服务。'
    };
  }
  return {
    title: '☀️ 阳光账本与公益宣言',
    label: '公益宗旨',
    content: `阳光笃行，爱心同行。${displayStoreName}坚持以公益之心服务社区，守护每一份需要关爱的心意。`
  };
}

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

// 🏛️（2026-08-31 Open-Core 架构拆分）export：供 enterprise/nationalDashboardService.ts
// 的 buildNationalExportDateRange() 复用
export function formatDate(date: Date): string {
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

// 🆕 大额数值紧凑展示：全国大屏的人次/金额一旦破万，蓝色 hero 卡片、暖金 KPI
// 卡片这类固定宽度的小格子很容易被撑爆换行、挤压布局，超过一万时转换成
// "x.x万"。income/expense 字段本身是后端 toFixed(2) 出来的字符串，diners 是
// 原始 number，两种入参都要能处理；非有限数值（如被脱敏成 null 的字段）原样
// 透传，不强行转成 '0' 误导成"确实是零"
// 🏛️（2026-08-31 Open-Core 架构拆分）export：供 enterprise/nationalDashboardService.ts
// 复用同一份实现，不重复维护一份拷贝——该文件当前唯一的调用点在全国大屏，
// 但这是通用的纯函数，未来 Core 自身场景要用也可以直接导入
export function formatCompactNumber(value: number | string | null): string | null {
  if (value === null || value === undefined) return value as any;
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!isFinite(n)) return typeof value === 'string' ? value : null;
  if (Math.abs(n) >= 10000) {
    return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  }
  return typeof value === 'string' ? value : String(n);
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
  // 🏛️（2026-08-31 Open-Core 架构拆分·终局阶段）Enterprise 扩展包：全国大屏/
  // 跨机构聚合/SaaS 订阅/爱心粮油集采相关方法，物理搬迁至 ./enterprise/ 目录，
  // 运行时通过 spread 合并回本页面实例——见 ./enterprise/index.ts 头部注释，
  // scripts/build-open-core.js 打包 Core 包时会整份替换该文件为空操作 stub。
  // 展开顺序在最前面，后面同名的 Core 方法（本对象字面量中不存在同名 key，
  // 这里只是约定放在最前）不会覆盖它们
  ...nationalDashboardHandlers,
  ...drillDownHandlers,
  ...procurementHandlers,

  _navGuard: null as NavGuardInstance | null,
  // 🔢 义工与用餐服务数据看板·数字滚动动画计时器，onUnload 统一清理
  _careCountUpTimer: null as any,
  // 🐛 根因修复：onLoad 与紧随其后的 onShow 都会各自调用一次
  // reloadShopListAndStats()——这两次调用命中的是同一份角色/门店状态，属于纯
  // 重复请求。scheduleReloadStats() 曾尝试靠 150ms 防抖从源头合并，但 onLoad/
  // onShow 之间的真实间隔在弱网/真机/开发者工具下并不保证 <150ms（例如
  // initUserRole() 的角色解析、loadShopList() 的云调用耗时都会把 onShow 实际
  // 触发的时间点顺延），间隔一旦超过 150ms，两次触发各自独立命中一次
  // reloadShopListAndStats()，控制台仍会打出"已有请求在途，记为待补发"、
  // getStatisticsData 被完整调用两次。真正根治见 _skipNextShowReload：只在
  // onLoad 已经调度过一次的这一次 onShow（冷启动背靠背的那次）跳过重复调度，
  // 之后任何"用户切走再切回来"的正常 onShow 不受影响，仍会正常刷新
  _reloadStatsDebounceTimer: null as any,
  // 🐛 见上面 _reloadStatsDebounceTimer 注释：冷启动时 onLoad 已经调度过一次
  // reloadShopListAndStats()，紧随其后的第一次 onShow 不需要再调度一次——
  // onLoad 末尾置位，onShow 消费一次后立即清零，不影响后续真正的"返回本页"场景
  _skipNextShowReload: false,
  // 🐛 见 data.roleReady 注释：reloadShopListAndStats() 在角色尚未就绪时把这次
  // 请求记成待办，不放进 data（不需要驱动渲染），applyRolePermissions() 落地后读取
  _pendingStatsReload: false,
  // 🆕 SWR 快照秒开只在本次页面生命周期内"第一次"调用 loadNationalDashboard()
  // 时尝试渲染缓存——切换筛选条件/手动点"刷新数据"等后续调用都是用户主动
  // 触发的二次请求，屏幕上已经有当前真实数据，不该被快照"倒退"回一份更旧的
  // 缓存值，见 loadNationalDashboard() 内 isFirstLoad 判断
  _nationalDashboardEverLoaded: false,
  // 🌟 导出配置弹窗「确认导出」（onConfirmExportConfig）置位，等选定周期的
  // loadStatistics() 重新把 statistics 灌好后自动触发一次 exportToExcel()。
  // 🐛 不再由 onLoad 的 ?autoShowExport=true/?action=export 直接置位——那两个
  // 入口现在改为无条件拉起导出配置弹窗（见 openExportConfigModal），空值校验
  // 只应该针对用户在弹窗里选定的周期，而不是页面刚打开时的默认周期。
  // 消费一次后立即清零，不随 onShow/切 Tab 反复重放
  _autoShowExportPending: false,
  // 🐛 根因修复：fetchStatistics()/loadStatistics() 此前的防抖锁是"已有请求
  // 在途就直接丢弃这次调用"——用户快速连续切换 Tab/年月/自定义日期时，最后一次
  // （真正想看的那次）选择很可能就在某次请求还没返回时被发起，直接被丢弃，
  // 等在途请求返回后页面停留在一个"不是用户最终选择"的旧结果上，且没有任何
  // 后续动作会自动补发。改为"pending 缓冲"：请求被锁挡下时不再直接丢弃，而是
  // 记一笔待办（loadStatistics 还要记下最新的 startDate/endDate，因为它俩是
  // 显式传参、不能像 fetchStatistics 那样单纯重新读 this.data 就能拿到最新值），
  // 等在途请求的 finally 结束、锁释放后自动补发一次——补发时读到的都是彼时最新的
  // 筛选状态，天然实现"最新参数覆盖"，不需要维护请求版本号/取消令牌这类更重的方案
  _pendingStatsFetch: false,
  _pendingStatsLoadArgs: null as [string, string] | null,

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
    // 🆕 Profile「财务稽核专区」跳转带来的 ?viewMode=finance 标记：角色解析
    // （initUserRole 是异步的）真正完成、isFinance 落地前的这段窗口期，先靠
    // 这个同步写入的标记提前收起营销 Banner，避免"先闪一下 Banner 再收起"的
    // 视觉跳变。isFinance 落地后两者语义等价，wxml 判断统一写
    // isFinance || financeEntryMode
    financeEntryMode: false,
    // ☀️ 阳光大盘：Profile「阳光账本核查」/首页「阳光账本」跳转的真正落地区块，
    // 取代此前"点了只弹一个理念宣言 Modal、不落到任何数据页面"的交互死胡同。
    // 数据源与首页阳光账本弹窗同一个公开只读云函数 getSunshineLedger（见
    // fetchSunshineBoardData），管理视图/个人视图两个分支都会渲染，只要能拿到
    // storeId 就与角色无关——该云函数本身就是"全角色/免登录门槛"的公开数据
    sunshineBoardLoading: false,
    sunshineBoardData: {
      storeName: '',
      periodLabel: '',
      auditedReportsCount: 0,
      totalDiners: 0,
      monthlyDiners: 0,
      takeawayMeals: 0,
      totalHours: 0,
      volunteerCount: 0,
      operatingDays: 0,
      ledgerPublicRate: null as string | null
    },
    sunshineBoardCards: [] as { label: string; value: string }[],
    // 🆕 阳光宣言辅助弹窗：由阳光大盘标题旁的 ⓘ 图标触发，只做理念说明，不再是
    // 进页面就顶在最前面的"点了只弹窗"入口——见 onOpenSunshineConceptModal
    showSunshineConceptModal: false,
    sunshineConceptTitle: '☀️ 阳光账本与公益宣言',
    sunshineConceptLabel: '',
    sunshineConceptContent: '',
    // 🆕 ?tab=sunshine / ?tab=ledger 跳转锚点：management 视图的主滚动区据此自动
    // 滚到阳光大盘 / 账目流水明细卡片
    scrollIntoViewId: '',
    // 🐛 根因修复：此前 tab=sunshine 与 tab=ledger 落地后除了滚动位置/月报默认
    // 选中之外，页面主体结构完全没有随 tab 分化——两个入口点进来看到的卡片、
    // 数据毫无差别。entryFocus 是真正的差异化开关：'sunshine' 收起下方的账目
    // 流水明细区块、只留阳光大盘；'ledger' 反过来收起阳光大盘、把视觉重心让给
    // 账目流水明细；'' 是普通访问（无 tab 参数），两块都保留，不改变原有行为
    entryFocus: '' as '' | 'sunshine' | 'ledger',
    // 📋 账目流水明细：与 core-metrics/finance-compliance 那套"周期汇总"口径不同，
    // 这是 loadStatistics() 里已经拉到手、此前只用来算汇总就丢弃的逐条原始
    // report_logs 记录（见 buildLedgerRecords），每条精确到"日期/收支金额/凭证
    // 关联状态/核销状态"，供 tab=ledger 落地时展示成流水列表，不再是只有几个
    // 汇总数字的空壳
    ledgerRecords: [] as Array<{
      id: string;
      date: string;
      shopName: string;
      incomeStr: string;
      expenseStr: string;
      netStr: string;
      netPositive: boolean;
      hasReceipt: boolean;
      receiptCount: number;
      receiptImages: string[];
      statusLabel: string;
      statusClass: string;
      categoryLabel: string;
      categoryClass: string;
      sourceLabel: string;
    }>,
    // 📋 账目流水明细空状态/卡片副标题联动文案：与当前 currentTab/selectedYear/
    // selectedMonth（或自定义区间）保持一致，随 loadStatistics() 重新计算，见
    // buildLedgerPeriodLabel——修复此前"选中 2026年8月，空状态提示却跟当前
    // 选中月份对不上"的文案错位
    ledgerPeriodText: '',
    // 大家长快捷入口：统计页头部的"全国数据看板 ↗"按钮可见性
    showNationalDashboardEntry: false,
    dashboardTitle: '🌐 全网爱心矩阵数据大屏',
    dashboardRoleTag: '',
    // 🆕 顶部横幅"📊 爱心网络总览 · [机构名称]"：来自 getNationalDashboard
    // 返回的 tenantName，加载完成前/查询失败时兜底展示通用文案，不留空
    currentTenantName: '',

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
    // 🐛 根因修复：默认值此前硬编码 'all'——对 super_admin 这是"全店汇总/个人
    // 统计"开关的合理默认，但同一个字段现在也承载 Profile「财务稽核专区」
    // 跳转带来的 ?viewMode=finance（见 onLoad），非超管角色的 this.data.viewMode
    // 必须能保持"未设置"这个明确可辨识的状态，才能在 loadStatistics()/
    // fetchStatistics() 里安全地统一读取（'' 是 falsy，兜底逻辑不受影响；若
    // 硬编码成 'all'，非超管会在没有任何 URL 参数时也把字面量 'all' 传给
    // getReports，见 loadStatistics 里已作废的 isSuperAdmin 硬编码分支曾经
    // 专门防的那个问题）。super_admin 的 'all' 默认改由 applyRolePermissions()
    // 落地角色后按需补一次（见该方法内 viewMode 赋值），不影响原有 UX
    viewMode: '' as string,
    // 🛡️ 预默认必须是 false：这是页面刚加载、角色尚未解析完成前的初始值，若默认
    // true，非超管账号会在 initUserRole()/reloadShopListAndStats() 并行请求的
    // 窗口期内短暂（甚至持续，如果角色解析本身就慢）处于"全部门店"聚合状态——
    // 与 canViewAllStoresDropdown（默认同样是 false，严格收窄到 super_admin）
    // 保持同一条口径，只有确认是 super_admin 才允许被置为 true
    isAllStoresMode: false,
    // 🆕（2026-08-31）大屏门店矩阵行点击下钻单店明细：标记"当前这次单店视图
    // 是从全国大屏点击某一行下钻进来的"，驱动"‹ 返回全国大屏"胶囊的显示，
    // 与 isAllStoresMode/showNationalDashboard 是两个维度——后两者描述"现在
    // 展示的是不是全国大屏"，这个字段描述"如果现在展示的不是，是不是刚从
    // 全国大屏下钻过来的"，见 onDrillDownStore/onReturnToNationalDashboard
    drilledDownFromNational: false,
    // 🏠 门店人员与服务人群画像：仅单店视角下有值，来自 manageStoreProfile 云函数
    storeProfile: null as any,
    // 🆕 骨架屏判据：仅在"首次请求还在飞、且还没有任何数据可展示"时才展示骨架屏，
    // 与 storeProfile===null 区分开——storeProfile 为 null 也可能是"已加载完成、
    // 确认没有画像数据"，不能仅凭它是否为空来判断是否该显示骨架屏
    storeProfileLoading: false,
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
    // 🆕 排行榜 Tab 切换：合并原先纵向堆叠的「餐报活跃度」「服务人次」两个榜单，
    // 改为单一列表 + Tab 切换，纯客户端状态，不触发重新请求
    rankingTab: 'active' as 'active' | 'diners',
    // 🆘 支援预警队列：由 formatNationalMatrixData 派生，按风险得分降序，
    // 只含得分 > 0 的门店。纯前端计算，不需要额外云函数请求
    supportNeededStores: [] as any[],
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
    // 📸 全网影像卷宗：来自 superAdminInsights，超管专属
    nationalMediaGallery: [] as Array<{ url: string; type: string; date: string; storeName: string; orgTypeLabel?: string; loadError?: boolean }>,

    // 🔢 义工与用餐服务数据看板·动画展示值：与 nationalData 里的原始数值分离，
    // 独立由 animateCareCountUp 逐帧驱动 0 → 目标值缓动，nationalData 本身
    // 不参与动画（避免其他读取 nationalData 原始字段的地方被中间态数值污染）
    careDisplay: {
      dineIn: 0,
      delivery: 0,
      takeaway: 0,
      listen: 0,
      onDutyVolunteers: 0,
      deliveryVolunteers: 0,
      volunteerHours: 0,
      totalDiningCount: 0,
      totalVolunteerPersonTimes: 0,
      totalServicePersonTimes: 0
    } as Record<string, number>,

    // 🆕 全国大屏门店选择范围：'national' 全国总览（默认，向后兼容旧行为）/
    // 'region' 按省份·城市分组筛选/'custom' 自定义勾选多家门店对比。三者互斥，
    // 由 onSuperAdminSelectStore 的 storePickerArray 三个固定入口驱动切换，
    // 见 loadNationalDashboard() 里据此拼装 getNationalDashboard 的筛选传参
    nationalFilterMode: 'national' as 'national' | 'region' | 'custom',
    // 🆕 门店目录：{storeId,storeName,province,city}[]，来自 getStoreList 云函数
    // （本就按 tenantId 隔离，见该云函数注释），供下面"按地区筛选"的省市级联
    // picker 与"自定义门店对比"勾选列表共用同一份数据源，避免重复查询
    storeDirectory: [] as any[],
    provincePickerOptions: ['全部省份'] as string[],
    cityPickerOptions: ['全部城市'] as string[],
    selectedProvinceIndex: 0,
    selectedCityIndex: 0,
    selectedProvince: '',
    selectedCity: '',
    showRegionFilterModal: false,
    // 🐛 省份/城市改为弹窗内嵌式下拉列表（而非原生 <picker>）后，这两个字段
    // 分别控制各自选项面板的展开/收起——同一时间只允许一个展开，见
    // onToggleProvinceDropdown/onToggleCityDropdown 的互斥逻辑
    showProvinceDropdown: false,
    showCityDropdown: false,
    showCustomStoreModal: false,
    // 已确认生效的自定义门店勾选结果（storeId 数组）
    customStoreSelection: [] as string[],
    // 🐛 弹窗内勾选的草稿态：每个门店项在自己身上直接带一个 checked 布尔字段，
    // 而不是另外维护一个"已勾选 storeId 列表"再靠 array.includes() 反推每一行
    // 是否勾选——后者是"顶层数组 + wx:for 循环变量"混合表达式，WXML 对这类跨
    // 作用域计算表达式的重渲染依赖追踪并不可靠，setData 更新那个顶层数组后
    // checkbox 的 checked 属性不一定会跟着刷新，导致勾选图标和真实选中状态脱节。
    // customStoreDraftList[i].checked 是 wx:for 列表单项状态更新的标准写法（用
    // 精确下标路径 setData），能可靠触发对应那一行的重渲染
    // 🆕 matchesSearch：门店名称搜索框的过滤结果落在这个同作用域字段上（wx:if
    // 直接判断，而不是在 wx:for 表达式里对顶层 keyword 变量和循环变量 store 做
    // 混合计算——同样是为了避开上面 checked 那类跨作用域表达式的重渲染追踪问题），
    // 搜索框内容变化时对整个列表重新 map 一遍、一次性 setData
    customStoreDraftList: [] as Array<{ storeId: string; storeName: string; province: string; city: string; checked: boolean; matchesSearch: boolean }>,
    customStoreDraftCheckedCount: 0,
    customStoreSearchKeyword: '',
    // 🆕 "按省份一键全选"筛选条：从 customStoreDraftList 派生的去重省份列表，
    // 供顶部快捷芯片使用，点击后把该省份下所有门店一次性勾选
    customStoreProvinceChips: [] as string[],

    // 🌟 超管专属高阶治理看板：核心指标/时间切片/离线门店预警/CSV 报表导出，见 getNationalDashboard
    // 云函数 superAdminInsights（服务端已按 role==='super_admin' 二次校验，非超管拿到的字段恒为 null）
    superAdminInsights: null as any,
    nationalRangeType: 'all' as 'all' | '7d' | 'month' | 'quarter' | 'year',
    nationalRangeOptions: [
      { value: '7d', label: '近7天' },
      { value: 'month', label: '本月' },
      { value: 'quarter', label: '本季度' },
      { value: 'year', label: '本年' },
      { value: 'all', label: '全部时间' }
    ],
    // 一键快筛：门店矩阵表按"正常运营/需关注预警"二选一展示，见 nationalMatrixList wx:if
    storeMatrixFilter: 'normal' as 'normal' | 'risk',
    showNationalReportModal: false,
    nationalReportSelection: { operations: true, financeAudit: false },
    generatingNationalReport: false,
    // 🆕（2026-08-31）机构多店合并阳光台账 Excel 导出：与上面 CSV 报表弹窗
    // 状态字段独立，避免两条导出通道的 loading/弹窗开关互相干扰
    showNationalExcelExportModal: false,
    generatingNationalExcelExport: false,
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
    // 🆕 导出配置弹窗：底部「导出当前周期 Excel 账本」快捷入口此前直接导出
    // "当前正在看的周期"，用户点完不清楚会导出哪段数据——现在先弹这一步，
    // 显式选定周期类型 + 年/月，再复用已有的 exportToExcel()（核对 → 确认 →
    // 生成 → 下载）走完整链路
    showExportConfigModal: false,
    exportConfigTab: 'month' as 'week' | 'month' | 'year',
    exportConfigYear: new Date().getFullYear(),
    exportConfigMonth: new Date().getMonth() + 1,
    // 🔐 专业版功能拦截弹窗：见 components/feature-locked-modal，
    // planUpgradeFeatureName 是具体触发这次拦截的功能名，拼进弹窗文案
    showPlanUpgradeModal: false,
    planUpgradeFeatureName: '',
    // 🆕（2026-08-31 商业化权益中心）机构 SaaS 权益看板：与上面的
    // feature-locked-modal（单一功能被拦截时的轻量引导）是两个不同场景——
    // 这个是用户主动点开"查看我的套餐用量"，展示完整的门店席位进度条 +
    // 三项衍生能力开通状态，不涉及具体定价文案（唯一定价真源仍是
    // profile.ts 的 showSubscriptionModal，见 onOpenPlanUpgradeModal 注释）
    showSaasBenefitsModal: false,
    // 🌾（2026-08-31 商业化生态延伸）爱心粮油源头集采直通车·意向说明弹窗
    showProcurementModal: false,
  },

  onLoad(options: any) {
    recordRecentVisit('/pages/statistics/statistics', '统计分析');

    // 🐛 根因修复：此前只解构 shopName/autoShowExport/view 三个参数，Profile
    // 「财务稽核专区」新增携带的 viewMode/tab/action 完全没人读，日志里才会打出
    // "{ viewMode: undefined }"——不是参数没传，是 onLoad 压根没解构它们。这里
    // 统一补齐，每个参数都做合法值校验，非法/缺失值一律走各自默认分支，不把
    // undefined 原样写进 setData
    const viewModeParam = options && options.viewMode;
    const tabParam = options && options.tab;
    const actionParam = options && options.action;
    console.log('[Statistics][onLoad] 入参解构结果：', {
      shopName: (options && options.shopName) || undefined,
      viewMode: viewModeParam || undefined,
      tab: tabParam || undefined,
      action: actionParam || undefined,
      autoShowExport: (options && options.autoShowExport) || undefined
    });

    if (options && options.shopName) {
      this.setData({ shopName: options.shopName });
    }

    // 💰 Profile「财务稽核专区」跳转标记：viewMode 是页面既有的"全店汇总/个人
    // 统计"（super_admin 专属开关）字段，这里统一持久化落进同一个字段，而不是
    // 另开一个——loadStatistics()/fetchStatistics() 已经在读 this.data.viewMode，
    // 不持久化的话下游统一读取到的永远是 undefined（此前的根因）。
    // financeEntryMode 只认字面量 'finance'，其余取值（含 undefined）一律按
    // 普通入口处理，不额外收窄任何数据权限——它只影响 UI 层的 Banner 收起/
    // 核心指标优先展示，真正的角色权限仍以 initUserRole() 解析出的 isFinance 为准
    if (viewModeParam) {
      this.setData({
        viewMode: viewModeParam,
        financeEntryMode: viewModeParam === 'finance'
      });
    }

    // 🎯 tab 驱动的落地焦点：☀️ 阳光大盘 / 📋 账目流水明细此前无论从哪个入口
    // 进来都同时展示、毫无差别——entryFocus 才是真正的差异化开关（见 wxml
    // sunshine-board-card / ledger-list-container 各自的 wx:if），这里只负责
    // 解析意图 + 记一个滚动锚点 id，两块卡片本身与 statistics.recordCount 无关、
    // 渲染时机不依赖数据是否已加载完成，scroll-into-view 在 onLoad 这一刻设置
    // 即可稳定生效，不需要等 loadStatistics() 回来
    if (tabParam === 'sunshine') {
      // 阳光大盘不是 week/month/year/custom 那套"周期 Tab"的一员（它展示的是
      // getSunshineLedger 的独立公开数据管线，不受周期切换影响），不改写 currentTab
      this.setData({ entryFocus: 'sunshine', scrollIntoViewId: 'sunshineBoardAnchor' });
    } else if (tabParam === 'ledger') {
      // 🗂️ 财务专区「门店账目明细」的落地锚点：账目流水明细按当前 currentTab
      // 周期口径取数（见 buildLedgerRecords 的调用点），"月报"（逐日摊开）是
      // 最贴近"账目明细"语义的默认周期
      this.setData({ entryFocus: 'ledger', currentTab: 'month', scrollIntoViewId: 'ledgerListAnchor' });
    } else if (tabParam) {
      if (['week', 'month', 'year', 'custom'].indexOf(tabParam) !== -1) {
        this.setData({ currentTab: tabParam });
      }
    }

    // 🐛 根因修复：兼容旧的 autoShowExport=true 与新的 action=export 两种写法，
    // 语义完全相同——但不再直接置位 _autoShowExportPending 让首次数据灌好后
    // 自动跑 exportToExcel()（该方法会用当前默认周期的数据做空值校验，默认
    // 周期大概率没数据，会被 Toast 拦截、配置弹窗永远弹不出来）。改为无条件
    // 直接拉起导出配置弹窗（见 openExportConfigModal），让用户自主选定年/月，
    // 空值校验交给用户确认选择之后
    const autoOpenExportConfig = (options && options.autoShowExport === 'true') || actionParam === 'export';
    // 大家长从"全国数据看板"入口跳转而来，角色落地后自动切入全国视图。
    // filterMode==='national' 一并识别（预留的等价入参写法，目前尚无实际跳转
    // 携带这个参数，但语义与 view=national 完全等价，不应该被漏判）
    const isNationalIntent = !!(options && (options.view === 'national' || options.filterMode === 'national'));
    if (isNationalIntent) {
      (this as any)._autoNationalIntent = true;
    }

    this.sanitizeDateVariables();
    if (autoOpenExportConfig) {
      this.openExportConfigModal('month');
    }
    this.calculateNavBarHeight();
    this.initCustomDates();
    this.initUserRole();
    // 🐛 根因修复（并发雪崩）：明确是"直接进全国大屏"的入口跳转时，本页当前
    // 门店的 loadShopList()/getReports（单店报表列表、门店选择器计数）与全国
    // 大屏是两套完全独立、互不重叠的数据源——national 视图不渲染任何依赖它们
    // 的 UI（stats-content 整块被 wx:if="{{!showNationalDashboard}}" 隐藏），
    // 调度这次刷新纯属陪跑，还会跟 initUserRole() 触发的 loadNationalDashboard/
    // getPatriarchDashboard 抢占同一时间窗口的云函数并发配额，是"路由超时警告
    // +多个云函数互相排队"的根因之一。跳过调度，全国视图自己的数据完全由
    // applyRolePermissions() 里的 _autoNationalIntent 分支驱动
    if (!isNationalIntent) {
      this.scheduleReloadStats();
    }
    // 🐛 见 _skipNextShowReload 声明处注释：冷启动紧随其后的第一次 onShow 不用
    // 再重复调度一次 reloadShopListAndStats()——不管上面是否跳过了 onLoad 自己
    // 的这次调度，national 入口同样不需要 onShow 补一次
    this._skipNextShowReload = true;
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
    if (this._careCountUpTimer) {
      clearInterval(this._careCountUpTimer);
      this._careCountUpTimer = null;
    }
    if (this._reloadStatsDebounceTimer) {
      clearTimeout(this._reloadStatsDebounceTimer);
      this._reloadStatsDebounceTimer = null;
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
    // 🐛 根因修复：冷启动时 onLoad 已经调度过一次 reloadShopListAndStats()，
    // 紧随其后的这第一次 onShow 不需要再调度第二次——见 _skipNextShowReload
    // 声明处注释。只跳过这一次，之后任何"用户切走再切回本页"的正常 onShow
    // 依然会照常刷新，不受影响
    if (this._skipNextShowReload) {
      this._skipNextShowReload = false;
    } else {
      this.scheduleReloadStats();
    }
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
    // 🆕 大家长可见全国数据看板（高级版专属，内部再做订阅二次校验）
    const canViewNationalDashboard = isSuperAdmin || isPatriarch;
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
      // 🐛 super_admin 专属默认值补位：viewMode 的 data 初始值已改为 ''（见该
      // 字段声明处注释），这里只在"确实还没有任何取值"时才补一次 'all'——
      // 保留原有 UX（超管首次看到统计页时"全店汇总"默认高亮），同时不覆盖
      // 用户已经手动切过的 'personal'（onShow/角色刷新会重复调用本方法）。
      // 非超管分支原样透传 this.data.viewMode，不做任何改写——它可能是初始的
      // ''，也可能是 onLoad 解析 ?viewMode=finance 后已经写入的 'finance'
      viewMode: isSuperAdmin ? (this.data.viewMode || 'all') : this.data.viewMode,
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
      // 大家长快捷入口可见（在单店视图时显示"全国数据看板 ↗"浮动按钮）
      showNationalDashboardEntry: isPatriarch,
      dashboardTitle: '🌐 全网爱心矩阵数据大屏',
      dashboardRoleTag: ''
    });

    // ☀️ 阳光大盘：与角色是否为"管理者"无关（getSunshineLedger 本身不做权限
    // 校验），管理视图/个人视图都渲染这张卡片，这里统一在角色（含 storeId）
    // 落地后触发一次，不放进下面 showPersonalView/else 各自的分支里重复触发
    this.fetchSunshineBoardData();

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

      // 🐛 根因修复（大家长大屏门禁逻辑断层）：此前 shouldDefaultToNational
      // 硬编码只看 isSuperAdmin，完全没有把大家长纳入判断——大家长只能通过
      // profile「全国数据看板」入口携带 ?view=national 跳转、由下方
      // _autoNationalIntent 分支临时触发一次 _triggerPatriarchNationalView()
      // 进全国视图，但 initUserRole() 缓存命中 + 网络角色请求落地会各自独立
      // 触发一次本方法（见文件其余处"两次 applyRolePermissions()"的既有注释），
      // _autoNationalIntent 在第一次调用里就被消费清空，第二次调用完全没有
      // 任何信号能让 shouldDefaultToNational 判真，于是这里重新把
      // isAllStoresMode 覆写回 false——全国大屏"看一眼就被打回单店"，控制台
      // 日志表现为 "currentUserRole: store_patriarch, showNationalDashboard:
      // false"。现在补两个大家长专属信号：
      //   ① isPatriarchNationalIntent：本次调用确实是从 view=national 跳转
      //      触发的（与此前 headingStraightToNational 语义相同）
      //   ② isPatriarchStayingNational："粘性"信号——读取本次 setData 之前
      //      的 isAllStoresMode（上一次调用已经进入全国视图），避免重复调用
      //      把已经建立好的全国视图状态悄悄打回单店。大家长没有 super_admin
      //      那种能在门店选择器里选中"全国总览"哨兵值的入口（store-picker
      //      组件里"全国总览"虚拟条目严格限定 super_admin 专属），因此不能
      //      照搬 super_admin 那套 getSelectedStore() 判断，只能靠这个粘性
      //      信号在多次调用之间保持视图连续
      const isPatriarchNationalIntent = isPatriarch && !!(this as any)._autoNationalIntent;
      const isPatriarchStayingNational = isPatriarch && this.data.isAllStoresMode;
      const shouldDefaultToNational = isSuperAdmin
        ? (!finalShopName || rawSelectedIsNational)
        : (isPatriarchNationalIntent || isPatriarchStayingNational);

      this.setData({
        shopName: shouldDefaultToNational ? '全部门店' : finalShopName,
        isAllStoresMode: shouldDefaultToNational
      });
      this.fetchStoreProfile();
      // 🐛 根因修复（并发雪崩）：进全国大屏时，单店营运的资源续航卡片根本不会
      // 渲染（wxml 里只在非全国视图分支展示），这里提前查一次 getPatriarchDashboard
      // 纯属浪费一次云函数调用，还会跟马上发起的 loadNationalDashboard 抢占
      // 并发配额，是"进入全国大屏卡顿"的根因之一——只在确定不进全国视图时才加载
      if (isPatriarch && !shouldDefaultToNational) {
        // 🆕 家长专属：资源储备/资金物资兜底/续航预警——与店长/财务共用的
        // 单店营运卡片是两套不同的数据源，单独加载
        this.loadPatriarchResourceStats();
      }
      if (shouldDefaultToNational) {
        this.setData({ showNationalDashboard: true });
        // 意图信号一旦被消费（用于本次判定 shouldDefaultToNational 为真）
        // 就清空，避免残留到未来某次用户已经主动切回单店后的调用里，被
        // isPatriarchStayingNational 判定接手前又意外再次触发
        if (isPatriarchNationalIntent) {
          (this as any)._autoNationalIntent = false;
        }
        // 🏛️ 架构共识（工作空间 vs 全国大屏双轨制，见 CLAUDE.md）：全国大屏
        // 查看权限不挂钩订阅套餐，大家长与超管待遇一致，这里不再做任何订阅
        // 拦截（历史上 _triggerPatriarchNationalView 曾经做过，已在更早的
        // 修复中移除，见该方法头部注释）
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

  // ☀️ 阳光大盘：数据源与首页阳光账本弹窗同一个公开只读云函数 getSunshineLedger
  // （见 pages/index/index.ts fetchSunshineLedgerData），这里独立实现一份而不是
  // 跨页面复用状态——两个页面的加载时机/周边状态完全不同，共享一份 setData 反而
  // 会把两边的生命周期耦合在一起
  async fetchSunshineBoardData(yearMonth?: string) {
    if (this.data.sunshineBoardLoading) return;
    const storeId = this.data.currentUserStoreId;
    // 🛡️ 超管处于"全部门店"聚合视图、或角色/门店尚未解析出来时，压根没有单一
    // storeId 可查——阳光账本口径与 getSunshineLedger 云函数一致，不支持跨店
    // 聚合，静默跳过即可，不额外弹 Toast 打扰
    if (!storeId) return;

    this.setData({ sunshineBoardLoading: true });
    try {
      const now = new Date();
      const targetYearMonth = yearMonth || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const res: any = await callFunctionWithTimeout({
        name: 'getSunshineLedger',
        data: { storeId, yearMonth: targetYearMonth }
      });
      const result = res.result;
      if (!result || !result.success) {
        console.warn('[fetchSunshineBoardData] 加载阳光账本失败:', result && result.error);
        return;
      }

      const ledgerData = {
        storeName: result.storeName || '',
        periodLabel: result.periodLabel || '',
        auditedReportsCount: result.auditedReportsCount || 0,
        totalDiners: result.totalDiners || 0,
        monthlyDiners: result.monthlyDiners || 0,
        takeawayMeals: result.takeawayMeals || 0,
        totalHours: result.totalHours || 0,
        volunteerCount: result.volunteerCount || 0,
        operatingDays: result.operatingDays || 0,
        ledgerPublicRate: result.ledgerPublicRate || null
      };
      const concept = computeSunshineConceptCopy(result.orgType || '', ledgerData.storeName || this.data.currentUserStoreName);

      this.setData({
        sunshineBoardData: ledgerData,
        sunshineConceptTitle: concept.title,
        sunshineConceptLabel: concept.label,
        sunshineConceptContent: concept.content,
        sunshineBoardCards: [
          { label: '累计就餐人次', value: String(ledgerData.totalDiners) },
          { label: '当月就餐人次', value: String(ledgerData.monthlyDiners) },
          { label: '已核销餐报篇数', value: String(ledgerData.auditedReportsCount) },
          { label: '爱心送餐份数', value: String(ledgerData.takeawayMeals) },
          { label: '安全营运天数', value: String(ledgerData.operatingDays) },
          { label: '账本公开率', value: ledgerData.ledgerPublicRate || '暂无数据' }
        ]
      });
    } catch (err) {
      console.error('[fetchSunshineBoardData] 加载阳光账本异常:', err);
      reportCloudSdkErrorIfCorrupted(err);
    } finally {
      this.setData({ sunshineBoardLoading: false });
    }
  },

  // ⓘ 阳光大盘标题旁的说明图标：只做理念/宣言说明，与数据大盘解耦——用户点开
  // 统计页时看到的第一屏是真实数据，不是一个必须先关掉才能看数据的宣言弹窗
  onOpenSunshineConceptModal() {
    this.setData({ showSunshineConceptModal: true });
  },

  onCloseSunshineConceptModal() {
    this.setData({ showSunshineConceptModal: false });
  },

  // 🆕 家长专属资源续航看板：复用 getPatriarchDashboard 云函数（该函数早已把
  // store_patriarch 的 storeId 硬锁定为调用者自己绑定的门店，见其 resolveTarget，
  // 不接受客户端传参指定查其他门店），只在本页面重新映射展示字段，不重复实现
  // 权限校验逻辑
  async loadPatriarchResourceStats() {
    // 🐛 根因修复（并发雪崩）：与 loadNationalDashboard() 同一个根因——initUserRole()
    // 缓存命中 + 网络角色请求落地各触发一次 applyRolePermissions()，isPatriarch
    // 分支此前无条件调用本方法，两次都会各自打一次 getPatriarchDashboard。用
    // patriarchStatsLoading 本身当请求中防重标志位，避免同一时刻发起第二次
    if (this.data.patriarchStatsLoading) return;
    this.setData({ patriarchStatsLoading: true });
    try {
      const res: any = await callFunctionWithTimeout({
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
      reportCloudSdkErrorIfCorrupted(err);
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
        const statsRes: any = await callFunctionWithTimeout({ name: 'getVolunteerHonorStats' });
        const statsResult = statsRes.result;
        if (statsResult && statsResult.success) {
          diningCount = statsResult.diningCount || 0;
        }
      } catch (statsErr) {
        console.warn('[loadPersonalDashboard] 个人荣誉数据查询失败，展示为 0:', statsErr);
        reportCloudSdkErrorIfCorrupted(statsErr);
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
          const qrRes: any = await callFunctionWithTimeout({
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
      reportCloudSdkErrorIfCorrupted(err);
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
      this.setData({ storeProfile: null, storeProfileLoading: false });
      return;
    }
    this.setData({ storeProfileLoading: true });
    try {
      const res: any = await callFunctionWithTimeout({
        name: 'manageStoreProfile',
        data: { action: 'get', storeName: this.data.shopName }
      });
      const result = res?.result;
      if (result?.success && result.data) {
        // 🆕 人群画像进度比例条：把 7 个原始计数归并成 4 个可视化分组
        // （党员/志愿者体系=社工+志愿者/长者服务对象=堂食+送餐+倾听/其他），
        // 算出各自占总人数的百分比，供 WXML 的分段比例条 + 图例使用。
        // 这里只做一次算术派生，不额外发起云调用
        const data = result.data;
        const party = Number(data.partyMembers) || 0;
        const volunteers = (Number(data.socialWorkers) || 0) + (Number(data.volunteersCount) || 0);
        const elderly = (Number(data.dineInSeniorsCount) || 0) + (Number(data.deliverySeniorsCount) || 0) + (Number(data.listeningSeniorsCount) || 0);
        const other = Number(data.otherCount) || 0;
        const profileTotal = party + volunteers + elderly + other;
        const pct = (n: number) => profileTotal > 0 ? Math.round((n / profileTotal) * 1000) / 10 : 0;
        this.setData({
          storeProfile: {
            ...data,
            profileTotal,
            partyRatioPct: pct(party),
            volunteerRatioPct: pct(volunteers),
            elderlyRatioPct: pct(elderly),
            otherRatioPct: pct(other)
          }
        });
      } else {
        this.setData({ storeProfile: null });
      }
    } catch (err) {
      console.error('[fetchStoreProfile] 获取门店人员画像失败:', err);
      reportCloudSdkErrorIfCorrupted(err);
      this.setData({ storeProfile: null });
    } finally {
      this.setData({ storeProfileLoading: false });
    }
  },

  // 🆕 SWR 快照读取：命中且未过期、版本匹配时直接渲染，返回 true；否则不做
  // 任何事情，返回 false 交由调用方走原有的 loading 骨架屏路径。快照只覆盖
  // "首屏展示"这一份数据，不包含 nationalDashboardLoading/nationalDashboardError
  // 这类瞬时状态字段——那些应该由本次真实请求的结果决定，不能被缓存值污染

  // 🐛 根因修复：statistics.wxml 里 honor-modal-box 的 catchtap="stopPropagation"
  // （阻止点击卡片内部时冒泡到外层 mask 触发关闭）一直引用着这个方法名，但本页
  // 此前从未定义过它——每次点击都会在开发者工具触发一次 "does not have a method
  // 'stopPropagation'" 的控制台告警（catch 绑定即使方法不存在也照样会阻止冒泡，
  // 所以功能表现正常，只是控制台一直在报噪音）。项目里其余页面（profile/index/
  // history 等）都已经各自定义了这个同名空方法，这里补齐，不改变任何交互行为，
  // 只是让绑定真正解析到一个存在的函数，消除告警
  stopPropagation() {},


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
          // 🐛（2026-08-31 紧急修复）原来只认原生数组形状、静默丢弃字符串形状
          // 的本地缓存（不报错但也读不到数据），改用 getLocalReports() 两种
          // 形状都能正确读出，见 dataService.ts 该函数头部注释
          allRecords = getLocalReports();
          // 🛡️ 二级审核门槛：同一条口径，绕开 approvedOnly 过滤的本地兜底直读
          // 也必须重新套用一遍
          allRecords = allRecords.filter((r: any) => r && (r.approvalStatus === 'APPROVED' || r.approvalStatus === 'AUDITED_LOCKED'));
        } catch (localError) {
          console.warn('[Statistics] 本地缓存读取失败:', localError);
        }
      }

      const shopCountMap = new Map<string, number>();
      allRecords.forEach((item: any) => {
        if (item.shopName && item.shopName.trim()) {
          const name = item.shopName.trim();
          shopCountMap.set(name, (shopCountMap.get(name) || 0) + 1);
        }
      });

      // 🛡️ 门店隔离：仅 super_admin 才允许在下拉里看到/选到"全部门店"聚合选项，
      // 与 canViewAllStoresDropdown（严格收窄到 super_admin）保持同一条权限口径。
      const isSuperAdmin = this.data.canViewAllStoresDropdown;

      if (isSuperAdmin) {
        // 🐛 根因修复："全国总览"胶囊点击无反应：此前 storePickerArray 完全依赖
        // allRecords（report_logs 已核对记录）是否非空才会被构建——全新租户/
        // 门店尚未产生任何已核对记录时 allRecords 为空，storePickerArray 永远
        // 停留在初始值 []，wxml 的 picker 渲染条件
        // canViewAllStoresDropdown && storePickerArray.length > 0 恒为 false，
        // 页面只能落到 wx:else 的纯展示"锁定态"分支——那根本不是可点击的
        // picker（没有 bindtap/bindchange），点击自然毫无反应，视觉上只是恰好
        // 紧挨着一个 role-tag-badge，容易被误判成"被角标挡住了"。改为超管的
        // 门店选择器改从权威的 stores 目录（getStoreList 云函数，本就按
        // tenantId 隔离）构建，不再要求"至少有一条已核对报表"这个前提条件
        // 复用 ensureStoreDirectory() 同一份门店目录缓存（也是"按地区筛选"/
        // "自定义门店对比"两个弹窗依赖的数据源），避免与它们各自发起一次
        // 重复的 getStoreList 云调用
        await this.ensureStoreDirectory();
        const storeDirectoryList = this.data.storeDirectory;

        // 以 stores 目录里的真实门店名为主（覆盖"零报表"新门店）；同时并入
        // report_logs 里出现过、但目录中找不到的门店名（历史遗留/未在 stores
        // 集合正式注册的门店，见 getNationalDashboard 的 fallbackStoreMap 兜底
        // 同款场景），两者取并集，避免这批"有数据但没档案"的门店从列表里消失
        const directoryNames = storeDirectoryList.map((s: any) => s.storeName).filter(Boolean);
        const recordOnlyNames = Array.from(shopCountMap.keys()).filter(
          (name: string) => !directoryNames.includes(name)
        );
        const shopNames = directoryNames.concat(recordOnlyNames);

        const shopList = ['全部门店'].concat(
          shopNames.map((name: string) => {
            const count = shopCountMap.get(name) || 0;
            return count > 0 ? `${name} (${count}条记录)` : name;
          })
        );

        // 🆕 "📍 按地区筛选"/"🏬 自定义门店对比" 是两个入口占位项（storeId 用
        // 专属哨兵值标记，仅供 onSuperAdminSelectStore 内部判断选中项类型用），
        // 选中后不直接切店，而是弹出对应筛选弹窗，见该方法
        const storePickerArray = [
          { shopName: '🌐 全国总览', storeId: 'ALL' },
          { shopName: '📍 按地区筛选', storeId: 'REGION_FILTER' },
          { shopName: '🏬 自定义门店对比', storeId: 'CUSTOM_STORES' }
        ].concat(
          shopNames.map((name: string) => {
            const matched = storeDirectoryList.find((s: any) => s.storeName === name);
            return { shopName: name, storeId: (matched && matched.storeId) || '', recordCount: shopCountMap.get(name) || 0 };
          })
        );

        const currentShopName = this.data.shopName;
        let selectedIndex = 0;
        if (currentShopName) {
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

        this.setData({
          shopList,
          selectedShopIndex: selectedIndex,
          shopName: selectedIndex === 0 ? '全部门店' : shopList[selectedIndex].replace(/\s*\(\d+条记录\)$/, ''),
          showAllStoresOption: shopList.length > 1,
          storePickerArray
        });
      } else if (allRecords.length > 0) {
        // 非超管：维持原有口径不变——不信任 allRecords 里可能混进来的其他门店名
        // （哪怕 getReports 云函数已经做了服务端强隔离，本地缓存 local_report_logs
        // 仍可能是共享设备上残留的旧数据），只用 applyRolePermissions 已经从服务端
        // 角色信息里解析出的 currentUserStoreName 作为唯一权威来源。storePickerArray
        // 保持默认空值——非超管的门店选择器渲染分支（wxml）本就不会读取它
        const ownStoreName = this.data.currentUserStoreName || this.data.shopName || '';
        const shopNames = ownStoreName ? [ownStoreName] : [];
        const shopList = shopNames.map(name => {
          const count = shopCountMap.get(name) || 0;
          return count > 0 ? `${name} (${count}条记录)` : name;
        });
        if (shopList.length > 0) {
          this.setData({
            shopList,
            selectedShopIndex: 0,
            shopName: shopList[0].replace(/\s*\(\d+条记录\)$/, ''),
            showAllStoresOption: false
          });
        }
      }
    } catch (error) {
      console.warn('[Statistics] 加载门店列表失败:', error);
    }
  },

  // 150ms 防抖调度：onLoad/onShow 冷启动背靠背触发时，只让最后一次真正执行，
  // 见 Page() 顶部 _reloadStatsDebounceTimer 注释。只用于这两个生命周期入口——
  // 其余任何用户主动触发的刷新（切 Tab/选门店/改年月）都应该立即响应，不套防抖
  scheduleReloadStats() {
    if (this._reloadStatsDebounceTimer) {
      clearTimeout(this._reloadStatsDebounceTimer);
    }
    this._reloadStatsDebounceTimer = setTimeout(() => {
      this._reloadStatsDebounceTimer = null;
      this.reloadShopListAndStats();
    }, 150);
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

    // 🆕 "按地区筛选"/"自定义门店对比" 是两个入口占位项，选中后不直接当成门店
    // 切换处理——弹出对应筛选弹窗，等用户在弹窗内确认选择后才真正触发
    // loadNationalDashboard()，这里先不动 shopName/showNationalDashboard 等状态
    if (selected.storeId === 'REGION_FILTER') {
      this.openRegionFilterModal();
      return;
    }
    if (selected.storeId === 'CUSTOM_STORES') {
      this.openCustomStoreModal();
      return;
    }

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
      // 🆕 切回"全国总览"或选中具体单店时，清空此前可能残留的地区/自定义筛选态，
      // 避免下次再点开"全部门店"聚合视图时误用上一次的筛选范围
      nationalFilterMode: 'national',
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

  // 🔗 数据联动：切 Tab/翻页/年月选择器/刷新数据这些入口都统一走
  // calculateStats() → loadWeekStatistics()/loadMonthStatistics()/
  // loadYearStatistics() → loadStatistics()，而 ledgerRecords（账目流水明细）
  // 正是在 loadStatistics() 里与 statistics/coreMetrics 同一次 setData 写入
  // 的——两者天生同源同步，不需要再单独维护一个 fetchLedgerDetails()
  // 与 fetchStatistics() 手动配对触发，也不会出现"统计数字刷新了、流水明细
  // 还是上一个周期"的不一致
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
    // 防抖锁：已有请求在途时不再直接丢弃这次调用（那样会丢掉用户最后一次真正
    // 想看的选择），改为记一笔 pending，等在途请求的 finally 解锁后自动补发一次——
    // 补发时会重新从 this.data 读取彼时最新的筛选状态，天然实现"最新参数覆盖"
    if (this.data.statisticsFetchLoading) {
      console.log('[Statistics][fetchStatistics] 已有请求在途，记为待补发');
      this._pendingStatsFetch = true;
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

    // 🐛 根因修复：viewMode 此前非"全部门店"聚合态时被显式置为 undefined，
    // 传给 getStatisticsData 后在调试日志/请求负载里都是一个裸的 undefined，
    // 排查问题时容易被误判成"参数没传上"。这里统一兜底到 this.data.viewMode
    // （页面自身的"全店汇总/个人统计"开关，默认值就是 'all'）——保证这个字段
    // 任何时候都有一个明确、可预期的取值，不再出现 undefined
    const statisticsCallData = {
      shopName: shopName || 'default',
      tabType,
      selectedYear: String(selectedYear),
      selectedMonth: String(selectedMonth).padStart(2, '0'),
      viewMode: this.data.isAllStoresMode ? 'all' : (this.data.viewMode || 'all'),
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
      const res = await callFunctionWithTimeout({
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
      reportCloudSdkErrorIfCorrupted(err);
    } finally {
      this.setData({ statisticsFetchLoading: false });
      // 🆕 Pending Query Buffer：锁在途期间被记下的待补发请求，在这里统一收尾时
      // 触发一次——用最新的 this.data 状态重新发起，覆盖掉本次已经完成、可能
      // 已经过时的结果
      if (this._pendingStatsFetch) {
        this._pendingStatsFetch = false;
        this.fetchStatistics();
      }
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

  // 📋 账目流水明细的周期文案：与 core-metrics-card 头部展示的周期口径保持
  // 一致——currentTab==='month' 时用"YYYY年M月"（tab=ledger 落地默认就是这个
  // 分支），year 用"YYYY年"，week/custom 用实际拿到的起止日期区间。
  // 🐛 根因修复：此前空状态提示是写死的"该周期内暂无账目流水记录"，与用户当前
  // 选中的年月完全没有联动，选中"2026年8月"时提示文案也看不出跟 8 月有关系
  buildLedgerPeriodLabel(startDate: string, endDate: string): string {
    const { currentTab, selectedYear, selectedMonth } = this.data;
    if (currentTab === 'month') return `${selectedYear}年${selectedMonth}月`;
    if (currentTab === 'year') return `${selectedYear}年`;
    return `${startDate} 至 ${endDate}`;
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
    // 在 wx.showLoading() 之前，不会留下未关闭的 loading。
    // 🆕 Pending Query Buffer：不再直接丢弃这次调用——startDate/endDate 是显式
    // 传参（不像 fetchStatistics 能单纯重读 this.data 就拿到最新值），锁在途时
    // 把这次的 (startDate, endDate) 记下来（覆盖上一次记的，只保留最新一次），
    // 等在途请求的 finally 解锁后用这份最新参数自动补发一次
    if (this.data.statisticsLoadLoading) {
      console.log('[Statistics][loadStatistics] 已有请求在途，记为待补发（最新参数）:', startDate, endDate);
      this._pendingStatsLoadArgs = [startDate, endDate];
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
    // 🐛 根因修复：此前非超管一律硬编码传 undefined，不管 this.data.viewMode
    // 实际取值是什么——Profile「财务稽核专区」跳转带来的 ?viewMode=finance 在
    // onLoad 已经持久化进 this.data.viewMode（见该字段声明处注释），却在这里
    // 被无条件抹掉，日志里才会出现"onLoad 解析到 finance，loadStatistics 打印
    // 却是 undefined"的落差。现在统一改为直接读 this.data.viewMode——门店隔离
    // 始终由 storeId 驱动（getReports 服务端只在 viewMode==='personal' 时才会
    // 额外收窄到"仅我自己提交的记录"，其余任何取值含 'finance'/''/undefined
    // 效果等价），这里传什么字符串都不影响实际查询范围，只是让调试日志如实反映
    // 页面当前状态。data 初始默认值已改为 ''（非 'all'，见字段声明处注释），非
    // 超管、且没有任何 URL 覆盖时 this.data.viewMode 仍是 ''，'' || undefined
    // 求值为 undefined，与此前的硬编码行为完全一致，不会给其余角色引入回归
    // 🐛 全局维度参数：isAll（"全部门店"聚合视图）下必须强制传 'all'，不能沿用
    // this.data.viewMode 当前的取值——超管此前若曾把「查看模式」切到"个人统计"
    // （viewMode==='personal'），一旦紧接着又切到"全部门店"，viewMode 不会自动
    // 复位，会把本该聚合全店的查询悄悄收窄成"仅超管自己提交的记录"，与"全部门店"
    // 这个选择的语义完全不符
    const reportsViewMode = isAll ? 'all' : (this.data.viewMode || undefined);
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
          // 🐛（2026-08-31 紧急修复）此处原本已经手写了"数组/字符串两种形状都
          // 兼容"的判断——收敛改用共用的 getLocalReports()（dataService.ts），
          // 逻辑完全一致，避免同一段判断在多处各自维护一份拷贝
          allRecords = getLocalReports();
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
          latestDataLabel,
          // 📋 账目流水明细：filteredData 是本次已经拉到手的当期原始 report_logs
          // 记录，calculateStatistics() 只用它算汇总/日历式 dailyRecords，逐条明细
          // 此前直接丢弃——ledger-list-container（tab=ledger 落地区块）需要的正是
          // 这份逐条原始数据，不是汇总
          ledgerRecords: this.buildLedgerRecords(filteredData),
          ledgerPeriodText: this.buildLedgerPeriodLabel(startDate, endDate)
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
          latestDataLabel,
          ledgerRecords: [],
          ledgerPeriodText: this.buildLedgerPeriodLabel(startDate, endDate)
        });
      }
    } catch (error) {
      console.error('[Statistics] 加载统计数据失败:', error);
      this.setData({
        statistics: null,
        isAllStoresMode: isAll,
        hasOtherStoreData: false,
        currentStoreTotalCount: 0,
        coreMetrics: EMPTY_CORE_METRICS,
        ledgerRecords: [],
        ledgerPeriodText: this.buildLedgerPeriodLabel(startDate, endDate)
      });
    } finally {
      // 🐛 与函数开头的防抖锁配套：wx.showLoading/wx.hideLoading 严格一对一，
      // 无论正常返回还是抛出异常都统一在这里收尾，不再在 try 中段提前 hide
      wx.hideLoading();
      this.setData({ statisticsLoadLoading: false });
      // 🆕 Pending Query Buffer：锁在途期间被记下的最新 (startDate, endDate)，
      // 在这里统一收尾时补发一次——确保用户最后一次真正想看的选择不会被静默丢弃
      if (this._pendingStatsLoadArgs) {
        const [pendingStart, pendingEnd] = this._pendingStatsLoadArgs;
        this._pendingStatsLoadArgs = null;
        this.loadStatistics(pendingStart, pendingEnd);
      }
    }

    // 🌟 导出配置弹窗「确认导出」（onConfirmExportConfig）置位后，本函数是选定
    // 周期被重新灌好数据的地方——消费一次待办标记后立即清零，避免 onShow/切换
    // Tab/年月再次触发本函数时重复弹出核对弹窗
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
      const res: any = await callFunctionWithTimeout({
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
      reportCloudSdkErrorIfCorrupted(err);
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

  // 📋 账目流水明细：逐条映射 getReports 返回的原始 report_logs 记录（不做
  // calculateStatistics() 那种按"门店+日期"去重合并的日历式汇总），每条精确到
  // 日期/收支金额/凭证关联状态/核销状态，供 ledger-list-container 渲染成
  // 银行流水式列表——这是 tab=ledger 落地时用户真正想看的"账目明细"，不是
  // 已经在 core-metrics/finance-compliance 卡片里出现过的那几个汇总数字。
  // 按日期倒序（最新的在最上面），符合"流水"的浏览习惯
  buildLedgerRecords(records: any[]) {
    if (!Array.isArray(records)) return [];

    const STATUS_MAP: Record<string, { label: string; className: string }> = {
      PENDING: { label: '待审核', className: 'pending' },
      APPROVED: { label: '已审核', className: 'approved' },
      AUDITED_LOCKED: { label: '已核销封账', className: 'locked' }
    };

    // 🏷️ 分类 Tag：report_logs 一条记录是"一天的完整报告"（收入+支出混合），
    // 不是单笔交易，天然没有现成的分类字段——复用 calculateStatistics() 同一条
    // "日常食材 vs 专项大额"拆分口径（dailyExpenseTotal/fixedExpenseTotal 字段
    // 优先，缺失时按 FIXED_EXPENSE_KEYWORDS 关键词兜底），按当天实际发生的收支
    // 构成推断出最贴切的展示分类，不臆造一个数据库里不存在的精确分类
    const FIXED_KEYWORDS = ['租金', '房租', '服装', '义工服', '设备', '装修', '采购', '大件', '空调', '冰箱', '冰柜', '桌椅', '改造', '维修', '购置', '大额', '专项'];
    const splitExpense = (item: any, expenseAmount: number): { dailyExpense: number; fixedExpense: number } => {
      const dailyExpenseText = item.dailyExpenseText || item.dailyIngredientText || '';
      const fixedExpenseText = item.fixedExpenseText || item.fixedMajorText || item.remark || '';
      let dailyExpense = parseFloat(item.dailyExpenseTotal) || 0;
      let fixedExpense = parseFloat(item.fixedExpenseTotal) || 0;
      if (dailyExpense === 0 && dailyExpenseText) {
        dailyExpense = this.parseAmountFromText(dailyExpenseText);
      }
      if (fixedExpense === 0 && fixedExpenseText) {
        fixedExpense = this.parseAmountFromText(fixedExpenseText);
      }
      if (dailyExpense === 0 && fixedExpense === 0 && expenseAmount > 0) {
        const textContext = fixedExpenseText || item.expenses || item.remark || '';
        if (FIXED_KEYWORDS.some((kw) => String(textContext).includes(kw))) {
          fixedExpense = expenseAmount;
        } else {
          dailyExpense = expenseAmount;
        }
      }
      return { dailyExpense, fixedExpense };
    };
    const classifyCategory = (income: number, dailyExpense: number, fixedExpense: number): { label: string; className: string } => {
      if (fixedExpense > 0) return { label: '物资采购', className: 'material' };
      if (dailyExpense > 0) return { label: '爱心餐饮', className: 'meal' };
      if (income > 0) return { label: '爱心捐赠', className: 'donation' };
      return { label: '日常运营', className: 'ops' };
    };

    return records
      .map((item: any) => {
        const income = (parseFloat(item.listDonationTotal) || 0) + (parseFloat(item.otherDonation) || 0);
        const expense = parseFloat(item.expenseAmount) || 0;
        const { dailyExpense, fixedExpense } = splitExpense(item, expense);
        const net = income - expense;
        // 🛡️ 凭证图片字段历史上有 receiptImages/receiptImageList 两种叫法并存
        // （见 utils/dataService.ts saveReport 双写说明），两个都要兜底读取
        const receiptImages: string[] = Array.isArray(item.receiptImages) ? item.receiptImages
          : (Array.isArray(item.receiptImageList) ? item.receiptImageList : []);
        const statusInfo = STATUS_MAP[item.approvalStatus] || STATUS_MAP.APPROVED;
        const dateStr = item.dateString || item.reportDate || item.date || '';
        const category = classifyCategory(income, dailyExpense, fixedExpense);

        return {
          id: item._id || `${item.shopName || item.storeId || ''}_${dateStr}`,
          date: dateStr,
          shopName: item.shopName || item.storeName || '',
          // 📡 来源：mpAccount 是提交这份报告时填的"公众号名称"（门店模板自动
          // 填充），report_logs 没有另存一份真人经办人姓名字段——诚实展示实际
          // 存在的数据来源，不为了凑"经办人"栏位而虚构一个不存在的字段
          sourceLabel: item.mpAccount || item.shopName || item.storeName || '本店提交',
          incomeStr: formatMoney(income),
          expenseStr: formatMoney(expense),
          netStr: formatMoney(Math.abs(net)),
          netPositive: net >= 0,
          hasReceipt: receiptImages.length > 0,
          receiptCount: receiptImages.length,
          receiptImages,
          statusLabel: statusInfo.label,
          statusClass: statusInfo.className,
          categoryLabel: category.label,
          categoryClass: category.className
        };
      })
      .sort((a, b) => (a.date < b.date ? 1 : (a.date > b.date ? -1 : 0)));
  },

  // 🧾 点击「凭证」图标：有凭证图片时唤起系统原生大图预览（复用微信内置
  // wx.previewImage，不重复实现一套图片查看器）；没有凭证时给个明确提示，
  // 而不是点了没反应
  onPreviewLedgerReceipt(e: any) {
    const index = e.currentTarget.dataset.index;
    const item = this.data.ledgerRecords[index];
    if (!item || !item.hasReceipt || !item.receiptImages.length) {
      wx.showToast({ title: '该笔记录未上传凭证', icon: 'none' });
      return;
    }
    wx.previewImage({
      urls: item.receiptImages,
      current: item.receiptImages[0]
    });
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

  // 🆕 底部「导出当前周期 Excel 账本」快捷入口：此前直接导出"当前正在看的
  // 周期"，点完用户不清楚导的是哪段数据，也没有任何中间反馈。现在先弹一个轻量
  // 配置弹窗，显式选定周期类型 + 年/月，确认后把选择写回 currentTab/
  // selectedYear/selectedMonth（与 switchTab()/onMonthChange() 是同一份状态），
  // 再借用已有的 _autoShowExportPending 机制——数据重新灌好后自动接上
  // exportToExcel() 的「核对 → 确认 → 生成 → 下载」全流程，不重复实现一套
  onOpenExportConfigModal() {
    const { currentTab } = this.data;
    // custom（自定义区间）没有对应的"月/年"输入项，弹窗里退回月报作为默认选项
    this.openExportConfigModal(currentTab === 'custom' ? 'month' : currentTab);
  },

  // 🐛 根因修复：Profile「Excel 财务报表导出」携带 action=export 跳转进来时，
  // 此前直接置位 _autoShowExportPending，等首次 loadStatistics()（默认周期是
  // "周报"，绝大多数场景下当周无数据）灌完数据后自动调用 exportToExcel()——
  // 该方法一进来就检查 statistics.dailyRecords 是否为空，为空直接弹 Toast 拦截
  // 返回，导出配置弹窗根本没机会弹出。现在改为无条件直接拉起配置弹窗，让用户
  // 自主选定年/月，数据是否为空的校验只在用户选完、点击"确认导出"后针对
  // 那个选定周期发生（见 onConfirmExportConfig → exportToExcel）
  openExportConfigModal(defaultTab: 'week' | 'month' | 'year') {
    const { selectedYear, selectedMonth } = this.data;
    this.setData({
      showExportConfigModal: true,
      exportConfigTab: defaultTab,
      exportConfigYear: selectedYear,
      exportConfigMonth: selectedMonth
    });
  },

  onCloseExportConfigModal() {
    this.setData({ showExportConfigModal: false });
  },

  onSelectExportConfigTab(e: any) {
    const tab = e.currentTarget.dataset.tab;
    if (['week', 'month', 'year'].indexOf(tab) === -1) return;
    this.setData({ exportConfigTab: tab });
  },

  onExportConfigMonthChange(e: any) {
    const rawValue = (e.detail && e.detail.value) || '';
    const parts = String(rawValue).split('-');
    const yearVal = parseInt(parts[0], 10);
    const monthVal = parseInt(parts[1], 10);
    this.setData({
      exportConfigYear: isNaN(yearVal) ? this.data.exportConfigYear : yearVal,
      exportConfigMonth: isNaN(monthVal) ? this.data.exportConfigMonth : monthVal
    });
  },

  onExportConfigYearChange(e: any) {
    const yearVal = parseInt((e.detail && e.detail.value) || '', 10);
    if (isNaN(yearVal)) return;
    this.setData({ exportConfigYear: yearVal });
  },

  onConfirmExportConfig() {
    const { exportConfigTab, exportConfigYear, exportConfigMonth } = this.data;
    this.setData({
      showExportConfigModal: false,
      currentTab: exportConfigTab,
      selectedYear: exportConfigYear,
      selectedMonth: exportConfigMonth,
      statistics: null
    });
    this._autoShowExportPending = true;
    this.calculateStats();
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
      this.onOpenPlanUpgradeModal('Excel 报表导出');
      return;
    }

    this.setData({ isExportPreviewLoading: true });
    wx.showLoading({ title: '正在核对数据...', mask: true });

    try {
      const res = await callFunctionWithTimeout({
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
      reportCloudSdkErrorIfCorrupted(err);
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
    safeNavigateTo({ url: '/pages/history/history' });
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
      const res = await callFunctionWithTimeout({
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
      reportCloudSdkErrorIfCorrupted(cloudErr);
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
        if ((wx as any).shareFileMessage) {
          (wx as any).shareFileMessage({
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

      // 🐛 根因修复（本地文件写满报错）：文件名随周期变化，长期反复导出会
      // 累积大量不再需要的历史 CSV，写满 USER_DATA_PATH 配额。写入失败时
      // writeLocalFileSafe 会先清理同门店前缀的历史导出文件再重试一次
      const written = writeLocalFileSafe(filePath, csvContent, 'utf8', `${safeStoreName}_收支明细_`);
      if (!written) throw new Error('本地表格文件写入失败');
      wx.hideLoading();

      if ((wx as any).shareFileMessage) {
        (wx as any).shareFileMessage({
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
      fileType: 'csv' as any,
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
        const dpr = (wx as any).getWindowInfo ? (wx as any).getWindowInfo().pixelRatio : 2;

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
    } else if ((wx as any).shareFileMessage) {
      (wx as any).shareFileMessage({
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
          const dpr = ((wx as any).getWindowInfo ? (wx as any).getWindowInfo().pixelRatio : 2) || 2;

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
        const result = await callFunctionWithTimeout({
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

      const localRecords = getLocalReports();
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
                const result = await callFunctionWithTimeout({
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
                const localReports = getLocalReports();
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
              const result = await callFunctionWithTimeout({
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
                const localReports = getLocalReports();
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
            const localReports = getLocalReports();
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
