/**
 * 智能风控熔断与三维异常拦截系统
 * 
 * 三维校验：
 * 1. 数据维度：余额、收入、支出、人数、工时等数值合理性
 * 2. 时间维度：日期间隔、提交频率、历史趋势对比
 * 3. 业务维度：逻辑冲突、数据突变、人均异常
 */

export interface GuardrailResult {
  canSubmit: boolean;
  hasWarning: boolean;
  blockReason: string;
  warningMessage: string;
  gapDaysNotice: string;
  warnings: string[];
  auditLog: AuditLogEntry[];
}

export interface GuardrailFormData {
  yesterdayBalance?: number;
  todayBalance?: number;
  income?: number;
  foodExpense?: number;
  dailyExpense?: number;
  diners?: number;
  totalDiners?: number;
  volunteerCount?: number;
  volunteerHours?: number;
  reportDate: string;
}

export interface GuardrailHistoryStats {
  avgDailyFoodExpense?: number;
  avgDailyIncome?: number;
  avgDailyDiners?: number;
  avgBalance?: number;
  lastReportDate?: string;
  lastBalance?: number;
  lastSubmitTime?: number;
}

export interface AuditLogEntry {
  rule: string;
  level: 'block' | 'warning' | 'info';
  value: any;
  threshold?: any;
  timestamp: number;
}

export interface FrequencyRecord {
  count: number;
  firstSubmitTime: number;
  lastSubmitTime: number;
  dailyCount: number;
  dailyDate: string;
}

// ─── 配置常量 ─────────────────────────────────────────────

const CONFIG = {
  // 余额校验
  MIN_BALANCE: 0,
  MAX_BALANCE_JUMP_ABS: 50000,      // 单日余额跳变上限（绝对值）
  MAX_BALANCE_JUMP_RATIO: 5,         // 单日余额跳变上限（倍数）

  // 收入校验
  MIN_INCOME: 0,
  MAX_INCOME_PER_DAY: 100000,        // 单日收入上限
  MAX_INCOME_PER_DINER: 200,         // 单人单日收入上限

  // 支出校验
  MIN_EXPENSE: 0,
  MAX_EXPENSE_RATIO: 10,             // 支出超过平均值的倍数预警

  // 人均校验
  MIN_EXPENSE_PER_DINER: 0.5,        // 最低人均支出（元）
  MAX_EXPENSE_PER_DINER: 500,        // 最高人均支出（元）
  MAX_INCOME_PER_DINER_CHECK: 1000,  // 人均收入预警线

  // 用餐人数
  MIN_DINERS: 0,
  MAX_DINERS: 1000,

  // 义工
  MIN_VOLUNTEER_COUNT: 0,
  MAX_VOLUNTEER_COUNT: 200,
  MIN_VOLUNTEER_HOURS: 0,
  MAX_VOLUNTEER_HOURS_PER_PERSON: 12, // 单人单日最大工时

  // 提交频率
  SUBMIT_COOLDOWN_MS: 3000,           // 两次提交间隔（毫秒）
  MAX_SUBMIT_PER_HOUR: 10,            // 每小时最大提交次数
  MAX_SUBMIT_PER_DAY: 50,             // 每天最大提交次数

  // 日期校验
  MAX_FUTURE_DAYS: 0,                 // 不允许未来日期
  MAX_PAST_DAYS: 365,                 // 最早允许1年前

  // 余额恒等式容差（元）
  BALANCE_EQUATION_TOLERANCE: 1.00,

  // 默认基准值
  DEFAULT_AVG_EXPENSE: 300,
  DEFAULT_AVG_INCOME: 200,
  DEFAULT_AVG_DINERS: 30,

  // 警告确认记录
  MAX_WARNING_PER_DAY: 3,             // 每天最大警告确认次数
};

// ─── 工具函数 ─────────────────────────────────────────────

function formatCurrency(value: number): string {
  return '¥' + sanitizeNumber(value).toFixed(2);
}

/**
 * 数值清洗：将 NaN / Infinity / null / undefined 统一归零
 */
function sanitizeNumber(val: any): number {
  const n = typeof val === 'number' ? val : parseFloat(val);
  if (isNaN(n) || !isFinite(n)) return 0;
  return n;
}

/**
 * 两位浮点精度修正（消除 0.1+0.2=0.30000000000000004 问题）
 */
function round2(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

function addAuditLog(logs: AuditLogEntry[], rule: string, level: 'block' | 'warning' | 'info', value: any, threshold?: any): void {
  logs.push({
    rule,
    level,
    value,
    threshold,
    timestamp: Date.now()
  });
}

/**
 * 获取本地日期字符串（YYYY-MM-DD），使用本地时区而非 UTC
 */
function getLocalDateString(date?: Date): string {
  const d = date || new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return yyyy + '-' + mm + '-' + dd;
}

/**
 * 获取本地存储的警告确认记录
 */
function getWarningConfirmCount(): number {
  try {
    const today = getLocalDateString();
    const record = wx.getStorageSync('warning_confirm_' + today);
    return record ? parseInt(record, 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * 记录警告确认次数
 */
function recordWarningConfirm(): void {
  try {
    const today = getLocalDateString();
    const current = getWarningConfirmCount();
    wx.setStorageSync('warning_confirm_' + today, current + 1);
  } catch {}
}

/**
 * 获取提交频率记录
 */
function getFrequencyRecord(): FrequencyRecord {
  try {
    const record = wx.getStorageSync('submit_frequency');
    if (record) {
      const parsed = JSON.parse(record);
      return {
        count: parsed.count || 0,
        firstSubmitTime: parsed.firstSubmitTime || 0,
        lastSubmitTime: parsed.lastSubmitTime || 0,
        dailyCount: parsed.dailyCount || 0,
        dailyDate: parsed.dailyDate || ''
      } as FrequencyRecord;
    }
  } catch {}
  return { count: 0, firstSubmitTime: 0, lastSubmitTime: 0, dailyCount: 0, dailyDate: '' };
}

/**
 * 记录提交
 */
function recordSubmit(): void {
  try {
    const now = Date.now();
    const record = getFrequencyRecord();
    const today = getLocalDateString();
    const isSameDay = record.dailyDate === today;

    // 如果距离首次提交超过1小时，重置小时计数
    const resetHour = now - record.firstSubmitTime > 3600000;

    wx.setStorageSync('submit_frequency', JSON.stringify({
      count: resetHour ? 1 : record.count + 1,
      firstSubmitTime: resetHour ? now : record.firstSubmitTime,
      lastSubmitTime: now,
      dailyCount: isSameDay ? record.dailyCount + 1 : 1,
      dailyDate: today
    }));
  } catch {}
}

/**
 * 持久化审计日志到本地存储（最近100条）
 */
function persistAuditLog(logs: AuditLogEntry[]): void {
  try {
    const key = 'guardrail_audit_log';
    const existing = wx.getStorageSync(key);
    const all = existing ? JSON.parse(existing) : [];
    all.push(...logs);
    // 仅保留最近100条
    const trimmed = all.length > 100 ? all.slice(-100) : all;
    wx.setStorageSync(key, JSON.stringify(trimmed));
  } catch {}
}

// ─── 主校验函数 ───────────────────────────────────────────

export function validateReportGuardrails(
  formData: GuardrailFormData,
  storeHistoryStats: GuardrailHistoryStats = {}
): GuardrailResult {
  // #1 数值清洗：防止 NaN / Infinity 穿透校验
  const yesterdayBalance = round2(sanitizeNumber(formData.yesterdayBalance));
  const todayBalance = round2(sanitizeNumber(formData.todayBalance));
  const income = round2(sanitizeNumber(formData.income));
  const foodExpense = round2(sanitizeNumber(formData.foodExpense));
  const dailyExpense = round2(sanitizeNumber(formData.dailyExpense));
  const diners = Math.round(sanitizeNumber(formData.diners));
  const totalDiners = Math.round(sanitizeNumber(formData.totalDiners));
  const volunteerCount = Math.round(sanitizeNumber(formData.volunteerCount));
  const volunteerHours = round2(sanitizeNumber(formData.volunteerHours));
  const reportDate = formData.reportDate || '';

  const {
    avgDailyFoodExpense = CONFIG.DEFAULT_AVG_EXPENSE,
    avgDailyIncome = CONFIG.DEFAULT_AVG_INCOME,
    avgDailyDiners = CONFIG.DEFAULT_AVG_DINERS,
    avgBalance = 0,
    lastReportDate = '',
    lastBalance = 0,
    lastSubmitTime = 0
  } = storeHistoryStats;

  const actualFoodExpense = round2(foodExpense || dailyExpense || 0);
  const actualDiners = diners || totalDiners || 0;
  const actualIncome = round2(income || 0);

  const results: GuardrailResult = {
    canSubmit: true,
    hasWarning: false,
    blockReason: '',
    warningMessage: '',
    gapDaysNotice: '',
    warnings: [],
    auditLog: []
  };

  // ═══════════════════════════════════════════════════════
  // 第一维：数据维度校验
  // ═══════════════════════════════════════════════════════

  // 1.0 日期范围校验（硬拦截）#9
  if (reportDate) {
    const reportDateStr = reportDate.replace(/-/g, '/');
    const reportTs = new Date(reportDateStr).getTime();
    if (!isNaN(reportTs)) {
      const todayTs = new Date(getLocalDateString().replace(/-/g, '/')).getTime();
      const diffDays = Math.round((reportTs - todayTs) / (1000 * 60 * 60 * 24));
      if (diffDays > CONFIG.MAX_FUTURE_DAYS) {
        results.canSubmit = false;
        results.blockReason = '🚨 日期异常：汇报日期 ' + reportDate + ' 是未来日期，不允许提交。';
        addAuditLog(results.auditLog, 'future_date', 'block', reportDate);
        persistAuditLog(results.auditLog);
        return results;
      }
      if (diffDays < -CONFIG.MAX_PAST_DAYS) {
        results.canSubmit = false;
        results.blockReason = '🚨 日期异常：汇报日期 ' + reportDate + ' 距今超过 ' + CONFIG.MAX_PAST_DAYS + ' 天，请确认年份是否正确。';
        addAuditLog(results.auditLog, 'too_old_date', 'block', reportDate);
        persistAuditLog(results.auditLog);
        return results;
      }
    }
  }

  // 1.1 用餐人数逻辑校验（硬拦截）
  if (actualDiners === 0 && actualFoodExpense > 0) {
    results.canSubmit = false;
    results.blockReason = '🚨 逻辑冲突：用餐人数为 0 人时，食材支出不应为 ' + formatCurrency(actualFoodExpense) + '。请核对人数或支出类型。';
    addAuditLog(results.auditLog, 'diners_expense_conflict', 'block', { diners: 0, expense: actualFoodExpense });
    persistAuditLog(results.auditLog);
    return results;
  }

  // 1.2 余额非负校验（硬拦截）
  if (yesterdayBalance < CONFIG.MIN_BALANCE) {
    results.canSubmit = false;
    results.blockReason = '🚨 数据异常：昨日余额不能为负数（当前 ' + formatCurrency(yesterdayBalance) + '）。请检查输入。';
    addAuditLog(results.auditLog, 'negative_balance', 'block', yesterdayBalance);
    persistAuditLog(results.auditLog);
    return results;
  }

  // 1.3 今日余额非负校验（硬拦截）#4
  if (todayBalance < CONFIG.MIN_BALANCE) {
    results.canSubmit = false;
    results.blockReason = '🚨 数据异常：今日余额不能为负数（当前 ' + formatCurrency(todayBalance) + '）。请检查收入与支出是否填写正确。';
    addAuditLog(results.auditLog, 'negative_today_balance', 'block', todayBalance);
    persistAuditLog(results.auditLog);
    return results;
  }

  // 1.4 收入非负校验（硬拦截）
  if (actualIncome < CONFIG.MIN_INCOME) {
    results.canSubmit = false;
    results.blockReason = '🚨 数据异常：收入不能为负数（当前 ' + formatCurrency(actualIncome) + '）。请检查输入。';
    addAuditLog(results.auditLog, 'negative_income', 'block', actualIncome);
    persistAuditLog(results.auditLog);
    return results;
  }

  // 1.5 支出非负校验（硬拦截）
  if (actualFoodExpense < CONFIG.MIN_EXPENSE) {
    results.canSubmit = false;
    results.blockReason = '🚨 数据异常：支出不能为负数（当前 ' + formatCurrency(actualFoodExpense) + '）。请检查输入。';
    addAuditLog(results.auditLog, 'negative_expense', 'block', actualFoodExpense);
    persistAuditLog(results.auditLog);
    return results;
  }

  // 1.6 用餐人数上限校验（硬拦截）
  if (actualDiners > CONFIG.MAX_DINERS) {
    results.canSubmit = false;
    results.blockReason = '🚨 数据异常：用餐人数超过上限（当前 ' + actualDiners + ' 人，上限 ' + CONFIG.MAX_DINERS + ' 人）。请检查是否多输入了数字。';
    addAuditLog(results.auditLog, 'diners_exceed_max', 'block', actualDiners, CONFIG.MAX_DINERS);
    persistAuditLog(results.auditLog);
    return results;
  }

  // 1.7 义工人数校验（硬拦截）#10
  if (volunteerCount < CONFIG.MIN_VOLUNTEER_COUNT) {
    results.canSubmit = false;
    results.blockReason = '🚨 数据异常：义工人数不能为负数（当前 ' + volunteerCount + ' 人）。请检查输入。';
    addAuditLog(results.auditLog, 'negative_volunteer_count', 'block', volunteerCount);
    persistAuditLog(results.auditLog);
    return results;
  }
  if (volunteerCount > CONFIG.MAX_VOLUNTEER_COUNT) {
    results.canSubmit = false;
    results.blockReason = '🚨 数据异常：义工人数超过上限（当前 ' + volunteerCount + ' 人，上限 ' + CONFIG.MAX_VOLUNTEER_COUNT + ' 人）。请检查是否多输入了数字。';
    addAuditLog(results.auditLog, 'volunteer_count_exceed', 'block', volunteerCount, CONFIG.MAX_VOLUNTEER_COUNT);
    persistAuditLog(results.auditLog);
    return results;
  }

  // 1.8 义工工时校验（硬拦截）
  if (volunteerHours < CONFIG.MIN_VOLUNTEER_HOURS) {
    results.canSubmit = false;
    results.blockReason = '🚨 数据异常：义工工时不能为负数（当前 ' + volunteerHours + ' 小时）。请检查输入。';
    addAuditLog(results.auditLog, 'negative_hours', 'block', volunteerHours);
    persistAuditLog(results.auditLog);
    return results;
  }

  // 1.9 义工人均工时校验
  if (volunteerCount > 0 && volunteerHours > 0) {
    const hoursPerPerson = round2(volunteerHours / volunteerCount);
    if (hoursPerPerson > CONFIG.MAX_VOLUNTEER_HOURS_PER_PERSON) {
      results.canSubmit = false;
      results.blockReason = '🚨 数据异常：人均工时 ' + hoursPerPerson.toFixed(1) + ' 小时超过上限（' + CONFIG.MAX_VOLUNTEER_HOURS_PER_PERSON + ' 小时/人）。请检查是否多输入了数字。';
      addAuditLog(results.auditLog, 'hours_per_person_exceed', 'block', hoursPerPerson, CONFIG.MAX_VOLUNTEER_HOURS_PER_PERSON);
      persistAuditLog(results.auditLog);
      return results;
    }
  }

  // ═══════════════════════════════════════════════════════
  // 第二维：业务维度校验
  // ═══════════════════════════════════════════════════════

  // 2.0 余额恒等式校验（硬拦截）#2
  // todayBalance 应该等于 yesterdayBalance + income - expense
  const expectedBalance = round2(yesterdayBalance + actualIncome - actualFoodExpense);
  const balanceDiff = Math.abs(todayBalance - expectedBalance);
  if (balanceDiff > CONFIG.BALANCE_EQUATION_TOLERANCE) {
    results.canSubmit = false;
    results.blockReason = '🨨 余额不平：今日余额应为 昨日余额 + 收入 - 支出 = ' + formatCurrency(yesterdayBalance) + ' + ' + formatCurrency(actualIncome) + ' - ' + formatCurrency(actualFoodExpense) + ' = ' + formatCurrency(expectedBalance) + '，但您填写的今日余额为 ' + formatCurrency(todayBalance) + '，差额 ' + formatCurrency(balanceDiff) + '。请核对各项金额。';
    addAuditLog(results.auditLog, 'balance_equation_mismatch', 'block', { today: todayBalance, expected: expectedBalance, diff: balanceDiff });
    persistAuditLog(results.auditLog);
    return results;
  }

  // 2.1 余额跳变预警（软警告）
  if (avgBalance > 0 && yesterdayBalance > 0) {
    const jumpAbs = Math.abs(yesterdayBalance - avgBalance);
    const jumpRatio = yesterdayBalance / avgBalance;

    if (jumpAbs > CONFIG.MAX_BALANCE_JUMP_ABS || jumpRatio > CONFIG.MAX_BALANCE_JUMP_RATIO) {
      const msg = '⚠️ 余额跳变提醒：昨日余额 ' + formatCurrency(yesterdayBalance) + ' 与历史平均值 ' + formatCurrency(avgBalance) + ' 偏差较大，请确认是否正确？';
      results.warnings.push(msg);
      results.hasWarning = true;
      addAuditLog(results.auditLog, 'balance_jump', 'warning', { balance: yesterdayBalance, avg: avgBalance });
    }
  }

  // 2.2 收入异常高值预警（软警告）
  if (actualIncome > CONFIG.MAX_INCOME_PER_DAY) {
    const msg = '⚠️ 收入异常提醒：今日收入 ' + formatCurrency(actualIncome) + ' 超过单日上限 ' + formatCurrency(CONFIG.MAX_INCOME_PER_DAY) + '，请确认是否包含非日常收入？';
    results.warnings.push(msg);
    results.hasWarning = true;
    addAuditLog(results.auditLog, 'income_exceed_max', 'warning', actualIncome, CONFIG.MAX_INCOME_PER_DAY);
  }

  // 2.3 支出异常高值预警（软警告）
  if (actualFoodExpense > avgDailyFoodExpense * CONFIG.MAX_EXPENSE_RATIO && avgDailyFoodExpense > 0) {
    const msg = '⚠️ 支出异常提醒：今日食材支出 ' + formatCurrency(actualFoodExpense) + ' 超过日常平均值 ' + formatCurrency(avgDailyFoodExpense) + ' 的 ' + CONFIG.MAX_EXPENSE_RATIO + ' 倍，请确认是否包含大额采购或打错数字？';
    results.warnings.push(msg);
    results.hasWarning = true;
    addAuditLog(results.auditLog, 'expense_exceed_avg', 'warning', actualFoodExpense, avgDailyFoodExpense);
  }

  // 2.4 人均支出校验
  if (actualDiners > 0 && actualFoodExpense > 0) {
    const expensePerDiner = round2(actualFoodExpense / actualDiners);
    if (expensePerDiner < CONFIG.MIN_EXPENSE_PER_DINER) {
      const msg = '⚠️ 人均支出偏低：今日人均食材支出仅 ' + formatCurrency(expensePerDiner) + '，低于正常范围（' + formatCurrency(CONFIG.MIN_EXPENSE_PER_DINER) + '/人起），请确认人数是否正确？';
      results.warnings.push(msg);
      results.hasWarning = true;
      addAuditLog(results.auditLog, 'expense_per_diner_low', 'warning', expensePerDiner, CONFIG.MIN_EXPENSE_PER_DINER);
    } else if (expensePerDiner > CONFIG.MAX_EXPENSE_PER_DINER) {
      const msg = '⚠️ 人均支出偏高：今日人均食材支出 ' + formatCurrency(expensePerDiner) + '，超过正常范围（' + formatCurrency(CONFIG.MAX_EXPENSE_PER_DINER) + '/人），请确认是否包含大额采购？';
      results.warnings.push(msg);
      results.hasWarning = true;
      addAuditLog(results.auditLog, 'expense_per_diner_high', 'warning', expensePerDiner, CONFIG.MAX_EXPENSE_PER_DINER);
    }
  }

  // 2.5 人均收入校验
  if (actualDiners > 0 && actualIncome > 0) {
    const incomePerDiner = round2(actualIncome / actualDiners);
    if (incomePerDiner > CONFIG.MAX_INCOME_PER_DINER_CHECK) {
      const msg = '⚠️ 人均收入偏高：今日人均收入 ' + formatCurrency(incomePerDiner) + '，超过预警线 ' + formatCurrency(CONFIG.MAX_INCOME_PER_DINER_CHECK) + '，请确认是否包含大额捐赠？';
      results.warnings.push(msg);
      results.hasWarning = true;
      addAuditLog(results.auditLog, 'income_per_diner_high', 'warning', incomePerDiner, CONFIG.MAX_INCOME_PER_DINER_CHECK);
    }
  }

  // ═══════════════════════════════════════════════════════
  // 第三维：时间维度校验
  // ═══════════════════════════════════════════════════════

  // 3.1 提交频率校验（硬拦截）#3 — 从本地频率记录获取 lastSubmitTime
  const now = Date.now();
  const freqRecord = getFrequencyRecord();
  const effectiveLastSubmit = lastSubmitTime || freqRecord.lastSubmitTime || 0;
  if (effectiveLastSubmit > 0 && now - effectiveLastSubmit < CONFIG.SUBMIT_COOLDOWN_MS) {
    results.canSubmit = false;
    results.blockReason = '🚨 提交过快：请等待 ' + Math.ceil((CONFIG.SUBMIT_COOLDOWN_MS - (now - effectiveLastSubmit)) / 1000) + ' 秒后再提交。';
    addAuditLog(results.auditLog, 'submit_too_fast', 'block', now - effectiveLastSubmit, CONFIG.SUBMIT_COOLDOWN_MS);
    persistAuditLog(results.auditLog);
    return results;
  }

  // 3.2 小时级频率限制（硬拦截）
  if (freqRecord.count >= CONFIG.MAX_SUBMIT_PER_HOUR && now - freqRecord.firstSubmitTime < 3600000) {
    results.canSubmit = false;
    results.blockReason = '🚨 频率超限：您在过去1小时内已提交 ' + freqRecord.count + ' 次（上限 ' + CONFIG.MAX_SUBMIT_PER_HOUR + ' 次），请稍后再试。';
    addAuditLog(results.auditLog, 'hourly_limit_exceeded', 'block', freqRecord.count, CONFIG.MAX_SUBMIT_PER_HOUR);
    persistAuditLog(results.auditLog);
    return results;
  }

  // 3.3 每日提交上限（硬拦截）#7
  const today = getLocalDateString();
  if (freqRecord.dailyDate === today && freqRecord.dailyCount >= CONFIG.MAX_SUBMIT_PER_DAY) {
    results.canSubmit = false;
    results.blockReason = '🚨 频率超限：您今日已提交 ' + freqRecord.dailyCount + ' 次（每日上限 ' + CONFIG.MAX_SUBMIT_PER_DAY + ' 次），请明日再试。';
    addAuditLog(results.auditLog, 'daily_limit_exceeded', 'block', freqRecord.dailyCount, CONFIG.MAX_SUBMIT_PER_DAY);
    persistAuditLog(results.auditLog);
    return results;
  }

  // 3.4 数据突变检测（与上一条记录对比）#13 修复 changeRatio=0 误报
  if (lastBalance > 0 && todayBalance >= 0) {
    const changeRatio = todayBalance / lastBalance;
    // 今日余额为 0 时不触发突变预警（可能是合理支出完毕）
    if (todayBalance > 0 && (changeRatio > CONFIG.MAX_BALANCE_JUMP_RATIO || changeRatio < 1 / CONFIG.MAX_BALANCE_JUMP_RATIO)) {
      const direction = todayBalance > lastBalance ? '增加' : '减少';
      const msg = '⚠️ 余额突变提醒：今日余额较昨日' + direction + ' ' + formatCurrency(Math.abs(todayBalance - lastBalance)) + '，变化幅度较大，请确认是否正确？';
      results.warnings.push(msg);
      results.hasWarning = true;
      addAuditLog(results.auditLog, 'balance_sudden_change', 'warning', { today: todayBalance, yesterday: lastBalance });
    }
  }

  // 3.5 日期间隔提示
  if (lastReportDate && reportDate) {
    const lastDateStr = lastReportDate.replace(/-/g, '/');
    const currDateStr = reportDate.replace(/-/g, '/');
    const diffMs = new Date(currDateStr).getTime() - new Date(lastDateStr).getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays > 1) {
      results.gapDaysNotice = '💡 日期感知：检测到距离上一条餐报 (' + lastReportDate + ') 相隔了 ' + (diffDays - 1) + ' 天，提交后系统将为您保留补录通道。';
      addAuditLog(results.auditLog, 'date_gap', 'info', diffDays - 1);
    }
  }

  // ═══════════════════════════════════════════════════════
  // 警告确认次数限制
  // ═══════════════════════════════════════════════════════

  const warningConfirmCount = getWarningConfirmCount();
  if (results.hasWarning && warningConfirmCount >= CONFIG.MAX_WARNING_PER_DAY) {
    results.canSubmit = false;
    results.blockReason = '🚨 安全限制：您今日已确认 ' + warningConfirmCount + ' 次异常数据警告，为防止误操作，请联系管理员协助检查数据。';
    addAuditLog(results.auditLog, 'warning_limit_exceeded', 'block', warningConfirmCount, CONFIG.MAX_WARNING_PER_DAY);
    persistAuditLog(results.auditLog);
    return results;
  }

  // 合并警告信息 #15 限制长度
  if (results.warnings.length > 0) {
    const joined = results.warnings.join('\n\n');
    // wx.showModal content 超过 ~500 字符可能被截断，截取前 450 字符
    results.warningMessage = joined.length > 450 ? joined.substring(0, 450) + '\n\n...（更多异常请查看详细日志）' : joined;
  }

  // #14 持久化审计日志
  if (results.auditLog.length > 0) {
    persistAuditLog(results.auditLog);
  }

  return results;
}

/**
 * 记录提交成功（用于频率统计）
 */
export function recordSuccessfulSubmit(): void {
  recordSubmit();
}

/**
 * 记录警告确认
 */
export function recordWarningConfirmed(): void {
  recordWarningConfirm();
}

/**
 * 检查是否可以提交（频率限制）— 前置快速检查
 */
export function canSubmitNow(): { canSubmit: boolean; waitMs: number; reason: string } {
  const now = Date.now();
  const freqRecord = getFrequencyRecord();
  const today = getLocalDateString();

  // 冷却时间检查
  if (freqRecord.lastSubmitTime > 0) {
    const elapsed = now - freqRecord.lastSubmitTime;
    if (elapsed < CONFIG.SUBMIT_COOLDOWN_MS) {
      return {
        canSubmit: false,
        waitMs: CONFIG.SUBMIT_COOLDOWN_MS - elapsed,
        reason: '请等待 ' + Math.ceil((CONFIG.SUBMIT_COOLDOWN_MS - elapsed) / 1000) + ' 秒后再提交'
      };
    }
  }

  // 小时级限制检查
  if (freqRecord.count >= CONFIG.MAX_SUBMIT_PER_HOUR && now - freqRecord.firstSubmitTime < 3600000) {
    return {
      canSubmit: false,
      waitMs: 3600000 - (now - freqRecord.firstSubmitTime),
      reason: '每小时提交上限 ' + CONFIG.MAX_SUBMIT_PER_HOUR + ' 次，请稍后再试'
    };
  }

  // 每日限制检查 #7
  if (freqRecord.dailyDate === today && freqRecord.dailyCount >= CONFIG.MAX_SUBMIT_PER_DAY) {
    return {
      canSubmit: false,
      waitMs: 0,
      reason: '今日提交已达上限 ' + CONFIG.MAX_SUBMIT_PER_DAY + ' 次，请明日再试'
    };
  }

  return { canSubmit: true, waitMs: 0, reason: '' };
}

/**
 * 获取今日警告确认次数
 */
export function getTodayWarningCount(): number {
  return getWarningConfirmCount();
}

/**
 * 清除过期频率记录（超过24小时）+ 过期警告确认记录（超过7天）
 */
export function cleanExpiredFrequencyRecords(): void {
  try {
    const now = Date.now();
    const freqRecord = getFrequencyRecord();
    if (freqRecord.firstSubmitTime > 0 && now - freqRecord.firstSubmitTime > 86400000) {
      wx.removeStorageSync('submit_frequency');
    }

    // 清除过期的警告确认记录（保留7天）#5 使用本地日期
    const today = new Date();
    for (let i = 8; i <= 30; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const yyyy = date.getFullYear();
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      const dateStr = yyyy + '-' + mm + '-' + dd;
      wx.removeStorageSync('warning_confirm_' + dateStr);
    }
  } catch {}
}