Component({
  options: {
    multipleSlots: true // 在组件定义时的选项中启用多slot支持
  },
  /**
   * 组件的属性列表
   */
  properties: {
    extClass: {
      type: String,
      value: ''
    },
    title: {
      type: String,
      value: ''
    },
    background: {
      type: String,
      value: ''
    },
    color: {
      type: String,
      value: ''
    },
    back: {
      type: Boolean,
      value: true
    },
    loading: {
      type: Boolean,
      value: false
    },
    homeButton: {
      type: Boolean,
      value: false,
    },
    animated: {
      // 显示隐藏的时候opacity动画效果
      type: Boolean,
      value: true
    },
    show: {
      // 显示隐藏导航，隐藏的时候navigation-bar的高度占位还在
      type: Boolean,
      value: true,
      observer: '_showChange'
    },
    // back为true的时候，返回的页面深度
    delta: {
      type: Number,
      value: 1
    },
  },
  /**
   * 组件的初始数据
   */
  data: {
    displayStyle: ''
  },
  lifetimes: {
    attached() {
      const rect = wx.getMenuButtonBoundingClientRect()
      // 使用新的 API 替代已废弃的 wx.getSystemInfo
      // getDeviceInfo 获取设备信息（platform、brand、model）
      // getWindowInfo 获取窗口信息（windowWidth、safeArea）
      try {
        const deviceInfo = wx.getDeviceInfo()
        const windowInfo = wx.getWindowInfo()
        const isAndroid = deviceInfo.platform === 'android'
        const isDevtools = deviceInfo.platform === 'devtools'
        const rightWidth = windowInfo.windowWidth - rect.left
        this.setData({
          ios: !isAndroid,
          innerPaddingRight: `padding-right: ${rightWidth}px`,
          leftWidth: `width: 80px`,
          rightWidth: `width: ${rightWidth}px`,
          safeAreaTop: isDevtools || isAndroid ? `height: calc(var(--height) + ${windowInfo.safeArea.top}px); padding-top: ${windowInfo.safeArea.top}px` : ``
        })
      } catch (err) {
        // 兼容旧版本基础库
        wx.getSystemInfo({
          success: (res) => {
            const isAndroid = res.platform === 'android'
            const isDevtools = res.platform === 'devtools'
            const rightWidth = res.windowWidth - rect.left
            this.setData({
              ios: !isAndroid,
              innerPaddingRight: `padding-right: ${rightWidth}px`,
              leftWidth: `width: 80px`,
              rightWidth: `width: ${rightWidth}px`,
              safeAreaTop: isDevtools || isAndroid ? `height: calc(var(--height) + ${res.safeArea.top}px); padding-top: ${res.safeArea.top}px` : ``
            })
          }
        })
      }
    },
  },
  /**
   * 组件的方法列表
   */
  methods: {
    _showChange(show: boolean) {
      const animated = this.data.animated
      let displayStyle = ''
      if (animated) {
        displayStyle = `opacity: ${
          show ? '1' : '0'
        };transition:opacity 0.5s;`
      } else {
        displayStyle = `display: ${show ? '' : 'none'}`
      }
      this.setData({
        displayStyle
      })
    },
    back() {
      const data = this.data
      if (data.delta) {
        wx.navigateBack({
          delta: data.delta
        })
      }
      this.triggerEvent('back', { delta: data.delta }, {})
    }
  },
})
