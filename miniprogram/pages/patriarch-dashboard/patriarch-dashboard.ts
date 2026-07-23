import { AuthService } from '../../utils/authService';
import { getSelectedStore } from '../../utils/storeManager';
import { createNavGuard, NavGuardInstance } from '../../utils/navGuard';
import { recordRecentVisit } from '../../utils/recentPages';

// 门店人员画像 7 项字段名，与 manageStoreProfile 云函数一致——用于展示
// pendingProfileUpdate 里"店长本次提交了什么"的明细列表
const PROFILE_FIELD_LABELS: Record<string, string> = {
  partyMembers: '中共党员',
  socialWorkers: '社会工作者',
  volunteersCount: '志愿者',
  dineInSeniorsCount: '堂食老人',
  deliverySeniorsCount: '送餐老人',
  listeningSeniorsCount: '倾听陪伴老人',
  otherCount: '其他'
};

Page({
  _navGuard: null as NavGuardInstance | null,

  data: {
    navTop: 0,
    contentTop: 0,
    loading: true,
    currentStoreId: '',

    storeName: '',
    patriarch: '',
    manager: '',

    monthLabel: '',
    monthDiners: 0,
    monthIncome: '0.00',
    monthExpense: '0.00',
    monthNet: '0.00',
    monthNetPositive: true,
    auditedCount: 0,
    totalCount: 0,

    pendingVoidList: [] as any[],
    pendingProfileUpdate: null as any,
    pendingProfileItems: [] as { label: string; value: number }[],
    pendingRoleRequests: [] as any[],

    voidActionInFlight: false,
    profileActionInFlight: false,
    roleActionInFlight: false
  },

  async onLoad() {
    recordRecentVisit('/pages/patriarch-dashboard/patriarch-dashboard', '家长监督台');
    this.calculateNavBarHeight();
    await this.initStore();
    this.fetchDashboard();

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
  },

  calculateNavBarHeight() {
    const menuButton = wx.getMenuButtonBoundingClientRect();
    if (!menuButton) {
      this.setData({ navTop: 44, contentTop: 88 });
      return;
    }
    this.setData({
      navTop: menuButton.top,
      contentTop: menuButton.top + menuButton.height + 8
    });
  },

  async initStore() {
    let roleInfo = AuthService.getCachedRoleInfo();
    if (!roleInfo) {
      const result = await AuthService.fetchUserRole();
      roleInfo = result.roleInfo || null;
    }
    // 家长/督导锁定本店；超管沿用全局门店切换器选中的门店（与 store-profile/daily-menu 一致）
    const store = getSelectedStore();
    const storeId = (roleInfo && roleInfo.role === 'store_patriarch' && roleInfo.storeId) || store.storeId || '';
    this.setData({ currentStoreId: storeId });
  },

  async fetchDashboard() {
    this.setData({ loading: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'getPatriarchDashboard',
        data: { storeId: this.data.currentStoreId }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '加载大盘失败', icon: 'none' });
        return;
      }

      const data = result.data;
      const pendingProfileItems = data.pendingProfileUpdate
        ? Object.keys(PROFILE_FIELD_LABELS)
            .filter((f) => data.pendingProfileUpdate[f] !== undefined)
            .map((f) => ({ label: PROFILE_FIELD_LABELS[f], value: data.pendingProfileUpdate[f] }))
        : [];

      this.setData({
        currentStoreId: data.storeId || this.data.currentStoreId,
        storeName: data.storeName || '',
        patriarch: data.patriarch || '',
        manager: data.manager || '',
        monthLabel: data.monthLabel || '',
        monthDiners: data.monthDiners || 0,
        monthIncome: (data.monthIncome || 0).toFixed(2),
        monthExpense: (data.monthExpense || 0).toFixed(2),
        monthNet: Math.abs(data.monthNet || 0).toFixed(2),
        monthNetPositive: (data.monthNet || 0) >= 0,
        auditedCount: data.auditedCount || 0,
        totalCount: data.totalCount || 0,
        pendingVoidList: data.pendingVoidList || [],
        pendingProfileUpdate: data.pendingProfileUpdate || null,
        pendingProfileItems,
        pendingRoleRequests: data.pendingRoleRequests || []
      });
    } catch (err) {
      console.error('[fetchDashboard] 加载家长大盘异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async onDecideVoid(e: any) {
    if (this.data.voidActionInFlight) return;
    const { id, action } = e.currentTarget.dataset; // action: 'approve' | 'reject'
    const cloudAction = action === 'approve' ? 'approvePendingVoid' : 'rejectPendingVoid';

    this.setData({ voidActionInFlight: true });
    wx.showLoading({ title: '处理中...', mask: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageReportApproval',
        data: { action: cloudAction, docId: id }
      });
      const result = res.result;
      wx.hideLoading();
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.errMsg) || '操作失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: action === 'approve' ? '已确认作废' : '已驳回申请', icon: 'success' });
      this.fetchDashboard();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ voidActionInFlight: false });
    }
  },

  async onDecideProfileUpdate(e: any) {
    if (this.data.profileActionInFlight) return;
    const { action } = e.currentTarget.dataset; // action: 'approve' | 'reject'
    const cloudAction = action === 'approve' ? 'approveProfileUpdate' : 'rejectProfileUpdate';

    this.setData({ profileActionInFlight: true });
    wx.showLoading({ title: '处理中...', mask: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreProfile',
        data: { action: cloudAction, storeId: this.data.currentStoreId }
      });
      const result = res.result;
      wx.hideLoading();
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: action === 'approve' ? '已确认变更' : '已驳回申请', icon: 'success' });
      this.fetchDashboard();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ profileActionInFlight: false });
    }
  },

  // 🏛️ 审批本店店长/财务申请：家长与超管均可，云函数 processRoleAudit 已实现分级校验
  async onDecideRoleRequest(e: any) {
    if (this.data.roleActionInFlight) return;
    const { id, action } = e.currentTarget.dataset; // action: 'approve' | 'reject'

    this.setData({ roleActionInFlight: true });
    wx.showLoading({ title: '处理中...', mask: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'processRoleAudit',
        data: { applyId: id, action }
      });
      const result = res.result;
      wx.hideLoading();
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: action === 'approve' ? '已审核通过' : '已拒绝申请', icon: 'success' });
      this.fetchDashboard();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ roleActionInFlight: false });
    }
  },

  goBack() {
    if (this._navGuard) {
      this._navGuard.goHome();
      return;
    }
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
  }
});
