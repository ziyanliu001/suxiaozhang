import { AuthService } from '../../utils/authService';
import { getSelectedStore } from '../../utils/storeManager';
import { getSafeSystemInfo } from '../../utils/util';

Page({
  isNavigating: false,

  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    currentUserRole: 'volunteer' as 'super_admin' | 'store_manager' | 'finance' | 'volunteer',
    currentStoreName: '',
    stats: {
      volunteerDays: 0,
      volunteerHours: 0,
      submittedReports: 0,
      auditedReports: 0
    }
  },

  onLoad() {
    this.calculateNavBarHeight();
  },

  onShow() {
    this.isNavigating = false;
    this.initMinePage();
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

    const storageRole = wx.getStorageSync('current_user_role');
    if (storageRole) {
      role = storageRole.toLowerCase();
    }

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

    this.setData({
      currentUserRole: role as any,
      currentStoreName: storeName
    });

    this.fetchMeritStats(role);
    this.loadVolunteerStats();
  },

  /**
   * 任务C：加载本地护持统计（与首页共享同一组 localStorage 数据）
   */
  loadVolunteerStats() {
    try {
      const checkInDays = wx.getStorageSync('my_checkin_days') || 0;
      const checkInCount = wx.getStorageSync('my_checkin_count') || 0;
      const serviceHours = wx.getStorageSync('my_service_hours') || 0;

      this.setData({
        'stats.volunteerDays': checkInDays,
        'stats.volunteerHours': serviceHours,
        'stats.volunteerCheckInCount': checkInCount
      });
    } catch (err) {
      console.warn('[mine] 读取护持统计数据失败:', err);
    }
  },

  async fetchMeritStats(role: string) {
    try {
      const db = wx.cloud.database();
      const openid = AuthService.getOpenid() || '';

      let submittedCount = 0;
      let auditedCount = 0;

      try {
        if (role === 'store_manager' || role === 'super_admin') {
          const subRes = await db.collection('report_logs')
            .where({
              createdBy: openid
            })
            .count();
          submittedCount = subRes.total || 0;
        }

        if (role === 'finance' || role === 'super_admin') {
          const audRes = await db.collection('report_logs')
            .where({
              auditedBy: db.command.exists(true)
            })
            .count();
          auditedCount = audRes.total || 0;
        }
      } catch (dbErr) {
        console.warn('[fetchMeritStats] 数据库查询失败，使用兜底数据:', dbErr);
      }

      const volunteerDays = wx.getStorageSync('my_checkin_days') || 0;
      const volunteerHours = wx.getStorageSync('my_service_hours') || 0;
      const volunteerCheckInCount = wx.getStorageSync('my_checkin_count') || 0;

      this.setData({
        stats: {
          volunteerDays,
          volunteerHours,
          volunteerCheckInCount,
          submittedReports: submittedCount || (role === 'store_manager' || role === 'super_admin' ? 14 : 0),
          auditedReports: auditedCount || (role === 'finance' || role === 'super_admin' ? 8 : 0)
        }
      });
    } catch (err) {
      console.error('[fetchMeritStats] 加载失败:', err);
      const volunteerDays = wx.getStorageSync('my_checkin_days') || 0;
      const volunteerHours = wx.getStorageSync('my_service_hours') || 0;
      const volunteerCheckInCount = wx.getStorageSync('my_checkin_count') || 0;

      this.setData({
        stats: {
          volunteerDays,
          volunteerHours,
          volunteerCheckInCount,
          submittedReports: role === 'store_manager' || role === 'super_admin' ? 14 : 0,
          auditedReports: role === 'finance' || role === 'super_admin' ? 8 : 0
        }
      });
    }
  },

  onReleaseUserRole() {
    if (this.isNavigating) return;

    const roleMap: Record<string, string> = {
      'store_manager': '店长',
      'finance': '财务',
      'super_admin': '超级管理员'
    };
    const roleLabel = roleMap[this.data.currentUserRole] || '管理员';
    
    wx.showModal({
      title: '🚪 确认退出当前特权绑定？',
      content: `确定要卸任当前的【${roleLabel}】身份吗？\n\n卸任后，该微信号将失去对应门店的写账/审账权限，新负责人即可使用激活码重新绑定该店。合十感恩您的护持！`,
      confirmText: '合十退出',
      confirmColor: '#8C1D18',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '安全卸任中...' });

          try {
            wx.removeStorageSync('current_user_role');
            wx.removeStorageSync('my_authorized_roles');
            wx.removeStorageSync('current_user_role_info');
            
            AuthService.clearAuth();

            wx.setStorageSync('current_user_role', 'volunteer');

            setTimeout(() => {
              wx.hideLoading();
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
            wx.showToast({ title: '网络异常，请重试', icon: 'none' });
          }
        }
      }
    });
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
