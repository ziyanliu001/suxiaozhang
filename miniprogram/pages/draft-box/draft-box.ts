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

  loadDraftList() {
    this.setData({ loading: true });

    try {
      const info = wx.getStorageInfoSync();
      const keys = (info.keys || []).filter((k) => k.startsWith(DRAFT_KEY_PREFIX));

      const draftList: DraftSummary[] = keys
        .map((key) => {
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
        })
        .filter((item): item is DraftSummary => !!item && !!item.dateValue)
        .sort((a, b) => b.saveTime - a.saveTime);

      this.setData({ draftList, loading: false });
    } catch (err) {
      console.error('[draft-box] 读取草稿列表失败:', err);
      this.setData({ draftList: [], loading: false });
    }
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
