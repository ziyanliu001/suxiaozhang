Page({
  data: {
    reports: [],
    loading: true
  },

  onLoad() {
    this.loadReports();
  },

  onShow() {
    this.loadReports();
  },

  loadReports() {
    this.setData({ loading: true });
    const db = wx.cloud.database();
    
    db.collection('meal_reports')
      .orderBy('createTime', 'desc')
      .get({
        success: (res) => {
          console.log('云数据库读取历史记录成功:', res);
          this.setData({
            reports: res.data || [],
            loading: false
          });
          if (!res.data || res.data.length === 0) {
            wx.showToast({ title: '暂无历史记录', icon: 'none' });
          }
        },
        fail: (error) => {
          if (error.errCode === -502005) {
            console.log('云数据库集合尚未创建，暂无历史记录');
            this.setData({
              reports: [],
              loading: false
            });
            wx.showToast({ title: '暂无历史记录', icon: 'none' });
          } else {
            console.error('云数据库读取历史记录失败:', error);
            this.setData({ loading: false });
            wx.showToast({ title: '加载失败', icon: 'error' });
          }
        }
      });
  },

  copyReport(e: any) {
    const { reportText } = e.currentTarget.dataset;
    wx.setClipboardData({
      data: reportText,
      success: () => {
        wx.showToast({ title: '复制成功', icon: 'success' });
      },
      fail: () => {
        wx.showToast({ title: '复制失败', icon: 'error' });
      }
    });
  },

  goBack() {
    wx.navigateBack();
  }
});