import { callFunctionWithTimeout } from './withTimeout';
const STORE_STORAGE_KEY = 'selectedStore';

export interface StoreInfo {
  storeId: string;
  storeName: string;
  role?: 'MANAGER' | 'FINANCE' | 'VOLUNTEER';
}

// 🐛 根因修复（全局兜底收敛，2026-09-09）：getSelectedStore() 此前无条件优先
// 读 app.globalData.currentStore——但 setCurrentActiveStore() 不传 role 时
// （"只更新门店信息，不动当前生效身份"这一既定设计，见该函数注释）只会同步
// app.globalData.selectedStore，不会触达 currentStore（见 setSelectedStore()
// 内部 `if (storeInfo.role)` 判断）。这意味着任何一次"只切门店、不切角色"的
// canonical 写入之后，只要 app.globalData.currentStore 还残留着更早之前某次
// 带 role 的旧写入，getSelectedStore() 就会一直返回那份陈旧数据——这正是
// "组织信息配置在首页切店后误报跨机构"的系统性根因，全仓库 30+ 处调用点
// 都共享同一个风险面，不是某一处业务代码各自的失误。
// 修复：canonical Storage key（setCurrentActiveStore() 唯一写入口）优先；
// 只有 current_store_id/current_store_name 这两个 key 都有值时才直接采信，
// 确保只要发生过一次完整的 canonical 切店，所有调用方立刻看到最新门店，
// 不必再逐个排查/改造调用点。两者有一个为空（罕见中间态，见
// getCurrentActiveStore() 同一处注释）时退回原有的 legacy 链路，向后兼容——
// 全仓库没有任何调用点读取本函数返回值的 role 字段（已逐一核对），下面的
// 'VOLUNTEER' 占位值与原有行为一致，不影响任何实际逻辑
export function getSelectedStore(): StoreInfo {
  const canonicalStoreId = wx.getStorageSync('current_store_id') || wx.getStorageSync('active_store_id') || '';
  const canonicalStoreName = wx.getStorageSync('current_store_name') || '';
  if (canonicalStoreId && canonicalStoreName) {
    return { storeId: canonicalStoreId, storeName: canonicalStoreName, role: 'VOLUNTEER' };
  }

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

  return { storeId: canonicalStoreId, storeName: '', role: 'VOLUNTEER' };
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

  // 🔍（2026-09-13 排查记录）全国总览入口闪烁复现追查：怀疑 activeStoreId
  // 在 initCurrentUserRole() 的 cached 分支与网络分支之间被某处代码悄悄改写，
  // 导致同一份 authorizedTenants 在两次 resolveActiveRoleGrant 匹配里得到
  // 不同结果。本函数是 current_store_id/active_store_id 这两个 canonical
  // storage key 唯一的写入口——先在这里打点，配合 authService.ts
  // resolveEffectiveRole() 里的打点，对照时间线就能确认闪烁瞬间是不是恰好
  // 有一次 setCurrentActiveStore() 调用改写了活跃门店。诊断用，不改变行为
  console.log('[StoreManager][flicker-debug] setCurrentActiveStore 写入:', JSON.stringify({ storeId, storeName, role: role || '(未传，不改角色)' }));

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
    // 🐛 根因修复（首页顶部站点胶囊显示"请选择站点"，但同一时刻其余模块已能
    // 正常拉到该店数据）：canonical 的 current_store_id 与 current_store_name
    // 理论上应该总是配对写入（见 setCurrentActiveStore()），但历史上存在直接
    // wx.setStorageSync('current_store_id', ...) 单独写 storeId、没有同步写
    // storeName 的旁路（如页面自己的 onStoreChange 事件处理，见各页面同名
    // 方法），一旦这类旁路先于 current_store_name 落地，就会出现"storeId 有效
    // 但 storeName 是空字符串"的中间态——用它的调用方（如 store-picker.ts
    // loadStoreInfo()）会误判成"未选择站点"。这里只在 storeName 恰好为空时
    // 退回 legacy 的 selectedStore key（getSelectedStore()，setCurrentActiveStore
    // 内部本就同步写这份 legacy 数据，见该函数尾部注释）找一个更可能有效的
    // 名字，storeId 本身仍以 canonical 值为准，不受 legacy 影响
    if (!storeName) {
      const legacyName = getSelectedStore().storeName || '';
      if (legacyName) {
        return { storeId, storeName: legacyName };
      }
    }
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

// 🌸 雨花/通用两个专区共用的门店店名关键词——两处（雨花专区兜底纳入 +
// 通用专区兜底剔除）必须用同一份判定口径，抽成常量避免两处拷贝各自维护、
// 未来改关键词漏改一处（如同时想覆盖"雨花斋"以外的别名）
const YUHUA_NAME_KEYWORD = '雨花';

// getStoreList 调用 + 超时重试一次（与 index.ts fetchAllStoresList 原有的
// "冷启动兜底"策略保持一致）+ 返回值数组防御性校验，index.ts / store-picker.ts
// 两个调用方共用同一份实现，避免各自维护一份、行为逐渐漂移
async function callGetStoreListResilient(data: Record<string, unknown>): Promise<any[]> {
  try {
    let res;
    try {
      res = await callFunctionWithTimeout({ name: 'getStoreList', data });
    } catch (timeoutErr) {
      res = await callFunctionWithTimeout({ name: 'getStoreList', data });
    }
    const result = res.result as any;
    const rawList = (result && result.success) ? result.list : null;
    return Array.isArray(rawList) ? rawList : [];
  } catch (err) {
    console.warn('[storeManager] getStoreList 调用失败:', data, err);
    return [];
  }
}

// 🐛 归属修复（"厦门海沧三源弘雨花斋"归属修复后，"漳州白礁保生雨花斋"反而
// 从雨花专区消失）：此前雨花专区是【顺序 await】两次 getStoreList——先按
// orgType 精确查询，成功后再发一次不带 orgType 的全量查询做店名兜底。两次
// 调用首尾相接，总耗时接近翻倍；而本仓库其余多处调用点的注释早已反复确认
// 云函数冷启动时单次调用就可能逼近 8s 超时阈值。第一次（orgType 精确查询）
// 那时候还没有重试兜底，一旦在总耗时被拉长后偶然超时失败，就会静默退化成
// 空列表，只剩第二次（全量查询按店名兜底）能找到的门店——于是出现"这次两家
// 店都在，下次却只剩靠店名兜底那一家"这种看似矛盾、实为超时竞态的间歇性
// 丢店现象。改为并行发起查询（互不阻塞、总耗时不再翻倍），且都套上与
// index.ts 原有逻辑一致的"超时重试一次"，最后按 storeId 去重合并——任一路
// 暂时失败都不会拖累另一路，多路都命中同一家店时以先出现的为准
//
// 🐛（2026-09-11 二次排查）真机复测确认"漳州白礁保生雨花斋"仍然缺席，说明
// 只并行两路还不够——前两路（`orgType:'yuhuazhai'` 精确查询 + 不带 orgType
// 的全量查询）都严格按调用者自己的 tenantId 过滤，只有本机构名下 orgType 命中
// 才会走 getStoreList 内置的"自动降级跨机构发现"（且只在本机构名下这个
// orgType 一条匹配都没有时才触发，见该云函数注释）——如果调用者所属机构下
// 已经有其它 yuhuazhai 门店（如三源弘本就在同一机构），这条自动降级永远不会
// 触发，白礁这类挂在【另一个机构】下的雨花斋门店就无论如何都查不到，跟它的
// orgType/店名是否打得准确无关。新增第三路显式 `crossTenant:true` +
// `orgType:'yuhuazhai'`——直接命中 handleDiscoverByOrgType，按 orgType 条件
// 做不区分机构的全局查询（该云函数已有能力，本次只是主动调用，不是新增查询
// 权限面），能补上"两家雨花斋标杆店分属不同机构"这种此前两路都覆盖不到的
// 缺口。三路结果一并按 storeId 去重合并
//
// includeInactive 透传给 getStoreList（默认只返回 status==='active' 的门店）——
// 首页 store-picker/工作台走默认值即可，门店管理页需要连"已停用"门店一起看
// 才能重新启用，见 store-management.ts loadStoreList() 调用点
export async function fetchYuhuaZoneStoreList(opts?: { includeInactive?: boolean }): Promise<any[]> {
  const extra = opts?.includeInactive ? { includeInactive: true } : {};
  const [primaryList, ownTenantList, globalDiscoverList] = await Promise.all([
    callGetStoreListResilient({ orgType: 'yuhuazhai', ...extra }),
    callGetStoreListResilient({ ...extra }),
    callGetStoreListResilient({ orgType: 'yuhuazhai', crossTenant: true, ...extra })
  ]);

  const merged = new Map<string, any>();
  primaryList.forEach((s: any) => { if (s && s.storeId) merged.set(s.storeId, s); });
  globalDiscoverList.forEach((s: any) => { if (s && s.storeId && !merged.has(s.storeId)) merged.set(s.storeId, s); });
  ownTenantList
    .filter((s: any) => s && (s.storeName || '').includes(YUHUA_NAME_KEYWORD))
    .forEach((s: any) => { if (s.storeId && !merged.has(s.storeId)) merged.set(s.storeId, s); });

  // 🐛（2026-09-11）雨花斋两家标杆店（漳州白礁保生雨花斋 / 厦门海沧三源弘
  // 雨花斋）历史上曾出现过 tenantId/orgType 数据不一致导致互相看不见对方的
  // 问题，即便上面三路查询都已经尽力覆盖，仍可能因为某条记录既不在调用者
  // 本机构下、orgType 又没打对而一路都查不到（三路查询的公共前提是"tenantId
  // 匹配"或"orgType 匹配"，两个都不满足时无解）。这里做最后一道静态兜底：
  // 名单里的店只要没有出现在上面任何一路结果中，就直接合成一张最小可用卡片
  // （仅 storeId/storeName，其余字段留空/默认值），保证用户至少能看到、点选
  // 切换过去——province/city/经纬度这类展示字段会缺失，选中后各业务页面按
  // storeId 现查真实数据，不受影响。⚠️ 这是应急保底，不是长久修复：一旦确认
  // 两家店的 tenantId/orgType 数据已经清洗一致（能被上面任一路真实查询命中），
  // 应该把这份名单删掉，不要让"假装查到了"的静态数据长期掩盖底层数据问题
  YUHUA_LANDMARK_STORE_FALLBACK.forEach((landmark) => {
    if (!merged.has(landmark.storeId)) {
      console.warn('[storeManager] 雨花斋标杆店查询三路均未命中，启用静态兜底展示:', landmark);
      merged.set(landmark.storeId, {
        storeId: landmark.storeId,
        storeName: landmark.storeName,
        status: 'active',
        operatingStatus: 'operating',
        province: '',
        city: '',
        isOwnTenant: false
      });
    }
  });

  console.log('[storeManager] fetchYuhuaZoneStoreList 三路查询结果:', {
    primary: primaryList.map((s: any) => s && s.storeName),
    ownTenantYuhuaMatch: ownTenantList.filter((s: any) => s && (s.storeName || '').includes(YUHUA_NAME_KEYWORD)).map((s: any) => s.storeName),
    globalDiscover: globalDiscoverList.map((s: any) => s && s.storeName),
    finalMerged: Array.from(merged.values()).map((s: any) => s.storeName)
  });

  return Array.from(merged.values());
}

// ⚠️（2026-09-11 应急保底，见上方 fetchYuhuaZoneStoreList 内详细注释）雨花斋
// 两家标杆店的 storeId 硬编码名单——只在三路真实查询都没找到时才会用到。
// 未来一旦通过一次性数据迁移把这两家店的 tenantId/orgType 统一清洗干净、
// 确认能被真实查询命中（可观察上面 console.warn 是否还会触发），这份名单
// 应当整体删除，不要长期维护一份可能与真实店名/停用状态脱节的静态数据
const YUHUA_LANDMARK_STORE_FALLBACK: Array<{ storeId: string; storeName: string }> = [
  { storeId: '8e9ed36b6a77084506c0fe6c659304f9', storeName: '厦门海沧三源弘雨花斋' },
  { storeId: '9367f7326a5d859f00d843c2405ac499', storeName: '漳州白礁保生雨花斋' }
];

// 🐛 专区隔离修复：社区普惠与社会互助专区（通用记账）严禁出现店名含"雨花"
// 字样的门店——即便某条历史门店的 orgType 字段缺失/打错导致服务端过滤条件
// 意外放行，这里在展示层再兜底剔除一次，确保"雨花斋门店只能出现在雨花专区"
// 这条业务归属边界不会因为脏数据在两个专区各出现一次，造成用户混淆
export async function fetchCommunityZoneStoreList(opts?: { includeInactive?: boolean }): Promise<any[]> {
  const extra = opts?.includeInactive ? { includeInactive: true } : {};
  const list = await callGetStoreListResilient({ orgType: 'general', ...extra });
  return list.filter((s: any) => !(s && (s.storeName || '').includes(YUHUA_NAME_KEYWORD)));
}
