Page({
  data: {
    reports: [],
    loading: true,
    navTop: 0,
    contentTop: 0
  },

  onLoad() {
    this.calculateNavBarHeight();
    this.loadReports();
  },

  onShow() {
    this.loadReports();
  },

  calculateNavBarHeight() {
    const menuButton = wx.getMenuButtonBoundingClientRect();
    if (!menuButton) {
      this.setData({
        navTop: 44,
        contentTop: 88
      });
      return;
    }

    const navTop = menuButton.top;
    const contentTop = menuButton.top + menuButton.height + 16;

    this.setData({
      navTop: navTop,
      contentTop: contentTop
    });
  },

  loadReports() {
    this.setData({ loading: true });
    const db = wx.cloud.database();
    
    db.collection('report_logs')
      .orderBy('dateString', 'desc')
      .get({
        success: (res) => {
          this.setData({
            reports: res.data || [],
            loading: false
          });
        },
        fail: (error) => {
          if (error.errCode === -502005) {
            this.setData({
              reports: [],
              loading: false
            });
          } else {
            console.error('云数据库读取历史记录失败:', error);
            this.setData({ loading: false });
            wx.showToast({ title: '加载失败', icon: 'error' });
          }
        }
      });
  },

  buildReportText(item: any) {
    const dateStr = item.dateString || '';
    const shopName = item.shopName || '店铺';
    const yesterdayBalance = (item.yesterdayBalance || 0).toFixed(2);
    const otherDonation = (item.otherDonation || 0).toFixed(2);
    const listDonationTotal = (item.listDonationTotal || 0).toFixed(2);
    const expenseAmount = (item.expenseAmount || 0).toFixed(2);
    const todayBalance = (item.todayBalance || 0).toFixed(2);

    let reportText = `📅 ${dateStr} ${shopName}餐报\n\n`;
    reportText += `一、爱心人士供养\n`;
    reportText += `随喜供养：${otherDonation}\n`;
    reportText += `名单供养：${listDonationTotal}\n`;
    reportText += `今日合计：${(parseFloat(otherDonation) + parseFloat(listDonationTotal)).toFixed(2)}\n\n`;
    reportText += `二、店铺支出：${expenseAmount > 0 ? expenseAmount : '无'}\n\n`;
    reportText += `三、《店铺余额》\n`;
    reportText += `${yesterdayBalance}+${(parseFloat(otherDonation) + parseFloat(listDonationTotal)).toFixed(2)}`;
    if (parseFloat(expenseAmount) > 0) {
      reportText += `-${expenseAmount}`;
    }
    reportText += `=${todayBalance}\n\n`;
    reportText += `如有遗漏、错误请指正！\n\n`;
    reportText += `四、没有杀戮，没有交易，只有感恩~`;

    return reportText;
  },

  copyReport(e: any) {
    const index = e.currentTarget.dataset.index;
    const report = this.data.reports[index];
    
    if (!report) {
      wx.showToast({ title: '数据异常', icon: 'none' });
      return;
    }

    const reportText = this.buildReportText(report);

    wx.setClipboardData({
      data: reportText,
      success: () => {
        wx.showToast({ title: '复制成功，可直接发群', icon: 'success' });
      },
      fail: () => {
        wx.showToast({ title: '复制失败', icon: 'error' });
      }
    });
  },

  goBack() {
    wx.navigateBack();
  },

  goToHome() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.reLaunch({
        url: '/pages/index/index'
      });
    }
  }
});