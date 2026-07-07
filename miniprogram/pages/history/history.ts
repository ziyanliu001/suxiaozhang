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
    const { id, date } = e.currentTarget.dataset;

    if (!id) {
      wx.showToast({ title: '数据异常', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '⚠️ 严谨确认',
      content: `确定要删除 ${date} 的用餐汇报记录吗？此操作不可逆，且会破坏连续账目的对账链条！`,
      confirmText: '确定删除',
      confirmColor: '#e53935',
      cancelText: '取消',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '正在删除...' });
          try {
            const db = wx.cloud.database();
            await db.collection('report_logs').doc(id).remove();

            let localLogs = wx.getStorageSync('local_report_logs') || [];
            localLogs = localLogs.filter((item: any) => item._id !== id);
            wx.setStorageSync('local_report_logs', localLogs);

            const updatedList = this.data.reports.filter((item: any) => item._id !== id);
            this.setData({ reports: updatedList });

            wx.showToast({ title: '已安全删除', icon: 'success' });
          } catch (err) {
            console.error("删除失败", err);
            wx.showToast({ title: '删除失败，请重试', icon: 'none' });
          } finally {
            wx.hideLoading();
          }
        }
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