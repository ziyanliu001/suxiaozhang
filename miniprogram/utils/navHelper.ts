/**
 * navHelper.ts
 * wx.navigateTo 防重/防抖封装
 *
 * 背景：多个页面/组件里存在"用户连续快速点击"或"同一事件被重复触发"两种场景
 * （如列表卡片的 tap 事件在低端机上偶发触发两次、用户手指连点跳转按钮），
 * 而 wx.navigateTo 在前一次跳转动画/路由栈还未完成时被再次调用，会命中微信
 * 基础库内部 "routeDone webviewId" 冲突告警，严重时新开的页面栈状态错乱。
 *
 * 方案：
 *  - 用一个模块级锁 + 短时间窗口去抖，跳转发起后到 complete 回调触发前，
 *    以及窗口期内的重复调用一律直接吞掉（无论 url 是否相同——因为冲突的
 *    根因是"上一次路由动画未结束"，与目标 url 是否一致无关）。
 *  - 返回 Promise，语义与 success/fail 回调对齐，兼容 `.then/.catch` 调用方式。
 */

// 🐛 经验值：微信路由切换动画 + webviewId 分配大约 300~400ms 完成，
// 600ms 窗口覆盖绝大多数机型，同时不会让正常的连续跳转操作感觉卡顿
const DEBOUNCE_WINDOW_MS = 600;

let navigating = false;
let lastNavigateAt = 0;

export function safeNavigateTo(
  options: WechatMiniprogram.NavigateToOption
): Promise<WechatMiniprogram.GeneralCallbackResult> {
  const now = Date.now();

  if (navigating || now - lastNavigateAt < DEBOUNCE_WINDOW_MS) {
    console.warn('[safeNavigateTo] 防抖拦截重复跳转:', options.url);
    const errMsg = 'navigateTo:fail debounced';
    options.fail && options.fail({ errMsg } as WechatMiniprogram.GeneralCallbackResult);
    options.complete && options.complete({ errMsg } as WechatMiniprogram.GeneralCallbackResult);
    return Promise.resolve({ errMsg } as WechatMiniprogram.GeneralCallbackResult);
  }

  navigating = true;
  lastNavigateAt = now;

  return new Promise((resolve, reject) => {
    wx.navigateTo({
      ...options,
      success: (res) => {
        options.success && options.success(res);
        resolve(res);
      },
      fail: (err) => {
        options.fail && options.fail(err);
        reject(err);
      },
      complete: (res) => {
        // 跳转流程结束（无论成败）才释放锁，允许下一次跳转
        navigating = false;
        options.complete && options.complete(res);
      }
    });
  });
}
