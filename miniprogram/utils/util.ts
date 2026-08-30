export function getSafeSystemInfo() {
  try {
    const windowInfo = (wx as any).getWindowInfo ? (wx as any).getWindowInfo() : {};
    const deviceInfo = (wx as any).getDeviceInfo ? (wx as any).getDeviceInfo() : {};
    const appBaseInfo = (wx as any).getAppBaseInfo ? (wx as any).getAppBaseInfo() : {};

    return {
      pixelRatio: windowInfo.pixelRatio || 2,
      screenWidth: windowInfo.screenWidth || 375,
      screenHeight: windowInfo.screenHeight || 667,
      windowWidth: windowInfo.windowWidth || 375,
      windowHeight: windowInfo.windowHeight || 667,
      statusBarHeight: windowInfo.statusBarHeight || 20,
      platform: deviceInfo.platform || 'unknown',
      brand: deviceInfo.brand || '',
      model: deviceInfo.model || '',
      system: deviceInfo.system || '',
      SDKVersion: appBaseInfo.SDKVersion || '3.0.0',
      safeArea: windowInfo.safeArea || { top: 20, right: 0, bottom: 0, left: 0 }
    };
  } catch (err) {
    console.warn('[getSafeSystemInfo] 获取系统信息异常，使用默认值:', err);
    return {
      pixelRatio: 2,
      screenWidth: 375,
      screenHeight: 667,
      windowWidth: 375,
      windowHeight: 667,
      statusBarHeight: 20,
      platform: 'devtools',
      brand: '',
      model: '',
      system: '',
      SDKVersion: '3.0.0',
      safeArea: { top: 20, right: 0, bottom: 0, left: 0 }
    };
  }
}

// 🐛 根因修复：微信开发者工具里切换到 iPhone 机型模拟器调试时，
// wx.getDeviceInfo().platform 恒为 'devtools'，不会变成 'ios'——如果 iOS 专属
// 分支（如订阅弹窗隐藏价格/支付按钮，见 pages/profile/profile.ts）只判断
// platform === 'ios'，开发者工具里选 iPhone 机型也永远进不去该分支，看起来
// "改了但没生效"，容易被误判成代码没生效而不是判断条件本身覆盖不到调试环境。
// 开发者工具的机型模拟会把 model/system 换成对应的 iPhone 型号名/iOS 版本号
// （如 model: 'iPhone 15 Pro'，system: 'iOS 17.0'），兜底再从这两个字段识别，
// 覆盖开发者工具调试场景；真机上 platform 本身就已经是 'ios'，第一个条件
// 就命中，不受这条兜底影响
export function isIOSDevice(sysInfo?: ReturnType<typeof getSafeSystemInfo>): boolean {
  const info = sysInfo || getSafeSystemInfo();
  if (info.platform === 'ios') return true;
  if (info.platform === 'devtools') {
    return /ios|iphone/i.test(info.model || '') || /ios/i.test(info.system || '');
  }
  return false;
}

// 🐛 性能修复：wx.getStorageSync 的异步替代——journey.ts/store-profile.ts/
// daily-menu.ts/activity-log.ts 等页面 onLoad/onShow 里读取 current_user_role/
// current_store_id 等零散 key 时，此前各自直接调用 wx.getStorageSync，同步
// 占用页面初始化的执行栈；本项目已出现过 safeNavigateTo 2.5s 诊断警告（见
// utils/navHelper.ts 的诊断计时器注释）。统一改成这个小工具函数，key 不存在
// 时 wx.getStorage 走 fail 回调，按空字符串兜底，与原先 wx.getStorageSync(...)
// || '' 的口径一致
export function getStorageAsync(key: string): Promise<any> {
  return new Promise((resolve) => {
    wx.getStorage({
      key,
      success: (res) => resolve(res.data),
      fail: () => resolve('')
    });
  });
}

export const formatTime = (date: Date) => {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hour = date.getHours()
  const minute = date.getMinutes()
  const second = date.getSeconds()

  return (
    [year, month, day].map(formatNumber).join('/') +
    ' ' +
    [hour, minute, second].map(formatNumber).join(':')
  )
}

const formatNumber = (n: number) => {
  const s = n.toString()
  return s[1] ? s : '0' + s
}
