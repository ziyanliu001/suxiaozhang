// 统一 wx.showLoading / wx.hideLoading 配对封装
//
// 🐛 全项目大量调用点各自手写 wx.showLoading(...)/wx.hideLoading()配对：一旦某个
// 分支提前 return/抛异常时漏调 hideLoading，或者两个互不知情的异步操作前后脚各自
// showLoading 一次，微信开发者工具就会报"showLoading、hideLoading 必须配对使用"——
// 因为原生 API 本身不是引用计数的，后完成的一次 hideLoading 会把仍在途的另一次操作
// 的遮罩一并关掉，或者在没有对应 showLoading 时多喊一次 hideLoading。
//
// withLoading() 用一个模块级计数器记录"当前有几个操作正在要求展示 loading"：只有
// 计数器从 0 变成 1 时才真正调用 wx.showLoading，只有计数器归 0 时才真正调用
// wx.hideLoading，嵌套/并发调用只增减计数，不重复弹出/收起遮罩；且用 try/finally
// 保证无论 fn 内部有多少条 return/throw 路径，hideLoading 都恰好被调用一次。
let activeLoadingCount = 0;

function showLoadingGuard(options?: WechatMiniprogram.ShowLoadingOption) {
  activeLoadingCount++;
  if (activeLoadingCount === 1) {
    wx.showLoading(options || { title: '加载中...', mask: true });
  }
}

function hideLoadingGuard() {
  activeLoadingCount = Math.max(0, activeLoadingCount - 1);
  if (activeLoadingCount === 0) {
    wx.hideLoading();
  }
}

export async function withLoading<T>(
  options: WechatMiniprogram.ShowLoadingOption | string,
  fn: () => Promise<T>
): Promise<T> {
  const opts = typeof options === 'string' ? { title: options, mask: true } : options;
  showLoadingGuard(opts);
  try {
    return await fn();
  } finally {
    hideLoadingGuard();
  }
}
