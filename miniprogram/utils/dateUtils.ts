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

export {
  getTodayIsoString,
  getPrevDayIsoString,
  getNextDayIsoString,
  formatDateToCnShort,
  isValidIsoDate,
  compareIsoDates,
  safeParseDate
};
