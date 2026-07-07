Page({
  data: {
    currentTab: 'week',
    selectedYear: new Date().getFullYear(),
    selectedMonth: new Date().getMonth() + 1,
    dateValue: '',
    statistics: null
  },

  onLoad() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    
    this.setData({
      dateValue: `${year}-${month}-${day}`,
      selectedYear: year,
      selectedMonth: now.getMonth() + 1
    });

    this.loadWeekStatistics();
  },

  switchTab(e: any) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({
      currentTab: tab,
      statistics: null
    });

    if (tab === 'week') {
      this.loadWeekStatistics();
    } else {
      this.loadMonthStatistics();
    }
  },

  onMonthChange(e: any) {
    const date = new Date(e.detail.value);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    
    this.setData({
      selectedYear: year,
      selectedMonth: month,
      statistics: null
    });

    this.loadMonthStatistics();
  },

  loadWeekStatistics() {
    wx.showLoading({ title: '加载中...' });
    
    wx.cloud.callFunction({
      name: 'getStatistics',
      data: {
        period: 'week'
      },
      success: (res: any) => {
        wx.hideLoading();
        if (res.result && res.result.success) {
          this.setData({
            statistics: res.result.data
          });
        } else {
          wx.showToast({ title: '加载失败', icon: 'none' });
        }
      },
      fail: (error: any) => {
        wx.hideLoading();
        console.error('云函数调用失败:', error);
        wx.showToast({ title: '加载失败', icon: 'none' });
      }
    });
  },

  loadMonthStatistics() {
    wx.showLoading({ title: '加载中...' });
    
    wx.cloud.callFunction({
      name: 'getStatistics',
      data: {
        period: 'month',
        year: this.data.selectedYear,
        month: this.data.selectedMonth
      },
      success: (res: any) => {
        wx.hideLoading();
        if (res.result && res.result.success) {
          this.setData({
            statistics: res.result.data
          });
        } else {
          wx.showToast({ title: '加载失败', icon: 'none' });
        }
      },
      fail: (error: any) => {
        wx.hideLoading();
        console.error('云函数调用失败:', error);
        wx.showToast({ title: '加载失败', icon: 'none' });
      }
    });
  },

  getDonationPercent() {
    const stats = this.data.statistics;
    if (!stats || stats.totalIncome === 0) return 0;
    return Math.round((stats.totalDonations / stats.totalIncome) * 100);
  },

  getBatch4Percent() {
    const stats = this.data.statistics;
    if (!stats || stats.totalIncome === 0) return 0;
    return Math.round((stats.totalBatch4 / stats.totalIncome) * 100);
  },

  getDailyAverage(total: number, days: number) {
    if (days === 0) return '0.00';
    return (total / days).toFixed(2);
  }
});