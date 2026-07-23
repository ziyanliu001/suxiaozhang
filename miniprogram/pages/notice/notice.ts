import { DataService } from '../../utils/dataService';
import { AuthService } from '../../utils/authService';
import { getSafeSystemInfo } from '../../utils/util';
import { evaluateReportStatus } from '../../utils/approvalBadge';

Page({
  isNavigating: false,

  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    loading: true,
    isManagerRole: false,
    isFinanceRole: false,
    isSuperAdmin: false,
    notifications: [] as any[],
    systemMessages: [
      {
        id: 'sys_welcome',
        icon: '📢',
        title: '欢迎使用雨花爱心餐报助手',
        desc: '门店账务变动、待您处理的审核事项都会汇总展示在这里'
      }
    ]
  },

  onLoad() {
    this.calculateNavBarHeight();
  },

  onShow() {
    this.isNavigating = false;
    this.initPermissions();
    this.loadNotifications();

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

  async loadNotifications() {
    this.setData({ loading: true });

    try {
      const result = await DataService.getReports({ viewMode: 'all', limit: 50 });
      const list = (result.data || []).filter((item: any) => !item.isVoid);

      const notifications = list
        .map((item: any) => this.buildNotificationItem(item))
        .sort((a: any, b: any) => {
          if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
          return (b.dateString || '').localeCompare(a.dateString || '');
        })
        .slice(0, 30);

      this.setData({ notifications, loading: false });

      // 🔔 Tab 红点徽标：直接统计本页已经算出的 actionable 条数，与列表展示保持完全一致，
      // 复用 selected 高亮态同款的跨组件同步写法（见 onShow 里对 getTabBar 的调用）
      const actionableCount = notifications.filter((n: any) => n.actionable).length;
      const app = getApp() as any;
      if (app && app.globalData) {
        app.globalData.pendingApprovalCount = actionableCount;
      }
      if (typeof this.getTabBar === 'function' && this.getTabBar()) {
        this.getTabBar().setData({ badge: actionableCount });
      }
    } catch (err) {
      console.error('[notice] 加载通知失败:', err);
      this.setData({ loading: false });
    }
  },

  buildNotificationItem(item: any) {
    const { isManagerRole, isFinanceRole, isSuperAdmin } = this.data;
    const { status, isMismatch, actionable } = evaluateReportStatus(item, { isManagerRole, isFinanceRole, isSuperAdmin });

    let icon = '📋';
    let tag = '';
    let desc = '';

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
      desc = `稽核人：${item.auditedBy || '财务'}`;
    }

    if (isMismatch) {
      icon = '⚠️';
      tag = tag ? `${tag} · 资金不平` : '资金不平';
    }

    return {
      id: item._id || item._localId || `${item.shopName}_${item.dateString}`,
      dateString: item.dateString || item.reportDate || '',
      shopName: item.shopName || '未命名门店',
      icon,
      tag,
      desc,
      actionable,
      isMismatch
    };
  },

  onTapNotification() {
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
