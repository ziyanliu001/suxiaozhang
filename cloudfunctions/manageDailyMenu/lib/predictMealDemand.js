'use strict';

// 🍚 雨花斋智能备餐与食材用量预测系统 · 一期原型（2026-09-10）
//
// 纯逻辑：不做 db I/O、不依赖 wx-server-sdk，便于单测；拆成独立文件与
// index.js 共用，是本仓库 wxPayCore/getSettlementSummary/manageVolunteerCheckIn
// 等云函数已有的既定写法（index.js 通过 require('./lib/xxx') 引入 db 查出的
// 数据，纯判断/计算逻辑委托给这里）。
//
// ⚠️ 数据来源如实说明：本文件按需求指定放在 manageDailyMenu/lib/ 下，但
// "开餐人次"（堂食+外送长者）历史数据实际落在 report_logs 集合（字段
// dineInSeniors/deliverySeniors，见 docs/SCHEMA.md 第 4.1 节），daily_menus
// 集合本身只存菜谱文字/配图、没有人次字段。index.js 的 getMealPrediction
// action 会去查 report_logs 拼出 historyRecords 数组传给这里——本函数只
// 认调用方传入的 { dateString, dineInSeniors, deliverySeniors } 形状，不关心
// 数据具体是从哪个集合查出来的。
//
// ⚠️ 食材换算比例如实说明：INGREDIENT_RATIO_PER_PERSON 是一期原型的粗略估算
// 值（未经真实厨房消耗数据校准），仅用于给出一个"大致备料方向"的参考量，
// 不能作为精确采购依据；后续接入真实用量台账后应替换成基于历史 materials[]
// 数据回归出来的比例，而不是继续沿用这里的占位常量。

// 近 N 天回溯窗口：取 targetDate 之前（不含当天）14 天内的历史记录作为
// 预测样本池，不含 targetDate 本身——预测某天不应该用到那天自己的实际数据
const LOOKBACK_DAYS = 14;

// 同星期样本的权重：与"相邻日期"样本相比，同星期几的历史数据更能反映
// 周中/周末这类周期性波动（比如周末堂食通常比工作日多），加权计入平均值
const SAME_WEEKDAY_WEIGHT = 2;

// 🌧️ 天气系数：字符串枚举，不认识的取值（含 undefined/空字符串）一律按 1
// （不调整）处理——不强制要求调用方一定要传，也不会因为传了个奇怪的值就
// 计算出离谱结果
const WEATHER_MULTIPLIER = {
  storm: 0.7,
  heavy_rain: 0.7,
  rain: 0.85
};

// 🏮 节假日/传统吃素高峰加权：isHoliday 由调用方判定并传入布尔值——既覆盖
// 法定节假日，也覆盖农历初一/十五这类传统吃素高峰日（本函数不做农历换算，
// "今天是不是初一十五"这类日期换算逻辑由调用方负责，这里只认最终的
// 布尔判定结果）
const HOLIDAY_MULTIPLIER = 1.25;

// 一期原型的食材换算比例（单位：每人每餐），全部是粗略估算的占位值
const INGREDIENT_RATIO_PER_PERSON = {
  riceJin: 0.3,
  oilLiter: 0.03,
  vegetableJin: 0.5,
  seasoningJin: 0.02
};

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// 把 'YYYY-MM-DD' 解析成 UTC 毫秒数——用 Date.UTC 而不是 new Date(str) 直接
// 解析，是为了让"这天是星期几""两个日期相差几天"这类计算不受运行环境本地
// 时区影响，云函数容器时区不保证是 UTC+8，必须显式按 UTC 口径计算日历日期
function parseDateOnly(dateString) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString || '').trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  return Number.isNaN(ms) ? null : ms;
}

function getWeekday(dateString) {
  const ms = parseDateOnly(dateString);
  return ms === null ? null : new Date(ms).getUTCDay();
}

// toDateString 相对 fromDateString 晚几天（可为负数）
function dayDiff(fromDateString, toDateString) {
  const fromMs = parseDateOnly(fromDateString);
  const toMs = parseDateOnly(toDateString);
  if (fromMs === null || toMs === null) return null;
  return Math.round((toMs - fromMs) / 86400000);
}

// 单条历史记录的开餐人次 = 堂食长者 + 外送长者，字段缺失/非数字按 0 兜底，
// 不让一条脏数据污染整体平均值计算
function getRecordHeadcount(record) {
  const dineIn = Number(record && record.dineInSeniors) || 0;
  const delivery = Number(record && record.deliverySeniors) || 0;
  return dineIn + delivery;
}

function resolveWeatherMultiplier(weatherFactor) {
  if (typeof weatherFactor !== 'string') return 1;
  const key = weatherFactor.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(WEATHER_MULTIPLIER, key) ? WEATHER_MULTIPLIER[key] : 1;
}

function computeIngredients(headcount) {
  return {
    riceJin: roundTo(headcount * INGREDIENT_RATIO_PER_PERSON.riceJin, 1),
    oilLiter: roundTo(headcount * INGREDIENT_RATIO_PER_PERSON.oilLiter, 2),
    vegetableJin: roundTo(headcount * INGREDIENT_RATIO_PER_PERSON.vegetableJin, 1),
    seasoningJin: roundTo(headcount * INGREDIENT_RATIO_PER_PERSON.seasoningJin, 2)
  };
}

// 预测某一天的推荐备餐人次与基础食材清单。
//
// @param {Array<{dateString: string, dineInSeniors?: number, deliverySeniors?: number}>} historyRecords
//   历史开餐记录，不要求预先排序/去重，本函数内部只按 dateString 过滤，不
//   信任调用方传入顺序
// @param {string} targetDate 'YYYY-MM-DD'，要预测的目标日期（必填，格式非法直接抛异常——
//   没有目标日期，"预测"这件事本身就无意义，不应该静默返回一个看似合理的假结果）
// @param {string} [weatherFactor] 天气枚举，见 WEATHER_MULTIPLIER，不认识的值按 1 处理
// @param {boolean} [isHoliday] 是否节假日/传统吃素高峰日，true 时整体加权 1.25
// @returns {object} 见下方 return 语句，insufficientData=true 时
//   recommendedHeadcount/ingredients 均为 null（历史数据完全不足时，如实
//   返回"算不出来"，不编造一个看起来合理实则毫无依据的数字）
function predictMealDemand({ historyRecords, targetDate, weatherFactor, isHoliday } = {}) {
  const targetMs = parseDateOnly(targetDate);
  if (targetMs === null) {
    throw new Error('targetDate 必须是合法的 YYYY-MM-DD 格式日期字符串');
  }
  const targetWeekday = new Date(targetMs).getUTCDay();

  const validRecords = Array.isArray(historyRecords)
    ? historyRecords.filter((r) => r && parseDateOnly(r.dateString) !== null)
    : [];

  // 回溯窗口：targetDate 之前 1~14 天（不含 targetDate 当天）
  const windowRecords = validRecords.filter((r) => {
    const diff = dayDiff(r.dateString, targetDate);
    return diff !== null && diff > 0 && diff <= LOOKBACK_DAYS;
  });

  let baseAverage = null;
  let sameWeekdayCount = 0;
  let adjacentCount = 0;

  if (windowRecords.length > 0) {
    let weightedSum = 0;
    let weightTotal = 0;
    windowRecords.forEach((r) => {
      const isSameWeekday = getWeekday(r.dateString) === targetWeekday;
      const weight = isSameWeekday ? SAME_WEEKDAY_WEIGHT : 1;
      if (isSameWeekday) {
        sameWeekdayCount += 1;
      } else {
        adjacentCount += 1;
      }
      weightedSum += getRecordHeadcount(r) * weight;
      weightTotal += weight;
    });
    baseAverage = weightedSum / weightTotal;
  } else if (validRecords.length > 0) {
    // 🐛 兜底：14 天窗口内恰好没有任何记录（新开门店/数据断档等场景），
    // 退而求其次用调用方提供的全部历史记录做简单平均——比完全没有依据强，
    // 但不再区分同星期/相邻日期权重（样本本来就已经不在"近期"范围内，
    // 硬套周期性权重意义不大）
    baseAverage = validRecords.reduce((sum, r) => sum + getRecordHeadcount(r), 0) / validRecords.length;
  }

  const weatherMultiplier = resolveWeatherMultiplier(weatherFactor);
  const holidayMultiplier = isHoliday ? HOLIDAY_MULTIPLIER : 1;

  if (baseAverage === null) {
    return {
      targetDate,
      insufficientData: true,
      recommendedHeadcount: null,
      basis: {
        sameWeekdayCount: 0,
        adjacentCount: 0,
        baseAverage: null,
        weatherMultiplier,
        holidayMultiplier,
        appliedMultiplier: null
      },
      ingredients: null
    };
  }

  const appliedMultiplier = weatherMultiplier * holidayMultiplier;
  // 人次不允许出现负数（理论上不会，防御一手极端天气系数配置失误）
  const recommendedHeadcount = Math.max(0, Math.round(baseAverage * appliedMultiplier));

  return {
    targetDate,
    insufficientData: false,
    recommendedHeadcount,
    basis: {
      sameWeekdayCount,
      adjacentCount,
      baseAverage: roundTo(baseAverage, 1),
      weatherMultiplier,
      holidayMultiplier,
      appliedMultiplier: roundTo(appliedMultiplier, 4)
    },
    ingredients: computeIngredients(recommendedHeadcount)
  };
}

module.exports = {
  predictMealDemand,
  LOOKBACK_DAYS,
  SAME_WEEKDAY_WEIGHT,
  WEATHER_MULTIPLIER,
  HOLIDAY_MULTIPLIER,
  INGREDIENT_RATIO_PER_PERSON
};
