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
import { safeParseDate } from '../../utils/dateUtils';
import { recordRecentVisit } from '../../utils/recentPages';
import { AuthService } from '../../utils/authService';
import { isCloudAvailable } from '../../utils/cloudGuard';
import { drawVolunteerHonorCard, VolunteerHonorData } from '../../utils/posterGenerator';

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
    // 页面元数据（由 navigation-bar 组件 bind:layout 上报，见 onNavLayout）
    navBarTotalHeight: 0,

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
    totalCount: 0,

    // 🆕 志愿者爱心荣誉卡
    isGeneratingHonorCard: false,
    showHonorModal: false,
    honorCardImage: '',
    isSavingHonorCard: false
  },

  onLoad(options: any) {
    recordRecentVisit('/pages/journey/journey', '暖心历程');
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

  // navigation-bar 组件按胶囊按钮实测坐标算出真实导航栏高度后通过 layout 事件上报
  onNavLayout(e: { detail: { totalHeight: number } }) {
    this.setData({ navBarTotalHeight: e.detail.totalHeight });
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

    // 按时间倒序（缺失/非法 timestamp 的历史脏数据一律兜底为 0，排到最后而不是破坏排序）
    const sortedLogs = [...logs].sort((a, b) => {
      const tsA = typeof a.timestamp === 'number' && isFinite(a.timestamp) ? a.timestamp : 0;
      const tsB = typeof b.timestamp === 'number' && isFinite(b.timestamp) ? b.timestamp : 0;
      return tsB - tsA;
    });

    const groupMap = new Map<string, TimelineGroup>();
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
    });

    const timelineGroups = Array.from(groupMap.values());
    this.setData({ timelineGroups });
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
      const storeName = (roleInfo && roleInfo.storeName) || '素小账 · 爱心公益';
      const nickName = (roleInfo && roleInfo.nickName) || '';
      const avatarUrl = (roleInfo && roleInfo.avatarUrl) || '';

      // 经手透明账目 / 协助服务人次：服务端按 _openid 真实统计，查询失败时降级为 0，
      // 不影响荣誉卡其余部分正常生成
      let reportCount = 0;
      let diningCount = 0;
      try {
        const statsRes = await wx.cloud.callFunction({ name: 'getVolunteerHonorStats' });
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
          const qrRes = await wx.cloud.callFunction({
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

      const honorData: VolunteerHonorData = {
        storeName,
        nickName,
        avatarUrl,
        serviceDays: this.data.totalDays,
        reportCount,
        diningCount,
        totalHours: this.data.totalHours,
        qrLocalPath
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
