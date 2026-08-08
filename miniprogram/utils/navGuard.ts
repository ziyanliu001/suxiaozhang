/**
 * navGuard.ts
 * 二级页面物理返回键 / 侧滑手势兜底拦截工具
 *
 * 业务场景：
 *  1. 用户通过分享卡片直接进入二级页（如 history/statistics/help），页面栈深度=1
 *     此时物理返回键 / 侧滑手势会直接退出小程序。
 *  2. 期望行为：拦截该退出动作，重定向到首页（/pages/index/index），
 *     让用户继续使用应用而不是被踢出。
 *
 * 实现要点：
 *  - 微信小程序无法直接拦截物理返回键，但可以借助 wx.enableAlertBeforeUnload
 *    弹出原生确认框，用户点击「取消」可留在当前页（即阻止退出）。
 *  - 同时在 onLoad 中检测页面栈深度=1 时，记录「待回首页」标记，
 *    在 onUnload 中检测标记，若用户最终选择离开，则 reLaunch 到首页。
 *  - 该方案保证：用户从分享进入二级页时，物理返回/侧滑会先弹确认框，
 *    点「确认」退出时被拦截并跳转首页，而非直接退出小程序。
 */

export interface NavGuardOptions {
  /** 回首页目标路径，默认 /pages/index/index */
  homePath?: string
  /** 是否启用「离开前确认」原生弹框（默认 true） */
  enableAlertBeforeUnload?: boolean
  /** 离开提示文案 */
  alertMessage?: string
  /** 是否携带参数回首页（用于锚点聚焦） */
  homeQuery?: string
}

export interface NavGuardInstance {
  /** 在页面 onLoad 中调用，初始化拦截逻辑 */
  setupOnLoad: () => void
  /** 在页面 onShow 中调用，刷新拦截状态 */
  setupOnShow: () => void
  /** 在页面 onHide / onUnload 中调用，清理资源 */
  teardown: () => void
  /** 主动跳转首页（按钮点击场景使用） */
  goHome: () => void
  /** 当前是否处于「分享直入二级页」场景 */
  isDeepLinkEntry: () => boolean
}

export function createNavGuard(options: NavGuardOptions = {}): NavGuardInstance {
  const {
    homePath = '/pages/index/index',
    enableAlertBeforeUnload = true,
    alertMessage = '即将退出素小账，是否返回首页继续使用？',
    homeQuery = ''
  } = options

  // 标记：用户是否从分享直接进入此二级页（页面栈深度=1）
  let deepLinkEntry = false
  // 标记：onUnload 阶段是否需要重定向到首页
  let needRedirectToHome = false
  // 防重入锁
  let isRedirecting = false

  function detectDeepLink(): boolean {
    try {
      const pages = getCurrentPages()
      // 页面栈深度=1 表示用户直接从分享/扫码进入此页，无上一页可返回
      return pages.length <= 1
    } catch (e) {
      return false
    }
  }

  function setupOnLoad() {
    deepLinkEntry = detectDeepLink()
    if (deepLinkEntry && enableAlertBeforeUnload) {
      // 启用「返回前确认」弹框：用户物理返回/侧滑时弹出
      try {
        wx.enableAlertBeforeUnload({
          message: alertMessage,
          fail: (err: any) => {
            console.warn('[navGuard] enableAlertBeforeUnload failed:', err)
          }
        })
      } catch (e) {
        console.warn('[navGuard] enableAlertBeforeUnload not supported:', e)
      }
    }
  }

  function setupOnShow() {
    // 用户从其他页 navigateBack 回到本页时，重新检测
    const nowDeepLink = detectDeepLink()
    if (nowDeepLink !== deepLinkEntry) {
      deepLinkEntry = nowDeepLink
      if (deepLinkEntry && enableAlertBeforeUnload) {
        try {
          wx.enableAlertBeforeUnload({ message: alertMessage })
        } catch (e) {
          /* ignore */
        }
      } else {
        try {
          wx.disableAlertBeforeUnload()
        } catch (e) {
          /* ignore */
        }
      }
    }
  }

  function teardown() {
    if (deepLinkEntry && enableAlertBeforeUnload) {
      try {
        wx.disableAlertBeforeUnload()
      } catch (e) {
        /* ignore */
      }
    }

    // 关键：用户最终选择离开且是分享直入场景，则重定向到首页而非退出
    if (deepLinkEntry && !isRedirecting) {
      needRedirectToHome = true
    }

    if (needRedirectToHome) {
      isRedirecting = true
      const targetUrl = homeQuery ? `${homePath}?${homeQuery}` : homePath
      // 使用 reLaunch 重新打开首页，避免 redirectTo 在自定义导航栏切换时的 webviewId 异常
      // setTimeout 100ms 确保当前页 webview 卸载流程完成
      setTimeout(() => {
        wx.reLaunch({ url: targetUrl })
      }, 100)
    }
  }

  function goHome() {
    if (isRedirecting) return
    isRedirecting = true

    // 主动点击「回首页」按钮场景：
    // 1. 若首页已在栈中，使用 navigateBack 回退（保留首页数据）
    try {
      const pages = getCurrentPages()
      for (let i = pages.length - 2; i >= 0; i--) {
        const route = '/' + (pages[i].route || '')
        if (route === homePath) {
          wx.navigateBack({ delta: pages.length - 1 - i })
          return
        }
      }
    } catch (e) {
      /* ignore */
    }

    // 2. 兜底：reLaunch 到首页
    const targetUrl = homeQuery ? `${homePath}?${homeQuery}` : homePath
    needRedirectToHome = true
    setTimeout(() => {
      wx.reLaunch({ url: targetUrl })
    }, 100)
  }

  return {
    setupOnLoad,
    setupOnShow,
    teardown,
    goHome,
    isDeepLinkEntry: () => deepLinkEntry
  }
}
