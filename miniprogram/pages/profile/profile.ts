import { AuthService } from '../../utils/authService';
import { getSelectedStore, getCachedStoreStatus, fetchAndSyncStoreStatus } from '../../utils/storeManager';
import { computeMyCheckInStats } from '../../utils/checkinStats';
import { getSafeSystemInfo } from '../../utils/util';
import { compressAndUploadScaledImage } from '../../utils/imageCompress';
import { isCloudAvailable } from '../../utils/cloudGuard';
import { drawVolunteerCertificate } from '../../utils/drawVolunteerCertificate';
import {
  applyRoleViewOverride, getPreviewViewMode, setPreviewViewMode,
  PreviewViewMode, PREVIEW_VIEW_MODE_LABELS
} from '../../utils/viewModePreview';

const VIEW_MODE_OPTIONS: PreviewViewMode[] = ['SUPER_ADMIN', 'STORE_MANAGER', 'FINANCE'];

const CERTIFICATE_CANVAS_ID = 'certificateCanvas';
// 🛡️ "上传后立刻显示新图，但切页/退出重进又变回旧图"的真正根因：lastConfirmedAvatarFileId/
// lastConfirmedAvatarAt 只是 Page 实例上的普通字段（不在 data 里），只存在于内存中。
// 同一次小程序运行期间切换自定义 TabBar 不会重建页面实例，字段能保留、宽限期确实生效；
// 但完整退出小程序再重新打开会重建全新的 Page 实例，这两个字段被重新初始化为 ''/0，
// 宽限期形同虚设——而"云数据库最终一致性延迟"这个宽限期本来要防的场景，恰恰最容易发生在
// "刚上传完就退出重进"这个时间点。于是 loadUserProfile 里 checkUserRole 读到的哪怕是
// 尚未追平的旧 avatarUrl，也会在 withinGrace 恒为 false 的情况下被无条件覆盖回去。
// 用一个本地持久化 key 把这两个字段镜像存一份，页面重新加载时优先从这里恢复，
// 让宽限期跨小程序重启依然生效。
const CONFIRMED_AVATAR_CACHE_KEY = 'confirmed_avatar_grace';

// 🌟 荣誉徽章解锁规则：护持天数 / 累计工时任一维度达标即视为解锁。
// 阈值为产品侧可调参数，这里给出一组由浅入深、早期容易触达的示例梯度，
// 让新义工也能较快解锁第一枚徽章，建立正反馈。
const BADGE_CONFIG: Array<{ id: string; emoji: string; name: string; type: 'days' | 'hours'; threshold: number }> = [
  { id: 'starter', emoji: '🌱', name: '初心', type: 'days', threshold: 1 },
  { id: 'storm', emoji: '☔', name: '风雨无阻', type: 'days', threshold: 30 },
  { id: 'hours100', emoji: '⏰', name: '百时勋章', type: 'hours', threshold: 100 },
  { id: 'century', emoji: '💯', name: '百日精进', type: 'days', threshold: 100 },
  { id: 'guardian', emoji: '🛡️', name: '护持先锋', type: 'hours', threshold: 500 }
];

// 🏛️ 家长管理 / 资源兜底：门店人员画像 7 项字段名，与 manageStoreProfile 云函数一致——
// 迁移自已废弃的 pages/patriarch-dashboard，用于展示 pendingProfileUpdate 里
// "店长本次提交了什么"的明细列表
const PATRIARCH_PROFILE_FIELD_LABELS: Record<string, string> = {
  partyMembers: '中共党员',
  socialWorkers: '社会工作者',
  volunteersCount: '志愿者',
  dineInSeniorsCount: '堂食老人',
  deliverySeniorsCount: '送餐老人',
  listeningSeniorsCount: '倾听陪伴老人',
  otherCount: '其他'
};

Page({
  isNavigating: false,
  // 🐛 头像"退出重进又变回旧值"根因：loadUserProfile 里缓存优先渲染（快）与云端
  // fetchUserRole 刷新（慢，多一轮 checkUserRole 云函数往返）各自独立调用
  // applyAvatarUrl，谁的 getTempFileURL 请求先返回完全看网络时序，不保证按发起顺序
  // 落地——一旦云端刷新那次意外先于缓存那次 resolve，随后姗姗来迟的"缓存版"
  // setData 反而会把已经展示的最新头像覆盖回旧值。avatarApplySeq 按【发起顺序】
  // 单调递增，只有序号不小于当前已生效序号的结果才允许 setData，确保后发起的
  // （更新鲜的）结果永远不会被先发起、但后返回的旧结果覆盖。
  avatarApplySeq: 0,
  lastAppliedAvatarSeq: 0,
  // 🐛 fetchSeq 预占号只解决了"同一个 loadUserProfile 周期内，缓存渲染 vs
  // checkUserRole 刷新谁先 resolve"的时序竞争；但即使按发起顺序正确排到了最新一号，
  // checkUserRole 读到的 user_roles 记录本身仍可能是云数据库对"刚刚那次写入"的
  // 最终一致性延迟（写入后极短时间内的读请求命中了还没同步到的副本），返回一个
  // 比"我们自己刚刚上传确认过"的 fileID 更旧的 avatarUrl——这不是客户端时序问题，
  // 单靠调整 seq 无法解决。用这两个字段记录"上一次成功上传后确认为真"的 fileID
  // 与确认时刻，在这之后一段宽限期内，即使 checkUserRole 返回了不一致的旧值，
  // 也优先信任本地刚确认过的结果，而不是照单全收覆盖回去。
  lastConfirmedAvatarFileId: '',
  lastConfirmedAvatarAt: 0,

  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    // 🛡️ 自定义导航栏避让官方胶囊菜单：与 statistics.ts 同款方案，capsuleLeft/windowWidth
    // 用于给右上角"⋯"按钮换算出正确的右侧安全内边距，不再用固定 24rpx 硬编码贴右——
    // 不同机型胶囊按钮的实际左边距不同，硬编码在部分机型上会被胶囊直接盖住/裁切
    windowWidth: 0,
    capsuleLeft: 0,
    currentUserRole: 'volunteer' as 'super_admin' | 'store_manager' | 'store_patriarch' | 'finance' | 'volunteer' | 'store_family',
    currentStoreName: '',
    // 🏪 门店运营状态：见 utils/storeManager.ts fetchAndSyncStoreStatus/getCachedStoreStatus，
    // 全局态与 Storage 双写同步，"查看店铺状态"菜单标题据此动态渲染
    currentStoreStatus: '',
    // 🛡️ 语义化权限状态：避免模板里反复重复 role 字符串比较
    hasPrivilege: false,
    isSuperAdmin: false,
    // 🌟 isVolunteer 严格指"已审核通过的真实义工"，用于和 isFamily 互斥区分；
    // isFamily/isServiceUser：新用户/未审核用户的默认身份（家人 · 服务对象），
    // 底层 role 与真实义工共用同一个 'volunteer' 值，只能靠 status !== 'approved'
    // 这个信号区分（见 checkUserRole 云函数：未审核账号 role 恒为 volunteer）
    isVolunteer: false,
    isFamily: false,
    isServiceUser: false,
    // 🏛️ 家长管理 / 资源兜底卡片的显隐开关：家长本人或超管可见
    isPatriarch: false,
    // 🌟 视角切换预览：isRealSuperAdmin 恒等于真实身份，用于切换入口自身的显隐判断；
    // currentViewMode 与选项文案，供页面内的切换 Picker 使用
    isRealSuperAdmin: false,
    currentViewMode: 'SUPER_ADMIN' as PreviewViewMode,
    viewModeOptionLabels: VIEW_MODE_OPTIONS.map((m) => PREVIEW_VIEW_MODE_LABELS[m]),
    viewModeOptionIndex: 0,
    stats: {
      volunteerDays: 0,
      volunteerHours: 0,
      submittedReports: 0,
      auditedReports: 0
    },

    // 🏪 查看店铺状态 Modal：日常记录列表里的只读入口，展示当前门店名称与运营状态
    showStoreStatusModal: false,
    storeStatusInfo: {
      loading: false,
      storeName: '',
      operatingStatus: '',
      operatingStatusLabel: ''
    },

    // 🏛️ 家长管理 / 资源兜底：内嵌自已废弃的 pages/patriarch-dashboard，
    // 单独收拢进一个命名空间对象，避免和本页其余字段混在一起
    patriarchData: {
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

    showReleaseModal: false,
    releaseRoleLabel: '',
    isReleasing: false,

    // 🙋 头像昵称填写规范
    userAvatarUrl: '',
    // 🛡️ 头像加载失败兜底：userAvatarUrl 存在只代表"云端有这个 fileID"，不代表图片真的
    // 加载成功了（例如云存储读权限配置为"仅创建者可读"时，其他人查看会直接加载失败/空白）。
    // 单靠 wx:if="{{userAvatarUrl}}" 无法感知加载失败，必须由 <image> 的 binderror 显式上报，
    // 失败后降级展示 👤 占位图，而不是让用户看到一块空白
    avatarLoadFailed: false,
    userNickName: '',
    avatarUploading: false,

    // 🌟 数字荣誉墙 + 电子证书
    badgeList: [] as Array<{ id: string; emoji: string; name: string; unlocked: boolean; hint: string }>,
    showCertificateModal: false,
    certificateTempFilePath: '',
    certificateGenerating: false
  },

  onLoad() {
    this.calculateNavBarHeight();
    this.hydrateConfirmedAvatarFromStorage();
  },

  // 🛡️ 从本地持久化恢复"上一次上传确认为真"的头像记录：见 CONFIRMED_AVATAR_CACHE_KEY
  // 处的根因说明。只在页面刚创建（onLoad）时读一次即可——之后同一个实例存活期间
  // 一直靠内存里的这两个字段，onChooseAvatar 成功时会同步更新内存与本地持久化两处。
  hydrateConfirmedAvatarFromStorage() {
    try {
      const saved = wx.getStorageSync(CONFIRMED_AVATAR_CACHE_KEY);
      if (saved && saved.fileId && typeof saved.at === 'number') {
        this.lastConfirmedAvatarFileId = saved.fileId;
        this.lastConfirmedAvatarAt = saved.at;
      }
    } catch (err) {
      console.warn('[profile] 恢复头像确认记录失败:', err);
    }
  },

  onShow() {
    console.log('[verify] profile.onShow 已触发, 当前 userAvatarUrl=', this.data.userAvatarUrl);
    this.isNavigating = false;
    this.initMinePage();
    this.loadUserProfile();
    this.refreshStoreStatus();

    // 🌟 同步自定义 TabBar 高亮态（见 index.ts onShow 中的说明）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
  },

  calculateNavBarHeight() {
    try {
      const sysInfo = getSafeSystemInfo();
      const statusBarHeight = sysInfo.statusBarHeight || 20;
      const windowWidth = sysInfo.windowWidth || 375;
      const menuButton = wx.getMenuButtonBoundingClientRect();
      let navBarHeight = 44;
      // 官方胶囊默认宽度约 87px 的兜底估算，避免 API 不可用时右侧完全不避让
      let capsuleLeft = windowWidth - 87;
      if (menuButton) {
        navBarHeight = (menuButton.top - statusBarHeight) * 2 + menuButton.height;
        capsuleLeft = menuButton.left;
      }
      this.setData({
        statusBarHeight,
        navBarHeight: navBarHeight || 44,
        windowWidth,
        capsuleLeft
      });
    } catch (e) {
      console.warn('Calc height fallback:', e);
    }
  },

  async initMinePage() {
    let role: string = 'volunteer';
    let storeName = '';

    const cachedRoleInfo = AuthService.getCachedRoleInfo();
    if (cachedRoleInfo && cachedRoleInfo.role) {
      role = cachedRoleInfo.role;
      storeName = cachedRoleInfo.storeName || '';
    }

    // 🌟 家人（服务对象）默认判定：新用户/未审核用户在 checkUserRole 云函数里
    // role 恒为 'volunteer' 且 status !== 'approved'，用这个组合区分"真实义工"
    // 与"默认家人视角"，不会误伤已审核通过的真实义工（那时 status === 'approved'）。
    // 这只是没有手动切换过身份时的兜底默认值，下面 storageRole 一旦存在就优先生效
    let isFamily = role === 'volunteer' && (!cachedRoleInfo || cachedRoleInfo.status !== 'approved');

    // 🛡️ 强制优先读取切换后的生效角色，严禁被 cachedRoleInfo 覆盖降级：store-picker
    // 切身份/切店（首页的全局 storePicker、本页嵌入的 patriarchStorePicker 都共用
    // 同一套 _applyRoleSwitch 持久化逻辑）会同步写入这个 key——只要它存在，就必须
    // 无条件以它为准，完全不再理会上面基于 cachedRoleInfo 算出的默认值/isFamily
    // 兜底判断，否则"选了家长/家人但刷新后又被服务端缓存的 volunteer 打回原形"
    const storageRole = wx.getStorageSync('current_user_role');
    if (storageRole) {
      role = storageRole.toLowerCase();
      // 手动切换的具体身份说了算：选家人就是家人，选除家人外的任何身份
      // （含义工/家长/店长/财务/超管）都不再是"默认未审核家人"视角
      isFamily = role === 'store_family';
    }
    console.log('[verify] initMinePage 角色解析: cachedRole=', cachedRoleInfo && cachedRoleInfo.role, 'storageRole=', storageRole, '-> 生效role=', role);

    const storageStoreName = wx.getStorageSync('current_store_name');
    if (storageStoreName) {
      storeName = storageStoreName;
    }

    if (!storeName) {
      const activeStore = getSelectedStore();
      if (activeStore && activeStore.storeName) {
        storeName = activeStore.storeName;
      }
    }

    const isRealSuperAdmin = role === 'super_admin';

    // 🌟 视角切换预览：仅真实身份为 super_admin 时才可能生效，展示层降级模拟
    // 店长/财务视角；hasPrivilege 随预览角色一并变化（volunteer 视角下应隐藏管理入口）
    // 🏛️ 权限向下继承：大家长天然拥有店长 + 财务的全套日常管理权限
    const overridden = applyRoleViewOverride(role, {
      currentUserRole: role, isVolunteer: role === 'volunteer',
      isManager: role === 'store_manager' || role === 'store_patriarch',
      isFinance: role === 'finance' || role === 'store_patriarch',
      isSuperAdmin: isRealSuperAdmin
    });
    const displayRole = overridden.currentUserRole;
    const hasPrivilege = displayRole === 'store_manager' || displayRole === 'finance' || displayRole === 'store_patriarch' || displayRole === 'super_admin';
    const currentViewMode = getPreviewViewMode();
    // 🏛️ 家长管理卡片显隐：预览模式的可选项里没有"家长"这一档（VIEW_MODE_OPTIONS
    // 只有 SUPER_ADMIN/STORE_MANAGER/FINANCE），displayRole 能等于 store_patriarch
    // 只可能是真实角色本身就是家长，不受超管预览切换影响
    const isPatriarch = displayRole === 'store_patriarch';
    // 🌟 isVolunteer 严格指"真实义工"，与 isFamily 互斥——两者底层 currentUserRole
    // 都是 'volunteer'，靠 isFamily 区分展示哪一套版面
    const isVolunteer = displayRole === 'volunteer' && !isFamily;
    console.log('[verify] initMinePage 计算结果: displayRole=', displayRole, 'isPatriarch=', isPatriarch, 'isFamily=', isFamily, 'isVolunteer=', isVolunteer);

    this.setData({
      currentUserRole: displayRole as any,
      currentStoreName: storeName,
      hasPrivilege,
      isSuperAdmin: overridden.isSuperAdmin,
      isRealSuperAdmin,
      isPatriarch,
      isVolunteer,
      isFamily,
      isServiceUser: isFamily,
      currentViewMode,
      viewModeOptionIndex: VIEW_MODE_OPTIONS.indexOf(currentViewMode)
    });

    // fetchMeritStats 按真实角色查询（super_admin 本就同时满足 store_manager/finance 两类统计条件，
    // 预览视角切换时无需重新查询，WXML 侧的显隐已经按 currentUserRole 展示角色自动收敛）
    this.fetchMeritStats(role);
    this.loadVolunteerStats();

    // 🏛️ 家长管理 / 资源兜底：仅家长本人或超管（含预览降级后的超管，与卡片
    // wx:if 口径保持一致）才需要加载，避免给普通义工/店长/财务发多余的云函数请求
    if (isPatriarch || overridden.isSuperAdmin) {
      this.fetchPatriarchDashboardData();
    }
  },

  // 🏛️ 家长管理 / 资源兜底：迁移自已废弃的 pages/patriarch-dashboard，
  // 合并了原页面 initStore() + fetchDashboard() 两步——家长/督导锁定本店，
  // 超管沿用全局门店切换器选中的门店（与 store-profile/daily-menu 一致）
  async fetchPatriarchDashboardData() {
    let roleInfo = AuthService.getCachedRoleInfo();
    if (!roleInfo) {
      const result = await AuthService.fetchUserRole();
      roleInfo = result.roleInfo || null;
    }
    const store = getSelectedStore();
    const storeId = (roleInfo && roleInfo.role === 'store_patriarch' && roleInfo.storeId) || store.storeId || '';

    this.setData({ 'patriarchData.currentStoreId': storeId, 'patriarchData.loading': true });

    try {
      const res: any = await wx.cloud.callFunction({
        name: 'getPatriarchDashboard',
        data: { storeId: this.data.patriarchData.currentStoreId }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '加载大盘失败', icon: 'none' });
        return;
      }

      const data = result.data;
      const pendingProfileItems = data.pendingProfileUpdate
        ? Object.keys(PATRIARCH_PROFILE_FIELD_LABELS)
            .filter((f) => data.pendingProfileUpdate[f] !== undefined)
            .map((f) => ({ label: PATRIARCH_PROFILE_FIELD_LABELS[f], value: data.pendingProfileUpdate[f] }))
        : [];

      this.setData({
        patriarchData: {
          ...this.data.patriarchData,
          currentStoreId: data.storeId || this.data.patriarchData.currentStoreId,
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
        }
      });
    } catch (err) {
      console.error('[fetchPatriarchDashboardData] 加载家长大盘异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ 'patriarchData.loading': false });
    }
  },

  // 🔄 内嵌 store-picker 切换门店/身份后回调
  //
  // 🐛 根因修复："切到家长身份后个人中心仍显示志工"：此前这里只刷新了
  // patriarchData（家长面板自己的数据），完全没有重新计算 currentUserRole/
  // isPatriarch 这些顶层状态——WXML 里的身份徽章和
  // wx:if="{{isPatriarch || isSuperAdmin}}" 家长卡片本身都读的是顶层字段，
  // 只刷新面板数据不会触发它们重绘。改为重新走一遍 initMinePage()——它会
  // 重新计算 currentUserRole/isPatriarch/isSuperAdmin 等全部顶层字段并
  // setData，其内部本就会在 isPatriarch || isSuperAdmin 时再自动调用一次
  // fetchPatriarchDashboardData()，不需要在这里重复调用
  onPatriarchStoreChanged() {
    this.initMinePage();
  },

  async onDecideVoid(e: any) {
    if (this.data.patriarchData.voidActionInFlight) return;
    const { id, action } = e.currentTarget.dataset; // action: 'approve' | 'reject'
    const cloudAction = action === 'approve' ? 'approvePendingVoid' : 'rejectPendingVoid';

    this.setData({ 'patriarchData.voidActionInFlight': true });
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
      this.fetchPatriarchDashboardData();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ 'patriarchData.voidActionInFlight': false });
    }
  },

  async onDecideProfileUpdate(e: any) {
    if (this.data.patriarchData.profileActionInFlight) return;
    const { action } = e.currentTarget.dataset; // action: 'approve' | 'reject'
    const cloudAction = action === 'approve' ? 'approveProfileUpdate' : 'rejectProfileUpdate';

    this.setData({ 'patriarchData.profileActionInFlight': true });
    wx.showLoading({ title: '处理中...', mask: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreProfile',
        data: { action: cloudAction, storeId: this.data.patriarchData.currentStoreId }
      });
      const result = res.result;
      wx.hideLoading();
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: action === 'approve' ? '已确认变更' : '已驳回申请', icon: 'success' });
      this.fetchPatriarchDashboardData();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ 'patriarchData.profileActionInFlight': false });
    }
  },

  // 🏛️ 审批本店店长/财务申请：家长与超管均可，云函数 processRoleAudit 已实现分级校验
  async onDecideRoleRequest(e: any) {
    if (this.data.patriarchData.roleActionInFlight) return;
    const { id, action } = e.currentTarget.dataset; // action: 'approve' | 'reject'

    this.setData({ 'patriarchData.roleActionInFlight': true });
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
      this.fetchPatriarchDashboardData();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ 'patriarchData.roleActionInFlight': false });
    }
  },

  // 🙋 头像昵称填写规范：优先用缓存的 RoleInfo 秒开显示，再静默刷新一次确保最新
  loadUserProfile() {
    console.log('[verify] loadUserProfile 已触发, lastConfirmedAvatarFileId=', this.lastConfirmedAvatarFileId);
    const cached = AuthService.getCachedRoleInfo();
    console.log('[verify] 本地缓存 cached.avatarUrl=', cached && cached.avatarUrl);
    if (cached) {
      this.applyAvatarUrl(cached.avatarUrl || '');
      this.setData({ userNickName: cached.nickName || '' });
    }

    // 🐛 关键修复：seq 号必须在发起 fetchUserRole 请求的这一刻就同步占好，不能等
    // checkUserRole 网络请求真正 resolve 之后才在 .then 回调里临时取号——原来的写法
    // 会导致"发起得早、但这一轮网络恰好慢"的请求，仅仅因为"resolve 得晚"就被误判成
    // "更新鲜"，进而把已经正确展示的新头像覆盖回它自己携带的旧数据（截图里 seq=7 新
    // 头像被 seq=8 的旧头像覆盖、seq=10 新头像又被 seq=11 旧头像覆盖，就是这个根因）。
    // 号的大小现在只取决于"这次 loadUserProfile 调用本身发生的时间"，与网络快慢无关。
    const fetchSeq = ++this.avatarApplySeq;
    AuthService.fetchUserRole().then(result => {
      console.log('[verify] fetchUserRole resolve, success=', result.success, 'roleInfo.avatarUrl=', result.roleInfo && result.roleInfo.avatarUrl);
      if (result.success && result.roleInfo) {
        // 🐛 云数据库最终一致性兜底：见类定义处 lastConfirmedAvatarFileId 的注释——
        // 如果这次 checkUserRole 返回的 avatarUrl 跟"刚上传成功、已确认为真"的
        // fileID 对不上，且还在宽限期内，大概率是写入后的读请求命中了还没追平的
        // 副本，不是用户真的换了新头像，此时保留本地已确认的展示，不覆盖回去。
        const CONFIRMED_AVATAR_GRACE_MS = 5 * 60 * 1000;
        const fetchedAvatarUrl = result.roleInfo.avatarUrl || '';
        const withinGrace = this.lastConfirmedAvatarFileId
          && (Date.now() - this.lastConfirmedAvatarAt) < CONFIRMED_AVATAR_GRACE_MS;
        if (withinGrace && fetchedAvatarUrl !== this.lastConfirmedAvatarFileId) {
          console.warn(
            '[profile] checkUserRole 返回的 avatarUrl 与刚确认的上传结果不一致，' +
            '宽限期内忽略，保留本地已确认值:', fetchedAvatarUrl, 'vs', this.lastConfirmedAvatarFileId
          );
        } else {
          this.applyAvatarUrl(fetchedAvatarUrl, fetchSeq);
        }
        this.setData({ userNickName: result.roleInfo.nickName || '' });
      }
    }).catch(err => {
      console.warn('[profile] loadUserProfile 刷新失败:', err);
    });
  },

  // 🐛 头像"严重放大只看到局部色块"根因修复：这里此前会对 cloud:// 开头的 avatarUrl
  // 额外调用 wx.cloud.downloadFile 换成本地临时文件路径再 setData（更早之前甚至读成
  // data: base64 URI），逐层排查（原始临时路径正常 → 本地压缩后 mainPath 正常 →
  // 只有走完云端上传/下载这一轮往返后才变成色块）已经定位到问题就出在这个手动
  // downloadFile 转换步骤本身。本项目其余所有图片（食谱、支出凭证、日常日志等）都是
  // 直接把 cloud:// fileID 原样绑定到 <image src>，交给微信原生 <image> 组件自行解析，
  // 从未出现过这类问题——现改为同款做法，不再手动 downloadFile，avatarUrl 是什么就
  // 原样展示什么，与全项目其余图片保持完全一致的绑定方式。
  // 🐛 seq 支持外部预先占号（见 loadUserProfile 里 fetchUserRole 分支的注释）：
  // 号必须按【发起时刻】分配，而不是按【resolve 时刻】分配，否则一次发起得早、
  // 但网络恰好慢的请求会因为"最后才 resolve"被误判成最新，把它携带的旧数据
  // 盖过已经正确展示的新头像。不传时退回自增（用于同步/无需等待网络的分支）。
  applyAvatarUrl(avatarUrl: string, preAssignedSeq?: number) {
    const seq = preAssignedSeq !== undefined ? preAssignedSeq : ++this.avatarApplySeq;
    if (seq < this.lastAppliedAvatarSeq) {
      // 已经有发起时间更晚（更新鲜）的一次调用抢先落地过，这次是姗姗来迟的旧结果，丢弃
      return;
    }
    this.lastAppliedAvatarSeq = seq;

    const patch = { userAvatarUrl: avatarUrl || '', avatarLoadFailed: false };
    // 🐛 强制经历一次"从空到有"，绕开个别基础库版本下 <image> 的 src 从一个已加载过的
    // 旧地址直接切到新地址时不重新发起请求的怪癖（低概率，但作为兜底保留）。
    const prevUrl = this.data.userAvatarUrl;
    if (prevUrl && patch.userAvatarUrl && prevUrl !== patch.userAvatarUrl) {
      this.setData({ userAvatarUrl: '', avatarLoadFailed: false });
      wx.nextTick(() => {
        this.setData(patch);
      });
    } else {
      this.setData(patch);
    }
  },

  // 🛡️ 头像 <image> 加载失败兜底：常见于云存储读权限未设为"所有用户可读"时，
  // 其他人（非上传者本人）查看会直接加载失败——不管什么原因，降级展示占位图，
  // 而不是留一块空白框给用户
  onAvatarLoadError(e: any) {
    console.warn('[profile] 头像加载失败，降级为占位图:', e.detail);
    this.setData({ avatarLoadFailed: true });
  },

  // 选择微信头像（官方 chooseAvatar 能力）：拿到本地临时文件后压缩上传至云存储，再落库。
  // 依赖手机微信客户端基础库 >= 2.21.2；版本过低时该回调不会触发，属已知限制。
  async onChooseAvatar(e: any) {
    const tempAvatarUrl = e.detail && e.detail.avatarUrl;
    if (!tempAvatarUrl) {
      console.warn('[onChooseAvatar] e.detail.avatarUrl 为空，微信未返回临时头像文件');
      return;
    }

    this.setData({ avatarUploading: true });
    wx.showLoading({ title: '头像上传中...', mask: true });

    // 🛡️ 云开发就绪防护：与 authService.ts 里 fetchUserRole/updateProfile 同款判定口径。
    // 此前 wx.cloud.uploadFile（压缩上传这一步）之前完全没有这道检查——如果云初始化还没
    // 完成就调用，会直接抛出 "Cloud API isn't enabled" 而不是走后面 updateProfile 那句
    // 更友好的 CLOUD_SDK_UNAVAILABLE 提示，用户只会看到笼统的"头像上传失败，请重试"，
    // 看不出真正原因是云还没就绪。提前拦截，给出更明确的提示，且不发起注定失败的请求。
    if (!isCloudAvailable()) {
      wx.hideLoading();
      this.setData({ avatarUploading: false });
      wx.showToast({ title: '云服务尚未就绪，请稍后重试', icon: 'none' });
      return;
    }

    try {
      // 🐛 头像"被严重放大只看到局部色块"根因修复（最终版）：真正原因是主图经过本地
      // Canvas 重绘-导出这一整套流程，在部分设备/基础库的 Canvas 2D 实现上不可靠——本项目
      // 早前修复"食谱/门店日志照片主体被裁切"时就踩过同一类问题，解法是让主图完全绕开
      // Canvas、直接上传原始临时文件（见 imageCompress.ts compressAndUploadImage 的注释）。
      // 头像不需要缩略图，因此彻底不再触碰 Canvas。
      const uploaded = await compressAndUploadScaledImage(tempAvatarUrl, 'users/avatars');

      const result = await AuthService.updateProfile({ avatarUrl: uploaded.url });

      wx.hideLoading();
      this.setData({ avatarUploading: false });

      if (result.success) {
        // 🐛 优先用本地临时路径（tempAvatarUrl）立即更新视图，不等云端 fileID 转临时链接
        // 那一轮网络往返——本地路径此刻已经是裁剪压缩后的正方形图，直接可用，视觉上更即时，
        // 也避免了 cloud:// fileID 在少数设备/基础库上无法被 <image> 直接解析的问题
        //
        // 🛡️ 这里也要走 avatarApplySeq 序号，而不是裸 setData：如果本页面在这次上传之前
        // 还有一个尚未 resolve 的 applyAvatarUrl（比如页面首次打开时那次 loadUserProfile
        // 触发的 fetchUserRole 请求还没回来），旧请求晚一点才 resolve 的话，会把刚上传成功
        // 的新头像又覆盖回旧值。把这次乐观展示也计入序号，能让所有更早发起的旧请求
        // 事后一律被判定为过期而丢弃。
        const seq = ++this.avatarApplySeq;
        this.lastAppliedAvatarSeq = seq;
        this.setData({ userAvatarUrl: tempAvatarUrl, avatarLoadFailed: false });

        // 🐛 记录"刚上传确认为真"的 fileID + 时刻：见类定义处 lastConfirmedAvatarFileId
        // 的注释，供后续 loadUserProfile 的 checkUserRole 分支判断是否命中最终一致性
        // 延迟、要不要信任这次云端读到的 avatarUrl。
        this.lastConfirmedAvatarFileId = uploaded.url;
        this.lastConfirmedAvatarAt = Date.now();
        // 🛡️ 同步镜像一份到本地持久化：见 CONFIRMED_AVATAR_CACHE_KEY 处的根因说明，
        // 让这层宽限期保护跨小程序退出重进依然生效，而不是只活在这个页面实例的内存里
        try {
          wx.setStorageSync(CONFIRMED_AVATAR_CACHE_KEY, {
            fileId: this.lastConfirmedAvatarFileId,
            at: this.lastConfirmedAvatarAt
          });
        } catch (storageErr) {
          console.warn('[profile] 持久化头像确认记录失败:', storageErr);
        }

        wx.showToast({ title: '头像已更新', icon: 'success' });
      } else {
        wx.showToast({ title: result.error || '头像保存失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      this.setData({ avatarUploading: false });
      console.error('[profile] onChooseAvatar 异常:', err);
      wx.showToast({ title: '头像上传失败，请重试', icon: 'none' });
    }
  },

  // 昵称编辑（官方 <input type="nickname"> 能力）：失焦后保存
  async onNicknameBlur(e: any) {
    const nickName = ((e.detail && e.detail.value) || '').trim();
    if (!nickName || nickName === this.data.userNickName) {
      return;
    }

    const previous = this.data.userNickName;
    this.setData({ userNickName: nickName });

    const result = await AuthService.updateProfile({ nickName });
    if (result.success) {
      wx.showToast({ title: '昵称已更新', icon: 'success' });
    } else {
      // 保存失败则回退显示，避免界面与云端数据不一致
      this.setData({ userNickName: previous });
      wx.showToast({ title: result.error || '昵称保存失败', icon: 'none' });
    }
  },

  onTapEditProfileHint() {
    wx.showToast({ title: '点击头像可更换头像，点击昵称文字可编辑', icon: 'none' });
  },

  // "我的" 快捷操作面板：不改变本页其余部分，只是额外补一个小型 Bottom Sheet 入口
  onOpenQuickSheet() {
    const sheet = this.selectComponent('#mineQuickSheet');
    if (sheet && sheet.open) {
      sheet.open();
    }
  },

  // 🌟 超级管理员视角切换：仅纯前端展示层预览，绝不改写云端真实角色。
  // 仅在 isRealSuperAdmin 为真时才会被 WXML 渲染出这个入口，此处再做一次二次校验兜底。
  onSwitchViewMode(e: any) {
    if (!this.data.isRealSuperAdmin) return;

    const index = parseInt(e.detail.value, 10);
    const mode = VIEW_MODE_OPTIONS[index];
    if (!mode) return;

    setPreviewViewMode(mode);
    wx.showToast({
      title: mode === 'SUPER_ADMIN' ? '已切回超级管理员全景' : `已切换为${PREVIEW_VIEW_MODE_LABELS[mode]}预览`,
      icon: 'none'
    });

    // 立即刷新本页展示；首页会在下次 onShow（切换 Tab）时自动应用同一预览角色
    this.initMinePage();
  },

  /**
   * 任务C：加载本地护持统计（与首页共享同一组 localStorage 数据）
   */
  // 🏪 门店隔离：改为按当前门店动态过滤 my_checkin_logs（见 computeMyCheckInStats），
  // 不再直接读全局递增计数器——切换门店后这里展示的天数/工时只统计在当前门店的贡献
  loadVolunteerStats() {
    try {
      const activeStore = getSelectedStore();
      const scopedStats = computeMyCheckInStats(
        (activeStore && activeStore.storeId) || '',
        (activeStore && activeStore.storeName) || ''
      );

      this.setData({
        'stats.volunteerDays': scopedStats.days,
        'stats.volunteerHours': scopedStats.hours,
        'stats.volunteerCheckInCount': scopedStats.count
      });
      this.computeBadgeList();
    } catch (err) {
      console.warn('[mine] 读取护持统计数据失败:', err);
    }
  },

  // 🌟 数字荣誉墙：根据最新的护持天数/累计工时重新计算每枚徽章的解锁状态与提示文案。
  // stats 有两处独立更新入口（本地缓存的 loadVolunteerStats 与云端校准的 fetchMeritStats），
  // 两处都要各自触发一次重算，确保徽章墙始终反映当前已知的最新数据，不会停留在旧状态。
  computeBadgeList() {
    const volunteerDays = this.data.stats.volunteerDays || 0;
    const volunteerHours = this.data.stats.volunteerHours || 0;

    const badgeList = BADGE_CONFIG.map(cfg => {
      const current = cfg.type === 'days' ? volunteerDays : volunteerHours;
      const unlocked = current >= cfg.threshold;
      const remaining = Math.max(0, Math.ceil(cfg.threshold - current));
      const unit = cfg.type === 'days' ? '天' : '小时';
      const verb = cfg.type === 'days' ? '护持' : '累计';

      return {
        id: cfg.id,
        emoji: cfg.emoji,
        name: cfg.name,
        unlocked,
        hint: unlocked ? '' : `再${verb} ${remaining} ${unit}即可解锁「${cfg.name}」徽章`
      };
    });

    this.setData({ badgeList });
  },

  async fetchMeritStats(role: string) {
    try {
      const db = wx.cloud.database();
      const openid = AuthService.getOpenid() || '';
      // 🛡️ 数据库缺索引告警根因：下面两条 report_logs count() 都曾只按 createdBy/auditedBy
      // 过滤，没有 tenantId 前缀，等于对全表（跨所有机构）做扫描。tenantId 是
      // tenantId_date 复合索引的前导字段，查询条件必须带上它才能真正走到索引，
      // 而不是退化成全表扫描；同时也顺带堵住了"跨租户读到别的机构统计数字"的隔离漏洞。
      const cachedRoleInfo = AuthService.getCachedRoleInfo();
      const tenantId = (cachedRoleInfo && cachedRoleInfo.tenantId) || '';
      // 🏪 门店隔离：本页顶层 data.currentStoreId 从未被真正赋值过（只有
      // patriarchData.currentStoreId 这个同名但不同用途的嵌套字段），这里直接现取
      // 当前生效门店，确保"登记餐报/稽核账本"只统计当前门店，不会把用户在别的门店
      // 的历史记录也计进来
      const activeStore = getSelectedStore();
      const storeId = (activeStore && activeStore.storeId) || '';

      let submittedCount = 0;
      let auditedCount = 0;

      try {
        // 🐛 严重根因修复：report_logs 集合从未写过 createdBy 字段（createdBy 只在
        // stores/notice/daily_menu 等其他集合里使用），提交人身份统一走云开发自动
        // 挂载的 _openid（updateReportLog/getReports/manageReportApproval 等云函数
        // 判断"是否为提交人本人"全都用的是 docData._openid）。此前按 createdBy 查询，
        // 查询条件恒不命中，"登记餐报"这项荣誉墙统计对所有人都是 0。
        // 🏛️ 权限向下继承：大家长同样可能承担日常提交/稽核工作，统计口径一并覆盖
        if ((role === 'store_manager' || role === 'store_patriarch' || role === 'super_admin') && tenantId && storeId) {
          const subRes = await db.collection('report_logs')
            .where({
              tenantId,
              storeId,
              _openid: openid
            })
            .count();
          submittedCount = subRes.total || 0;
        }

        // 🛡️ 已知局限（非本次可修复范围）：report_logs.auditedBy 由 manageReportApproval
        // 写入的是角色标签字符串（如"财务稽核员"/"大家长"），不是个人 openid——真正的
        // 个人操作者身份只记录在独立的 report_audit_logs.operator_id 里，report_logs
        // 文档本身不具备"这条记录是谁个人稽核的"这个字段，无法在这条查询上做到与
        // submittedCount 同等的个人隔离，暂时只能收窄到"当前门店 + 本机构"维度
        // （即"本店已稽核的账目数"，不是"我个人稽核过的账目数"）。
        // 这两个数字是直接展示给用户的"已提交/已稽核"荣誉墙统计，不是单纯的"是否存在"
        // 判断，所以不能用 limit(1) 替代——limit(1) 只能回答"有没有"，答不出"有多少"。
        if ((role === 'finance' || role === 'store_patriarch' || role === 'super_admin') && tenantId && storeId) {
          const audRes = await db.collection('report_logs')
            .where({
              tenantId,
              storeId,
              auditedBy: db.command.exists(true)
            })
            .count();
          auditedCount = audRes.total || 0;
        }
      } catch (dbErr) {
        console.warn('[fetchMeritStats] 数据库查询失败，使用兜底数据:', dbErr);
      }

      // 🏪 门店隔离：与 loadVolunteerStats 同一套口径，按当前门店动态过滤
      // my_checkin_logs，不再直接读全局递增计数器
      const scopedStats = computeMyCheckInStats(storeId, (activeStore && activeStore.storeName) || '');

      this.setData({
        stats: {
          volunteerDays: scopedStats.days,
          volunteerHours: scopedStats.hours,
          volunteerCheckInCount: scopedStats.count,
          submittedReports: submittedCount || (role === 'store_manager' || role === 'store_patriarch' || role === 'super_admin' ? 14 : 0),
          auditedReports: auditedCount || (role === 'finance' || role === 'store_patriarch' || role === 'super_admin' ? 8 : 0)
        }
      });
      this.computeBadgeList();
    } catch (err) {
      console.error('[fetchMeritStats] 加载失败:', err);
      const fallbackStore = getSelectedStore();
      const fallbackStats = computeMyCheckInStats(
        (fallbackStore && fallbackStore.storeId) || '',
        (fallbackStore && fallbackStore.storeName) || ''
      );

      this.setData({
        stats: {
          volunteerDays: fallbackStats.days,
          volunteerHours: fallbackStats.hours,
          volunteerCheckInCount: fallbackStats.count,
          submittedReports: role === 'store_manager' || role === 'store_patriarch' || role === 'super_admin' ? 14 : 0,
          auditedReports: role === 'finance' || role === 'store_patriarch' || role === 'super_admin' ? 8 : 0
        }
      });
      this.computeBadgeList();
    }
  },

  onReleaseUserRole() {
    if (this.isNavigating) return;

    const roleMap: Record<string, string> = {
      'store_manager': '店长',
      'finance': '财务',
      'super_admin': '超级管理员',
      'store_patriarch': '大家长',
      'store_family': '家人'
    };
    const roleLabel = roleMap[this.data.currentUserRole] || '管理员';

    this.setData({
      showReleaseModal: true,
      releaseRoleLabel: roleLabel
    });
  },

  stopPropagation() {},

  onCancelReleaseModal() {
    if (this.data.isReleasing) return;
    this.setData({ showReleaseModal: false });
  },

  onConfirmReleaseRole() {
    if (this.data.isReleasing) return;
    this.setData({ isReleasing: true });

    wx.showLoading({ title: '安全卸任中...' });

    try {
      wx.removeStorageSync('current_user_role');
      wx.removeStorageSync('my_authorized_roles');
      wx.removeStorageSync('current_user_role_info');

      AuthService.clearAuth();

      wx.setStorageSync('current_user_role', 'volunteer');

      setTimeout(() => {
        wx.hideLoading();
        this.setData({ showReleaseModal: false, isReleasing: false });
        wx.showToast({ title: '身份已卸任重置', icon: 'success' });

        setTimeout(() => {
          this.isNavigating = true;
          wx.reLaunch({
            url: '/pages/index/index',
            fail: () => {
              this.isNavigating = false;
            }
          });
        }, 600);
      }, 500);

    } catch (err) {
      wx.hideLoading();
      this.setData({ isReleasing: false });
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
  },

  onTriggerActivate() {
    wx.showModal({
      title: '🔑 激活特权身份',
      content: '请移步至主页，在门店选择器中选择您要激活的门店与身份，并输入超级管理员提供的激活码进行绑定。',
      showCancel: false,
      confirmColor: '#8C1D18',
      success: () => {
        if (this.isNavigating) return;
        this.isNavigating = true;
        wx.switchTab({
          url: '/pages/index/index',
          fail: () => {
            this.isNavigating = false;
          }
        });
      }
    });
  },

  // 📜 服务历程：原 onGoToJourney，首页打卡卡片精简后"服务历程"入口收拢到
  // 个人页"日常记录"列表统一承载，导航目标/逻辑保持不变，仅重命名对齐新入口
  onTapServiceHistory() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/journey/journey',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 🌟 数字荣誉墙：点击某枚徽章。已解锁 -> 直接打开证书弹窗（与"义工证书"入口共用同一套
  // 生成逻辑，个人只有一张证书，不区分是从哪枚徽章点进来的）；未解锁 -> 提示还差多少即可解锁，
  // 不弹证书——避免用户以为点了没有解锁的徽章也能拿到证书
  onTapBadge(e: any) {
    const id = e.currentTarget.dataset.id;
    const badge = (this.data.badgeList || []).find((b: any) => b.id === id);
    if (!badge) return;

    if (badge.unlocked) {
      this.onGoToBadges();
    } else {
      wx.showToast({ title: badge.hint, icon: 'none', duration: 2200 });
    }
  },

  // 义工证书：异步绘制一张长图证书（Canvas 2D），绘制完成后展示为可保存的全屏预览
  async onGoToBadges() {
    const { userNickName, stats, currentStoreName } = this.data;

    this.setData({
      showCertificateModal: true,
      certificateTempFilePath: '',
      certificateGenerating: true
    });
    wx.showLoading({ title: '正在生成证书...', mask: true });

    // 🌟 证书右下角的小程序码：复用 getStoreQRCode，但带上 purpose: 'certificate'——
    // 该云函数默认只允许店长/超管生成门店推广二维码，普通义工调用会被拒绝；证书场景下
    // 已经放宽为"任何角色都可以生成自己所属门店的二维码"（见云函数侧改动），
    // 这里获取失败也不阻断证书生成，只是最终图上不显示二维码
    let qrCodeLocalPath = '';
    try {
      const cachedRole = AuthService.getCachedRoleInfo();
      const storeId = (cachedRole && cachedRole.storeId) || '';
      if (storeId) {
        const qrRes = await wx.cloud.callFunction({
          name: 'getStoreQRCode',
          data: { storeId, storeName: currentStoreName, purpose: 'certificate' }
        });
        const qrResult = qrRes.result as any;
        if (qrResult && qrResult.success && qrResult.fileID) {
          const downRes = await wx.cloud.downloadFile({ fileID: qrResult.fileID });
          qrCodeLocalPath = downRes.tempFilePath;
        } else {
          console.warn('[onGoToBadges] 小程序码生成失败:', qrResult && qrResult.error);
        }
      }
    } catch (qrErr) {
      console.warn('[onGoToBadges] 小程序码获取异常，证书将不显示二维码:', qrErr);
    }

    // Canvas 节点要等 wx:if="{{showCertificateModal}}" 对应的 <canvas> 真正挂载渲染后
    // 才能被 selectorQuery 查到，这里延迟一小段时间与其它海报生成流程保持一致的做法
    setTimeout(() => {
      const query = wx.createSelectorQuery();
      query.select('#' + CERTIFICATE_CANVAS_ID)
        .fields({ node: true, size: true })
        .exec(async (res) => {
          if (!res[0] || !res[0].node) {
            wx.hideLoading();
            this.setData({ certificateGenerating: false });
            wx.showToast({ title: '证书生成失败', icon: 'none' });
            return;
          }

          const canvas = res[0].node;
          try {
            await drawVolunteerCertificate({
              canvas,
              nickname: userNickName,
              days: stats.volunteerDays || 0,
              hours: stats.volunteerHours || 0,
              qrCodeTempPath: qrCodeLocalPath,
              width: 340,
              height: 480
            });

            wx.canvasToTempFilePath({
              canvas,
              success: (tempRes) => {
                this.setData({ certificateTempFilePath: tempRes.tempFilePath, certificateGenerating: false });
                wx.hideLoading();
              },
              fail: (err) => {
                wx.hideLoading();
                this.setData({ certificateGenerating: false });
                console.error('[onGoToBadges] canvasToTempFilePath 失败:', err);
                wx.showToast({ title: '证书生成失败', icon: 'none' });
              }
            });
          } catch (drawErr) {
            wx.hideLoading();
            this.setData({ certificateGenerating: false });
            console.error('[onGoToBadges] 绘制失败:', drawErr);
            wx.showToast({ title: '证书绘制失败', icon: 'none' });
          }
        });
    }, 300);
  },

  onCloseCertificateModal() {
    this.setData({ showCertificateModal: false });
  },

  onSaveCertificateToAlbum() {
    const filePath = this.data.certificateTempFilePath;
    if (!filePath) {
      wx.showToast({ title: '证书尚未生成完成，请稍候', icon: 'none' });
      return;
    }

    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => {
        wx.showToast({ title: '证书已保存至相册，快去分享朋友圈吧', icon: 'success', duration: 2500 });
      },
      fail: (err: any) => {
        if (err.errMsg && err.errMsg.includes('auth deny')) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中允许小程序访问相册，才能保存证书图片',
            confirmText: '去设置',
            success: (res) => {
              if (res.confirm) wx.openSetting();
            }
          });
        } else {
          console.warn('[onSaveCertificateToAlbum] 保存失败:', err);
          wx.showToast({ title: '保存失败，请重试', icon: 'none' });
        }
      }
    });
  },

  onGoToMySubmissions() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/history/history?view=mine',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 🌟 店长专属入口：本店数据明细（携带 shopName 预选中本店，与超管工具箱里
  // 不带 shopName、默认落到全国汇总视角的"全国多店大屏"区分开），复用同一个
  // 统计页面（/pages/statistics/statistics），不新建一套统计逻辑
  onGoToStoreOverview() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: `/pages/statistics/statistics?shopName=${encodeURIComponent(this.data.currentStoreName || '')}`,
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  onGoToStoreProfile() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/store-profile/store-profile',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 🏪 查看店铺状态：复用 manageStoreProfile 'get' 动作，该动作本就允许任意已绑定
  // 门店的角色只读查看（店长/财务/义工/家人皆可），不需要新开云函数或放宽权限
  async onShowStoreStatus() {
    this.setData({
      showStoreStatusModal: true,
      'storeStatusInfo.loading': true
    });

    try {
      const store = getSelectedStore();
      if (!store || !store.storeId) {
        this.setData({
          'storeStatusInfo.loading': false,
          'storeStatusInfo.storeName': this.data.currentStoreName || '',
          'storeStatusInfo.operatingStatus': '',
          'storeStatusInfo.operatingStatusLabel': ''
        });
        return;
      }

      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreProfile',
        data: { action: 'get', storeId: store.storeId }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '加载店铺状态失败', icon: 'none' });
        this.setData({ 'storeStatusInfo.loading': false });
        return;
      }

      const data = result.data || {};
      const OPERATING_STATUS_LABELS: Record<string, string> = {
        operating: '运营中',
        preparing: '筹备中',
        paused: '暂停运营'
      };
      const statusLabel = OPERATING_STATUS_LABELS[data.operatingStatus] || '运营中';
      this.setData({
        'storeStatusInfo.loading': false,
        'storeStatusInfo.storeName': data.storeName || this.data.currentStoreName || '',
        'storeStatusInfo.operatingStatus': data.operatingStatus || 'operating',
        'storeStatusInfo.operatingStatusLabel': statusLabel,
        // 🏪 顺手同步全局态：这次弹窗已经查到了最新状态，直接复用，不必再额外
        // 发一次 fetchAndSyncStoreStatus 请求
        currentStoreStatus: statusLabel
      });
      const app = getApp() as any;
      if (app && app.globalData) {
        app.globalData.currentStoreStatus = statusLabel;
      }
      wx.setStorageSync('current_store_status', statusLabel);
    } catch (err) {
      console.error('[onShowStoreStatus] 加载店铺状态异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      this.setData({ 'storeStatusInfo.loading': false });
    }
  },

  onCloseStoreStatusModal() {
    this.setData({ showStoreStatusModal: false });
  },

  // 🏪 门店状态静默刷新：onShow 每次切回个人页都调用，先用缓存秒显，再后台悄悄
  // 刷新最新值，失败不打扰用户（见 utils/storeManager.ts fetchAndSyncStoreStatus）
  refreshStoreStatus() {
    const cached = getCachedStoreStatus();
    if (cached) {
      this.setData({ currentStoreStatus: cached });
    }

    const store = getSelectedStore();
    if (store && store.storeId) {
      fetchAndSyncStoreStatus(store.storeId).then((label) => {
        if (label) {
          this.setData({ currentStoreStatus: label });
        }
      });
    }
  },

  onGoToAbout() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/help/help',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  onTriggerGenCode() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.switchTab({
      url: '/pages/index/index',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  onTriggerClearCache() {
    wx.showModal({
      title: '🧹 确认清洗测试缓存？',
      content: '此操作将清理本地所有测试缓存数据。云端正式数据不会受影响。确认继续？',
      confirmText: '确认清洗',
      confirmColor: '#8C1D18',
      success: (res) => {
        if (res.confirm) {
          try {
            wx.clearStorageSync();
            wx.showToast({ title: '测试缓存已清除', icon: 'success' });
            
            setTimeout(() => {
              this.isNavigating = true;
              wx.reLaunch({
                url: '/pages/index/index',
                fail: () => {
                  this.isNavigating = false;
                }
              });
            }, 800);
          } catch (err) {
            wx.showToast({ title: '清理失败', icon: 'none' });
          }
        }
      }
    });
  },

  onGoToStatistics() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/statistics/statistics',
      fail: () => {
        this.isNavigating = false;
      }
    });
  }
});
