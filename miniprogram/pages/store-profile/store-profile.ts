import { AuthService } from '../../utils/authService';
import { getSelectedStore } from '../../utils/storeManager';
import { createNavGuard, NavGuardInstance } from '../../utils/navGuard';
import { recordRecentVisit } from '../../utils/recentPages';
import { compressAndUploadImages } from '../../utils/imageCompress';

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

// 门店档案信息：文本/日期类字段，字段名与 manageStoreProfile 云函数的 TEXT_PROFILE_FIELDS 一致
const TEXT_PROFILE_FIELDS = ['address', 'openDate', 'registeredName', 'background', 'characteristics', 'province', 'city'] as const;
type TextProfileField = typeof TEXT_PROFILE_FIELDS[number];

const TEXT_PROFILE_FIELD_LABELS: Record<TextProfileField, string> = {
  address: '详细地址',
  openDate: '开业日期',
  registeredName: '民政登记名称',
  background: '发起背景',
  characteristics: '家园特色',
  province: '省份',
  city: '城市'
};

const OPERATING_STATUS_LABELS: Record<string, string> = {
  operating: '运营中',
  preparing: '筹备中',
  paused: '暂停运营'
};

const MILESTONE_CANVAS_ID = 'milestoneImgCompressCanvas';
const MAX_MILESTONE_IMAGES = 9;

Page({
  _navGuard: null as NavGuardInstance | null,

  data: {
    navTop: 0,
    contentTop: 0,

    currentStoreId: '',
    currentStoreName: '',
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

    // 展示态：门店档案信息（文本/日期）+ 运营状态 + 坐标
    address: '',
    openDate: '',
    registeredName: '',
    background: '',
    characteristics: '',
    province: '',
    city: '',
    operatingStatus: 'operating',
    operatingStatusLabel: '运营中',
    latitude: undefined as number | undefined,
    longitude: undefined as number | undefined,
    locationLabel: '',

    // 🏛️ 家长风控锁：本店若绑定了家长/督导，店长发起的画像变更会先落到这里等待确认，
    // 不为空时页面显示"有一份更新正在等待审批"提示；数据结构与 manageStoreProfile
    // 云函数的 pendingProfileUpdate 字段一致（人员画像 + 档案信息 + 运营状态/坐标 +
    // requestedBy/requestedAt）
    pendingProfileUpdate: null as any,

    // 编辑态：与展示态字段同名，人员画像走字符串（数字输入框），档案信息走字符串（文本/日期），
    // 运营状态/坐标走各自专属控件（胶囊单选 / "设置门店位置"按钮），不提供手工经纬度输入框
    editing: false,
    saving: false,
    editForm: {
      partyMembers: '0',
      socialWorkers: '0',
      volunteersCount: '0',
      dineInSeniorsCount: '0',
      deliverySeniorsCount: '0',
      listeningSeniorsCount: '0',
      otherCount: '0',
      address: '',
      openDate: '',
      registeredName: '',
      background: '',
      characteristics: '',
      province: '',
      city: '',
      operatingStatus: 'operating' as 'operating' | 'preparing' | 'paused',
      latitude: undefined as number | undefined,
      longitude: undefined as number | undefined,
      locationLabel: ''
    },

    // 🏛️ 门店大事记/发展历程：按年份分组的时间轴，复用 pages/journey 的
    // {yearKey,yearLabel,items,expanded} + 展开/收起交互范式
    milestonesLoading: true,
    milestoneTimelineGroups: [] as any[],
    allMilestonesExpanded: true,
    showMilestoneModal: false,
    milestoneSaving: false,
    milestoneUploading: false,
    milestoneForm: {
      id: '',
      title: '',
      eventDate: '',
      content: '',
      images: [] as string[]
    }
  },

  async onLoad() {
    recordRecentVisit('/pages/store-profile/store-profile', '门店档案');
    this.calculateNavBarHeight();
    await this.initRoleAndStore();
    this.fetchProfile();
    this.fetchMilestones();

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
        canManage: !!data.canEdit,
        currentStoreName: data.storeName || this.data.currentStoreName,
        pendingProfileUpdate: data.pendingProfileUpdate || null,
        operatingStatus: data.operatingStatus || 'operating',
        operatingStatusLabel: OPERATING_STATUS_LABELS[data.operatingStatus] || '运营中',
        latitude: data.latitude,
        longitude: data.longitude,
        locationLabel: (typeof data.latitude === 'number' && typeof data.longitude === 'number') ? '已设置门店位置' : ''
      };
      PROFILE_FIELDS.forEach((f) => { update[f] = data[f] || 0; });
      TEXT_PROFILE_FIELDS.forEach((f) => { update[f] = data[f] || ''; });
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
    TEXT_PROFILE_FIELDS.forEach((f) => { editForm[f] = (this.data as any)[f] || ''; });
    editForm.operatingStatus = this.data.operatingStatus || 'operating';
    editForm.latitude = this.data.latitude;
    editForm.longitude = this.data.longitude;
    editForm.locationLabel = this.data.locationLabel || '';
    this.setData({ editing: true, editForm });
  },

  onCancelEdit() {
    this.setData({ editing: false });
  },

  onEditInput(e: any) {
    const field = e.currentTarget.dataset.field as ProfileField | TextProfileField;
    const value = e.detail.value;
    this.setData({ [`editForm.${field}`]: value });
  },

  onSelectOperatingStatus(e: any) {
    this.setData({ 'editForm.operatingStatus': e.currentTarget.dataset.value });
  },

  onEditOpenDateChange(e: any) {
    this.setData({ 'editForm.openDate': e.detail.value });
  },

  stopPropagation() {},

  // 📍 编辑态设置门店位置：与 store-management 建店表单共用同一条
  // app.json "scope.userLocation" 权限声明
  async onChooseLocation() {
    try {
      const res: any = await wx.chooseLocation({});
      this.setData({
        'editForm.latitude': res.latitude,
        'editForm.longitude': res.longitude,
        'editForm.locationLabel': res.name || res.address || `${res.latitude}, ${res.longitude}`
      });
      if (!this.data.editForm.address && res.address) {
        this.setData({ 'editForm.address': res.address });
      }
    } catch (err) {
      console.warn('[store-profile] 选择门店位置失败/取消:', err);
    }
  },

  async onSaveProfile() {
    if (this.data.saving) return;
    this.setData({ saving: true });

    try {
      const payload: any = { action: 'update', storeId: this.data.currentStoreId };
      PROFILE_FIELDS.forEach((f) => { payload[f] = parseInt(this.data.editForm[f], 10) || 0; });
      TEXT_PROFILE_FIELDS.forEach((f) => { payload[f] = this.data.editForm[f] || ''; });
      payload.operatingStatus = this.data.editForm.operatingStatus;
      if (typeof this.data.editForm.latitude === 'number' && typeof this.data.editForm.longitude === 'number') {
        payload.latitude = this.data.editForm.latitude;
        payload.longitude = this.data.editForm.longitude;
      }

      const res: any = await wx.cloud.callFunction({ name: 'manageStoreProfile', data: payload });
      const result = res.result;

      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '保存失败', icon: 'none' });
        return;
      }

      if (result.pending) {
        // 🏛️ 家长风控锁：本店已绑定家长/督导，未直接生效，转为待确认——
        // 展示态保持不变，只把提交内容记进 pendingProfileUpdate 供提示条展示
        const pendingProfileUpdate: any = { requestedAt: Date.now() };
        PROFILE_FIELDS.forEach((f) => { pendingProfileUpdate[f] = payload[f]; });
        TEXT_PROFILE_FIELDS.forEach((f) => { pendingProfileUpdate[f] = payload[f]; });
        this.setData({ editing: false, pendingProfileUpdate });
        wx.showModal({ title: '已提交审批', content: result.message || '已提交家长/超管审批，确认后生效', showCancel: false });
        return;
      }

      const update: any = {
        editing: false,
        pendingProfileUpdate: null,
        operatingStatus: payload.operatingStatus,
        operatingStatusLabel: OPERATING_STATUS_LABELS[payload.operatingStatus] || '运营中'
      };
      PROFILE_FIELDS.forEach((f) => { update[f] = payload[f]; });
      TEXT_PROFILE_FIELDS.forEach((f) => { update[f] = payload[f]; });
      if (payload.latitude !== undefined) {
        update.latitude = payload.latitude;
        update.longitude = payload.longitude;
        update.locationLabel = '已设置门店位置';
      }
      this.setData(update);
      wx.showToast({ title: '门店档案已更新', icon: 'success' });
    } catch (err: any) {
      console.error('[onSaveProfile] 保存门店画像异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  // ============ 🏛️ 门店大事记/发展历程：按年份分组的时间轴 ============
  // 数据结构/展开-收起交互照抄 pages/journey 的 {yearKey,yearLabel,items,expanded}
  // + onToggleGroup/onToggleAll 范式，仅把"按月"换成"按年"

  async fetchMilestones() {
    if (!this.data.currentStoreId) {
      this.setData({ milestonesLoading: false });
      return;
    }
    this.setData({ milestonesLoading: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreMilestone',
        data: { action: 'list', storeId: this.data.currentStoreId }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '加载大事记失败', icon: 'none' });
        return;
      }

      const items = (result.data || []).sort((a: any, b: any) => (b.eventDate || '').localeCompare(a.eventDate || ''));
      const groupMap = new Map<string, any>();
      items.forEach((item: any) => {
        const yearKey = String(item.year || (item.eventDate || '').slice(0, 4));
        if (!groupMap.has(yearKey)) {
          groupMap.set(yearKey, { yearKey, yearLabel: `${yearKey}年`, items: [], expanded: this.data.allMilestonesExpanded });
        }
        groupMap.get(yearKey).items.push(item);
      });
      const milestoneTimelineGroups = Array.from(groupMap.values()).sort((a, b) => b.yearKey.localeCompare(a.yearKey));

      this.setData({ milestoneTimelineGroups });
    } catch (err) {
      console.error('[fetchMilestones] 加载大事记异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ milestonesLoading: false });
    }
  },

  onToggleMilestoneGroup(e: any) {
    const yearKey = e.currentTarget.dataset.yearKey;
    const groups = this.data.milestoneTimelineGroups.map((g: any) => (g.yearKey === yearKey ? { ...g, expanded: !g.expanded } : g));
    this.setData({ milestoneTimelineGroups: groups });
  },

  onToggleAllMilestones() {
    const allExpanded = !this.data.allMilestonesExpanded;
    const groups = this.data.milestoneTimelineGroups.map((g: any) => ({ ...g, expanded: allExpanded }));
    this.setData({ milestoneTimelineGroups: groups, allMilestonesExpanded: allExpanded });
  },

  onOpenAddMilestone() {
    this.setData({
      showMilestoneModal: true,
      milestoneForm: { id: '', title: '', eventDate: '', content: '', images: [] }
    });
  },

  onOpenEditMilestone(e: any) {
    const item = e.currentTarget.dataset.item;
    this.setData({
      showMilestoneModal: true,
      milestoneForm: {
        id: item._id,
        title: item.title || '',
        eventDate: item.eventDate || '',
        content: item.content || '',
        images: (Array.isArray(item.images) ? item.images : []).map((img: any) => (img && img.url) || img).filter((u: any) => u && typeof u === 'string')
      }
    });
  },

  onCloseMilestoneModal() {
    if (this.data.milestoneSaving) return;
    this.setData({ showMilestoneModal: false });
  },

  onMilestoneTitleInput(e: any) {
    this.setData({ 'milestoneForm.title': e.detail.value });
  },

  onMilestoneDateChange(e: any) {
    this.setData({ 'milestoneForm.eventDate': e.detail.value });
  },

  onMilestoneContentInput(e: any) {
    this.setData({ 'milestoneForm.content': e.detail.value });
  },

  onRemoveMilestoneImage(e: any) {
    const index = e.currentTarget.dataset.index;
    const images = [...this.data.milestoneForm.images];
    images.splice(index, 1);
    this.setData({ 'milestoneForm.images': images });
  },

  // 🖼️ 大事记配图：与门店日志(activity-log)同款流程，最多 9 张（大事记数量少，
  // 不需要门店日志那种双九宫格 18 张上限）
  async onChooseMilestoneImage() {
    const remaining = MAX_MILESTONE_IMAGES - this.data.milestoneForm.images.length;
    if (remaining <= 0) {
      wx.showToast({ title: `最多上传 ${MAX_MILESTONE_IMAGES} 张配图`, icon: 'none' });
      return;
    }

    try {
      const chooseRes = await wx.chooseMedia({
        count: Math.min(remaining, 9),
        mediaType: ['image'],
        sourceType: ['album', 'camera']
      });

      const paths = (chooseRes.tempFiles || []).map((f) => f.tempFilePath);
      if (paths.length === 0) return;

      const insertStart = this.data.milestoneForm.images.length;
      this.setData({ 'milestoneForm.images': [...this.data.milestoneForm.images, ...paths], milestoneUploading: true });

      try {
        const uploaded = await compressAndUploadImages(MILESTONE_CANVAS_ID, paths, `store_milestones/${this.data.currentStoreId}`);
        const finalImages = [...this.data.milestoneForm.images];
        uploaded.forEach((u, i) => { finalImages[insertStart + i] = u.url; });
        this.setData({ 'milestoneForm.images': finalImages });
      } catch (uploadErr) {
        const rolledBack = this.data.milestoneForm.images.filter((_: any, i: number) => i < insertStart || i >= insertStart + paths.length);
        this.setData({ 'milestoneForm.images': rolledBack });
        throw uploadErr;
      }

      this.setData({ milestoneUploading: false });
    } catch (err) {
      this.setData({ milestoneUploading: false });
      console.error('[onChooseMilestoneImage] 图片处理失败:', err);
      wx.showToast({ title: '图片处理失败，请重试', icon: 'none' });
    }
  },

  async onSaveMilestone() {
    if (this.data.milestoneSaving) return;
    const { id, title, eventDate, content, images } = this.data.milestoneForm;

    if (!title || !title.trim()) {
      wx.showToast({ title: '请填写标题', icon: 'none' });
      return;
    }
    if (!eventDate) {
      wx.showToast({ title: '请选择发生日期', icon: 'none' });
      return;
    }

    this.setData({ milestoneSaving: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreMilestone',
        data: {
          action: id ? 'update' : 'create',
          id,
          storeId: this.data.currentStoreId,
          title: title.trim(),
          eventDate,
          content: content || '',
          images: images.map((url: string) => ({ url, thumbUrl: url }))
        }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '保存失败', icon: 'none' });
        return;
      }

      wx.showToast({ title: id ? '大事记已更新' : '大事记已发布', icon: 'success' });
      this.setData({ showMilestoneModal: false });
      this.fetchMilestones();
    } catch (err) {
      console.error('[onSaveMilestone] 保存大事记异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ milestoneSaving: false });
    }
  },

  onDeleteMilestone(e: any) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除大事记',
      content: '确定要删除这条大事记吗？删除后不可恢复。',
      confirmColor: '#D32F2F',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const cloudRes: any = await wx.cloud.callFunction({ name: 'manageStoreMilestone', data: { action: 'delete', id } });
          const result = cloudRes.result;
          if (!result || !result.success) {
            wx.showToast({ title: (result && result.error) || '删除失败', icon: 'none' });
            return;
          }
          wx.showToast({ title: '已删除', icon: 'success' });
          this.fetchMilestones();
        } catch (err) {
          console.error('[onDeleteMilestone] 删除大事记异常:', err);
          wx.showToast({ title: '网络异常，请重试', icon: 'none' });
        }
      }
    });
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
