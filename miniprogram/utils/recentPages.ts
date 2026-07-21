// 左侧功能导航抽屉「最近访问」分组的数据来源：记录用户最近访问过的二级页面，
// 供 side-drawer 组件读取展示，不做全局路由拦截，只在需要展示的几个二级页面里主动打点。
const RECENT_PAGES_KEY = 'recent_visited_pages';
const MAX_ENTRIES = 3;
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export interface RecentPageEntry {
  path: string;
  title: string;
  ts: number;
}

export function recordRecentVisit(path: string, title: string): void {
  try {
    const now = Date.now();
    const raw = wx.getStorageSync(RECENT_PAGES_KEY);
    let list: RecentPageEntry[] = Array.isArray(raw) ? raw : [];

    list = list.filter((item) => item.path !== path);
    list.unshift({ path, title, ts: now });
    list = list.filter((item) => now - item.ts <= MAX_AGE_MS).slice(0, MAX_ENTRIES);

    wx.setStorageSync(RECENT_PAGES_KEY, list);
  } catch (err) {
    console.warn('[recentPages] 记录最近访问失败:', err);
  }
}
