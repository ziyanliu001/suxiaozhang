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
