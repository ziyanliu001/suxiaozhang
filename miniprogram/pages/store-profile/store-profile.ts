import { AuthService } from '../../utils/authService';
import { getSelectedStore } from '../../utils/storeManager';
import { createNavGuard, NavGuardInstance } from '../../utils/navGuard';
import { recordRecentVisit } from '../../utils/recentPages';

// 门店人员与服务人群画像：7 项人数指标，字段名与 manageStoreProfile 云函数一致
const PROFILE_FIELDS = [
  'partyMembers',
  'socialWorkers',
  'volunteersCount',
  'dineInSeniorsCount',
  'deliverySeniorsCount',
  'listeningSeniorsCount',
  'otherCount'
] as const;

type ProfileField = typeof PROFILE_FIELDS[number];

Page({
  _navGuard: null as NavGuardInstance | null,

  data: {
    navTop: 0,
    contentTop: 0,

    currentStoreId: '',
    currentStoreName: '',
    storeAddress: '',
    canManage: false,
    loading: true,

    // 展示态：7 项人数指标
    partyMembers: 0,
    socialWorkers: 0,
    volunteersCount: 0,
    dineInSeniorsCount: 0,
    deliverySeniorsCount: 0,
    listeningSeniorsCount: 0,
    otherCount: 0,

    // 🏛️ 家长风控锁：本店若绑定了家长/督导，店长发起的画像变更会先落到这里等待确认，
    // 不为空时页面显示"有一份更新正在等待审批"提示；数据结构与 manageStoreProfile
    // 云函数的 pendingProfileUpdate 字段一致（7 项指标 + requestedBy/requestedAt）
    pendingProfileUpdate: null as any,

    // 编辑态：与展示态字段同名，但存字符串，供 input 双向绑定
    editing: false,
    saving: false,
    editForm: {
      partyMembers: '0',
      socialWorkers: '0',
      volunteersCount: '0',
      dineInSeniorsCount: '0',
      deliverySeniorsCount: '0',
      listeningSeniorsCount: '0',
      otherCount: '0'
    }
  },

  async onLoad() {
    recordRecentVisit('/pages/store-profile/store-profile', '门店档案');
    this.calculateNavBarHeight();
    await this.initRoleAndStore();
    this.fetchProfile();

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

  async initRoleAndStore() {
    let roleInfo = AuthService.getCachedRoleInfo();
    if (!roleInfo) {
      const result = await AuthService.fetchUserRole();
      roleInfo = result.roleInfo || null;
    }

    const store = getSelectedStore();
    const storeId = (roleInfo && roleInfo.storeId) || store.storeId || '';
    const storeName = (roleInfo && roleInfo.storeName) || store.storeName || '';
    const canManage = !!(roleInfo && (roleInfo.role === 'store_manager' || roleInfo.role === 'super_admin'));

    this.setData({ currentStoreId: storeId, currentStoreName: storeName, canManage });
  },

  async fetchProfile() {
    if (!this.data.currentStoreId) {
      this.setData({ loading: false });
      wx.showToast({ title: '未找到所属门店，无法查看画像', icon: 'none' });
      return;
    }

    this.setData({ loading: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreProfile',
        data: { action: 'get', storeId: this.data.currentStoreId }
      });

      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '加载门店画像失败', icon: 'none' });
        return;
      }

      const data = result.data || {};
      const update: any = {
        storeAddress: data.address || '',
        canManage: !!data.canEdit,
        currentStoreName: data.storeName || this.data.currentStoreName,
        pendingProfileUpdate: data.pendingProfileUpdate || null
      };
      PROFILE_FIELDS.forEach((f) => { update[f] = data[f] || 0; });
      this.setData(update);
    } catch (err: any) {
      console.error('[fetchProfile] 加载门店画像异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onStartEdit() {
    const editForm: any = {};
    PROFILE_FIELDS.forEach((f) => { editForm[f] = String((this.data as any)[f] || 0); });
    this.setData({ editing: true, editForm });
  },

  onCancelEdit() {
    this.setData({ editing: false });
  },

  onEditInput(e: any) {
    const field = e.currentTarget.dataset.field as ProfileField;
    const value = e.detail.value;
    this.setData({ [`editForm.${field}`]: value });
  },

  async onSaveProfile() {
    if (this.data.saving) return;
    this.setData({ saving: true });

    try {
      const payload: any = { action: 'update', storeId: this.data.currentStoreId };
      PROFILE_FIELDS.forEach((f) => { payload[f] = parseInt(this.data.editForm[f], 10) || 0; });

      const res: any = await wx.cloud.callFunction({ name: 'manageStoreProfile', data: payload });
      const result = res.result;

      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '保存失败', icon: 'none' });
        return;
      }

      if (result.pending) {
        // 🏛️ 家长风控锁：本店已绑定家长/督导，未直接生效，转为待确认——
        // 展示态的 7 项指标保持不变，只把提交内容记进 pendingProfileUpdate 供提示条展示
        const pendingProfileUpdate: any = { requestedAt: Date.now() };
        PROFILE_FIELDS.forEach((f) => { pendingProfileUpdate[f] = payload[f]; });
        this.setData({ editing: false, pendingProfileUpdate });
        wx.showModal({ title: '已提交审批', content: result.message || '已提交家长/超管审批，确认后生效', showCancel: false });
        return;
      }

      const update: any = { editing: false, pendingProfileUpdate: null };
      PROFILE_FIELDS.forEach((f) => { update[f] = payload[f]; });
      this.setData(update);
      wx.showToast({ title: '门店画像已更新', icon: 'success' });
    } catch (err: any) {
      console.error('[onSaveProfile] 保存门店画像异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ saving: false });
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
