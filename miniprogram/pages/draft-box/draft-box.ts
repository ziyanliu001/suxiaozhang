import { setResumeDraftHandoff } from '../../utils/draftHandoff';
import { getSafeSystemInfo } from '../../utils/util';

const DRAFT_KEY_PREFIX = 'DRAFT_';

interface DraftSummary {
  key: string;
  dateValue: string;
  reportDate: string;
  shopName: string;
  saveTime: number;
  saveTimeLabel: string;
  hasContent: boolean;
}

function formatSaveTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm} 保存`;
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    loading: true,
    draftList: [] as DraftSummary[]
  },

  onLoad() {
    this.calculateNavBarHeight();
  },

  onShow() {
    this.loadDraftList();
  },

  // 与 notice.ts/profile.ts 同款：按右上角胶囊按钮实测位置换算导航栏高度，
  // 确保自定义返回箭头与胶囊按钮垂直居中对齐、不同机型都不错位
  calculateNavBarHeight() {
    try {
      const sysInfo = getSafeSystemInfo();
      const statusBarHeight = sysInfo.statusBarHeight || 20;
      const menuButton = wx.getMenuButtonBoundingClientRect();
      let navBarHeight = 44;
      if (menuButton) {
        navBarHeight = (menuButton.top - statusBarHeight) * 2 + menuButton.height;
      }
      this.setData({
        statusBarHeight,
        navBarHeight: navBarHeight || 44
      });
    } catch (e) {
      console.warn('[draft-box] Calc height fallback:', e);
    }
  },

  onBackTap() {
    wx.navigateBack({ delta: 1 });
  },

  // 🐛 阻塞点修复：此前用 wx.getStorageInfoSync() 枚举全部本地存储 key，再对
  // 每一个 DRAFT_ 前缀的 key 逐个同步 wx.getStorageSync() 读取——每次 wx.xxxSync
  // 调用都是一次同步 JSBridge 往返（不是白拿的纯内存读取），草稿积累到几十/
  // 上百条时（长期使用、忘记清理的账号很常见），这一整串同步调用会连续占用
  // JS 主线程数百毫秒甚至更久。这段时间里主线程被占满，任何跳转到本页面的
  // wx.navigateTo 原生回调都可能排不上号，是 "navigateTo:fail timeout" 这类
  // 问题的典型阻塞点之一。改为：① 枚举 key 换成 wx.getStorageInfo 异步版本，
  // 不再同步阻塞；② 逐个 key 的读取按批次穿插 setTimeout(0) 让出主线程，
  // 避免成百上千次同步调用挤在同一个 JS 执行帧里
  loadDraftList() {
    this.setData({ loading: true });

    wx.getStorageInfo({
      success: (info) => {
        const keys = (info.keys || []).filter((k) => k.startsWith(DRAFT_KEY_PREFIX));
        this.readDraftsInBatches(keys, []);
      },
      fail: (err) => {
        console.error('[draft-box] 读取本地存储信息失败:', err);
        this.setData({ draftList: [], loading: false });
      }
    });
  },

  // 分批读取草稿：每批最多 BATCH_SIZE 个 key，批次之间用 setTimeout(0) 让出
  // 主线程一次，避免一长串同步 wx.getStorageSync 挤占单帧、阻塞其它交互
  // （包括别的页面正在等待完成的 navigateTo 跳转回调）
  readDraftsInBatches(keys: string[], accumulated: DraftSummary[]) {
    const BATCH_SIZE = 20;
    const batch = keys.slice(0, BATCH_SIZE);
    const rest = keys.slice(BATCH_SIZE);

    const parsed = batch
      .map((key) => {
        try {
          const draftData = wx.getStorageSync(key);
          if (!draftData) return null;

          const hasContent = !!(
            draftData.allDonations || draftData.expenses ||
            draftData.otherDonation || (draftData.yesterdayBalance && draftData.yesterdayBalance !== '0.00')
          );
          if (!hasContent) return null;

          return {
            key,
            dateValue: draftData.reportDateValue || '',
            reportDate: draftData.reportDate || draftData.reportDateValue || '',
            shopName: draftData.shopName || '未命名门店',
            saveTime: draftData.saveTime || 0,
            saveTimeLabel: formatSaveTime(draftData.saveTime || 0),
            hasContent: true
          } as DraftSummary;
        } catch (err) {
          console.warn('[draft-box] 读取单条草稿失败，跳过:', key, err);
          return null;
        }
      })
      .filter((item): item is DraftSummary => !!item && !!item.dateValue);

    const nextAccumulated = accumulated.concat(parsed);

    if (rest.length === 0) {
      nextAccumulated.sort((a, b) => b.saveTime - a.saveTime);
      this.setData({ draftList: nextAccumulated, loading: false });
      return;
    }

    setTimeout(() => this.readDraftsInBatches(rest, nextAccumulated), 0);
  },

  onTapResume(e: any) {
    const { dateValue, shopName } = e.currentTarget.dataset;
    if (!dateValue) return;

    setResumeDraftHandoff({ dateValue, shopName });
    wx.switchTab({
      url: '/pages/index/index',
      fail: (err) => {
        console.warn('[draft-box] 跳转首页失败:', err);
      }
    });
  },

  onTapDelete(e: any) {
    const { key } = e.currentTarget.dataset;
    if (!key) return;

    wx.showModal({
      title: '删除该条草稿？',
      content: '删除后无法恢复，需要重新填写。',
      confirmText: '删除',
      confirmColor: '#E03131',
      success: (res) => {
        if (!res.confirm) return;
        try {
          wx.removeStorageSync(key);
          this.loadDraftList();
        } catch (err) {
          wx.showToast({ title: '删除失败，请重试', icon: 'none' });
        }
      }
    });
  }
});
