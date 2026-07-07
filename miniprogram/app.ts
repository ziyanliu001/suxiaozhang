// app.ts
import { AuthService } from './utils/authService';

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

    // 预热静默登录（不 await，真正的严格等待在首页 onLoad 中完成）
    AuthService.ensureLogin().then(res => {
      if (res.success) {
        console.log('[App] 静默登录预热成功:', res.openid);
      } else {
        console.warn('[App] 静默登录预热失败:', res.error);
      }
    });
  },
})