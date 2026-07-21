// 云开发 SDK 可用性防护
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
// 🛡️ 探测口径：只做 typeof 链路检查（wx / wx.cloud / wx.cloud.callFunction），
// 不再强依赖 wx.cloud.database 等内部方法是否存在——那类校验容易因基础库版本差异
// 或方法挂载时机不同而误判为"不可用"，只要 wx.cloud 实例本身存在且 callFunction
// 可调用，就判定为可用，真正的调用失败交给各调用点自身的 try/catch 兜底。
export function isCloudAvailable(): boolean {
  try {
    return (
      typeof wx !== 'undefined' &&
      typeof wx.cloud !== 'undefined' &&
      typeof wx.cloud.callFunction === 'function'
    );
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
