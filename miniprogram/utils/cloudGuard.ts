// 云开发 SDK 可用性防护
//
// ⚠️ 与 utils/withTimeout.ts 的关系：本文件底部的 callCloudFunctionGuarded()
// 是叠加在 callFunctionWithTimeout 之上的可选高阶封装（复用其超时逻辑，不
// 重新实现一遍），不是替代品——withTimeout.ts 头部注释记录过真实教训：
// authService.ts/pages/index/index.ts 曾各自独立维护一份功能相同的超时封装，
// 长期漂移不一致，才统一收敛成 callFunctionWithTimeout 这一份全仓库共用的
// 实现（目前 200+ 处调用点在用）。这里不重蹈覆辙、不新造第二套超时机制，
// 只在其外层加"耗时监控 + 出错自动降级提示"这两件事——且默认不会自动接管
// 已有调用点：多数既有调用点出错时走"静默降级本地缓存"路径、故意不弹提示
// （尤其 careMode 长者模式下 wx.showToast 字号/时长不受控，CLAUDE.md 第 3
// 节已经把它排除在适老化主要反馈手段之外），批量迁移属于另一项需要单独
// 评审影响面的改动，不在这次改动范围内。新增调用点如果就是想要"失败即弹
// 兜底提示"这种通用语义，可以直接用 callCloudFunctionGuarded。
//
// 背景：微信开发者工具偶发在 wx.cloud.init 阶段抛出内部致命错误
// "Fatal: unexpected loadSdkSubPackage case"，此后 wx.cloud 可能残留为
// 半初始化/损坏状态——对象本身依然存在，但内部方法表未正确挂载，导致
// 后续任意 wx.cloud.database() / wx.cloud.callFunction() 调用抛出
// "TypeError: Cannot read property 'getCloudAPI' of undefined"。
//
// 这类调用往往发生在 try/catch 保护范围之外（例如作为函数顶部的同步赋值语句），
// 单纯依赖事后捕获无法完全兜底。因此在每次真正使用云能力之前，
// 先做一次轻量的"能力探测"，不可用时直接跳过云端路径、退回本地缓存模式。
//
// 🛡️ 探测口径：先做 typeof 链路检查（wx / wx.cloud / wx.cloud.callFunction），
// 不强依赖 wx.cloud.database 等内部方法是否存在——那类校验容易因基础库版本差异
// 或方法挂载时机不同而误判为"不可用"。
//
// 🐛 根因修复：仅这条 typeof 链路检查是不够的——wx.cloud.callFunction 这个方法
// 本身在 wx.cloud.init() 完成之前就已经存在（SDK 早早挂好了方法表），调用它只是
// 在还没 init 时会抛运行时错误 "Cloud API isn't enabled, please call wx.cloud.init
// first"。app.ts 的 onLaunch 里 wx.cloud.init 曾被人为延迟到 1.5s 后才执行（为了
// 避开本地 Linux 开发者工具在 init 阶段偶发崩溃的问题），这段窗口期内任何页面的
// 早期云调用，单看 typeof 检查会误判为"可用"，实际执行时却直接报错。这里额外核对
// app.globalData.isCloudReady（由 app.ts _attemptCloudInit 在 init 真正成功后置位），
// 让这段窗口期被正确识别为"不可用"，交给各调用点已有的本地兜底路径，而不是让请求
// 真的打出去再报错。
import { callFunctionWithTimeout, DEFAULT_CALL_FUNCTION_TIMEOUT_MS } from './withTimeout';

export function isCloudAvailable(): boolean {
  try {
    if (
      typeof wx === 'undefined' ||
      typeof wx.cloud === 'undefined' ||
      typeof wx.cloud.callFunction !== 'function'
    ) {
      return false;
    }

    const app = getApp() as any;
    return !!(app && app.globalData && app.globalData.isCloudReady);
  } catch (err) {
    console.warn('[cloudGuard] 云能力探测异常，判定为不可用:', err);
    return false;
  }
}

/** 云 SDK 不可用时统一抛出的标记错误，供既有 catch 分支识别并走本地兜底逻辑 */
export function assertCloudAvailable(): void {
  if (!isCloudAvailable()) {
    throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用（可能是 wx.cloud.init 初始化失败），已降级本地模式');
  }
}

// 🛡️ 自愈防护：isCloudAvailable() 的方法表探测（typeof xxx === 'function'）拦不住
// 本文件顶部注释里那种"半初始化/损坏"状态——wx.cloud.database/callFunction 作为
// 属性确实存在、类型确实是 function，isCloudReady 因此被判定为 true，但真正发起
// 调用时，WeChat 内部 WASubContext.js 的递归遍历逻辑会抛出 TypeError（典型信息
// "Cannot read property 'xxx' of undefined"），且这个 TypeError 是直接从
// wx.cloud.callFunction()/wx.cloud.database() 调用本身抛出的（不是业务代码自己
// 处理 res.result 时因字段缺失产生的），是本地开发者工具在 Linux 环境下已知的
// loadSdkSubPackage 后遗症（见 app.ts _attemptCloudInit 注释）。
// 命中这个特征后应把 isCloudReady 标回 false，让本次会话后续云调用直接走本地
// 兜底，不再对同一处已损坏的 SDK 状态重复发起、重复崩溃。

/** 识别"wx.cloud 半初始化/损坏"这一特征错误，供 reportCloudSdkErrorIfCorrupted 内部使用，也可单独判断 */
export function isCloudSdkCorruptionError(err: any): boolean {
  return !!(
    err &&
    err instanceof TypeError &&
    /Cannot read propert(y|ies) '.*' of undefined/i.test(err.message || '')
  );
}

// 各云调用 catch 块里统一调用：命中损坏特征时把 isCloudReady 标回 false 并打印一次
// 明确提示；调用方自身已有的本地兜底逻辑（result=null 等）继续照常执行，不需要
// 额外改动——这个函数只负责"止血"标记，不接管错误处理流程，也不会对普通的网络
// 超时/权限拒绝等正常业务错误误判（那些不是 TypeError，不会命中这个特征）
export function reportCloudSdkErrorIfCorrupted(err: any): void {
  if (!isCloudSdkCorruptionError(err)) return;
  try {
    const app = getApp() as any;
    if (app && app.globalData && app.globalData.isCloudReady) {
      app.globalData.isCloudReady = false;
      console.error('[cloudGuard] 检测到 wx.cloud SDK 损坏特征错误（疑似本地开发者工具 loadSdkSubPackage 残留问题），本次会话已降级本地模式，后续云调用将直接跳过:', err);
    }
  } catch (guardErr) {
    console.warn('[cloudGuard] 自愈标记 isCloudReady 时异常:', guardErr);
  }
}

export interface CloudGuardOptions {
  /** 超时毫秒数，透传给 callFunctionWithTimeout，默认沿用其既定 8000ms（DEFAULT_CALL_FUNCTION_TIMEOUT_MS） */
  timeoutMs?: number;
  /**
   * 出错时是否自动 wx.showToast 兜底提示，默认 true。
   * 已有"静默降级本地缓存"逻辑的调用点应显式传 false，避免用户被无谓打扰；
   * careMode 长者模式页面同样建议传 false，改用物理震动反馈（见 CLAUDE.md 第 3 节）。
   */
  showErrorToast?: boolean;
  /** 自定义降级提示文案，默认"网络繁忙，请稍后重试" */
  errorToastTitle?: string;
}

/**
 * 云函数调用统一高阶封装：在 callFunctionWithTimeout（已有的全仓库统一超时
 * 实现，见本文件头部注释）外层叠加 try...catch、执行耗时监控、出错时的
 * wx.cloud SDK 损坏自愈标记（复用 reportCloudSdkErrorIfCorrupted），以及
 * 可选的原生 wx.showToast 降级提示。
 *
 * 调用前会先做一次 isCloudAvailable() 探测，命中"云能力不可用"时直接快速
 * 失败（不真的发起会必然出错的网络请求），错误信息与 assertCloudAvailable()
 * 抛出的一致，供调用方既有的 catch 分支识别。
 *
 * 本函数不吞掉错误——记录耗时与日志、按需弹出提示后仍会把原始错误 throw
 * 出去，调用方原有的业务级错误处理（如本地兜底赋值）不受影响。
 */
export async function callCloudFunctionGuarded<T = any>(
  options: ICloud.CallFunctionParam,
  guardOptions: CloudGuardOptions = {}
): Promise<T> {
  const {
    timeoutMs = DEFAULT_CALL_FUNCTION_TIMEOUT_MS,
    showErrorToast = true,
    errorToastTitle = '网络繁忙，请稍后重试'
  } = guardOptions;
  const name = (options && options.name) || '(未知云函数)';
  const startTime = Date.now();

  try {
    assertCloudAvailable();
    const result = await callFunctionWithTimeout<T>(options, timeoutMs);
    console.log(`[cloudGuard] 云函数 "${name}" 调用成功，耗时 ${Date.now() - startTime}ms`);
    return result;
  } catch (err: any) {
    console.error(`[cloudGuard] 云函数 "${name}" 调用失败，耗时 ${Date.now() - startTime}ms:`, err);
    reportCloudSdkErrorIfCorrupted(err);
    if (showErrorToast) {
      try {
        wx.showToast({ title: errorToastTitle, icon: 'none', duration: 2000 });
      } catch (toastErr) {
        console.warn('[cloudGuard] 降级提示 wx.showToast 触发异常:', toastErr);
      }
    }
    throw err;
  }
}
