import { DataService } from '../../utils/dataService';

Page({
  data: {
    currentTab: 'week',
    shopName: '',
    selectedYear: new Date().getFullYear(),
    selectedMonth: new Date().getMonth() + 1,
    customStartDate: '',
    customEndDate: '',
    statistics: null,
    navTop: 0,
    contentTop: 0
  },

  onLoad(options: any) {
    if (options && options.shopName) {
      this.setData({ shopName: options.shopName });
    }
    
    this.calculateNavBarHeight();
    this.loadWeekStatistics();
  },

  onShow() {
    DataService.syncLocalDataToCloud();
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
    const contentTop = menuButton.top + menuButton.height + 20;

    this.setData({
      navTop: navTop,
      contentTop: contentTop
    });
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

  async loadStatistics(startDate: string, endDate: string) {
    wx.showLoading({ title: '加载中...' });

    const result = await DataService.getStatistics(startDate, endDate, this.data.shopName);
    
    wx.hideLoading();
    
    if (result.success && result.data) {
      this.setData({
        statistics: result.data
      });
    } else {
      wx.showToast({ title: '暂无统计数据', icon: 'none' });
      this.setData({
        statistics: null
      });
    }
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
  },

  goBackHome() {
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