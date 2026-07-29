import { AuthService } from '../../utils/authService';
import { getSelectedStore } from '../../utils/storeManager';
import { createNavGuard, NavGuardInstance } from '../../utils/navGuard';
import { recordRecentVisit } from '../../utils/recentPages';
import { compressAndUploadImages } from '../../utils/imageCompress';

const CANVAS_ID = 'storeProfileImgCompressCanvas';
const MAX_STORE_PHOTOS = 9;

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

// 门店档案信息：文本/日期类字段，字段名与 manageStoreProfile 云函数的 TEXT_PROFILE_FIELDS 一致。
// contactPhone（门店对外公示联系电话）是 processRoleAudit 申请高阶角色/新建门店档案补全校验
// 依赖的字段之一，此前门店档案页从未提供编辑入口，只能通过建店/申请流程写入，这里补齐
const TEXT_PROFILE_FIELDS = ['address', 'contactPhone', 'openDate', 'registeredName', 'background', 'characteristics', 'province', 'city'] as const;
type TextProfileField = typeof TEXT_PROFILE_FIELDS[number];

const TEXT_PROFILE_FIELD_LABELS: Record<TextProfileField, string> = {
  address: '详细地址',
  contactPhone: '联系电话',
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
    contactPhone: '',
    openDate: '',
    registeredName: '',
    background: '',
    characteristics: '',
    province: '',
    city: '',
    operatingStatus: 'operating',
    operatingStatusLabel: '运营中',
    latitude: null as number | null,
    longitude: null as number | null,
    locationLabel: '',
    // 🏪 门店照片：云存储 fileID 数组，与 manageStoreProfile 云函数的 storePhotos 字段一致
    storePhotos: [] as string[],
    storePhotoUploading: false,

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
      contactPhone: '',
      openDate: '',
      registeredName: '',
      background: '',
      characteristics: '',
      province: '',
      city: '',
      operatingStatus: 'operating' as 'operating' | 'preparing' | 'paused',
      latitude: undefined as number | undefined,
      longitude: undefined as number | undefined,
      locationLabel: '',
      storePhotos: [] as string[]
    },

    // 👥 门店人员与服务人群画像 · 快捷修改弹窗：只改这 7 项人数指标的独立轻量弹窗，
    // 与上面整页的 editing/editForm 相互独立——那个模式会一并带出地址/开业日期等
    // 一大堆档案字段，日常只想改改人数时没必要整页进编辑态
    showProfileCountModal: false,
    profileCountSaving: false,
    profileCountForm: {
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

    this._navGuard = createNavGuard({
      homePath: '/pages/index/index',
      alertMessage: '即将退出雨花爱心餐报助手，是否返回首页继续使用？'
    });
    this._navGuard.setupOnLoad();
  },

  // 🛡️ 本页此前把角色/数据拉取全放在 onLoad（只在页面实例首次创建时跑一次），
  // 从未在 onShow 里重新同步——如果用户是"先进入本页，再切到别的页面用
  // store-picker 切换身份/门店，然后返回本页"（页面实例仍在导航栈里，只触发
  // onShow 不触发 onLoad），canManage 会一直停留在第一次进入本页那一刻的旧值。
  // 改为把角色同步 + 数据拉取整体挪到 onShow（每次页面可见都强制重新走一遍
  // initRoleAndStore()），与 profile.ts initMinePage() 的"强制优先读取生效角色"
  // 保持同一套刷新时机口径；onShow 在首次打开时本就会紧跟 onLoad 触发一次，
  // 不需要在 onLoad 里再重复调用一遍
  async onShow() {
    await this.initRoleAndStore();
    this.fetchProfile();
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

    // 🛡️ 强制优先读取切换后的生效角色：本页此前只认 AuthService.getCachedRoleInfo()
    // 下发的服务端真实角色，完全没读过 store-picker 切身份时写入的 current_user_role
    // 本地缓存——与 profile.ts initMinePage() 的优先级口径不一致，导致"切到家长
    // 身份后个人中心正确刷新，门店档案页却还是不能编辑"。这里补齐同一套优先级：
    // storage 一旦有值就无条件作为生效角色，不再理会服务端角色
    const storageRole = wx.getStorageSync('current_user_role');
    const effectiveRole = storageRole ? String(storageRole).toLowerCase() : ((roleInfo && roleInfo.role) || '');

    // 🏛️ 严格白名单：只有 store_manager / store_patriarch / super_admin 这三种生效
    // 角色允许为 true，store_family（家人）/volunteer（义工）/finance（财务）一律
    // 强制 false。这是本页 canManage 唯一的判定点——fetchProfile() 不再用服务端
    // canEdit 覆盖这里算出的值（canEdit 只反映调用者的真实服务端角色，不认本地
    // 预览覆盖，见该函数内注释），避免真实 super_admin 账号在本地预览"家人"视角时，
    // 请求一回来又把按钮重新点亮。权限向下继承：大家长天然拥有店长的全套门店档案
    // 管理权限，与云函数 manageStoreProfile 的 resolveWriteTarget 写权限口径对齐——
    // 真正的写操作授权仍然完全由服务端独立校验，这里只决定按钮是否渲染
    const canManage = effectiveRole === 'store_manager' || effectiveRole === 'store_patriarch' || effectiveRole === 'super_admin';

    this.setData({ currentStoreId: storeId, currentStoreName: storeName, canManage });
    console.log('[verify] store-profile rendered, canManage:', canManage);
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
      // 🛡️ 严格权限收紧：canManage 只能来自 initRoleAndStore() 里基于 effectiveRole
      // （优先读 store-picker 本地预览覆盖）算出的值，绝不能再被这里的服务端 canEdit
      // 覆盖——canEdit 只反映调用者的真实服务端角色，不知道客户端正在本地预览哪个
      // 角色。真实 super_admin 账号本就对任意门店 canEdit=true（服务端这条判断本身
      // 是对的，见 manageStoreProfile 云函数），但如果客户端正在本地预览"家人"身份，
      // 这里再用 canEdit 覆盖回 true，就会让"家人预览视角"下的按钮又冒出来，
      // 完全违背预览模拟的初衷。canManage 只允许 store_manager/store_patriarch/
      // super_admin 三种生效角色为 true，这一条判定口径只在 initRoleAndStore() 一处
      const update: any = {
        currentStoreName: data.storeName || this.data.currentStoreName,
        pendingProfileUpdate: data.pendingProfileUpdate || null,
        operatingStatus: data.operatingStatus || 'operating',
        operatingStatusLabel: OPERATING_STATUS_LABELS[data.operatingStatus] || '运营中',
        // 🛡️ setData 不接受 undefined 字段值（会报 "field ... is invalid" 警告）：
        // 门店尚未设置坐标时 data.latitude/longitude 就是 undefined，这里兜底为 null
        latitude: typeof data.latitude === 'number' ? data.latitude : null,
        longitude: typeof data.longitude === 'number' ? data.longitude : null,
        locationLabel: (typeof data.latitude === 'number' && typeof data.longitude === 'number') ? '已设置门店位置' : ''
      };
      PROFILE_FIELDS.forEach((f) => { update[f] = data[f] || 0; });
      TEXT_PROFILE_FIELDS.forEach((f) => { update[f] = data[f] || ''; });
      update.storePhotos = Array.isArray(data.storePhotos) ? data.storePhotos : [];
      this.setData(update);
      // 🛡️ canManage 不在这份 update 里——它自始至终只由 initRoleAndStore() 的
      // effectiveRole 判定决定，这里只是确认 fetchProfile() 没有意外动过它
      console.log('[verify] store-profile fetchProfile 完成, canManage 保持:', this.data.canManage, 'data.canEdit(服务端真实角色判定, 仅供参考不采用):', data.canEdit);
    } catch (err: any) {
      console.error('[fetchProfile] 加载门店画像异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onEditProfile() {
    const editForm: any = {};
    PROFILE_FIELDS.forEach((f) => { editForm[f] = String((this.data as any)[f] || 0); });
    TEXT_PROFILE_FIELDS.forEach((f) => { editForm[f] = (this.data as any)[f] || ''; });
    editForm.operatingStatus = this.data.operatingStatus || 'operating';
    editForm.latitude = this.data.latitude;
    editForm.longitude = this.data.longitude;
    editForm.locationLabel = this.data.locationLabel || '';
    editForm.storePhotos = [...this.data.storePhotos];
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

  // 🏪 门店照片：与 store-picker.ts onChooseNewStorePhoto 同一套 chooseMedia +
  // compressAndUploadImages 模式，上限 9 张，仅编辑态可操作
  async onChooseStorePhoto() {
    const remaining = MAX_STORE_PHOTOS - this.data.editForm.storePhotos.length;
    if (remaining <= 0) {
      wx.showToast({ title: `最多上传 ${MAX_STORE_PHOTOS} 张门店照片`, icon: 'none' });
      return;
    }

    try {
      const chooseRes = await wx.chooseMedia({
        count: remaining,
        mediaType: ['image'],
        sourceType: ['album', 'camera']
      });

      const paths = (chooseRes.tempFiles || []).map((f) => f.tempFilePath);
      if (paths.length === 0) return;

      const insertStart = this.data.editForm.storePhotos.length;
      this.setData({
        'editForm.storePhotos': [...this.data.editForm.storePhotos, ...paths],
        storePhotoUploading: true
      });

      try {
        const uploaded = await compressAndUploadImages(CANVAS_ID, paths, 'store_profile_photos/' + this.data.currentStoreId + '/' + Date.now());
        const finalPhotos = [...this.data.editForm.storePhotos];
        uploaded.forEach((u, i) => { finalPhotos[insertStart + i] = u.url; });
        this.setData({ 'editForm.storePhotos': finalPhotos });
      } catch (uploadErr) {
        const rolledBack = this.data.editForm.storePhotos.filter((_: string, i: number) => i < insertStart || i >= insertStart + paths.length);
        this.setData({ 'editForm.storePhotos': rolledBack });
        throw uploadErr;
      }

      this.setData({ storePhotoUploading: false });
    } catch (err) {
      this.setData({ storePhotoUploading: false });
      console.error('[store-profile] onChooseStorePhoto 异常:', err);
      wx.showToast({ title: '图片处理失败，请重试', icon: 'none' });
    }
  },

  onDeleteStorePhoto(e: any) {
    const index = e.currentTarget.dataset.index;
    const next = this.data.editForm.storePhotos.filter((_: string, i: number) => i !== index);
    this.setData({ 'editForm.storePhotos': next });
  },

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
      payload.storePhotos = this.data.editForm.storePhotos || [];
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
        pendingProfileUpdate.storePhotos = payload.storePhotos;
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
      update.storePhotos = payload.storePhotos;
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

  // ============ 👥 门店人员与服务人群画像 · 快捷修改弹窗 ============

  onOpenProfileCountModal() {
    const profileCountForm: any = {};
    PROFILE_FIELDS.forEach((f) => { profileCountForm[f] = String((this.data as any)[f] || 0); });
    this.setData({ showProfileCountModal: true, profileCountForm });
  },

  onCloseProfileCountModal() {
    if (this.data.profileCountSaving) return;
    this.setData({ showProfileCountModal: false });
  },

  onProfileCountInput(e: any) {
    const field = e.currentTarget.dataset.field as ProfileField;
    this.setData({ [`profileCountForm.${field}`]: e.detail.value });
  },

  async onSaveProfileCount() {
    if (this.data.profileCountSaving) return;
    this.setData({ profileCountSaving: true });
    wx.showLoading({ title: '正在保存...', mask: true });

    try {
      const payload: any = { action: 'update', storeId: this.data.currentStoreId };
      PROFILE_FIELDS.forEach((f) => { payload[f] = parseInt(this.data.profileCountForm[f], 10) || 0; });

      const res: any = await wx.cloud.callFunction({ name: 'manageStoreProfile', data: payload });
      const result = res.result;

      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '保存失败', icon: 'none' });
        return;
      }

      if (result.pending) {
        // 🏛️ 家长风控锁：与整页保存 onSaveProfile 同一套挂起逻辑——本店已绑定
        // 家长/督导时不会直接生效，展示态数字保持不变，只更新待审批提示条
        const pendingProfileUpdate: any = { ...this.data.pendingProfileUpdate, requestedAt: Date.now() };
        PROFILE_FIELDS.forEach((f) => { pendingProfileUpdate[f] = payload[f]; });
        this.setData({ showProfileCountModal: false, pendingProfileUpdate });
        wx.showModal({ title: '已提交审批', content: result.message || '已提交家长/超管审批，确认后生效', showCancel: false });
        return;
      }

      const update: any = { showProfileCountModal: false };
      PROFILE_FIELDS.forEach((f) => { update[f] = payload[f]; });
      this.setData(update);
      wx.showToast({ title: '更新成功', icon: 'success' });
    } catch (err: any) {
      console.error('[onSaveProfileCount] 保存人员画像异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ profileCountSaving: false });
    }
  },

  // 🛡️ 全局返回逻辑排查修复：此前这里的 pages.length 判断因为上面一段无条件调用
  // _navGuard.goHome() 并 return，从未真正执行过——goHome() 是给"分享直入二级页时
  // 物理返回键/侧滑手势"这个完全不同的场景设计的兜底（见 utils/navGuard.ts），
  // 拿来当自定义导航栏"←"按钮的点击逻辑，会导致不管从哪个页面点进来，点"←"永远
  // 跳回首页而不是真正的上一页，"从哪里点进来就退回哪里"完全失效。按钮点击只需要
  // 最朴素的判断：栈里有上一页就退回去，没有就安全落到首页 Tab
  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
  }
});
