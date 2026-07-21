import { AuthService } from '../../utils/authService';
import { requestComplianceReview } from '../../utils/complianceHandoff';
import { getSafeSystemInfo } from '../../utils/util';

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    currentUserRole: 'volunteer' as string,
    hasPrivilege: false,
    isReleasing: false
  },

  onLoad() {
    this.calculateNavBarHeight();
  },

  onShow() {
    this.initRoleState();
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

    this.setData({ currentUserRole: role, hasPrivilege });
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

  // 清除本地缓存：与 profile.ts 的 onTriggerClearCache 同款逻辑，改为对所有用户开放
  // （这是一个通用的自助操作，不涉及管理权限）
  onTapClearCache() {
    wx.showModal({
      title: '🧹 确认清除本地缓存？',
      content: '此操作将清理本地所有缓存数据（含未提交的草稿）。云端正式数据不会受影响。确认继续？',
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

  // 退出当前身份 / 切换身份：与 profile.ts 的 onReleaseUserRole/onConfirmReleaseRole 同款核心逻辑
  onTapReleaseRole() {
    if (this.data.isReleasing) return;

    const roleMap: Record<string, string> = {
      store_manager: '店长',
      finance: '财务',
      super_admin: '超级管理员'
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
    wx.navigateTo({
      url: '/pages/help/help',
      fail: (err) => {
        console.warn('[settings] 跳转帮助页失败:', err);
      }
    });
  }
});
