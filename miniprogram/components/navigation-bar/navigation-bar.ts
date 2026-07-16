import { getSafeSystemInfo } from '../../utils/util'

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
    // 新增：返回按钮旁紧邻显示「回到首页」按钮（双功能模式）
    // 取值：'auto' 自动按页面栈深度判断；true 强制显示；false 强制隐藏
    showHomeButton: {
      type: String,
      value: 'auto'
    },
    // 「回到首页」目标路径，默认首页
    homePath: {
      type: String,
      value: '/pages/index/index'
    },
    // 「回到首页」是否携带参数（用于首页锚点聚焦）
    homeQuery: {
      type: String,
      value: ''
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
    displayStyle: '',
    // 是否实际渲染「回到首页」按钮（根据 showHomeButton 配置 + 页面栈深度计算）
    actualShowHome: false
  },
  lifetimes: {
    attached() {
      const rect = wx.getMenuButtonBoundingClientRect()
      const sysInfo = getSafeSystemInfo()
      const isAndroid = sysInfo.platform === 'android'
      const isDevtools = sysInfo.platform === 'devtools'
      const rightWidth = sysInfo.windowWidth - rect.left

      // 智能计算是否显示「回家」按钮
      let actualShowHome = false
      const showHomeCfg = this.data.showHomeButton
      if (showHomeCfg === 'true') {
        actualShowHome = true
      } else if (showHomeCfg === 'false') {
        actualShowHome = false
      } else {
        // auto：仅当存在上一页可返回时才显示「回家」（避免首页自己也显示）
        try {
          const pages = getCurrentPages()
          actualShowHome = pages.length > 1
        } catch (e) {
          actualShowHome = false
        }
      }

      this.setData({
        ios: !isAndroid,
        innerPaddingRight: `padding-right: ${rightWidth}px`,
        // 双按钮模式下左侧宽度加大，避免返回+首页按钮挤压标题
        leftWidth: `width: ${actualShowHome ? 130 : 80}px`,
        rightWidth: `width: ${rightWidth}px`,
        safeAreaTop: isDevtools || isAndroid ? `height: calc(var(--height) + ${sysInfo.safeArea.top}px); padding-top: ${sysInfo.safeArea.top}px` : ``,
        actualShowHome
      })
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
    },
    // 新增：点击「回家」按钮 - 智能跳转，避免白屏
    goHome() {
      const data = this.data
      const pages = getCurrentPages()
      const targetUrl = data.homeQuery
        ? `${data.homePath}?${data.homeQuery}`
        : data.homePath

      this.triggerEvent('home', { url: targetUrl }, {})

      // 优先策略：如果首页已在页面栈中，使用 navigateBack 回退到首页（保留首页已加载数据，避免重载白屏）
      for (let i = pages.length - 2; i >= 0; i--) {
        const route = '/' + (pages[i].route || '')
        if (route === data.homePath) {
          wx.navigateBack({ delta: pages.length - 1 - i })
          return
        }
      }

      // 兜底策略：栈中无首页，使用 reLaunch 重新打开（避免 redirectTo 在自定义导航栏切换时的 webviewId 异常）
      setTimeout(() => {
        wx.reLaunch({ url: targetUrl })
      }, 100)
    }
  },
})
