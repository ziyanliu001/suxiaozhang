import { DataService } from '../../utils/dataService';

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
    const contentTop = menuButton.top + menuButton.height + 16;

    this.setData({
      navTop: navTop,
      contentTop: contentTop
    });
  },

  async loadReports() {
    this.setData({ loading: true });

    const result = await DataService.getReports();
    
    const formattedReports = result.data.map((item: any) => {
      const yesterdayBalance = parseFloat(item.yesterdayBalance || 0);
      const otherDonation = parseFloat(item.otherDonation || 0);
      const listDonationTotal = parseFloat(item.listDonationTotal || 0);
      const expenseAmount = parseFloat(item.expenseAmount || 0);
      const todayBalance = parseFloat(item.todayBalance || 0);
      const totalIncome = otherDonation + listDonationTotal;
      
      return {
        ...item,
        yesterdayBalanceStr: yesterdayBalance.toFixed(2),
        totalIncomeStr: totalIncome.toFixed(2),
        expenseAmountStr: expenseAmount.toFixed(2),
        todayBalanceStr: todayBalance.toFixed(2)
      };
    });

    this.setData({
      reports: formattedReports,
      loading: false
    });
  },

  copyReport(e: any) {
    const index = e.currentTarget.dataset.index;
    const report = this.data.reports[index];
    
    if (!report) {
      wx.showToast({ title: '数据异常', icon: 'none' });
      return;
    }

    const reportText = DataService.buildReportText(report);

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

  onDeleteRecord(e: any) {
    const id = e.currentTarget.dataset.id;
    const date = e.currentTarget.dataset.date;

    if (!id) {
      wx.showToast({ title: '数据异常', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '⚠️ 安全警告',
      content: `确定要删除 ${date} 的餐报记录吗？删除后数据将无法恢复，且可能会导致后续日期的"昨日余额"链条断开！`,
      confirmColor: '#e53935',
      success: (res) => {
        if (res.confirm) {
          this.performDelete(id);
        }
      }
    });
  },

  async performDelete(id: string) {
    try {
      const db = wx.cloud.database();
      
      await db.collection('report_logs').doc(id).remove();
      
      const localLogs = wx.getStorageSync('local_report_logs') || [];
      const filteredLogs = localLogs.filter((item: any) => item._id !== id);
      wx.setStorageSync('local_report_logs', filteredLogs);
      
      const reports = this.data.reports.filter((item: any) => item._id !== id);
      this.setData({ reports });
      
      wx.showToast({ title: '删除成功', icon: 'success' });
    } catch (error) {
      console.error('[History] 删除失败:', error);
      
      const localLogs = wx.getStorageSync('local_report_logs') || [];
      const filteredLogs = localLogs.filter((item: any) => item._id !== id);
      wx.setStorageSync('local_report_logs', filteredLogs);
      
      const reports = this.data.reports.filter((item: any) => item._id !== id);
      this.setData({ reports });
      
      wx.showToast({ title: '本地删除成功', icon: 'success' });
    }
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