// app.ts
import { AuthService } from './utils/authService';

App<IAppOption>({
  globalData: {
    onNetworkReconnected: null as (() => void) | null
  },
  onLaunch() {
    wx.cloud.init({
      env: 'cloudbase-d8g7hg2bf851750ab',
      traceUser: true
    });

    const logs = wx.getStorageSync('logs') || []
    logs.unshift(Date.now())
    wx.setStorageSync('logs', logs)

    AuthService.ensureLogin().then(res => {
      if (res.success) {
        console.log('[App] 静默登录预热成功:', res.openid);
      } else {
        console.warn('[App] 静默登录预热失败:', res.error);
      }
    });

    wx.onNetworkStatusChange((res) => {
      console.log('[App] 网络状态变化:', res);
      if (res.isConnected) {
        console.log('[App] 网络已恢复连接');
        if (this.globalData.onNetworkReconnected) {
          try {
            this.globalData.onNetworkReconnected();
          } catch (error) {
            console.error('[App] 网络恢复回调执行失败:', error);
          }
        }
      }
    });
  },
})