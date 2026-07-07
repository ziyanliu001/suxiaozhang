// app.ts
App<IAppOption>({
  globalData: {},
  onLaunch() {
    wx.cloud.init({
      env: 'cloudbase-d8g7hg2bf851750ab',
      traceUser: true
    });

    const logs = wx.getStorageSync('logs') || []
    logs.unshift(Date.now())
    wx.setStorageSync('logs', logs)

    // 登录
    wx.login({
      success: res => {
        console.log(res.code)
        // 发送 res.code 到后台换取 openId, sessionKey, unionId
      },
    })
  },
})