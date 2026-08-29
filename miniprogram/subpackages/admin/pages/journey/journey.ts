/**
 * journey.ts
 * 暖心历程页
 *
 * 功能：
 *  - 顶部热力图：展示最近 30 天 / 12 个月的义工打卡足迹
 *  - 时间轴：按服务类型展示打卡记录，支持折叠/展开动效
 *  - 从首页传递或本地存储读取打卡日志
 */

import { createNavGuard, NavGuardInstance } from '../../../../utils/navGuard';
import { safeParseDate } from '../../../../utils/dateUtils';
import { recordRecentVisit } from '../../../../utils/recentPages';
import { AuthService } from '../../../../utils/authService';
import { isCloudAvailable } from '../../../../utils/cloudGuard';
import { resolveHonorCardStoreName } from '../../../../utils/storeIdentity';
import { drawVolunteerHonorCard, VolunteerHonorData } from '../../../../utils/posterGenerator';
import { computeMyCheckInStats, computeMyCheckInStreak } from '../../../../utils/checkinStats';
import { computeBadgeList as computeBadgeListShared, BadgeItem } from '../../../../utils/badgeWall';
import { callFunctionWithTimeout } from '../../../../utils/withTimeout';

interface CheckInLog {
  timestamp: number;
  date: string;
  time: string;
  shiftKey: string;
  shiftName: string;
  hours: number;
  storeName: string;
  serviceType?: 'reception' | 'kitchen' | 'finance' | 'other';
}

interface StoreStatItem {
  storeName: string;
  days: number;
  hours: number;
  count: number;
}

interface HeatCell {
  date: string;
  dayLabel: string;
  count: number;
  hours: number;
}

interface TimelineGroup {
  monthKey: string;
  monthLabel: string;
  logs: CheckInLog[];
  expanded: boolean;
}

const SERVICE_TYPE_MAP: Record<string, 'reception' | 'kitchen' | 'finance' | 'other'> = {
  'morning_prep': 'kitchen',
  'lunch_service': 'reception',
  'afternoon_cleanup': 'kitchen',
  'finance_audit': 'finance',
  'evening_prep': 'kitchen',
  'weekend_special': 'other'
};

Page({
  _navGuard: null as NavGuardInstance | null,
  _countUpTimers: {} as Record<string, any>,

  data: {
    // 页面元数据（由 navigation-bar 组件 bind:layout 上报，见 onNavLayout）
    navBarTotalHeight: 0,

    // ✨ 动态称谓：由 resolveOrgLabels() 根据 tenantId 派生，默认通用文案
    isYuhuazhai: false,
    pageTitle: '我的志愿历程',
    pageTitleIcon: '🤝',
    pageSubtitle: '每一份付出，都是爱的印记',
    dayLabel: '志愿天数',
    hoursLabel: '志愿工时(h)',
    mealsLabel: '服务人次',
    heatmapTip: '金色越亮、图标越满，代表当日志愿工时越长',
    emptyStateTitle: '开启您的第一次爱心志愿之旅',
    emptyStateDesc: '一份关爱，一份温情。前往首页完成首次签到打卡，点亮您的第一枚爱心足迹吧！',

    // 热力图数据
    heatmapTitle: '近 30 天服务足迹',
    heatmapCells: [] as HeatCell[],
    maxHeatHours: 1,

    // 时间轴数据
    timelineGroups: [] as TimelineGroup[],
    allExpanded: true,

    // 📍 多站点足迹汇总（同一志愿者在多个门店有打卡记录时展示）
    storeStats: [] as StoreStatItem[],

    // 页面状态
    isLoading: true,
    totalDays: 0,
    totalHours: 0,
    totalCount: 0,
    totalMeals: 0,

    // 🆕 志愿者爱心荣誉卡
    isGeneratingHonorCard: false,
    showHonorModal: false,
    honorCardImage: '',
    isSavingHonorCard: false,

    // 🎖️ 3 列勋章墙：解锁规则与 profile.ts 共享（见 utils/badgeWall.ts）
    badgeList: [] as BadgeItem[],
    showBadgeDetailModal: false,
    selectedBadge: null as BadgeItem | null,

    // 🔒 全国纵览：仅 super_admin 可见，聚合本机构全部门店的义工/供餐数据
    isSuperAdmin: false,
    isLoadingNationalSummary: false,
    nationalSummary: {
      totalVolunteers: 0,
      totalServiceDays: 0,
      totalServiceHours: 0,
      totalReportCount: 0,
      totalDiningCount: 0,
      totalActiveStores: 0
    }
  },

  onLoad(options: any) {
    recordRecentVisit('/subpackages/admin/pages/journey/journey', '志愿历程');
    // 🌟 称谓自适应：先同步解析角色缓存，再异步加载数据，两者互不阻塞
    this.resolveOrgLabels();

    // 🐛 性能修复：此前 loadStats/loadHeatmapData/loadTimelineData 在 onLoad 里
    // 同步执行——loadHeatmapData/loadTimelineData 各自独立同步调用一次
    // wx.getStorageSync('my_checkin_logs')，loadStats 经 computeMyCheckInStats/
    // computeMyCheckInStreak（checkinStats.ts）内部又各自触发一次同名同步读取，
    // 同一个 key 在同一次 onLoad 里被连续同步读取 4 次，叠加热力图 30 天循环
    // 过滤、时间轴全量排序分组这类 O(N) 计算全部堆在同步执行栈里，是开发者
    // 工具报"跳转耗时阻塞警告"的根因。这些数字只影响首屏渲染完成后的展示，
    // 不影响转场动画本身——改为异步读取一次 my_checkin_logs 后统一分发给三个
    // 方法复用（loadStats 通过新增的 preFetchedLogs 参数跳过内部重复读取），
    // 把 4 次同步读取收敛成 1 次异步读取，且整体移出 onLoad 的同步执行栈
    this.loadAllLocalCheckInStats();

    this.loadMealStat();
    // 🔒 全国纵览：权限判定 + 数据拉取全部异步、非阻塞，isSuperAdmin 解析出来前
    // wxml 的 wx:if="{{isSuperAdmin}}" 默认 false，不会有"先露一下又收回去"的闪烁
    this.loadNationalSummary();

    this._navGuard = createNavGuard({
      homePath: '/pages/index/index'
    });
    this._navGuard.setupOnLoad();

    // 模拟加载动效
    setTimeout(() => {
      this.setData({ isLoading: false });
    }, 400);
  },

  // 统一异步读取一次 my_checkin_logs，分发给 loadStats/loadHeatmapData/
  // loadTimelineData 复用——用 wx.getStorage（异步）而非 wx.getStorageSync，
  // 不占用 onLoad 的同步执行栈；未写入过打卡记录时 key 不存在会走 fail 回调，
  // 按空数组处理，与原先 wx.getStorageSync(...) || [] 的兜底口径一致
  loadAllLocalCheckInStats() {
    wx.getStorage({
      key: 'my_checkin_logs',
      success: (res: any) => {
        const logs: CheckInLog[] = Array.isArray(res.data) ? res.data : [];
        this.loadStats(logs);
        this.loadHeatmapData(logs);
        this.loadTimelineData(logs);
      },
      fail: () => {
        this.loadStats([]);
        this.loadHeatmapData([]);
        this.loadTimelineData([]);
      }
    });
  },

  onUnload() {
    if (this._navGuard) {
      this._navGuard.teardown();
      this._navGuard = null;
    }
    Object.keys(this._countUpTimers).forEach((key) => clearInterval(this._countUpTimers[key]));
    this._countUpTimers = {};
  },

  onShow() {
    if (this._navGuard) {
      this._navGuard.setupOnShow();
    }
  },

  // navigation-bar 组件按胶囊按钮实测坐标算出真实导航栏高度后通过 layout 事件上报
  onNavLayout(e: { detail: { totalHeight: number } }) {
    this.setData({ navBarTotalHeight: e.detail.totalHeight });
  },

  // ✨ 称谓自适应：读取 tenantId → 判断是否雨花斋 → 派生全部展示文案。
  // 优先同步读缓存（零延迟，页面首帧即正确）；缓存未命中时静默异步补充，
  // 两路都拿不到角色信息时保持通用文案，绝不影响后续数据加载流程。
  // 🐛 根因修复：tenantId 前缀只是历史租户/建店命名空间，同一 tenantId 前缀下
  // 完全可能挂着 elderly_canteen（社区助餐点）等非雨花斋门店——与 profile.ts
  // fetchStoreOrgType() 同一类问题（详见该方法的根因修复注释）。这里先用
  // tenantId 前缀起一个 seed（避免首帧文案空白/闪烁），随后用 fetchRealOrgType()
  // 查到的 stores.orgType 真实值覆盖，避免把社区助餐点误标成"雨花护持"
  resolveOrgLabels() {
    const seedFromTenantId = (tenantId: string) => {
      this.applyOrgLabels(String(tenantId || '').startsWith('yuhuazhai'));
    };

    try {
      const cached = AuthService.getCachedRoleInfo();
      if (cached) {
        seedFromTenantId((cached as any).tenantId || '');
      } else {
        // 缓存缺失：静默异步补充 seed，不阻塞页面其余加载
        AuthService.fetchUserRole().then((res) => {
          const tenantId = (res && res.roleInfo && (res.roleInfo as any).tenantId) || '';
          seedFromTenantId(tenantId);
        }).catch(() => { /* keep generic labels */ });
      }
    } catch (e) { /* ignore */ }

    // 精确覆盖：查真实 stores.orgType，只有它才能分清雨花斋 / elderly_canteen
    // 等具体机构类型，不用 tenantId 前缀猜测兜底
    this.fetchRealOrgType();
  },

  // 派生全部展示文案：雨花斋一套护持向措辞，其余机构（含 elderly_canteen 社区
  // 助餐点）统一走通用志愿向措辞——resolveOrgLabels() 里的 seed 与
  // fetchRealOrgType() 里的精确覆盖共用同一份计算，避免两处文案对不上
  applyOrgLabels(isYuhuazhai: boolean) {
    if (isYuhuazhai) {
      this.setData({
        isYuhuazhai: true,
        pageTitle: '我的护持历程',
        pageTitleIcon: '🌸',
        pageSubtitle: '每一滴汗水，都是爱的印记',
        dayLabel: '护持天数',
        hoursLabel: '护持工时(h)',
        mealsLabel: '护持餐数',
        heatmapTitle: '近 30 天护持足迹',
        heatmapTip: '金色越亮、图标越满，代表当日护持工时越长',
        emptyStateTitle: '开启您的第一次雨花护持之旅',
        emptyStateDesc: '一碗热饭，一份温情。前往首页完成首次签到打卡，点亮您的第一枚爱心足迹吧！'
      });
      return;
    }
    // 通用标签：从雨花斋态切回来时需要显式还原（真实 orgType 覆盖 seed 猜测时
    // 可能发生这种情况），不能假设"非雨花斋就什么都不用做"
    this.setData({
      isYuhuazhai: false,
      pageTitle: '我的志愿历程',
      pageTitleIcon: '🤝',
      pageSubtitle: '每一份付出，都是爱的印记',
      dayLabel: '志愿天数',
      hoursLabel: '志愿工时(h)',
      mealsLabel: '服务人次',
      heatmapTitle: '近 30 天服务足迹',
      heatmapTip: '金色越亮、图标越满，代表当日志愿工时越长',
      emptyStateTitle: '开启您的第一次爱心志愿之旅',
      emptyStateDesc: '一份关爱，一份温情。前往首页完成首次签到打卡，点亮您的第一枚爱心足迹吧！'
    });
  },

  // 🌟 拉取当前绑定门店的真实 orgType（stores.orgType，见 manageStoreProfile
  // 云函数 get 动作），用它覆盖上面 tenantId 前缀猜出来的 seed 文案。查询失败或
  // 未设置 orgType（历史门店）时静默保留 seed 结果，不阻断页面其余加载
  async fetchRealOrgType() {
    if (!isCloudAvailable()) return;
    try {
      const res: any = await callFunctionWithTimeout({
        name: 'manageStoreProfile',
        data: { action: 'get' }
      });
      const orgType = res && res.result && res.result.data && res.result.data.orgType;
      if (!orgType) return;
      this.applyOrgLabels(orgType === 'yuhuazhai');
    } catch (err) {
      console.warn('[journey][fetchRealOrgType] 查询真实机构类型失败:', err);
    }
  },

  // 🐛 数据硬核对齐：此前直接读全局递增计数器（my_checkin_days 等），与首页/个人页
  // 早已迁移到的 computeMyCheckInStats（按 my_checkin_logs 流水动态重算）口径不一致，
  // 同一个人在不同页面可能看到不同的护持天数/工时。改为统一走同一份计算逻辑——
  // "暖心历程"本身是回顾全部足迹的页面，includeAllStores 恒为 true，不受当前选中
  // 门店影响（与下方热力图/时间轴本就展示全部门店记录的口径保持一致）。
  // parseFloat(...) || 0 的双重兜底在 computeMyCheckInStats 内部已处理，这里不会出现
  // NaN/undefined。
  loadStats(preFetchedLogs?: CheckInLog[]) {
    try {
      const stats = computeMyCheckInStats('', '', true, preFetchedLogs);
      const streak = computeMyCheckInStreak('', '', true, preFetchedLogs);
      this.animateCountUp('totalDays', stats.days);
      this.animateCountUp('totalCount', stats.count);
      this.animateCountUp('totalHours', stats.hours);
      const verb = this.data.isYuhuazhai ? '护持' : '服务';
      this.computeBadgeList(stats.days, stats.hours, streak, verb);
    } catch (e) {
      console.warn('[journey] loadStats failed:', e);
    }
  },

  // 🍱 服务人次（餐饮类=护持餐数，通用类=协助服务人次）：与荣誉卡使用同一个云函数的
  // 个人统计动作，按 _openid 服务端真实统计，不在前端编造估算数字；独立于生成荣誉卡
  // 的流程，页面一进来就展示，不用等用户点开荣誉卡弹窗才看到这个数字
  async loadMealStat() {
    try {
      if (!isCloudAvailable()) return;
      const res = await callFunctionWithTimeout({ name: 'getVolunteerHonorStats' });
      const result = res.result as any;
      if (result && result.success) {
        this.animateCountUp('totalMeals', result.diningCount || 0);
      }
    } catch (err) {
      console.warn('[journey] 护持餐数加载失败:', err);
    }
  },

  // 🎖️ 3 列勋章墙：解锁规则与 profile.ts 共享（见 utils/badgeWall.ts），
  // current >= threshold 即视为解锁，不会出现"已达成条件仍显示锁定"的问题
  computeBadgeList(volunteerDays: number, volunteerHours: number, volunteerStreak: number = 0, verb: string = '服务') {
    this.setData({ badgeList: computeBadgeListShared(volunteerDays, volunteerHours, volunteerStreak, verb) });
  },

  onTapBadge(e: any) {
    const id = e.currentTarget.dataset.id;
    const badge = (this.data.badgeList || []).find((b: any) => b.id === id);
    if (!badge) return;
    this.setData({ showBadgeDetailModal: true, selectedBadge: badge });
  },

  onCloseBadgeModal() {
    this.setData({ showBadgeDetailModal: false });
  },

  // 🔢 核心数据数字递增动画：ease-out 缓动，600ms 内从 0 平滑滚动到目标值。
  // 用 setInterval 而非逐帧 requestAnimationFrame——小程序页面态更适合这种轻量
  // 步进定时器，且 onUnload 里统一 clearInterval，不会有页面销毁后仍在跳动的残留计时器
  animateCountUp(field: 'totalDays' | 'totalCount' | 'totalHours' | 'totalMeals', target: number, duration: number = 600) {
    if (this._countUpTimers[field]) {
      clearInterval(this._countUpTimers[field]);
      delete this._countUpTimers[field];
    }

    const isDecimal = field === 'totalHours';
    const steps = 20;
    const stepTime = Math.max(16, Math.round(duration / steps));
    let currentStep = 0;

    if (!target) {
      this.setData({ [field]: 0 });
      return;
    }

    this._countUpTimers[field] = setInterval(() => {
      currentStep++;
      const progress = Math.min(1, currentStep / steps);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = target * eased;
      this.setData({ [field]: isDecimal ? parseFloat(value.toFixed(1)) : Math.round(value) });

      if (progress >= 1) {
        clearInterval(this._countUpTimers[field]);
        delete this._countUpTimers[field];
        // 收尾强制对齐目标值，避免缓动舍入误差导致最终停留在 99.9 这类肉眼可辨的偏差
        this.setData({ [field]: target });
      }
    }, stepTime);
  },

  // 🔒 全国纵览：checkUserRole 权限判定（经 AuthService 封装，与 onGenerateHonorCard
  // 同一套角色解析路径）——只有 isSuperAdmin === true 才请求聚合数据，wxml 端再叠加
  // wx:if="{{isSuperAdmin}}" 双重把关，非管理员既拿不到数据也看不到入口
  async loadNationalSummary() {
    try {
      let roleInfo = AuthService.getCachedRoleInfo();
      if (!roleInfo) {
        const roleResult = await AuthService.fetchUserRole();
        roleInfo = roleResult.roleInfo || null;
      }
      const trueServerRole = (roleInfo && roleInfo.role) || 'volunteer';

      // 🐛 核心修复：与 profile.ts initMinePage() 同一套"手动切换角色优先"口径——
      // 此前这里只看 checkUserRole 缓存的服务端角色快照（roleInfo.role），完全
      // 不理会「选择服务站点与身份」/「切换身份」弹窗手动切换后写入的
      // current_user_role。真超管手动切到店长/义工等展示视角后，本页依旧会把
      // 【全国纵览】这张"超管专属"绿色卡片渲染出来，与个人中心等其它页面的
      // 展示态互相矛盾——表现为"明明当前显示的是普通角色，护持历程页却还挂着
      // 超管专属卡片"。只要 current_user_role 存在就必须以它为准
      const storageRole = wx.getStorageSync('current_user_role');
      const effectiveRole = storageRole
        ? (trueServerRole === 'super_admin' ? storageRole : AuthService.resolveEffectiveRole(trueServerRole))
        : trueServerRole;
      const isSuperAdmin = (effectiveRole || '').toLowerCase() === 'super_admin';
      this.setData({ isSuperAdmin });
      if (!isSuperAdmin) return;

      this.setData({ isLoadingNationalSummary: true });
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用');

      const res = await callFunctionWithTimeout({
        name: 'getVolunteerHonorStats',
        data: { action: 'networkSummary' }
      });
      const result = res.result as any;
      if (result && result.success) {
        this.setData({
          nationalSummary: {
            totalVolunteers: result.totalVolunteers || 0,
            totalServiceDays: result.totalServiceDays || 0,
            totalServiceHours: result.totalServiceHours || 0,
            totalReportCount: result.totalReportCount || 0,
            totalDiningCount: result.totalDiningCount || 0,
            totalActiveStores: result.totalActiveStores || 0
          }
        });
      } else {
        console.warn('[journey] 全国纵览数据查询失败:', result && result.error);
      }
    } catch (err) {
      console.warn('[journey] 全国纵览加载异常:', err);
    } finally {
      this.setData({ isLoadingNationalSummary: false });
    }
  },

  /**
   * 生成近 30 天热力图数据
   */
  loadHeatmapData(logs: CheckInLog[] = []) {
    const cells: HeatCell[] = [];
    const today = new Date();

    // 最近 30 天（含今天）
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const dayLabel = `${d.getMonth() + 1}/${d.getDate()}`;

      const dayLogs = logs.filter((l) => l.date === dateStr);
      const count = dayLogs.length;
      const hours = parseFloat(dayLogs.reduce((sum, l) => sum + l.hours, 0).toFixed(1));

      cells.push({ date: dateStr, dayLabel, count, hours });
    }

    const maxHours = Math.max(1, ...cells.map((c) => c.hours));
    this.setData({ heatmapCells: cells, maxHeatHours: maxHours });
  },

  /**
   * 按月份分组加载时间轴数据，同时计算多站点足迹汇总（storeStats）
   */
  loadTimelineData(logs: CheckInLog[] = []) {
    // 按时间倒序（缺失/非法 timestamp 的历史脏数据一律兜底为 0，排到最后而不是破坏排序）
    const sortedLogs = [...logs].sort((a, b) => {
      const tsA = typeof a.timestamp === 'number' && isFinite(a.timestamp) ? a.timestamp : 0;
      const tsB = typeof b.timestamp === 'number' && isFinite(b.timestamp) ? b.timestamp : 0;
      return tsB - tsA;
    });

    const groupMap = new Map<string, TimelineGroup>();
    // 📍 多站点足迹汇总：按 storeName 聚合天数/工时/次数
    const storeMap = new Map<string, { days: Set<string>; hours: number; count: number }>();

    sortedLogs.forEach((log) => {
      // 🐛 修复 NaN年NaN月：优先用 log.date（"YYYY-MM-DD"）做兼容解析，
      // timestamp 缺失/损坏时也不会再渲染出 Invalid Date
      const date = safeParseDate(log.date, log.timestamp);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      const monthLabel = `${date.getFullYear()}年${date.getMonth() + 1}月`;

      if (!groupMap.has(monthKey)) {
        groupMap.set(monthKey, { monthKey, monthLabel, logs: [], expanded: true });
      }

      // 为每条日志补充服务类型（用于图标分类）
      const serviceType = SERVICE_TYPE_MAP[log.shiftKey] || 'other';
      const enrichedLog: CheckInLog = { ...log, serviceType };
      groupMap.get(monthKey)!.logs.push(enrichedLog);

      // 按门店聚合（storeName 空值统一归入"未知站点"）
      const sName = (log.storeName || '').trim() || '未知站点';
      if (!storeMap.has(sName)) {
        storeMap.set(sName, { days: new Set(), hours: 0, count: 0 });
      }
      const entry = storeMap.get(sName)!;
      if (log.date) entry.days.add(log.date);
      entry.hours = parseFloat((entry.hours + (log.hours || 0)).toFixed(1));
      entry.count++;
    });

    const storeStats: StoreStatItem[] = Array.from(storeMap.entries())
      .map(([storeName, s]) => ({ storeName, days: s.days.size, hours: s.hours, count: s.count }))
      .sort((a, b) => b.days - a.days); // 按天数降序

    const timelineGroups = Array.from(groupMap.values());
    this.setData({ timelineGroups, storeStats });
  },

  /**
   * 切换某一月份的折叠/展开
   */
  // 空状态"去首页打卡"：首页是 tabBar 页面，必须用 wx.switchTab 而非 navigateTo
  onGoCheckIn() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onToggleGroup(e: any) {
    const monthKey = e.currentTarget.dataset.monthKey;
    const groups = this.data.timelineGroups.map((g) => {
      if (g.monthKey === monthKey) {
        return { ...g, expanded: !g.expanded };
      }
      return g;
    });
    this.setData({ timelineGroups: groups });
  },

  /**
   * 全部展开 / 全部收起
   */
  onToggleAll() {
    const allExpanded = !this.data.allExpanded;
    const groups = this.data.timelineGroups.map((g) => ({ ...g, expanded: allExpanded }));
    this.setData({ timelineGroups: groups, allExpanded });
  },

  // 🆕 生成我的爱心荣誉卡：服务天数取本页已有的本地打卡统计（totalDays），
  // 经手透明账目/协助服务人次改由 getVolunteerHonorStats 云函数按 _openid 查真实值，
  // 不在前端编造估算数字；头像/邀请码任一步下载失败都不阻断，由 posterGenerator.ts
  // 优雅降级为占位图标/占位框
  async onGenerateHonorCard() {
    if (this.data.isGeneratingHonorCard) return;
    // 🐛 体验修复：此前弹窗要等整个生成流程（云函数查数据 + 下载邀请码 + Canvas
    // 绘制）全部跑完才 setData 打开，中间只有一个全局 wx.showLoading 蒙层，用户
    // 完全看不到"弹窗本身"，容易以为点击没反应。改为立刻打开弹窗（此时
    // honorCardImage 还是空的），弹窗内部用 isGeneratingHonorCard 展示加载态，
    // 图片生成好之后再原地填进去——全程都能看到弹窗在，只是内容从"加载中"变成
    // "荣誉卡"，不会出现从"什么都没有"到"突然弹出一张图"的跳变
    this.setData({ isGeneratingHonorCard: true, showHonorModal: true, honorCardImage: '' });

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');

      let roleInfo = AuthService.getCachedRoleInfo();
      if (!roleInfo) {
        const roleResult = await AuthService.fetchUserRole();
        roleInfo = roleResult.roleInfo || null;
      }
      const storeId = (roleInfo && roleInfo.storeId) || '';
      const isSuperAdmin = !!roleInfo && roleInfo.role === 'super_admin';
      const storeName = resolveHonorCardStoreName(roleInfo && roleInfo.storeName, isSuperAdmin);
      const nickName = (roleInfo && roleInfo.nickName) || '';
      const avatarUrl = (roleInfo && roleInfo.avatarUrl) || '';

      // 经手透明账目 / 协助服务人次：服务端按 _openid 真实统计，查询失败时降级为 0，
      // 不影响荣誉卡其余部分正常生成
      let reportCount = 0;
      let diningCount = 0;
      try {
        const statsRes = await callFunctionWithTimeout({ name: 'getVolunteerHonorStats' });
        const statsResult = statsRes.result as any;
        if (statsResult && statsResult.success) {
          reportCount = statsResult.reportCount || 0;
          diningCount = statsResult.diningCount || 0;
        }
      } catch (statsErr) {
        console.warn('[onGenerateHonorCard] 荣誉数据查询失败，展示为 0:', statsErr);
      }

      // 邀请二维码：与首页"选择服务门店"推广码同一用途（非验真），未绑定具体门店时
      // （storeId 为空）跳过生成，降级为占位框，不强行传空 storeId 请求云函数
      let qrLocalPath = '';
      if (storeId) {
        try {
          const qrRes = await callFunctionWithTimeout({
            name: 'getStoreQRCode',
            data: { storeId, storeName, purpose: 'certificate' }
          });
          const qrResult = qrRes.result as any;
          if (qrResult && qrResult.success && qrResult.fileID) {
            const downRes = await wx.cloud.downloadFile({ fileID: qrResult.fileID });
            qrLocalPath = (downRes && downRes.tempFilePath) || '';
          }
        } catch (qrErr) {
          console.warn('[onGenerateHonorCard] 邀请二维码生成/下载失败，降级为占位框:', qrErr);
        }
      }

      // 🌟 荣誉卡感谢文案：雨花斋用"护持"专属文案，其他平台用通用感谢语
      const tenantId = (roleInfo && (roleInfo as any).tenantId) || '';
      const isYuhuazhai = tenantId.startsWith('yuhuazhai');
      const honorDesc = isYuhuazhai
        ? '感谢您在雨花斋的无私护持与付出'
        : storeName && storeName !== '全国总览'
          ? `感谢您在${storeName}的无私奉献与志愿服务`
          : '感谢您用爱心温暖这座城市';

      const honorData: VolunteerHonorData = {
        storeName,
        nickName,
        avatarUrl,
        serviceDays: this.data.totalDays,
        reportCount,
        diningCount,
        totalHours: this.data.totalHours,
        qrLocalPath,
        honorDesc
      };

      const honorCardImage = await drawVolunteerHonorCard(this, honorData);
      this.setData({ honorCardImage });
    } catch (err: any) {
      console.error('[onGenerateHonorCard] 荣誉卡生成失败:', err);
      wx.showToast({ title: err.message || '荣誉卡生成失败', icon: 'none' });
      // 生成失败时弹窗里没有图可看，直接关掉比留一个永远转圈的空壳更清楚
      this.setData({ showHonorModal: false });
    } finally {
      this.setData({ isGeneratingHonorCard: false });
    }
  },

  onCloseHonorModal() {
    this.setData({ showHonorModal: false });
  },

  // 保存到相册：与 index.ts savePoster 同一套权限拒绝引导（wx.openSetting），
  // 保持全项目"保存图片"交互一致
  onSaveHonorCard() {
    if (this.data.isSavingHonorCard) return;
    const { honorCardImage } = this.data;
    if (!honorCardImage) {
      wx.showToast({ title: '荣誉卡图片为空', icon: 'none' });
      return;
    }

    this.setData({ isSavingHonorCard: true });
    wx.saveImageToPhotosAlbum({
      filePath: honorCardImage,
      success: () => {
        wx.showToast({ title: '已保存至相册', icon: 'success' });
      },
      fail: (err) => {
        console.error('[onSaveHonorCard] 保存失败:', err);
        if (err.errMsg.includes('auth')) {
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
        } else if (!err.errMsg.includes('cancel')) {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      },
      complete: () => {
        this.setData({ isSavingHonorCard: false });
      }
    });
  },

  stopPropagation() {},

  // 🛡️ 全局返回逻辑排查修复：goHome() 是给分享直入场景的物理返回键设计的，不该
  // 挪用给自定义导航栏的"←"按钮——那会导致不管从哪个页面点进来都被强制跳回首页
  onGoBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
  }
});
