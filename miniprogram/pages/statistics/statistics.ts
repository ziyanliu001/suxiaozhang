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
          this.loadStatisticsLocal(startDate, endDate);
        }
      },
      fail: (error: any) => {
        console.warn('云函数调用失败，尝试本地数据库查询:', error);
        this.loadStatisticsLocal(startDate, endDate);
      }
    });
  },

  loadStatisticsLocal(startDate: string, endDate: string) {
    const db = wx.cloud.database();
    const { shopName } = this.data;
    
    db.collection('report_logs')
      .where({
        dateString: db.command.gte(startDate).and(db.command.lte(endDate)),
        ...(shopName && { shopName: shopName })
      })
      .orderBy('dateString', 'asc')
      .get({
        success: (res: any) => {
          wx.hideLoading();
          const records = res.data || [];
          
          let statistics = {
            totalIncome: 0,
            totalOtherDonation: 0,
            totalListDonation: 0,
            totalExpense: 0,
            recordCount: records.length,
            netBalance: 0,
            startDate: startDate,
            endDate: endDate,
            dailyRecords: []
          };
          
          records.forEach((item: any) => {
            const otherDonation = parseFloat(item.otherDonation || 0);
            const listDonationTotal = parseFloat(item.listDonationTotal || 0);
            const expenseAmount = parseFloat(item.expenseAmount || 0);
            
            statistics.totalOtherDonation += otherDonation;
            statistics.totalListDonation += listDonationTotal;
            statistics.totalExpense += expenseAmount;
            
            statistics.dailyRecords.push({
              date: item.dateString,
              otherDonation: otherDonation,
              listDonation: listDonationTotal,
              expense: expenseAmount,
              income: otherDonation + listDonationTotal,
              balance: parseFloat(item.todayBalance || 0)
            });
          });
          
          statistics.totalIncome = statistics.totalOtherDonation + statistics.totalListDonation;
          statistics.netBalance = statistics.totalIncome - statistics.totalExpense;
          
          statistics.totalOtherDonation = Math.round(statistics.totalOtherDonation * 100) / 100;
          statistics.totalListDonation = Math.round(statistics.totalListDonation * 100) / 100;
          statistics.totalExpense = Math.round(statistics.totalExpense * 100) / 100;
          statistics.totalIncome = Math.round(statistics.totalIncome * 100) / 100;
          statistics.netBalance = Math.round(statistics.netBalance * 100) / 100;
          
          this.setData({
            statistics: statistics
          });
        },
        fail: (error: any) => {
          wx.hideLoading();
          console.error('本地数据库查询失败:', error);
          wx.showToast({ title: '暂无统计数据', icon: 'none' });
          this.setData({
            statistics: null
          });
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