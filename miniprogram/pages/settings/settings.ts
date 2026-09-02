import { AuthService } from '../../utils/authService';
import { requestComplianceReview } from '../../utils/complianceHandoff';
import { getSafeSystemInfo } from '../../utils/util';
import { safeNavigateTo } from '../../utils/navHelper';
import { requestDailyReportReminderSubscription } from '../../utils/subscribeMessage';
import { STORAGE_KEY_DEFAULT_HOME_VIEW, STORAGE_KEY_PRIVACY_MASK } from '../../utils/userPreferences';

// 🆕 本页新增的三项本地偏好，均为纯客户端展示/交互开关（不改动任何服务端权限
// 判定口径）：默认首页视图 / 隐私脱敏模式 / 每日餐报提醒。前两项的 Storage key
// 集中定义在 utils/userPreferences.ts（history.ts/index.ts 等消费方共用同一份，
// 避免字符串常量各自复制一份漂移不一致）；每日提醒纯粹是本页私有的开关，不需要
// 其余页面读取，仍留在本文件
const STORAGE_KEY_DAILY_REMINDER = 'setting_daily_report_reminder_enabled';

const ROLE_LABEL_MAP: Record<string, { label: string; icon: string }> = {
  super_admin: { label: '超级管理员', icon: '👑' },
  store_patriarch: { label: '大家长', icon: '🏛️' },
  store_manager: { label: '店长', icon: '🏪' },
  finance: { label: '财务', icon: '💰' },
  store_family: { label: '家人', icon: '👨‍👩‍👧' },
  volunteer: { label: '志愿者', icon: '🙋' }
};

const HOME_VIEW_LABEL_MAP: Record<string, string> = {
  store: '门店汇总',
  personal: '个人记录'
};

const ENV_LABEL_MAP: Record<string, string> = {
  develop: '开发版',
  trial: '体验版',
  release: '正式版'
};

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    currentUserRole: 'volunteer' as string,
    hasPrivilege: false,
    isReleasing: false,

    // 🆕 头部 Profile 简述
    roleLabel: '志愿者',
    roleIcon: '🙋',
    storeName: '',

    // 🆕 权限与授权组
    cameraAuthStatus: 'unknown' as 'authorized' | 'denied' | 'unknown',
    albumAuthStatus: 'unknown' as 'authorized' | 'denied' | 'unknown',
    reminderEnabled: false,
    reminderToggling: false,

    // 🆕 数据与展示偏好组
    defaultHomeView: 'store' as 'store' | 'personal',
    defaultHomeViewLabel: '门店汇总',
    privacyMaskEnabled: false,

    // 🆕 系统运维组
    cacheSizeStr: '0 KB',
    appVersion: '',
    appEnvLabel: ''
  },

  onLoad() {
    this.calculateNavBarHeight();
    this.loadPreferences();
    this.refreshCacheSize();
    this.loadAppVersionInfo();
  },

  onShow() {
    this.initRoleState();
    this.refreshPermissionStatus();
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
      console.warn('[settings] Calc height fallback:', e);
    }
  },

  onBackTap() {
    wx.navigateBack({ delta: 1 });
  },

  initRoleState() {
    const cached = AuthService.getCachedRoleInfo();
    const storageRole = wx.getStorageSync('current_user_role');
    const role = (storageRole || (cached && cached.role) || 'volunteer').toLowerCase();
    const hasPrivilege = role === 'store_manager' || role === 'finance' || role === 'super_admin';
    const roleMeta = ROLE_LABEL_MAP[role] || ROLE_LABEL_MAP.volunteer;

    // 门店名优先取角色缓存里的权威值，其次退回历史遗留的 Storage 原始 key
    // （与 history.ts onShow 同一条兜底顺序），超管未绑定具体门店时留空展示"全国总览"
    const storeName = (cached && cached.storeName) || wx.getStorageSync('current_store_name') || '';

    this.setData({
      currentUserRole: role,
      hasPrivilege,
      roleLabel: roleMeta.label,
      roleIcon: roleMeta.icon,
      storeName: storeName || (role === 'super_admin' ? '全国总览' : '未绑定门店')
    });
  },

  // 🆕 权限与授权组：读取相机/相册系统授权状态，供"去系统授权"入口展示当前态
  refreshPermissionStatus() {
    wx.getSetting({
      success: (res) => {
        const authSetting = res.authSetting || {};
        this.setData({
          cameraAuthStatus: this.mapAuthValue(authSetting['scope.camera']),
          albumAuthStatus: this.mapAuthValue(authSetting['scope.writePhotosAlbum'])
        });
      },
      fail: (err) => {
        console.warn('[settings] wx.getSetting 查询权限状态失败:', err);
      }
    });
  },

  mapAuthValue(value: boolean | undefined): 'authorized' | 'denied' | 'unknown' {
    if (value === true) return 'authorized';
    if (value === false) return 'denied';
    return 'unknown';
  },

  // 相册与相机权限：跳系统设置页；用户返回后立即用最新授权结果刷新展示态，
  // 不需要等下一次 onShow
  onOpenSystemAuthSetting() {
    wx.openSetting({
      success: (res) => {
        const authSetting = res.authSetting || {};
        this.setData({
          cameraAuthStatus: this.mapAuthValue(authSetting['scope.camera']),
          albumAuthStatus: this.mapAuthValue(authSetting['scope.writePhotosAlbum'])
        });
      },
      fail: (err) => {
        console.warn('[settings] wx.openSetting 调用失败:', err);
      }
    });
  },

  loadPreferences() {
    try {
      const defaultHomeView = wx.getStorageSync(STORAGE_KEY_DEFAULT_HOME_VIEW) || 'store';
      const privacyMaskEnabled = !!wx.getStorageSync(STORAGE_KEY_PRIVACY_MASK);
      const reminderEnabled = !!wx.getStorageSync(STORAGE_KEY_DAILY_REMINDER);
      this.setData({
        defaultHomeView,
        defaultHomeViewLabel: HOME_VIEW_LABEL_MAP[defaultHomeView] || '门店汇总',
        privacyMaskEnabled,
        reminderEnabled
      });
    } catch (err) {
      console.warn('[settings] 读取本地偏好失败:', err);
    }
  },

  // 默认首页视图：门店汇总 / 个人记录
  onSelectDefaultView() {
    wx.showActionSheet({
      itemList: ['门店汇总', '个人记录'],
      success: (res) => {
        const value = res.tapIndex === 1 ? 'personal' : 'store';
        wx.setStorageSync(STORAGE_KEY_DEFAULT_HOME_VIEW, value);
        this.setData({
          defaultHomeView: value,
          defaultHomeViewLabel: HOME_VIEW_LABEL_MAP[value]
        });
        wx.showToast({ title: '已设为默认视图', icon: 'none' });
      },
      fail: () => { /* 用户取消，静默忽略 */ }
    });
  },

  // 隐私与脱敏模式：敏感捐赠者姓名/金额掩码显示的客户端展示偏好
  onTogglePrivacyMask(e: any) {
    const enabled = !!(e.detail && e.detail.value);
    wx.setStorageSync(STORAGE_KEY_PRIVACY_MASK, enabled);
    this.setData({ privacyMaskEnabled: enabled });
    wx.showToast({ title: enabled ? '已开启隐私脱敏模式' : '已关闭隐私脱敏模式', icon: 'none' });
  },

  // 每日未录入餐报提醒：开启时唤起订阅消息授权弹窗，用户是否点击"允许"不影响
  // 开关本身的本地展示态——拒绝只是拿不到这次的推送资格，不阻塞其余设置操作
  async onToggleReminder(e: any) {
    if (this.data.reminderToggling) return;
    const enabled = !!(e.detail && e.detail.value);

    if (!enabled) {
      wx.setStorageSync(STORAGE_KEY_DAILY_REMINDER, false);
      this.setData({ reminderEnabled: false });
      wx.showToast({ title: '已关闭每日提醒', icon: 'none' });
      return;
    }

    this.setData({ reminderToggling: true });
    try {
      await requestDailyReportReminderSubscription();
      wx.setStorageSync(STORAGE_KEY_DAILY_REMINDER, true);
      this.setData({ reminderEnabled: true });
      wx.showToast({ title: '已开启每日提醒', icon: 'none' });
    } finally {
      this.setData({ reminderToggling: false });
    }
  },

  // 清理本地缓存：与此前逻辑一致（清空 Storage 后重启回首页），额外补上清理前的
  // 容量展示，让"清理"这个操作有具体可感知的数字反馈，而不是纯粹的盲操作
  onTapClearCache() {
    // 打开确认弹窗前重新读一次，避免展示上次 onLoad 时留下的旧数值（与
    // profile.ts onTriggerClearCache 同款时机）
    this.refreshCacheSize();
    wx.showModal({
      title: '🧹 确认清除本地缓存？',
      content: `当前本地缓存约 ${this.data.cacheSizeStr}（含统计数据缓存、未提交草稿等）。此操作会清理全部本地缓存，云端正式数据不受影响。确认继续？`,
      confirmText: '确认清除',
      confirmColor: '#8C1D18',
      success: (res) => {
        if (res.confirm) {
          try {
            wx.clearStorageSync();
            wx.showToast({ title: '本地缓存已清除', icon: 'success' });
            setTimeout(() => {
              wx.reLaunch({
                url: '/pages/index/index',
                fail: () => {}
              });
            }, 800);
          } catch (err) {
            wx.showToast({ title: '清理失败，请重试', icon: 'none' });
          }
        }
      }
    });
  },

  // 🆕 缓存容量展示：与 profile.ts refreshCacheSize() 同款格式化口径（"<0.1MB"/
  // "X.XMB"），wx.getStorageInfoSync 是小程序唯一能拿到的本地容量口径（Storage 区），
  // 不虚构一个无法验证的"图片缓存"数字，也不在全项目内制造第二套容量文案风格
  refreshCacheSize() {
    try {
      const info = wx.getStorageInfoSync();
      const mb = (info.currentSize || 0) / 1024;
      this.setData({ cacheSizeStr: mb < 0.1 ? '<0.1MB' : `${mb.toFixed(1)}MB` });
    } catch (err) {
      console.warn('[settings] wx.getStorageInfoSync 查询失败:', err);
      this.setData({ cacheSizeStr: '--' });
    }
  },

  loadAppVersionInfo() {
    try {
      const accountInfo = wx.getAccountInfoSync();
      const mp = accountInfo && accountInfo.miniProgram;
      const version = (mp && mp.version) || '';
      const envVersion = (mp && mp.envVersion) || '';
      this.setData({
        appVersion: version || '开发版',
        appEnvLabel: ENV_LABEL_MAP[envVersion] || ''
      });
    } catch (err) {
      console.warn('[settings] wx.getAccountInfoSync 获取版本信息失败:', err);
    }
  },

  // 查看合规声明：不复制文案，跳回首页触发已有的 review 场景弹窗（见 index.ts checkPendingHandoffs）
  onTapComplianceReview() {
    requestComplianceReview();
    wx.switchTab({
      url: '/pages/index/index',
      fail: (err) => {
        console.warn('[settings] 跳转首页失败:', err);
      }
    });
  },

  // 退出当前身份 / 切换身份：与 profile.ts 的 onReleaseUserRole/onConfirmReleaseRole 同款核心逻辑
  onTapReleaseRole() {
    if (this.data.isReleasing) return;

    const roleMap: Record<string, string> = {
      store_manager: '店长',
      finance: '财务',
      super_admin: '超级管理员',
      store_patriarch: '大家长',
      store_family: '家人'
    };
    const roleLabel = roleMap[this.data.currentUserRole] || '管理员';

    wx.showModal({
      title: `确认退出「${roleLabel}」身份？`,
      content: '将立即失去当前门店的写账/审账权限，本地权限凭证会被清除，需重新申请或扫码激活，该操作不可逆。',
      confirmText: '确认退出',
      confirmColor: '#E03131',
      success: (res) => {
        if (res.confirm) {
          this.doReleaseRole();
        }
      }
    });
  },

  doReleaseRole() {
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
        this.setData({ isReleasing: false });
        wx.showToast({ title: '身份已卸任重置', icon: 'success' });

        setTimeout(() => {
          wx.reLaunch({ url: '/pages/index/index', fail: () => {} });
        }, 600);
      }, 500);
    } catch (err) {
      wx.hideLoading();
      this.setData({ isReleasing: false });
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
  },

  onTapAbout() {
    safeNavigateTo({
      url: '/pages/help/help',
      fail: (err) => {
        console.warn('[settings] 跳转帮助页失败:', err);
      }
    });
  }
});
