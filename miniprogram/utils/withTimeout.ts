// 统一的 Promise / 云函数调用超时封装
//
// 🐛 此前 utils/authService.ts 与 pages/index/index.ts 各自独立定义了一份功能
// 相同的 withTimeout，其余 200+ 处 wx.cloud.callFunction 调用完全没有超时保护，
// 弱网/云函数冷启动下会一直等到微信 SDK 自身的默认超时（远长于业务可接受的
// 等待时长）才失败，期间页面容易停留在 loading 态。这里统一成一份，供全项目
// 复用，避免各页面各自维护一份容易长期漂移不一致的超时实现。

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMsg?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMsg || `操作超时（>${timeoutMs}ms）`)), timeoutMs);
  });
  // .finally 清掉计时器：即使真正的 promise 先赢得竞速，也不留一个悬空的
  // setTimeout 在背后空跑到超时时长耗尽才被回收
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// 云函数冷启动实测偶尔超过 5~8s，此前 authService.ts 的 LOGIN_TIMEOUT_MS/
// ROLE_QUERY_TIMEOUT_MS 用的是 8000，这里保持一致作为通用默认值
export const DEFAULT_CALL_FUNCTION_TIMEOUT_MS = 8000;

// wx.cloud.callFunction 的超时封装：返回值与原始调用一致（{result, requestID}），
// 调用方判断 res.result.success 的既有逻辑不需要改动，只是外面多一层超时保护，
// 超时以后 reject 一个 Error，需要调用方自己 catch（与 wx.cloud.callFunction
// 本身网络失败时的 reject 行为一致，不改变既有错误处理约定）。
export function callFunctionWithTimeout<T = any>(
  options: ICloud.CallFunctionParam,
  timeoutMs: number = DEFAULT_CALL_FUNCTION_TIMEOUT_MS,
  timeoutMsg?: string
): Promise<T> {
  const name = (options && options.name) || 'unknown';
  return withTimeout(
    wx.cloud.callFunction(options) as unknown as Promise<T>,
    timeoutMs,
    timeoutMsg || `${name} 调用超时（>${timeoutMs}ms），请检查网络后重试`
  );
}
