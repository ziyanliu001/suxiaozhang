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
    // 是否显示返回按钮（旧属性名，继续兼容）
    back: {
      type: Boolean,
      value: true
    },
    // 是否显示返回按钮（推荐属性名）。未传时（null）回退到 back 的值
    showBack: {
      type: null,
      value: null
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
    // 取值：'auto' 自动按页面栈深度判断；true 强制显示；false 强制隐藏（旧属性名，继续兼容）
    showHomeButton: {
      type: String,
      value: 'auto'
    },
    // 是否显示「回到首页」按钮（推荐属性名），取值同上。未传时（null）回退到 showHomeButton
    showHome: {
      type: null,
      value: null
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
    // 是否实际渲染「返回」按钮
    actualBack: true,
    // 是否实际渲染「回到首页」按钮（根据 showHome/showHomeButton 配置 + 页面栈深度计算）
    actualShowHome: false
  },
  lifetimes: {
    attached() {
      this._layout()
    },
  },
  /**
   * 组件的方法列表
   */
  methods: {
    // 计算导航栏布局：左侧按钮区域始终与右侧胶囊按钮严格对齐
    _layout() {
      const sysInfo = getSafeSystemInfo()
      const isAndroid = sysInfo.platform === 'android'
      const statusBarHeight = sysInfo.statusBarHeight || 20

      let menuButtonInfo: WechatMiniprogram.Rect | null = null
      try {
        menuButtonInfo = wx.getMenuButtonBoundingClientRect()
      } catch (e) {
        menuButtonInfo = null
      }

      // 胶囊按钮的坐标由客户端根据当前设备真实安全区（挖孔屏/刘海屏等）计算得出，
      // 比自行读取 statusBarHeight/safeArea 更可靠。因此始终以胶囊 top/height 为基准，
      // 反推导航内容区（左/中/右三个按钮区域）应处的位置，保证与胶囊严格对齐，
      // 不会因个别机型 statusBarHeight 偏差而出现内容偏高、被状态栏/摄像头遮挡的问题。
      let contentTop: number
      let contentHeight: number
      let rightGap: number

      if (menuButtonInfo && menuButtonInfo.height) {
        contentTop = menuButtonInfo.top
        contentHeight = menuButtonInfo.height
        rightGap = sysInfo.windowWidth - menuButtonInfo.left
      } else {
        // 兜底：极少数机型 getMenuButtonBoundingClientRect 异常时的保守估算
        contentHeight = isAndroid ? 48 : 44
        contentTop = statusBarHeight + (isAndroid ? 4 : 6)
        rightGap = 90
      }

      // 胶囊上下留白基本对称，用该留白反推导航栏总高度（不含/含状态栏两个版本都保留供页面使用）
      const gap = contentTop - statusBarHeight
      const navBarHeight = gap * 2 + contentHeight
      const totalHeight = statusBarHeight + navBarHeight

      let actualShowHome = false
      const showHomeCfg = this.data.showHome !== null && this.data.showHome !== undefined
        ? this.data.showHome
        : this.data.showHomeButton
      if (showHomeCfg === 'true' || showHomeCfg === true) {
        actualShowHome = true
      } else if (showHomeCfg === 'false' || showHomeCfg === false) {
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

      const showBackCfg = this.data.showBack
      const actualBack = showBackCfg === null || showBackCfg === undefined
        ? !!this.data.back
        : !!showBackCfg

      this.setData({
        ios: !isAndroid,
        statusBarHeight,
        navBarHeight,
        barStyle: `height: ${totalHeight}px;`,
        contentStyle: `top: ${contentTop}px; height: ${contentHeight}px;`,
        rightWidth: `width: ${rightGap}px`,
        leftWidth: `width: ${actualShowHome ? 130 : 80}px`,
        actualBack,
        actualShowHome
      })

      // 供页面获取真实布局尺寸，替代各页面各自估算 navTop 的老写法
      this.triggerEvent('layout', { statusBarHeight, navBarHeight, totalHeight }, {})
    },
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
    // 点击「回家」按钮 - 智能跳转，避免白屏
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
