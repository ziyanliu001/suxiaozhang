'use strict';

// 纯逻辑：「物资流转历史明细」页的快捷筛选（日期范围 + 物资类目）。与
// pages/index/lib/materialTransferForm.js 同一套既定写法——不依赖 wx.*/
// this.setData，便于 node:test 直接单测。
//
// 🛡️ 不做服务端分页/筛选：本页数据量级（单店几个月的调拨/采购流水）用
// cloudfunctions/manageMaterialTransfer 的 listTransferHistory/
// listPurchaseHistory 一次性拉回（上限 200 条，HISTORY_MAX_LIMIT），日期
// 范围/物资类目筛选完全在客户端这批数据上现算——志工反复切换筛选条件时
// 不需要重新发起云函数请求，交互更跟手，200 条量级的数组过滤在小程序端
// 也不构成性能问题。
//
// 🥬 素食边界：本文件的物资类目选项是 pages/index/lib/materialTransferForm.js
// 里 MATERIAL_TRANSFER_ITEM_OPTIONS/MATERIAL_PURCHASE_ITEM_OPTIONS 的独立
// 拷贝（跨页面/跨目录不是云函数那种硬性"无共享模块机制"限制，但本仓库一贯
// 做法是页面级 lib/ 各自维护同源拷贝，改一处需要同步改另一处，这里延续
// 同一套约定，不引入新的共享模块层级）——同样必须严格限定纯素范围，见下方
// 常量定义处注释。

// 与 pages/index/lib/materialTransferForm.js 的两份类目常量保持同源口径——
// 调拨三项（时蔬保质期短不支持跨店调配）、采购四项全覆盖，这里额外统一
// 加一个"全部"选项（value 为空字符串，语义是不按类目过滤）
const TRANSFER_ITEM_FILTER_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'rice', label: '大米' },
  { value: 'oil', label: '食用油' },
  { value: 'flour', label: '面粉' }
];

const PURCHASE_ITEM_FILTER_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'rice', label: '大米' },
  { value: 'oil', label: '食用油' },
  { value: 'flour', label: '面粉' },
  { value: 'vegetable', label: '时蔬' }
];

const DATE_RANGE_OPTIONS = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '近7天' },
  { value: '30d', label: '近30天' },
  { value: 'all', label: '全部' }
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 按日期范围 key 算出筛选起点（含当天/含今天算起）；'all' 返回 null，
 * 表示不做时间下限过滤。
 * @param {'today'|'7d'|'30d'|'all'} rangeKey
 * @param {Date} [now]
 * @returns {Date|null}
 */
function resolveDateRangeStart(rangeKey, now) {
  const base = now instanceof Date ? now : new Date();
  if (rangeKey === 'today') {
    return new Date(base.getFullYear(), base.getMonth(), base.getDate());
  }
  if (rangeKey === '7d') {
    return new Date(base.getTime() - 6 * DAY_MS);
  }
  if (rangeKey === '30d') {
    return new Date(base.getTime() - 29 * DAY_MS);
  }
  return null;
}

/**
 * 按日期范围过滤记录（record.createTime 是 db.serverDate() 经云函数响应
 * 序列化后的值，与本仓库 inventory-management.ts 同一处理惯例一致，直接
 * new Date() 解析）。
 * @param {Array<{createTime?: string|number}>} records
 * @param {'today'|'7d'|'30d'|'all'} rangeKey
 * @param {Date} [now]
 * @returns {Array}
 */
function filterRecordsByDateRange(records, rangeKey, now) {
  if (!Array.isArray(records)) return [];
  const start = resolveDateRangeStart(rangeKey, now);
  if (!start) return records.slice();
  const startMs = start.getTime();
  return records.filter((r) => {
    if (!r || !r.createTime) return false;
    const t = new Date(r.createTime).getTime();
    return Number.isFinite(t) && t >= startMs;
  });
}

/**
 * 按物资类目过滤——itemValue 为空字符串（"全部"）时原样返回，不过滤。
 * @param {Array<{item?: string}>} records
 * @param {string} itemValue
 * @returns {Array}
 */
function filterRecordsByItem(records, itemValue) {
  if (!Array.isArray(records)) return [];
  if (!itemValue) return records.slice();
  return records.filter((r) => r && r.item === itemValue);
}

/**
 * 两个筛选维度合并应用——先按日期范围收窄，再按物资类目收窄，顺序不影响
 * 结果（两个过滤条件互相独立）。
 * @param {Array} records
 * @param {{dateRange?: string, item?: string}} filters
 * @param {Date} [now]
 * @returns {Array}
 */
function applyMaterialHistoryFilters(records, filters, now) {
  const dateRange = (filters && filters.dateRange) || 'all';
  const item = (filters && filters.item) || '';
  const byDate = filterRecordsByDateRange(records, dateRange, now);
  return filterRecordsByItem(byDate, item);
}

module.exports = {
  TRANSFER_ITEM_FILTER_OPTIONS,
  PURCHASE_ITEM_FILTER_OPTIONS,
  DATE_RANGE_OPTIONS,
  resolveDateRangeStart,
  filterRecordsByDateRange,
  filterRecordsByItem,
  applyMaterialHistoryFilters
};
