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
  const name = (options && options.name) || '';
  // 🐛 防御：调用方传入空/undefined 云函数名时，wx.cloud.callFunction 会以
  // -501000 FunctionName could not be found 报错——错误信息完全看不出"根因是
  // 调用方没传对 name"，容易被误判成云端未部署。这里提前在本地快速失败，
  // 报错文案直接点名问题，不让排查者绕远路
  if (!name) {
    return Promise.reject(new Error('callFunctionWithTimeout: 缺少云函数名 name，请检查调用方传参'));
  }
  return withTimeout(
    (wx.cloud.callFunction(options) as unknown as Promise<T>).catch((err: any) => {
      // 🐛 -501000 FunctionName could not be found：绝大多数真实场景下是该
      // 云函数代码在仓库里存在，但从未在微信开发者工具里对其执行过"上传并
      // 部署：云端安装依赖"，而不是调用方拼错了函数名（拼错的话代码审查/
      // 全仓库搜索更容易先发现）。这里补一句可操作的诊断日志，不改变原始
      // 错误对象本身，调用方现有的 catch/toast 逻辑不受影响
      if (err && (err.errCode === -501000 || /FunctionName.*could not be found/i.test(err.errMsg || ''))) {
        console.error(`[callFunctionWithTimeout] 云函数 "${name}" 未找到（-501000）：请确认已在微信开发者工具对 cloudfunctions/${name} 目录执行"上传并部署：云端安装依赖"，这通常是部署遗漏而非调用方代码问题`);
      }
      throw err;
    }),
    timeoutMs,
    timeoutMsg || `${name} 调用超时（>${timeoutMs}ms），请检查网络后重试`
  );
}
