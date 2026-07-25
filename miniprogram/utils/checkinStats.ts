/**
 * 个人打卡数据的门店隔离统计——从本地打卡流水 my_checkin_logs 按门店动态过滤汇总，
 * 取代"全局递增计数器，切店也不分家"的旧口径。
 *
 * 🛡️ 历史兼容：本次修复前写入的打卡记录只有 storeName，没有 storeId 字段；
 * 优先按 storeId 精确匹配，storeId 缺失（老记录）或未提供时退回按 storeName 匹配，
 * 避免这些历史数据在切到"按门店隔离"后直接从统计里消失。
 *
 * 🛡️ 全局计数器（my_checkin_days/my_checkin_count/my_service_hours）本身继续保留
 * 不动——journey.ts/statistics.ts 的个人看板仍在读这三个 key，本文件只新增
 * "按门店过滤"这一种新的读取方式，不影响其余页面的既有读取逻辑。
 */

export interface CheckInLogEntry {
  timestamp: number;
  date: string;
  storeId?: string;
  storeName?: string;
  hours: number;
  [key: string]: any;
}

export interface CheckInStats {
  days: number;
  count: number;
  hours: number;
}

const LOGS_KEY = 'my_checkin_logs';

export function getMyCheckInLogs(): CheckInLogEntry[] {
  try {
    return wx.getStorageSync(LOGS_KEY) || [];
  } catch (err) {
    console.warn('[checkinStats] 读取本地打卡流水失败:', err);
    return [];
  }
}

// includeAllStores：全国总览/未选定具体门店场景下汇总全部历史打卡，不按门店过滤
export function computeMyCheckInStats(storeId: string, storeName: string, includeAllStores: boolean = false): CheckInStats {
  const logs = getMyCheckInLogs();
  const scoped = includeAllStores
    ? logs
    : logs.filter((l) => {
      if (storeId && l.storeId) return l.storeId === storeId;
      return !!storeName && l.storeName === storeName;
    });

  const uniqueDays = new Set(scoped.map((l) => l.date));
  const hours = parseFloat(
    scoped.reduce((sum, l) => sum + (parseFloat(String(l.hours)) || 0), 0).toFixed(1)
  );

  return { days: uniqueDays.size, count: scoped.length, hours };
}
