// 左侧功能导航抽屉「最近访问」分组的数据来源：记录用户最近访问过的二级页面，
// 供 side-drawer 组件读取展示，不做全局路由拦截，只在需要展示的几个二级页面里主动打点。
// 🐛（2026-09-06 主包瘦身）本文件原在主包 utils/ 下，但只有 subpackages/admin
// 与 subpackages/reports 两个分包页面引用它，被 DevTools 代码质量面板判定为
// "主包未引用文件"。改为在这两个分包里各放一份拷贝（与
// components/side-drawer/side-drawer.ts 自己重复定义 RECENT_PAGES_KEY 常量
// 同一个既有约定）——三处都只是读写同一个 wx.setStorageSync 的
// 'recent_visited_pages' 全局存储 key，拷贝再多份运行时行为都完全一致，
// 不存在"分包各自为政导致数据不一致"的风险。修改 MAX_ENTRIES/MAX_AGE_MS 等
// 常量时记得三处（本文件、reports 分包的同名拷贝、side-drawer.ts）一起改
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
