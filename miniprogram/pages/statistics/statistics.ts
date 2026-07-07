Page({
  data: {
    currentTab: 'week',
    shopName: '',
    selectedYear: new Date().getFullYear(),
    selectedMonth: new Date().getMonth() + 1,
    customStartDate: '',
    customEndDate: '',
    statistics: null
  },

  onLoad(options: any) {
    if (options && options.shopName) {
      this.setData({ shopName: options.shopName });
    }
    this.loadWeekStatistics();
  },

  switchTab(e: any) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({
      currentTab: tab,
      statistics: null
    });

    switch (tab) {
      case 'week':
        this.loadWeekStatistics();
        break;
      case 'month':
        this.loadMonthStatistics();
        break;
      case 'year':
        this.loadYearStatistics();
        break;
      case 'custom':
        this.initCustomDates();
        break;
    }
  },

  initCustomDates() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    
    this.setData({
      customEndDate: `${year}-${month}-${day}`,
      customStartDate: `${year}-${month}-01`
    });
  },

  onCustomStartDateChange(e: any) {
    this.setData({
      customStartDate: e.detail.value,
      statistics: null
    });
  },

  onCustomEndDateChange(e: any) {
    this.setData({
      customEndDate: e.detail.value,
      statistics: null
    });
  },

  loadCustomStatistics() {
    const { customStartDate, customEndDate } = this.data;
    if (!customStartDate || !customEndDate) {
      wx.showToast({ title: '请选择起止日期', icon: 'none' });
      return;
    }
    this.loadStatistics(customStartDate, customEndDate);
  },

  getWeekRange() {
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const startDate = new Date(now.setDate(diff));
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);

    return {
      startDate: this.formatDate(startDate),
      endDate: this.formatDate(endDate)
    };
  },

  getMonthRange() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    
    return {
      startDate: this.formatDate(startDate),
      endDate: this.formatDate(endDate)
    };
  },

  getYearRange() {
    const now = new Date();
    const year = now.getFullYear();
    
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31);
    
    return {
      startDate: this.formatDate(startDate),
      endDate: this.formatDate(endDate)
    };
  },

  formatDate(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  },

  loadWeekStatistics() {
    const range = this.getWeekRange();
    this.loadStatistics(range.startDate, range.endDate);
  },

  loadMonthStatistics() {
    const range = this.getMonthRange();
    this.loadStatistics(range.startDate, range.endDate);
  },

  loadYearStatistics() {
    const range = this.getYearRange();
    this.loadStatistics(range.startDate, range.endDate);
  },

  loadStatistics(startDate: string, endDate: string) {
    wx.showLoading({ title: '加载中...' });
    
    wx.cloud.callFunction({
      name: 'getStatistics',
      data: {
        startDate: startDate,
        endDate: endDate,
        shopName: this.data.shopName
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

  getTabTitle() {
    const { currentTab, statistics } = this.data;
    if (!statistics) return '';
    
    switch (currentTab) {
      case 'week':
        return '本周财务结余';
      case 'month':
        return '本月财务结余';
      case 'year':
        return statistics.startDate.substring(0, 4) + '年度财务结余';
      case 'custom':
        return '自定义区间财务结余';
      default:
        return '财务结余';
    }
  },

  getExpensePercent() {
    const stats = this.data.statistics;
    if (!stats || stats.totalIncome === 0) return 0;
    return Math.round((stats.totalExpense / stats.totalIncome) * 100);
  },

  isExpenseOverIncome() {
    const stats = this.data.statistics;
    if (!stats) return false;
    return stats.totalExpense > stats.totalIncome;
  },

  goBack() {
    wx.navigateBack();
  }
});