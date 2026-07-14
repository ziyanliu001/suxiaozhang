// ─── 配置项 ───────────────────────────────────────────────
export interface RunwayConfig {
  warningThreshold: number;
  urgentThreshold: number;
  defaultDailyCost: number;
  emaWindow: number;
  minNetCostRelToExpense: number;
  outlierIqrFactor: number;
  minKeepRatio: number;
  trendRelThresholdPct: number;
  bootstrapSamples: number;
}

const DEFAULT_CONFIG: RunwayConfig = {
  warningThreshold: 15,
  urgentThreshold: 5,
  defaultDailyCost: 100,
  emaWindow: 7,
  minNetCostRelToExpense: 0.05,
  outlierIqrFactor: 1.5,
  minKeepRatio: 0.6,
  trendRelThresholdPct: 0.05,
  bootstrapSamples: 200
};

// ─── 输出结果 ─────────────────────────────────────────────
export interface RunwayResult {
  emaDailyCost: string;
  emaDailyExpense: string;
  emaDailyIncome: string;
  runwayDays: number;
  statusLevel: 'ample' | 'warning' | 'urgent';
  statusText: string;
  trendSlope: number;
  trendLabel: string;
  confidenceLower: number;
  confidenceUpper: number;
  dataQuality: 'high' | 'medium' | 'low';
  dataQualityText: string;
  isSmaFallback: boolean;
}

// ─── 工具函数 ─────────────────────────────────────────────

function getDailyExpense(item: any): number {
  return parseFloat(item.dailyExpenseTotal || item.dailyExpense || item.foodExpense || 0);
}

function getDailyIncome(item: any): number {
  const totalIncome = parseFloat(item.totalIncome || 0);
  const listDonation = parseFloat(item.listDonationTotal || 0);
  const otherDonation = parseFloat(item.otherDonation || 0);
  return totalIncome > 0 ? totalIncome : listDonation + otherDonation;
}

function getNetDailyCost(item: any): number {
  return getDailyExpense(item) - getDailyIncome(item);
}

/**
 * 线性插值法计算分位数
 */
function quantile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * 根据净值序列的 IQR 边界，返回保留的索引数组（日期对齐）
 */
function getKeepIndicesByNetIQR(
  records: { net: number; exp: number; inc: number }[],
  factor: number
): number[] {
  const values = records.map(r => r.net);
  if (values.length < 4) return values.map((_, i) => i);

  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lower = q1 - factor * iqr;
  const upper = q3 + factor * iqr;

  return values
    .map((v, i) => (v >= lower && v <= upper ? i : -1))
    .filter(i => i >= 0);
}

function sma(values: number[], n: number): number {
  const slice = values.slice(0, Math.min(n, values.length));
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function ema(values: number[], window: number): number {
  if (values.length === 0) return 0;
  const alpha = 2 / (window + 1);
  let result = sma(values, window);
  const startIndex = Math.min(window, values.length);
  for (let i = startIndex; i < values.length; i++) {
    result = alpha * values[i] + (1 - alpha) * result;
  }
  return result;
}

function linearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

/**
 * 轻量 EMA 平滑（用于趋势分析前的去噪）
 */
function smoothEma(values: number[], window: number): number[] {
  if (values.length <= 2) return values;
  const alpha = 2 / (window + 1);
  const result = [values[0], values[1]];
  for (let i = 2; i < values.length; i++) {
    result.push(alpha * values[i] + (1 - alpha) * result[result.length - 1]);
  }
  return result;
}

/**
 * Bootstrap 法计算余额续航天数的置信区间
 */
function bootstrapRunwayCI(
  netCosts: number[],
  balance: number,
  samples: number,
  minCost: number
): { lower: number; upper: number } {
  if (netCosts.length < 2 || balance <= 0) return { lower: 0, upper: 0 };

  const bootstrapMeans: number[] = [];
  const n = netCosts.length;

  for (let s = 0; s < samples; s++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const randIdx = Math.floor(Math.random() * n);
      sum += netCosts[randIdx];
    }
    const mean = sum / n;
    if (mean > 0) {
      bootstrapMeans.push(Math.floor(balance / Math.max(mean, minCost)));
    } else {
      bootstrapMeans.push(999);
    }
  }

  const sorted = bootstrapMeans.sort((a, b) => a - b);
  const lowerIdx = Math.floor(sorted.length * 0.025);
  const upperIdx = Math.floor(sorted.length * 0.975);

  return {
    lower: sorted[lowerIdx] || 0,
    upper: Math.min(sorted[upperIdx] || 999, 999)
  };
}

/**
 * 评估数据质量
 */
function assessDataQuality(totalCount: number, keepCount: number, keepRatio: number, isSma: boolean): {
  level: 'high' | 'medium' | 'low';
  text: string;
} {
  if (totalCount < 7 || keepRatio < 0.5 || isSma) {
    return { level: 'low', text: '数据量不足，仅供参考' };
  }
  if (totalCount < 14 || keepRatio < 0.7) {
    return { level: 'medium', text: '数据有限，参考谨慎' };
  }
  return { level: 'high', text: '数据充足，可信度高' };
}

// ─── 主函数 ───────────────────────────────────────────────

export function calculateEmaRunway(
  historyList: any[] = [],
  currentBalance: number = 0,
  config: Partial<RunwayConfig> = {}
): RunwayResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const balance = parseFloat(String(currentBalance)) || 0;

  // 余额非正直接返回告急
  if (balance <= 0) {
    return {
      emaDailyCost: '0.00',
      emaDailyExpense: '0.00',
      emaDailyIncome: '0.00',
      runwayDays: 0,
      statusLevel: 'urgent',
      statusText: '🔴 告急：账户余额已不足',
      trendSlope: 0,
      trendLabel: '持平',
      confidenceLower: 0,
      confidenceUpper: 0,
      dataQuality: 'low',
      dataQualityText: '暂无数据',
      isSmaFallback: false
    };
  }

  // 筛选 + 按日期升序排序
  const validRecords = historyList
    .filter((item: any) => getDailyExpense(item) > 0 || getDailyIncome(item) > 0)
    .sort((a: any, b: any) => (a.dateString || '').localeCompare(b.dateString || ''));

  const totalCount = validRecords.length;

  if (totalCount === 0) {
    const days = Math.floor(balance / cfg.defaultDailyCost);
    const level = days >= cfg.warningThreshold ? 'ample' : days >= cfg.urgentThreshold ? 'warning' : 'urgent';
    return {
      emaDailyCost: cfg.defaultDailyCost.toFixed(2),
      emaDailyExpense: cfg.defaultDailyCost.toFixed(2),
      emaDailyIncome: '0.00',
      runwayDays: days,
      statusLevel: level,
      statusText: level === 'ample'
        ? `🟢 资金充沛 (约可开餐 ${days} 天)`
        : level === 'warning'
        ? `🟡 预警：资金仅够开餐 ${days} 天`
        : `🔴 告急：资金不足 ${days} 天开餐`,
      trendSlope: 0,
      trendLabel: '持平',
      confidenceLower: 0,
      confidenceUpper: 0,
      dataQuality: 'low',
      dataQualityText: '暂无历史数据，按默认估算',
      isSmaFallback: false
    };
  }

  // 构建三元组
  const triplets = validRecords.map(item => ({
    exp: getDailyExpense(item),
    inc: getDailyIncome(item),
    net: getNetDailyCost(item)
  }));

  // IQR 异常值剔除（以净值为基准，日期对齐）
  const keepIdx = getKeepIndicesByNetIQR(triplets, cfg.outlierIqrFactor);
  const keepRatio = keepIdx.length / triplets.length;

  let cleanedNets: number[];
  let cleanedExps: number[];
  let cleanedIncs: number[];
  let isSmaFallback = false;

  if (keepRatio < cfg.minKeepRatio) {
    // 保留率过低，降级使用全部数据 + SMA，避免 IQR 过度剔除
    cleanedNets = triplets.map(t => t.net);
    cleanedExps = triplets.map(t => t.exp);
    cleanedIncs = triplets.map(t => t.inc);
    isSmaFallback = true;
  } else {
    cleanedNets = keepIdx.map(i => triplets[i].net);
    cleanedExps = keepIdx.map(i => triplets[i].exp);
    cleanedIncs = keepIdx.map(i => triplets[i].inc);
  }

  // 计算 EMA（降级模式用 SMA）
  let emaExpense: number;
  let emaIncome: number;
  if (isSmaFallback) {
    emaExpense = cleanedExps.reduce((a, b) => a + b, 0) / cleanedExps.length;
    emaIncome = cleanedIncs.reduce((a, b) => a + b, 0) / cleanedIncs.length;
  } else {
    emaExpense = ema(cleanedExps, cfg.emaWindow);
    emaIncome = ema(cleanedIncs, cfg.emaWindow);
  }
  const rawNetDailyCost = emaExpense - emaIncome;

  // 计算相对下限（日均支出的 5%）
  const minNetDailyCost = Math.max(emaExpense * cfg.minNetCostRelToExpense, 10);

  // 趋势分析（最近14天，EMA 轻量平滑后再回归，减少噪声）
  const recentNets = cleanedNets.slice(-14);
  const smoothedNets = smoothEma(recentNets, 3);
  const trendSlope = linearSlope(smoothedNets);

  const avgRecentNet = recentNets.reduce((a, b) => a + b, 0) / Math.max(recentNets.length, 1);
  const relThreshold = Math.abs(avgRecentNet) * cfg.trendRelThresholdPct;
  let trendLabel: string;
  if (Math.abs(trendSlope) < Math.max(relThreshold, 1)) {
    trendLabel = '持平';
  } else if (trendSlope > 0) {
    trendLabel = '消耗上升趋势';
  } else {
    trendLabel = '消耗下降趋势';
  }

  // 续航天数
  let netDailyCost: number;
  let runwayDays: number;
  if (rawNetDailyCost <= 0) {
    netDailyCost = 0;
    runwayDays = 999;
  } else {
    netDailyCost = Math.max(rawNetDailyCost, minNetDailyCost);
    runwayDays = Math.floor(balance / netDailyCost);
  }

  // Bootstrap 置信区间
  const bootstrapCI = bootstrapRunwayCI(cleanedNets, balance, cfg.bootstrapSamples, minNetDailyCost);

  // 数据质量评估
  const quality = assessDataQuality(totalCount, keepIdx.length, keepRatio, isSmaFallback);

  // 状态分级
  let statusLevel: 'ample' | 'warning' | 'urgent';
  let statusText: string;
  if (runwayDays >= 999) {
    statusLevel = 'ample';
    statusText = '🟢 资金充裕，持续开餐';
  } else if (runwayDays >= cfg.warningThreshold) {
    statusLevel = 'ample';
    statusText = `🟢 资金充沛 (约可开餐 ${runwayDays} 天)`;
  } else if (runwayDays >= cfg.urgentThreshold) {
    statusLevel = 'warning';
    statusText = `🟡 预警：资金仅够开餐 ${runwayDays} 天`;
  } else {
    statusLevel = 'urgent';
    statusText = `🔴 告急：资金不足 ${runwayDays} 天开餐`;
  }

  return {
    emaDailyCost: netDailyCost.toFixed(2),
    emaDailyExpense: emaExpense.toFixed(2),
    emaDailyIncome: emaIncome.toFixed(2),
    runwayDays,
    statusLevel,
    statusText,
    trendSlope: Math.round(trendSlope * 100) / 100,
    trendLabel,
    confidenceLower: bootstrapCI.lower,
    confidenceUpper: bootstrapCI.upper,
    dataQuality: quality.level,
    dataQualityText: quality.text,
    isSmaFallback
  };
}
