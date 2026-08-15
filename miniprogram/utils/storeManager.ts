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
  
  return { storeId: '', storeName: '', role: 'VOLUNTEER' };
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

// 🐛 Bug 修复配套：index.ts fetchAllStoresList() 的本地缓存改为按专区
// （currentPlatformMode：'yuhua'/'general'/未选定时的 'default'）分开存储，
// 避免超管在雨花专区拉取过列表后，5 分钟内切到通用专区又直接复用同一份缓存、
// 展示出上一个专区的门店。这里统一列出全部可能的 key 组合，供
// store-management.ts（新建/移出门店后）与 index.ts（切店后）失效缓存时
// 一次性清空，不需要调用方各自猜测"当前该清哪个专区的 key"
const ALL_STORES_LIST_CACHE_ZONES = ['yuhua', 'general', 'default'];

export function clearAllStoresListCache(): void {
  ALL_STORES_LIST_CACHE_ZONES.forEach((zone) => {
    wx.removeStorageSync(`all_stores_list_cache_${zone}`);
    wx.removeStorageSync(`all_stores_list_cache_time_${zone}`);
  });
}

export function getUserStoresList(): StoreInfo[] {
  const app = getApp() as any;
  if (app && app.globalData && app.globalData.userStoresList) {
    return app.globalData.userStoresList;
  }
  return [];
}

const STORE_STATUS_STORAGE_KEY = 'current_store_status';

const OPERATING_STATUS_LABELS: Record<string, string> = {
  operating: '运营中',
  preparing: '筹备中',
  paused: '暂停运营'
};

// 🏪 门店运营状态全局态：先从 app.globalData 秒读缓存值（跨页面切换时不必等一次
// 网络往返才能显示），拿不到时退回本地 Storage 兜底，两处都没有才是真正的空
export function getCachedStoreStatus(): string {
  const app = getApp() as any;
  if (app && app.globalData && app.globalData.currentStoreStatus) {
    return app.globalData.currentStoreStatus;
  }
  try {
    return wx.getStorageSync(STORE_STATUS_STORAGE_KEY) || '';
  } catch (e) {
    return '';
  }
}

// 🏪 拉取门店运营状态并同步进 app.globalData + 本地 Storage：复用 store-profile.ts/
// profile.ts 已经在用的 manageStoreProfile 'get' 动作（任意已绑定门店角色可读），
// 不新开云函数、不重复实现状态映射表。静默失败——查询失败不影响页面其余渲染，
// 调用方按需决定是否要感知失败（一般不需要，保留上一次已知状态即可）
export async function fetchAndSyncStoreStatus(storeId: string): Promise<string> {
  if (!storeId) return '';
  try {
    const res: any = await wx.cloud.callFunction({
      name: 'manageStoreProfile',
      data: { action: 'get', storeId }
    });
    const result = res.result;
    if (!result || !result.success) return getCachedStoreStatus();

    const label = OPERATING_STATUS_LABELS[result.data && result.data.operatingStatus] || '运营中';

    const app = getApp() as any;
    if (app && app.globalData) {
      app.globalData.currentStoreStatus = label;
    }
    try {
      wx.setStorageSync(STORE_STATUS_STORAGE_KEY, label);
    } catch (e) {
      /* ignore */
    }
    return label;
  } catch (err) {
    console.warn('[fetchAndSyncStoreStatus] 查询门店状态失败:', err);
    return getCachedStoreStatus();
  }
}