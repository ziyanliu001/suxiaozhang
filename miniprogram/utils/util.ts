export function getSafeSystemInfo() {
  try {
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : {};
    const deviceInfo = wx.getDeviceInfo ? wx.getDeviceInfo() : {};
    const appBaseInfo = wx.getAppBaseInfo ? wx.getAppBaseInfo() : {};

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
