import { DataService } from '../../utils/dataService';
import { AuthService } from '../../utils/authService';
import { getSafeSystemInfo } from '../../utils/util';
import { evaluateReportStatus } from '../../utils/approvalBadge';
import { formatRelativeTime } from '../../utils/dateUtils';
import { isCloudAvailable } from '../../utils/cloudGuard';

const ANNOUNCE_PAGE_SIZE = 15;

Page({
  isNavigating: false,

  data: {
    statusBarHeight: 20,
    navBarHeight: 44,

    loading: true, // 首屏骨架屏：两个分区都还没拿到过数据时为 true
    refreshing: false, // scroll-view 下拉刷新态（refresher-triggered）
    isMarkingRead: false,

    isManagerRole: false,
    isFinanceRole: false,
    isSuperAdmin: false,

    // 分区一：审批提醒 / 账目变更——衍生自 report_logs 当前状态，本身就是一份很小的
    // "待办清单"，每次刷新都整份重取，不做分页
    reminders: [] as any[],

    // 分区二：系统通知/门店公告——来自 notices 集合的真实消息记录，走真分页
    announcements: [] as any[],
    announcePage: 0,
    announceHasMore: true,
    announceLoadingMore: false,
    unreadAnnounceCount: 0
  },

  onLoad() {
    this.calculateNavBarHeight();
  },

  onShow() {
    this.isNavigating = false;
    this.initPermissions();
    this.refreshAll();

    // 🌟 同步自定义 TabBar 高亮态（见 index.ts onShow 中的说明）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
  },

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
      console.warn('[notice] Calc height fallback:', e);
    }
  },

  initPermissions() {
    const cached = AuthService.getCachedRoleInfo();
    const role = ((cached && cached.role) || wx.getStorageSync('current_user_role') || 'volunteer').toLowerCase();
    const isSuperAdmin = role === 'super_admin';
    // 🏛️ 权限向下继承：大家长天然拥有店长 + 财务的全套日常管理权限
    const isManagerRole = role === 'store_manager' || role === 'store_patriarch' || isSuperAdmin;
    const isFinanceRole = role === 'finance' || role === 'store_patriarch' || isSuperAdmin;

    this.setData({ isManagerRole, isFinanceRole, isSuperAdmin });
  },

  // 统一入口：并行刷新"审批提醒"整份重取 + "系统通知"重置回第一页，
  // 供 onShow 首次进入、下拉刷新共用，避免两处各写一套逻辑长出分叉
  async refreshAll() {
    const isFirstLoad = this.data.reminders.length === 0 && this.data.announcements.length === 0;
    if (isFirstLoad) this.setData({ loading: true });

    await Promise.all([
      this.loadReminders(),
      this.loadAnnouncements(true)
    ]);

    this.setData({ loading: false });
    this.syncBadge();
  },

  onScrollRefresh() {
    if (this.data.refreshing) return;
    this.setData({ refreshing: true });
    this.refreshAll().finally(() => this.setData({ refreshing: false }));
  },

  onScrollToLower() {
    if (!this.data.announceHasMore || this.data.announceLoadingMore) return;
    this.loadAnnouncements(false);
  },

  async loadReminders() {
    try {
      const result = await DataService.getReports({ viewMode: 'all', limit: 50 });
      const list = (result.data || []).filter((item: any) => !item.isVoid);

      const reminders = list
        .map((item: any) => this.buildReminderItem(item))
        .sort((a: any, b: any) => {
          if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
          return (b.dateString || '').localeCompare(a.dateString || '');
        })
        .slice(0, 30);

      this.setData({ reminders });
    } catch (err) {
      console.error('[notice] 加载审批提醒失败:', err);
    }
  },

  buildReminderItem(item: any) {
    const { isManagerRole, isFinanceRole, isSuperAdmin } = this.data;
    const { status, isMismatch, actionable } = evaluateReportStatus(item, { isManagerRole, isFinanceRole, isSuperAdmin });

    let icon = '📋';
    let tag = '';
    let desc = '';
    let category = 'approval';
    let categoryLabel = '审批提醒';

    if (status === 'PENDING_APPROVAL') {
      icon = '⏳';
      tag = '待店长确认';
      desc = (isManagerRole || isSuperAdmin) ? '请核对当日账目并确认' : '等待店长核对确认';
    } else if (status === 'APPROVED') {
      icon = '🔒';
      tag = '待财务稽核';
      desc = (isFinanceRole || isSuperAdmin) ? '请完成稽核并封账' : '店长已确认，等待财务稽核';
    } else if (status === 'AUDITED_LOCKED') {
      icon = '✅';
      tag = '已封账归档';
      category = 'ledger';
      categoryLabel = '账目变更';
      desc = `稽核人：${item.auditedBy || '财务'}`;
    }

    if (isMismatch) {
      icon = '⚠️';
      tag = tag ? `${tag} · 资金不平` : '资金不平';
    }

    const dateStr = item.dateString || item.reportDate || '';
    const timeMs = dateStr ? new Date(dateStr.replace(/-/g, '/')).getTime() : 0;

    return {
      id: item._id || item._localId || `${item.shopName}_${dateStr}`,
      dateString: dateStr,
      shopName: item.shopName || '未命名门店',
      icon,
      tag,
      desc,
      category,
      categoryLabel,
      actionable,
      isMismatch,
      // 待处理项视觉上按"未读"（红条）呈现，已封账归档项按"已读"（灰）呈现——
      // 这类提醒本身没有真正的读/未读状态，只有"需不需要我处理"
      unread: actionable,
      timeLabel: isFinite(timeMs) && timeMs > 0 ? formatRelativeTime(timeMs) : dateStr,
      expandable: false,
      expanded: false
    };
  },

  async loadAnnouncements(reset: boolean) {
    if (this.data.announceLoadingMore) return;
    if (!reset && !this.data.announceHasMore) return;

    const nextPage = reset ? 1 : this.data.announcePage + 1;
    this.setData({ announceLoadingMore: true });

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用');

      const storeId = wx.getStorageSync('current_store_id') || '';
      const res = await wx.cloud.callFunction({
        name: 'manageNotice',
        data: { action: 'listPaged', storeId, page: nextPage, pageSize: ANNOUNCE_PAGE_SIZE }
      });
      const result = res.result as any;
      if (!result || !result.success) {
        throw new Error((result && result.error) || 'listPaged 调用失败');
      }

      const mapped = (result.data || []).map((n: any) => this.buildAnnouncementItem(n));
      // 🐛 修复重复拼接：翻页边界处并发触发（下拉刷新与上拉加载几乎同时命中）时，
      // 用已加载 id 做集合去重后再拼接，而不是无脑 concat
      const announcements = reset ? mapped : this.dedupeAppend(this.data.announcements, mapped);

      this.setData({
        announcements,
        announcePage: nextPage,
        announceHasMore: !!result.hasMore,
        unreadAnnounceCount: typeof result.unreadCount === 'number' ? result.unreadCount : this.data.unreadAnnounceCount
      });
    } catch (err) {
      console.error('[notice] 加载系统通知失败:', err);
    } finally {
      this.setData({ announceLoadingMore: false });
    }
  },

  dedupeAppend(existing: any[], incoming: any[]) {
    const seen = new Set(existing.map((x) => x.id));
    const fresh = incoming.filter((x) => !seen.has(x.id));
    return existing.concat(fresh);
  },

  buildAnnouncementItem(n: any) {
    const createdAtMs = n.createdAt ? new Date(n.createdAt).getTime() : 0;
    const content = String(n.content || '');
    return {
      id: n._id,
      category: 'system',
      categoryLabel: '系统通知',
      tag: n.tag || (n.storeId ? (n.storeName || '门店公告') : '全域公告'),
      icon: '📢',
      title: n.title || '',
      desc: content,
      timeLabel: createdAtMs ? formatRelativeTime(createdAtMs) : '',
      unread: !!n.unread,
      actionable: false,
      isMismatch: false,
      // 长文本才允许展开/折叠，短文本直接全展示，点击不产生视觉跳动
      expandable: content.length > 42,
      expanded: false
    };
  },

  onToggleExpand(e: any) {
    const { id, section } = e.currentTarget.dataset;
    const key = section === 'announcements' ? 'announcements' : 'reminders';
    const list = ((this.data as any)[key] as any[]).map((item) =>
      item.id === id ? { ...item, expanded: !item.expanded } : item
    );
    this.setData({ [key]: list });
  },

  async onMarkAllRead() {
    if (this.data.isMarkingRead) return;

    const hasUnread = this.data.unreadAnnounceCount > 0 || this.data.announcements.some((a: any) => a.unread);
    if (!hasUnread) {
      wx.showToast({ title: '暂无未读通知', icon: 'none' });
      return;
    }

    this.setData({ isMarkingRead: true });
    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用');

      const res = await wx.cloud.callFunction({ name: 'manageNotice', data: { action: 'markAllRead' } });
      const result = res.result as any;
      if (!result || !result.success) {
        throw new Error((result && result.error) || '标记已读失败');
      }

      const announcements = this.data.announcements.map((a: any) => ({ ...a, unread: false }));
      this.setData({ announcements, unreadAnnounceCount: 0 });
      wx.showToast({ title: '已全部标记为已读', icon: 'success' });
      this.syncBadge();
    } catch (err) {
      console.error('[notice] 一键已读失败:', err);
      wx.showToast({ title: '操作失败，请检查网络', icon: 'none' });
    } finally {
      this.setData({ isMarkingRead: false });
    }
  },

  // 🔔 Tab 红点徽标：待处理提醒数 + 未读公告数之和。这个项目的 tabBar 是自定义组件
  // （custom-tab-bar），并非原生 tabBar，wx.setTabBarBadge/removeTabBarBadge 对自定义
  // tabBar 不生效——与 custom-tab-bar/index.ts 自身刷新徽标同款写法：
  // 直接更新 app.globalData + getTabBar().setData({ badge })
  syncBadge() {
    const actionableCount = this.data.reminders.filter((n: any) => n.actionable).length;
    const badge = actionableCount + (this.data.unreadAnnounceCount || 0);

    const app = getApp() as any;
    if (app && app.globalData) {
      app.globalData.pendingApprovalCount = badge;
    }
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ badge });
    }
  },

  onTapReminder() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/history/history',
      fail: () => {
        this.isNavigating = false;
      }
    });
  }
});
