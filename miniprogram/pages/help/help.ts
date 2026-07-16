import { createNavGuard, NavGuardInstance } from '../../utils/navGuard';

Page({
  _navGuard: null as NavGuardInstance | null,
  isNavigating: false,

  data: {
    activeTab: 'manager' as 'manager' | 'finance' | 'volunteer' | 'faq',
    navTop: 0,
    contentTop: 0
  },

  onLoad(options: any) {
    this.calculateNavBarHeight();

    if (options && options.tab) {
      const validTabs = ['manager', 'finance', 'volunteer', 'faq'];
      if (validTabs.indexOf(options.tab) >= 0) {
        this.setData({ activeTab: options.tab });
      }
    }

    // 注入物理返回键兜底拦截
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

  onShow() {
    // 重置路由防重锁
    this.isNavigating = false;
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

  onSwitchTab(e: any) {
    const tab = e.currentTarget.dataset.tab;
    if (tab && tab !== this.data.activeTab) {
      this.setData({ activeTab: tab });
    }
  },

  onGoBack() {
    // 优先使用 navGuard 的智能跳转
    if (this._navGuard) {
      this._navGuard.goHome();
      return;
    }
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.reLaunch({ url: '/pages/index/index' });
    }
  },

  /**
   * 任务C：携带 action=checkInCard 参数跳转首页，触发锚点聚焦 + 高亮动画
   * 优先使用 navigateBack 回退到栈中已有的首页（保留首页状态），否则 reLaunch
   */
  onGotoCheckInCard() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    const targetUrl = '/pages/index/index?action=checkInCard';

    try {
      const pages = getCurrentPages();
      // 倒序查找栈中是否已有首页
      for (let i = pages.length - 2; i >= 0; i--) {
        const route = '/' + (pages[i].route || '');
        if (route === '/pages/index/index') {
          wx.navigateBack({
            delta: pages.length - 1 - i,
            success: () => {
              // 通过 eventChannel 或全局变量传递参数（navigateBack 不支持 url 参数）
              const app = getApp() as any;
              if (app.globalData) {
                app.globalData.pendingScrollTarget = 'checkInCard';
              }
              this.isNavigating = false;
            },
            fail: () => {
              this.isNavigating = false;
            }
          });
          return;
        }
      }
    } catch (e) {
      /* ignore */
    }

    // 兜底：reLaunch 携带参数
    setTimeout(() => {
      wx.reLaunch({
        url: targetUrl,
        complete: () => {
          this.isNavigating = false;
        }
      });
    }, 100);
  }
});
