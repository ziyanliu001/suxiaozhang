// app.ts
import { AuthService } from './utils/authService';

interface StorePermission {
  storeId: string;
  storeName: string;
  role: 'MANAGER' | 'FINANCE' | 'VOLUNTEER';
}

App<IAppOption>({
  globalData: {
    onNetworkReconnected: null as (() => void) | null,
    selectedStore: null as { storeId: string; storeName: string } | null,
    currentStore: {
      storeId: 'store_haicang_001',
      storeName: '海沧区雨花斋',
      role: 'VOLUNTEER' as 'MANAGER' | 'FINANCE' | 'VOLUNTEER'
    },
    userStoresList: [] as StorePermission[]
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
        this.fetchUserStorePermissions(res.openid!);
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

  async fetchUserStorePermissions(openid: string) {
    try {
      const db = wx.cloud.database();
      const res = await db.collection('user_roles').where({
        _openid: openid
      }).get();

      if (res.data && res.data.length > 0) {
        const userRec = res.data[0];
        const storeList = userRec.storePermissions || [];

        if (storeList.length > 0) {
          const savedStoreId = wx.getStorageSync('active_store_id');
          const matchedStore = storeList.find((s: any) => s.storeId === savedStoreId) || storeList[0];

          const normalizedStores = storeList.map((s: any) => ({
            storeId: s.storeId,
            storeName: s.storeName,
            role: (s.role || 'VOLUNTEER').toUpperCase() as 'MANAGER' | 'FINANCE' | 'VOLUNTEER'
          }));

          this.globalData.userStoresList = normalizedStores;
          this.globalData.currentStore = {
            storeId: matchedStore.storeId,
            storeName: matchedStore.storeName,
            role: (matchedStore.role || 'VOLUNTEER').toUpperCase() as 'MANAGER' | 'FINANCE' | 'VOLUNTEER'
          };

          wx.setStorageSync('active_store_id', matchedStore.storeId);
          console.log('[App] 多店权限加载完成:', normalizedStores.length, '个门店');
        }
      }
    } catch (err) {
      console.error('获取多店权限失败:', err);
    }
  },

  switchStore(storeId: string, storeName: string, role: 'MANAGER' | 'FINANCE' | 'VOLUNTEER') {
    this.globalData.currentStore = { storeId, storeName, role };
    this.globalData.selectedStore = { storeId, storeName };
    wx.setStorageSync('active_store_id', storeId);
    wx.setStorageSync('selectedStore', { storeId, storeName });
    console.log('[App] 已切换门店:', storeName, '角色:', role);
  }
})