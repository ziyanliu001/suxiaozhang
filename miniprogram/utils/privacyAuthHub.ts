// 🛡️ 隐私授权拦截全局 Hub：修复"21 listeners of event onBeforeUnloadPage_N have
// been added, possibly causing memory leak"控制台告警。
//
// 根因：wx.onNeedPrivacyAuthorization 是 App 级累加式监听器——多次调用会不断叠加，
// 且 wx.offNeedPrivacyAuthorization 在不少基础库版本里根本不存在（本文件也没有把
// 它列进任何官方类型声明）。此前 components/privacy-popup 的做法是"每个页面挂载的
// 组件实例各自在 attached() 里调一次 wx.onNeedPrivacyAuthorization，detached() 里
// 尝试 wx.offNeedPrivacyAuthorization 注销"——一旦 off 在当前基础库版本里静默调用
// 失败（typeof 检测不到就直接跳过，见旧版注释"旧基础库无此 API，静默跳过"），
// 这次注册就永远无法被撤销。index/profile 是 tabBar 页（正常不重建），但
// history/statistics 是普通页面，用户每次导航进出都会让 privacy-popup 组件重新
// attached/detached 一轮，只要 off 没有真正生效，监听器数量就会随导航次数线性增长，
// 最终撞上平台的"疑似泄漏"阈值告警。
//
// 修复方式：wx.onNeedPrivacyAuthorization 全局只在 app.ts onLaunch 时注册这一次
// （与 app.ts 里已有的 wx.onNetworkStatusChange 是同一种"App 级单例监听器"用法），
// 之后各页面的 privacy-popup 组件实例不再各自调用原生 API，只是订阅/取消订阅本模块
// 内的一个普通 Set——Set.add/delete 是纯内存操作，不依赖任何原生 off API 是否存在，
// 组件反复 attached/detached 多少次都不会残留任何东西。
//
// 🌟 顺带修复的潜在陈旧态问题：index/profile 这类 tabBar 页可能同时有多个
// privacy-popup 实例挂载（当前 tab 之外的其它 tab 页并不会被销毁），原生事件一次
// 触发会广播给所有实例，各自都会弹出确认框。用户在其中一个弹窗里点了同意/拒绝后，
// 其它实例的弹窗此前会停留在"仍然显示、且持有一个已经被消费过的 resolve"的陈旧
// 状态——切回那个 tab 时会看到一个多余的弹窗，再点一次还会对同一个 resolve 调用
// 两次。这里把订阅者从"单一回调函数"改成"{onNeedAuth, onResolved} 一对回调"，
// resolve 一旦被任意一个实例真正调用，就广播 onResolved() 通知所有实例收起弹窗、
// 清空自己持有的 resolve 引用，不再需要用户手动点掉每一个陈旧弹窗。

type ResolveFn = (res: { event: 'agree' | 'disagree' }) => void;

export interface PrivacyAuthSubscriber {
  // 平台触发一次隐私拦截时调用，resolve 已经过本模块包装：调用它既会真正放行/
  // 中断原生调用，也会自动触发下面的 onResolved 广播给所有订阅者
  onNeedAuth: (resolve: ResolveFn) => void;
  // 任意一个订阅者调用了 resolve 后，广播给包括自己在内的所有订阅者，用于收起
  // 弹窗、清空自己持有的 resolve 引用，避免陈旧态
  onResolved: () => void;
}

let initialized = false;
const subscribers = new Set<PrivacyAuthSubscriber>();

// 只应在 app.ts onLaunch 中调用一次；重复调用是安全的空操作（initialized 幂等卫士）
export function initPrivacyAuthHub() {
  if (initialized) return;
  initialized = true;

  const wxAny = wx as any;
  if (typeof wxAny.onNeedPrivacyAuthorization !== 'function') return;

  try {
    wxAny.onNeedPrivacyAuthorization((resolve: ResolveFn) => {
      let settled = false;
      const wrappedResolve: ResolveFn = (res) => {
        // 🛡️ 幂等防线：微信平台本身应当保证同一个 resolve 只有第一次调用生效，
        // 这里再加一层，确保即使用户在两个陈旧弹窗上手快各点一次，也只广播一次
        // onResolved，不重复触发
        if (settled) return;
        settled = true;
        resolve(res);
        subscribers.forEach((s) => {
          try {
            s.onResolved();
          } catch (e) {
            console.error('[privacyAuthHub] onResolved 回调执行异常:', e);
          }
        });
      };

      // 广播给当前所有已挂载的 privacy-popup 实例——多个 tabBar 页面可能同时
      // 挂载各自的组件实例，都会弹出确认框；用户在其中任意一个点了同意/拒绝，
      // wrappedResolve 会通知所有实例一起收起
      subscribers.forEach((s) => {
        try {
          s.onNeedAuth(wrappedResolve);
        } catch (e) {
          console.error('[privacyAuthHub] onNeedAuth 回调执行异常:', e);
        }
      });
    });
  } catch (e) {
    console.error('[privacyAuthHub] onNeedPrivacyAuthorization 注册异常:', e);
  }
}

export function subscribeNeedAuth(subscriber: PrivacyAuthSubscriber) {
  subscribers.add(subscriber);
}

export function unsubscribeNeedAuth(subscriber: PrivacyAuthSubscriber) {
  subscribers.delete(subscriber);
}

// 🛡️（2026-09-03 死锁根因修复）ensurePrivacyAuthorized：在调用 wx.chooseMedia/
// chooseImage/saveImageToPhotosAlbum 等隐私接口之前主动调用，确保隐私授权在
// "屏幕上完全没有任何遮罩层"的干净状态下弹出。
//
// 死锁根因：此前部分选图入口的写法是"先 wx.showLoading({mask:true})，再调
// wx.chooseMedia"——如果这是本次会话第一次触碰隐私接口、用户还没同意过《隐私
// 保护指引》，wx.chooseMedia 内部会先触发隐私拦截弹出该指引弹窗（走
// wx.onNeedPrivacyAuthorization，见 initPrivacyAuthHub），但此时 showLoading
// 的全屏遮罩已经盖在页面最上层——原生 loading 遮罩与隐私弹窗共享同一层
// WeChat 客户端 UI 层级，遮罩会挡住隐私弹窗"同意并继续"按钮的点击事件，用户
// 点不到同意，chooseMedia 永远不会 resolve/reject，showLoading 也永远等不到
// 对应的 hideLoading——彻底死锁，界面表现为"点了拍照/相册后卡死不动"。
//
// 修复：把"确保隐私授权已解决"这一步提到调用方最前面、且不携带任何 loading，
// 用官方的主动式 wx.requirePrivacyAuthorize API（与已有的被动式
// wx.onNeedPrivacyAuthorization 走同一套隐私弹窗——本小程序已经用
// components/privacy-popup 接管了这个弹窗的展示，requirePrivacyAuthorize 只是
// 提供一个"我要主动确认一下，现在授权到底有没有解决"的 await 入口，不会额外
// 弹出第二个弹窗）。无论用户同意还是拒绝都直接 resolve，不阻塞调用方——拒绝
// 时紧接着的 chooseMedia 调用会自己失败并走既有的 catch 分支，不需要在这里
// 代为判断/拦截。
export function ensurePrivacyAuthorized(): Promise<void> {
  return new Promise((resolve) => {
    const wxAny = wx as any;
    if (typeof wxAny.requirePrivacyAuthorize !== 'function') {
      // 基础库版本过旧、没有这个主动式 API：静默跳过，退回到纯被动式
      // wx.onNeedPrivacyAuthorization 兜底（本模块已经在 app.ts onLaunch 里
      // 注册好），不阻塞调用方
      resolve();
      return;
    }
    try {
      wxAny.requirePrivacyAuthorize({
        success: () => resolve(),
        // 用户拒绝、或本次调用与隐私接口无关而被判定失败：同样直接放行，
        // 不在这里弹任何提示——调用方紧接着发起的 chooseMedia 等真正的隐私
        // 接口调用会自己走一遍平台校验，该失败的地方交给那里处理
        fail: () => resolve()
      });
    } catch (e) {
      console.error('[privacyAuthHub] requirePrivacyAuthorize 调用异常:', e);
      resolve();
    }
  });
}
