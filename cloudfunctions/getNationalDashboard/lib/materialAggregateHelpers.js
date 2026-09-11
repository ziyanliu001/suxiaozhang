'use strict';

// 🌾（2026-09-12 1000 条截断修复配套）material_logs 聚合管道（$match+$group）
// 返回结果的纯函数处理逻辑——不依赖 wx-server-sdk，可直接单测。真正发起
// db.collection('material_logs').aggregate() 调用的部分留在 index.js。
// 抽出来的另一个好处：把此前在两处（当前范围总量 + 近30天集采预估）各写
// 一份、写法几乎一样的"从聚合结果取值+兜底0"逻辑收敛成一份，不再重复。

/**
 * 从 db.collection(...).aggregate().group({_id:null, totalXxx: sum(...)}).end()
 * 的返回结果里取出四个物资总量，缺失/非法值一律兜底为 0。
 * @param {{list?: Array<{totalRice?: any, totalFlour?: any, totalOil?: any, totalVegetable?: any}>}} aggregateResult
 * @returns {{riceTotal: number, flourTotal: number, oilTotal: number, vegetableTotal: number}}
 */
function extractMaterialTotals(aggregateResult) {
  const sums = (aggregateResult && Array.isArray(aggregateResult.list) && aggregateResult.list[0]) || {};
  return {
    riceTotal: parseFloat(sums.totalRice) || 0,
    flourTotal: parseFloat(sums.totalFlour) || 0,
    oilTotal: parseFloat(sums.totalOil) || 0,
    vegetableTotal: parseFloat(sums.totalVegetable) || 0
  };
}

/**
 * material_logs 的 riceCount 等字段历史上一律按"斤"（0.5kg）记录，对外输出
 * 字段是公斤单位，这里做统一换算，保留一位小数。
 * @param {number} jin
 * @returns {number}
 */
function convertJinToKg(jin) {
  return Math.round((parseFloat(jin) || 0) * 0.5 * 10) / 10;
}

/**
 * 月度集采预估文案：以近30天大米实际消耗量线性外推到"每月"口径，
 * ≥1000kg 时换算成"吨"展示，更符合采购人员的直觉单位。
 * @param {number} estimatedMonthlyRiceKg
 * @returns {string}
 */
function buildEstimatedMonthlySupplyNeedsText(estimatedMonthlyRiceKg) {
  const kg = parseFloat(estimatedMonthlyRiceKg) || 0;
  if (!(kg > 0)) return '暂无近30天食材消耗数据';
  if (kg >= 1000) {
    const tons = Math.round((kg / 1000) * 10) / 10;
    return `大米约需 ${tons} 吨/月`;
  }
  return `大米约需 ${Math.round(kg)} 公斤/月`;
}

module.exports = {
  extractMaterialTotals,
  convertJinToKg,
  buildEstimatedMonthlySupplyNeedsText
};
