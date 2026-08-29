import { callFunctionWithTimeout } from './withTimeout';
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

// 🐛 根因修复："首页显示门店 A，切到个人中心却显示门店 B"跨页面不同步：
// profile.ts initMinePage() 的门店名解析以 Storage 里的 current_store_name 为
// 最高优先级信号（见该方法注释），但"当前生效门店"此前分散在至少 3 处各自
// 手写持久化——store-picker.ts _persistStoreSelection（写全 5 个 canonical key）、
// index.ts onStoreChanged（写全 5 个 key）、index.ts switchStoreTarget（只调了
// setSelectedStore 写 legacy 的 selectedStore key，current_store_id/
// current_store_name/active_store_id 这三个 profile.ts 真正依赖的 key 完全没写）。
// 一旦门店切换是经由 switchStoreTarget 这条路径发生（如工作台"自动默认选店"、
// 模板编辑门店下拉框切换），首页页面自身的 this.data.currentStoreId 立刻更新、
// UI 看起来是对的，但 current_store_name 这个 Storage key 还停留在上一次真正
// 写过它的旧值——profile.ts 切过去读到的正是这份过期数据，表现为两个 Tab 显示
// 不同门店。现在统一收敛成这一对 setCurrentActiveStore()/getCurrentActiveStore()，
// 所有"切店"入口只应调用这里，不再各自维护一份可能遗漏 key 的写入逻辑；所有
// "读当前门店"的地方也统一从这里读，而不是直接摸 current_store_name 这个
// Storage key 或 legacy 的 selectedStore key
const ROLE_STORAGE_NORMALIZE_MAP: Record<string, string> = {
  MANAGER: 'store_manager',
  STORE_MANAGER: 'store_manager',
  FINANCE: 'finance',
  VOLUNTEER: 'volunteer',
  PATRIARCH: 'store_patriarch',
  STORE_PATRIARCH: 'store_patriarch',
  ADMIN: 'super_admin',
  SUPER_ADMIN: 'super_admin',
  FAMILY: 'store_family',
  STORE_FAMILY: 'store_family'
};

export function setCurrentActiveStore(storeId: string, storeName: string, role?: string): void {
  if (!storeId) return;

  wx.setStorageSync('current_store_id', storeId);
  wx.setStorageSync('current_store_name', storeName);
  wx.setStorageSync('active_store_id', storeId);

  // role 缺省（如工作台自动默认选店/模板编辑门店切换）时只更新门店信息，
  // 不动当前生效身份——避免把用户手动选定的角色意外重置回默认值
  if (role) {
    wx.setStorageSync('current_user_role', ROLE_STORAGE_NORMALIZE_MAP[role.toUpperCase()] || 'volunteer');
    wx.setStorageSync('active_role', role);
  }

  // 与 legacy 的 selectedStore key / app.globalData 保持同步，兼容仍在用
  // getSelectedStore() 的旧读取方，不留一份"另一套真相"
  setSelectedStore({ storeId, storeName });
}

export function getCurrentActiveStore(): StoreInfo {
  const storeId = wx.getStorageSync('current_store_id') || wx.getStorageSync('active_store_id') || '';
  const storeName = wx.getStorageSync('current_store_name') || '';
  if (storeId) {
    return { storeId, storeName };
  }
  // canonical key 缺失（极少数只调用过旧版 setSelectedStore 的历史路径）时，
  // 退回 legacy 的 selectedStore key / app.globalData 信号兜底
  const legacy = getSelectedStore();
  return { storeId: legacy.storeId || '', storeName: legacy.storeName || '' };
}

// 🐛 专区状态污染清理配套：index.ts maybeAutoSelectStore() 在"上次访问门店"已不
// 属于当前专区收窄后的门店列表时调用——本地/全局态里这份跨专区的门店缓存已经
// 不再有效，须一并清掉（而不是只在内存里绕过它），避免其它仍在读
// getCurrentActiveStore()/getSelectedStore() 的地方（如切页面回来）继续展示这个
// 早已不属于当前专区的门店名，造成"看似还记得上一家店，其实是别的专区的脏
// 数据"的状态污染。canonical 的 current_store_id/current_store_name/
// active_store_id 与 legacy 的 selectedStore key 是同一份"当前门店"语义，
// 必须一并清掉，只清 legacy key 的话 getCurrentActiveStore() 优先读的 canonical
// key 依然是那份跨专区脏数据，等于没清干净
export function clearSelectedStoreCache(): void {
  wx.removeStorageSync(STORE_STORAGE_KEY);
  wx.removeStorageSync('current_store_id');
  wx.removeStorageSync('current_store_name');
  wx.removeStorageSync('active_store_id');

  const app = getApp() as any;
  if (app && app.globalData) {
    delete app.globalData.selectedStore;
    delete app.globalData.currentStore;
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
    const res: any = await callFunctionWithTimeout({
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