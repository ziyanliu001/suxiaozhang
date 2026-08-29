/**
 * 个人打卡数据的门店隔离统计——从本地打卡流水 my_checkin_logs 按门店动态过滤汇总，
 * 取代"全局递增计数器，切店也不分家"的旧口径。index.ts/profile.ts/journey.ts
 * 现已统一改读本文件的计算结果，不再各自直接读 my_checkin_days 等全局递增计数器。
 *
 * 🛡️ 历史兼容：本次修复前写入的打卡记录只有 storeName，没有 storeId 字段；
 * 优先按 storeId 精确匹配，storeId 缺失（老记录）或未提供时退回按 storeName 匹配，
 * 避免这些历史数据在切到"按门店隔离"后直接从统计里消失。
 */

import { safeParseDate } from './dateUtils';

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

// includeAllStores：全国总览/未选定具体门店场景下汇总全部历史打卡，不按门店过滤——
// 与 computeMyCheckInStreak 共用同一套过滤口径，避免两个函数各写一份筛选逻辑后走偏
function scopeByStore(logs: CheckInLogEntry[], storeId: string, storeName: string, includeAllStores: boolean): CheckInLogEntry[] {
  if (includeAllStores) return logs;
  return logs.filter((l) => {
    if (storeId && l.storeId) return l.storeId === storeId;
    return !!storeName && l.storeName === storeName;
  });
}

export function computeMyCheckInStats(storeId: string, storeName: string, includeAllStores: boolean = false): CheckInStats {
  const scoped = scopeByStore(getMyCheckInLogs(), storeId, storeName, includeAllStores);

  const uniqueDays = new Set(scoped.map((l) => l.date));
  const hours = parseFloat(
    scoped.reduce((sum, l) => sum + (parseFloat(String(l.hours)) || 0), 0).toFixed(1)
  );

  return { days: uniqueDays.size, count: scoped.length, hours };
}

/**
 * 🐛 门店上下文漂移兜底：profile.ts 的 initMinePage() 在同一次页面停留内可能被
 * 触发不止一次（如 loadUserProfile 里 AuthService.fetchUserRole() 网络请求
 * 返回后，为修复"角色缓存刷新不生效"而无条件重跑一次 initMinePage），每次都
 * 各自重新解析一遍"当前门店"（getSelectedStore()/AuthService.getCachedRoleInfo()）。
 * 若两次解析出的门店不是同一个（多门店账号/角色缓存尚未完全稳定等场景），
 * 后一次调用会用一个跟"打卡时实际所在门店"对不上的门店去过滤本地流水，
 * 现算出 0，并把前一次算对的结果覆盖掉——即使打卡记录明明就在本地。
 *
 * 这里用"今天最新一条打卡记录自带的 storeId/storeName"作为兜底真源：按当前
 * 解析出的门店上下文算出来是 0，但本地流水里确实存在"今天"的记录时，改用
 * 那条记录自己落库时的门店重新算一次——打卡记录本身的门店归属永远是真的，
 * 不会因为后续页面重新解析上下文而"漂移"。
 */
export function computeMyCheckInStatsWithTodayFallback(storeId: string, storeName: string): CheckInStats {
  const primary = computeMyCheckInStats(storeId, storeName);
  if (primary.count > 0) return primary;

  const todayIso = new Date().toISOString().split('T')[0];
  const todayLog = getMyCheckInLogs().find((l) => l.date === todayIso);
  if (!todayLog) return primary;

  return computeMyCheckInStats(todayLog.storeId || '', todayLog.storeName || '');
}

/**
 * 连续护持天数（streak）：从最近一次打卡往前数，中间没有断档的连续自然日天数。
 * 语义与常见"连续打卡"一致——若最近一次打卡不是今天或昨天，视为已断档，返回 0，
 * 不保留断档前的旧连续记录（避免用户很久没来却还显示"连续 30 天"的误导）。
 * 🐛 日期解析统一走 safeParseDate，避免 iOS Safari/WKWebView 对 "YYYY-MM-DD"
 * 短横线字符串 new Date() 解析不稳定这个本项目已知坑（见该函数注释）。
 */
export function computeMyCheckInStreak(storeId: string, storeName: string, includeAllStores: boolean = false): number {
  const scoped = scopeByStore(getMyCheckInLogs(), storeId, storeName, includeAllStores);
  const uniqueDates = Array.from(new Set(scoped.map((l) => l.date))).filter(Boolean).sort();
  if (uniqueDates.length === 0) return 0;

  const now = new Date();
  const todayIso = now.toISOString().split('T')[0];
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayIso = yesterday.toISOString().split('T')[0];

  const latest = uniqueDates[uniqueDates.length - 1];
  if (latest !== todayIso && latest !== yesterdayIso) return 0;

  let streak = 1;
  for (let i = uniqueDates.length - 1; i > 0; i--) {
    const cur = safeParseDate(uniqueDates[i]);
    const prev = safeParseDate(uniqueDates[i - 1]);
    const diffDays = Math.round((cur.getTime() - prev.getTime()) / 86400000);
    if (diffDays === 1) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}
