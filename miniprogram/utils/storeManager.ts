const STORE_STORAGE_KEY = 'selectedStore';

export interface StoreInfo {
  storeId: string;
  storeName: string;
  role?: 'MANAGER' | 'FINANCE' | 'VOLUNTEER';
}

export function getSelectedStore(): StoreInfo {
  const app = getApp() as any;
  
  if (app && app.globalData && app.globalData.currentStore) {
    return app.globalData.currentStore;
  }
  
  if (app && app.globalData && app.globalData.selectedStore) {
    return { ...app.globalData.selectedStore, role: 'VOLUNTEER' };
  }
  
  const cached = wx.getStorageSync(STORE_STORAGE_KEY);
  if (cached) {
    if (app && app.globalData) {
      app.globalData.selectedStore = cached;
    }
    return { ...cached, role: 'VOLUNTEER' };
  }
  
  return { storeId: 'store_haicang_001', storeName: '海沧区雨花斋', role: 'VOLUNTEER' };
}

export function setSelectedStore(storeInfo: StoreInfo): void {
  if (!storeInfo) return;
  
  wx.setStorageSync(STORE_STORAGE_KEY, storeInfo);
  
  const app = getApp() as any;
  if (app && app.globalData) {
    app.globalData.selectedStore = { storeId: storeInfo.storeId, storeName: storeInfo.storeName };
    if (storeInfo.role) {
      app.globalData.currentStore = { ...storeInfo };
    }
  }
}

export function getUserStoresList(): StoreInfo[] {
  const app = getApp() as any;
  if (app && app.globalData && app.globalData.userStoresList) {
    return app.globalData.userStoresList;
  }
  return [];
}