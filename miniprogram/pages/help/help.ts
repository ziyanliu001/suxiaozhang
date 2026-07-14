Page({
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
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.reLaunch({ url: '/pages/index/index' });
    }
  }
});
