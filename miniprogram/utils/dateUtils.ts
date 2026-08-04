function getTodayIsoString(): string {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getPrevDayIsoString(isoDateStr: string): string {
  if (!isoDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(isoDateStr)) {
    return getTodayIsoString();
  }

  const parts = isoDateStr.split('-');
  let y = parseInt(parts[0], 10);
  let m = parseInt(parts[1], 10);
  let d = parseInt(parts[2], 10);

  d -= 1;
  if (d === 0) {
    m -= 1;
    if (m === 0) {
      y -= 1;
      m = 12;
    }
    d = new Date(y, m, 0).getDate();
  }

  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function getNextDayIsoString(isoDateStr: string): string {
  if (!isoDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(isoDateStr)) {
    return getTodayIsoString();
  }

  const parts = isoDateStr.split('-');
  let y = parseInt(parts[0], 10);
  let m = parseInt(parts[1], 10);
  let d = parseInt(parts[2], 10);

  const daysInMonth = new Date(y, m, 0).getDate();
  d += 1;
  if (d > daysInMonth) {
    d = 1;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }

  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function formatDateToCnShort(isoDateStr: string): string {
  if (!isoDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(isoDateStr)) {
    return '';
  }
  const parts = isoDateStr.split('-');
  return `${parseInt(parts[1], 10)}月${parseInt(parts[2], 10)}日`;
}

function isValidIsoDate(str: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

function compareIsoDates(a: string, b: string): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return a.localeCompare(b);
}

/**
 * 🐛 修复 "NaN年NaN月" Bug：iOS Safari/WKWebView 对 "YYYY-MM-DD" 短横线日期字符串的
 * new Date() 解析不稳定（常返回 Invalid Date），统一替换为斜杠格式后再解析可兼容全平台。
 * 优先使用 dateStr（如打卡记录的 log.date），仅当其缺失/无法解析时才回退到数值时间戳，
 * 两者都失败时兜底返回当前时间，确保调用方永远拿到一个合法 Date，不会渲染出 NaN。
 */
function safeParseDate(dateStr?: string | null, fallbackTimestamp?: number): Date {
  if (dateStr && typeof dateStr === 'string') {
    const normalized = new Date(dateStr.replace(/-/g, '/'));
    if (!isNaN(normalized.getTime())) {
      return normalized;
    }
  }

  if (typeof fallbackTimestamp === 'number' && isFinite(fallbackTimestamp)) {
    const fromTimestamp = new Date(fallbackTimestamp);
    if (!isNaN(fromTimestamp.getTime())) {
      return fromTimestamp;
    }
  }

  return new Date();
}

/**
 * 相对时间展示："刚刚" / "N分钟前" / "N小时前"（当天内）/ "昨天 HH:mm" /
 * "M月D日"（同年）/ "YYYY年M月D日"（跨年）。用于通知页消息卡片的时间标签。
 * input 支持 Date / 毫秒时间戳 / 日期字符串（字符串走 safeParseDate 兼容 iOS 解析）。
 */
function formatRelativeTime(input?: Date | number | string | null): string {
  if (!input && input !== 0) return '';

  const target = input instanceof Date
    ? input
    : (typeof input === 'number' ? new Date(input) : safeParseDate(input));

  const targetMs = target.getTime();
  if (isNaN(targetMs)) return '';

  const now = new Date();
  const diffMs = now.getTime() - targetMs;

  // 未来时间（时钟偏差等异常情况）不显示负数"前"，直接按日期兜底展示
  if (diffMs >= 0) {
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin}分钟前`;

    const isSameDay = target.getFullYear() === now.getFullYear()
      && target.getMonth() === now.getMonth()
      && target.getDate() === now.getDate();
    if (isSameDay) return `${Math.floor(diffMin / 60)}小时前`;
  }

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const isYesterday = target.getFullYear() === yesterday.getFullYear()
    && target.getMonth() === yesterday.getMonth()
    && target.getDate() === yesterday.getDate();
  if (isYesterday) {
    const hh = String(target.getHours()).padStart(2, '0');
    const mm = String(target.getMinutes()).padStart(2, '0');
    return `昨天 ${hh}:${mm}`;
  }

  const isSameYear = target.getFullYear() === now.getFullYear();
  if (isSameYear) return `${target.getMonth() + 1}月${target.getDate()}日`;
  return `${target.getFullYear()}年${target.getMonth() + 1}月${target.getDate()}日`;
}

export {
  getTodayIsoString,
  getPrevDayIsoString,
  getNextDayIsoString,
  formatDateToCnShort,
  isValidIsoDate,
  compareIsoDates,
  safeParseDate,
  formatRelativeTime
};
