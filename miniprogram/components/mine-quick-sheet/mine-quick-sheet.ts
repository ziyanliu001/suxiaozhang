// "我的" 快捷操作面板：四个入口全部指向已有的真实页面，本组件只负责弹层展示 + 跳转，
// 不持有任何业务状态，因此可以直接自行 wx.navigateTo，无需再向宿主页面转发事件。
Component({
  data: {
    show: false
  },

  methods: {
    open() {
      this.setData({ show: true });
    },

    close() {
      this.setData({ show: false });
    },

    stopBubble() {},
    preventTouchMove() {},

    onTapHistory() {
      this.close();
      wx.navigateTo({
        url: '/pages/history/history?view=mine',
        fail: (err) => console.warn('[mine-quick-sheet] 跳转历史记录失败:', err)
      });
    },

    onTapDraftBox() {
      this.close();
      wx.navigateTo({
        url: '/pages/draft-box/draft-box',
        fail: (err) => console.warn('[mine-quick-sheet] 跳转草稿箱失败:', err)
      });
    },

    onTapSettings() {
      this.close();
      wx.navigateTo({
        url: '/pages/settings/settings',
        fail: (err) => console.warn('[mine-quick-sheet] 跳转设置页失败:', err)
      });
    },

    onTapHelp() {
      this.close();
      wx.navigateTo({
        url: '/pages/help/help',
        fail: (err) => console.warn('[mine-quick-sheet] 跳转帮助页失败:', err)
      });
    }
  }
});
