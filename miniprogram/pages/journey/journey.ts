/**
 * journey.ts
 * 暖心历程页
 *
 * 功能：
 *  - 顶部热力图：展示最近 30 天 / 12 个月的义工打卡足迹
 *  - 时间轴：按服务类型展示打卡记录，支持折叠/展开动效
 *  - 从首页传递或本地存储读取打卡日志
 */

import { createNavGuard, NavGuardInstance } from '../../utils/navGuard';

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

  data: {
    // 页面元数据
    navTop: 0,
    safeTop: 0,

    // 热力图数据
    heatmapTitle: '近 30 天护持足迹',
    heatmapCells: [] as HeatCell[],
    maxHeatHours: 1,

    // 时间轴数据
    timelineGroups: [] as TimelineGroup[],
    allExpanded: true,

    // 页面状态
    isLoading: true,
    totalDays: 0,
    totalHours: 0,
    totalCount: 0
  },

  onLoad(options: any) {
    this.calculateNavBarHeight();
    this.loadStats();
    this.loadHeatmapData();
    this.loadTimelineData();

    this._navGuard = createNavGuard({
      homePath: '/pages/index/index',
      alertMessage: '即将退出雨花爱心餐报助手，是否返回首页继续使用？'
    });
    this._navGuard.setupOnLoad();

    // 模拟加载动效
    setTimeout(() => {
      this.setData({ isLoading: false });
    }, 400);
  },

  onUnload() {
    if (this._navGuard) {
      this._navGuard.teardown();
      this._navGuard = null;
    }
  },

  onShow() {
    if (this._navGuard) {
      this._navGuard.setupOnShow();
    }
  },

  calculateNavBarHeight() {
    const menuButton = wx.getMenuButtonBoundingClientRect();
    const sysInfo = wx.getSystemInfoSync();
    this.setData({
      safeTop: sysInfo.statusBarHeight || 0,
      navTop: menuButton ? menuButton.top : sysInfo.statusBarHeight || 0
    });
  },

  loadStats() {
    try {
      const days = wx.getStorageSync('my_checkin_days') || 0;
      const hours = wx.getStorageSync('my_service_hours') || 0;
      const count = wx.getStorageSync('my_checkin_count') || 0;
      this.setData({ totalDays: days, totalHours: hours, totalCount: count });
    } catch (e) {
      console.warn('[journey] loadStats failed:', e);
    }
  },

  /**
   * 生成近 30 天热力图数据
   */
  loadHeatmapData() {
    const logs: CheckInLog[] = wx.getStorageSync('my_checkin_logs') || [];
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
   * 按月份分组加载时间轴数据
   */
  loadTimelineData() {
    const logs: CheckInLog[] = wx.getStorageSync('my_checkin_logs') || [];

    // 按时间倒序
    const sortedLogs = [...logs].sort((a, b) => b.timestamp - a.timestamp);

    const groupMap = new Map<string, TimelineGroup>();
    sortedLogs.forEach((log) => {
      const date = new Date(log.timestamp);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      const monthLabel = `${date.getFullYear()}年${date.getMonth() + 1}月`;

      if (!groupMap.has(monthKey)) {
        groupMap.set(monthKey, { monthKey, monthLabel, logs: [], expanded: true });
      }

      // 为每条日志补充服务类型（用于图标分类）
      const serviceType = SERVICE_TYPE_MAP[log.shiftKey] || 'other';
      const enrichedLog: CheckInLog = { ...log, serviceType };
      groupMap.get(monthKey)!.logs.push(enrichedLog);
    });

    const timelineGroups = Array.from(groupMap.values());
    this.setData({ timelineGroups });
  },

  /**
   * 切换某一月份的折叠/展开
   */
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

  onGoBack() {
    if (this._navGuard) {
      this._navGuard.goHome();
      return;
    }
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.reLaunch({ url: '/pages/index/index' });
    }
  }
});
