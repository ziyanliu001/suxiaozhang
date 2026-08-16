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

// 🛡️ 微信小程序页面栈硬上限就是 10 层——第 10 层再调用 wx.navigateTo 会
// 直接 fail（errMsg 类似 "navigateTo:fail 已经达到最大打开页面数"）。这里
// 提前一步在达到上限时自动降级为 wx.redirectTo（替换当前页而不是新开一层），
// 用户体感上依然是跳转到了目标页面，只是不再往深处叠加页面栈，从根源上
// 避免这一类 fail，而不是等它先失败一次再兜底重试
const MAX_PAGE_STACK = 10;

// ⏱️ navigateTo 本身没有内建的"超时"事件——控制台看到的
// `navigateTo:fail timeout` 是微信基础库在原生跳转流程卡住太久后才抛出的
// 错误，根因几乎总是当前页 JS 主线程被同步代码占满（大循环、密集的
// wx.xxxSync 调用等），导致跳转的原生回调迟迟排不上号执行。这里额外起一个
// 纯前端计时器兜底诊断：若跳转发起后 DIAGNOSTIC_TIMEOUT_MS 内 complete 都
// 没触发，主动打一条诊断日志（不影响 wx.navigateTo 本身的真实结果），让这
// 类偶发问题在开发/灰度阶段有迹可循，而不是复现一次就随日志滚走、线上排查
// 两眼一抹黑
const DIAGNOSTIC_TIMEOUT_MS = 2500;

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

  const stackDepth = getCurrentPages().length;

  // 🛡️ 栈满降级：见 MAX_PAGE_STACK 声明处注释。降级路径同样受本模块的锁保护，
  // 且同样在 complete 里统一释放锁——与下面 navigateTo 分支是同一套生命周期，
  // 调用方无需关心内部到底走了哪条路
  if (stackDepth >= MAX_PAGE_STACK) {
    console.warn(`[safeNavigateTo] 页面栈已达 ${stackDepth} 层（上限 ${MAX_PAGE_STACK}），自动降级为 redirectTo:`, options.url);
    return new Promise((resolve, reject) => {
      wx.redirectTo({
        url: options.url,
        success: (res) => {
          options.success && options.success(res as unknown as WechatMiniprogram.NavigateToSuccessCallbackResult);
          resolve(res as unknown as WechatMiniprogram.GeneralCallbackResult);
        },
        fail: (err) => {
          console.error('[safeNavigateTo] 降级 redirectTo 仍然失败:', options.url, err);
          options.fail && options.fail(err as WechatMiniprogram.GeneralCallbackResult);
          reject(err);
        },
        complete: (res) => {
          navigating = false;
          options.complete && options.complete(res);
        }
      });
    });
  }

  return new Promise((resolve, reject) => {
    const diagnosticTimer = setTimeout(() => {
      console.error(
        '[safeNavigateTo] ⚠️ 跳转 2.5s 仍未完成，疑似当前页 JS 主线程被同步代码阻塞（大循环 / 密集 wx.xxxSync 调用）:',
        options.url, '发起跳转时页面栈深度:', stackDepth
      );
    }, DIAGNOSTIC_TIMEOUT_MS);

    wx.navigateTo({
      ...options,
      success: (res) => {
        options.success && options.success(res);
        resolve(res);
      },
      fail: (err) => {
        console.error('[safeNavigateTo] 跳转失败:', options.url, err);
        options.fail && options.fail(err);
        reject(err);
      },
      complete: (res) => {
        // 跳转流程结束（无论成败）才释放锁，允许下一次跳转；诊断计时器同样
        // 无条件清除，避免"跳转其实已经完成，但计时器还在后台空转"的误报
        clearTimeout(diagnosticTimer);
        navigating = false;
        options.complete && options.complete(res);
      }
    });
  });
}
