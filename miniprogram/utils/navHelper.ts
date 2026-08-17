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

// 🛡️ TabBar 页面清单：与 app.json 的 tabBar.list 一一对应（该文件独立部署/
// 没有跨文件读取 app.json 的机制，只能手动保持一致，改 tabBar 时记得同步这
// 里）。wx.navigateTo 对这几个页面一律直接 fail（errMsg 固定是
// "navigateTo:fail can not navigateTo a tabbar page"），且这条限制与页面栈
// 深度/是否已经打开过该页完全无关——不是"栈满再兜底重试"能解决的问题，
// 必须在发起跳转前就识别出目标是 tabBar 页面，改走 wx.switchTab
const TABBAR_PAGES = [
  '/pages/index/index',
  '/pages/notice/notice',
  '/pages/profile/profile'
];

// 跳转参数里的 url 可能带查询串（如 '/pages/profile/profile?foo=1'），
// TabBar 页面清单只登记不带查询串的纯路径，这里剥离后再比对
function stripQuery(url: string): string {
  const idx = url.indexOf('?');
  return idx >= 0 ? url.slice(0, idx) : url;
}

function isTabBarPage(url: string): boolean {
  return TABBAR_PAGES.includes(stripQuery(url || ''));
}

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

  // 🛡️ TabBar 页面自动分流：见 TABBAR_PAGES 声明处注释。必须排在栈深度检查
  // 之前——目标是 tabBar 页面时，无论当前栈多深，wx.navigateTo 都只会是这
  // 一种确定性失败，不存在"栈没满就能 navigateTo 成功"的侥幸；switchTab
  // 本身会把页面栈收敛回只剩这一个 tab 页，也不需要叠加 MAX_PAGE_STACK 判断
  if (isTabBarPage(options.url)) {
    console.warn('[safeNavigateTo] 目标是 TabBar 页面，自动切换为 wx.switchTab:', options.url);
    return new Promise((resolve, reject) => {
      wx.switchTab({
        url: options.url,
        success: (res) => {
          options.success && options.success(res as unknown as WechatMiniprogram.NavigateToSuccessCallbackResult);
          resolve(res as unknown as WechatMiniprogram.GeneralCallbackResult);
        },
        fail: (err) => {
          console.error('[safeNavigateTo] switchTab 失败:', options.url, err);
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
    // 🛡️ 兜底安全阀：诊断计时器到点时，跳转流程如果连 fail 都还没来（比如某些
    // 移植版开发者工具在路由管道上偶发彻底卡死、原生回调再也不会触发），锁就
    // 会一直是 true，导致用户后续点其它任何入口都被开头的防抖拦截误伤锁死。
    // 这里到点强制先放锁，让应用至少能继续响应后续点击；如果原生回调之后终
    // 究还是姗姗来迟，靠 settled 标记避免它再重复走一遍收尾逻辑
    let settled = false;
    let fallbackAttempted = false;
    const diagnosticTimer = setTimeout(() => {
      console.error(
        '[safeNavigateTo] ⚠️ 跳转 2.5s 仍未完成，疑似当前页 JS 主线程被同步代码阻塞（大循环 / 密集 wx.xxxSync 调用），或开发者工具路由管道卡死:',
        options.url, '发起跳转时页面栈深度:', stackDepth
      );
      if (!settled) {
        navigating = false;
      }
    }, DIAGNOSTIC_TIMEOUT_MS);

    wx.navigateTo({
      ...options,
      success: (res) => {
        options.success && options.success(res);
        resolve(res);
      },
      fail: (err) => {
        // 🐛 超时自动降级：navigateTo:fail timeout 意味着原生跳转管道卡住了，
        // 原页面大概率还停留在当前这个 webview 上（不是白屏就是卡在原地）。
        // 与其把这个失败原样抛给调用方、让用户卡在半死不活的页面上，不如自动
        // 补一次 redirectTo——直接替换当前页完成跳转，用户体感上仍然到达了
        // 目标页，只是没有保留返回栈上的原页面（等价于降级重试一次）
        const isTimeout = typeof err.errMsg === 'string' && err.errMsg.indexOf('fail timeout') >= 0;
        if (isTimeout) {
          fallbackAttempted = true;
          console.warn('[safeNavigateTo] navigateTo 超时失败，自动降级为 redirectTo 重试一次:', options.url, err);
          wx.redirectTo({
            url: options.url,
            success: (res2) => {
              options.success && options.success(res2 as unknown as WechatMiniprogram.NavigateToSuccessCallbackResult);
              resolve(res2 as unknown as WechatMiniprogram.GeneralCallbackResult);
            },
            fail: (err2) => {
              console.error('[safeNavigateTo] 降级 redirectTo 仍然失败:', options.url, err2);
              options.fail && options.fail(err2 as WechatMiniprogram.GeneralCallbackResult);
              reject(err2);
            },
            complete: (res2) => {
              settled = true;
              clearTimeout(diagnosticTimer);
              navigating = false;
              options.complete && options.complete(res2);
            }
          });
          return;
        }
        console.error('[safeNavigateTo] 跳转失败:', options.url, err);
        options.fail && options.fail(err);
        reject(err);
      },
      complete: (res) => {
        // fallbackAttempted 为 true 时，收尾职责已经转交给上面 redirectTo 自己
        // 的 complete，这里直接跳过，避免 options.complete 被调用两次、锁被
        // 提前误放（此时 redirectTo 可能还没跑完）
        if (fallbackAttempted) return;
        settled = true;
        clearTimeout(diagnosticTimer);
        navigating = false;
        options.complete && options.complete(res);
      }
    });
  });
}
