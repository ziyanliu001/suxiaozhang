// 🌸 云端打卡状态自愈：与 utils/offlineQueue.ts（离线账目汇报队列）同一套
// get/save/remove/count API 形状，专门缓存"到岗服务打卡时网络抖动/超时导致
// 云端 manageVolunteerCheckIn 未拿到 cloudLogId"的记录，供 onShow()/网络恢复
// 时静默重试，见 pages/index/index.ts 的 resyncPendingMeritCheckins()。
//
// updateMeritTags() 是本模块相对 offlineQueue.ts 多出的一个方法——这个队列的
// 条目在入队之后还可能被继续修改（用户在标签弹窗里选了标签，需要补挂到已经
// 入队的那条待补录记录上），不是纯粹"写入后只会整条删除"的一次性队列。
export interface PendingMeritCheckinItem {
  id: string;
  timestamp: number;
  // 对应 my_checkin_logs 里那条本地记录的 timestamp，补到 logId 后据此回填
  localLogTimestamp: number;
  storeId: string;
  storeName: string;
  shiftKey: string;
  shiftName: string;
  shiftType: string;
  hours: number;
  willEatLunch: boolean;
  reservedMeals: string[];
  // 初始为空字符串；resync 补打卡成功后落到这里（仅用于排查，队列条目成功后即移除）
  cloudLogId: string;
  // 初始为空数组；用户在标签弹窗里选了才会通过 updateMeritTags() 补进来
  meritTags: string[];
}

const STORAGE_KEY = 'PENDING_MERIT_CHECKINS';

export function getQueue(): PendingMeritCheckinItem[] {
  try {
    const data = wx.getStorageSync(STORAGE_KEY);
    if (data && Array.isArray(data)) {
      return data;
    }
  } catch (error) {
    console.error('[pendingMeritCheckinQueue] getQueue error:', error);
  }
  return [];
}

export function saveToQueue(item: Omit<PendingMeritCheckinItem, 'id' | 'timestamp'>): PendingMeritCheckinItem {
  const queue = getQueue();
  const newItem: PendingMeritCheckinItem = {
    ...item,
    id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    timestamp: Date.now()
  };
  queue.push(newItem);
  try {
    wx.setStorageSync(STORAGE_KEY, queue);
  } catch (error) {
    console.error('[pendingMeritCheckinQueue] saveToQueue error:', error);
  }
  return newItem;
}

export function removeFromQueue(id: string): void {
  const queue = getQueue();
  const newQueue = queue.filter(item => item.id !== id);
  try {
    wx.setStorageSync(STORAGE_KEY, newQueue);
  } catch (error) {
    console.error('[pendingMeritCheckinQueue] removeFromQueue error:', error);
  }
}

export function getQueueCount(): number {
  return getQueue().length;
}

// 把标签补挂到已经入队的那条待补录记录上——用户可能是在打卡云同步失败之后才
// 打开标签弹窗选的标签，这时队列条目已经存在（meritTags 为空数组），需要就地更新
// 而不是新建一条；找不到对应 id 时静默忽略（队列条目可能已经被上一轮 resync 处理掉）
export function updateMeritTags(id: string, meritTags: string[]): void {
  const queue = getQueue();
  const idx = queue.findIndex(item => item.id === id);
  if (idx === -1) return;
  queue[idx] = { ...queue[idx], meritTags };
  try {
    wx.setStorageSync(STORAGE_KEY, queue);
  } catch (error) {
    console.error('[pendingMeritCheckinQueue] updateMeritTags error:', error);
  }
}
