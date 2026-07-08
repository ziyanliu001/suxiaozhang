import { DataService, formatMoney } from '../../utils/dataService';
import { AuthService } from '../../utils/authService';

Page({
  data: {
    reports: [],
    loading: true,
    navTop: 0,
    contentTop: 0,
    isAdmin: false,
    viewMode: 'all' as 'all' | 'personal'
  },

  onLoad() {
    this.calculateNavBarHeight();
    this.checkAdminStatus();
    this.loadReports();
  },

  onShow() {
    this.loadReports();
    DataService.syncLocalDataToCloud();
  },

  checkAdminStatus() {
    const isAdmin = AuthService.isAdmin();
    this.setData({ isAdmin });
  },

  switchViewMode(e: any) {
    const mode = e.currentTarget.dataset.mode as 'all' | 'personal';
    this.setData({ viewMode: mode });
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

  async loadReports() {
    this.setData({ loading: true });

    const { viewMode } = this.data;
    const result = await DataService.getReports({ viewMode });
    
    const formattedReports = result.data.map((item: any) => {
      const yesterdayBalance = parseFloat(item.yesterdayBalance || 0);
      const otherDonation = parseFloat(item.otherDonation || 0);
      const listDonationTotal = parseFloat(item.listDonationTotal || 0);
      const expenseAmount = parseFloat(item.expenseAmount || 0);
      const todayBalance = parseFloat(item.todayBalance || 0);
      const totalIncome = otherDonation + listDonationTotal;
      
      return {
        ...item,
        yesterdayBalanceStr: formatMoney(yesterdayBalance),
        totalIncomeStr: formatMoney(totalIncome),
        expenseAmountStr: formatMoney(expenseAmount),
        todayBalanceStr: formatMoney(todayBalance)
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

    console.log("[Debug] 尝试删除记录，抓取到的参数:", { id, date });

    if (!id) {
      console.error("[Bug] 参数传递依然失效，请检查 WXML 是否存在 data-id 属性");
      wx.showToast({ title: '参数传递失效', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '⚠️ 严谨确认',
      content: `确定要删除 ${date} 的餐报记录吗？此操作不可逆！`,
      confirmColor: '#e53935',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '正在提交删除...' });
        try {
          const result = await DataService.deleteReport(id);
          console.log('[Debug] 删除结果:', result);

          if (result.success) {
            const currentList = this.data.reports || [];
            const updatedList = currentList.filter(
              (item: any) => item._id !== id && item._localId !== id
            );
            this.setData({ reports: updatedList });
            wx.showToast({ title: '已安全删除', icon: 'success' });
          } else {
            wx.showToast({ title: result.message || '删除失败', icon: 'none' });
          }
        } catch (err: any) {
          console.error('[Bug] 删除执行异常:', err);
          wx.showModal({
            title: '删除失败提示',
            content: `错误信息: ${err.errMsg || err.message || '未知错误'}`,
            showCancel: false
          });
        } finally {
          wx.hideLoading();
        }
      }
    });
  },

  goBack() {
    wx.navigateBack();
  },

  previewReceipt(e: any) {
    const images = e.currentTarget.dataset.images;
    const index = e.currentTarget.dataset.index;

    if (!images || !Array.isArray(images) || images.length === 0) {
      wx.showToast({ title: '图片数据异常', icon: 'none' });
      return;
    }

    wx.previewImage({
      current: images[index],
      urls: images
    });
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