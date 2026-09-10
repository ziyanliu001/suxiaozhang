'use strict';

// 🛒（2026-09-11 AI 备餐预测一键流转后厨采买任务·方向2）纯逻辑：把
// predictMealDemand() 算出的 ingredients 转成结构化的后厨采买待办清单。
//
// ⚠️ 与 cloudfunctions/manageDailyMenu/lib/buildPurchasePlan.js 是同一份
// 逻辑的两处独立维护（miniprogram/ 与 cloudfunctions/ 是两个独立的构建/
// 部署单元，前端无法跨目录 require 云函数代码，与本仓库 MERIT_TAGS 白名单
// 在 cloudfunctions/manageVolunteerCheckIn 与
// components/volunteer-merit-dialog 两处独立维护同一份字典是同一种既有
// 约束）——两份文件的函数行为必须保持一致，改动一处记得同步另一处。
// 本文件供 daily-menu.ts 前端弹窗直接调用，不做 db I/O、不依赖任何
// wx.* API，配套单测 buildPurchasePlan.test.js。
//
// 🛡️ 诚实的能力边界：本仓库目前没有一个真实的"后厨采购清单/备餐看板"云端
// 集合（见 daily-menu.ts onApplyMealPrediction 头部注释同一处如实说明）。
// 这里产出的任务列表由前端落地到本机 storage（当前设备当天可查看/勾选，
// 不是跨设备/跨班次共享的云端看板）+ 一键复制到剪贴板（供分享到微信群/
// 纸质台账等真正的跨人协作渠道），不假装接了一个不存在的云端持久化模块。

const INGREDIENT_ITEM_DEFS = [
  { key: 'riceJin', itemName: '大米', unit: '斤' },
  { key: 'oilLiter', itemName: '食用油', unit: '升' },
  { key: 'vegetableJin', itemName: '蔬菜', unit: '斤' },
  { key: 'seasoningJin', itemName: '调味品', unit: '斤' }
];

const PURCHASE_TASK_REMARK = 'AI备餐生成';

function buildPurchasePlan(ingredients) {
  if (!ingredients || typeof ingredients !== 'object') return [];

  return INGREDIENT_ITEM_DEFS
    .filter((def) => {
      const v = ingredients[def.key];
      return typeof v === 'number' && Number.isFinite(v) && v > 0;
    })
    .map((def) => ({
      itemKey: def.key,
      itemName: def.itemName,
      estimatedWeight: ingredients[def.key],
      unit: def.unit,
      status: 'pending',
      remark: PURCHASE_TASK_REMARK
    }));
}

function togglePurchaseTaskStatus(tasks, itemKey) {
  if (!Array.isArray(tasks)) return [];
  return tasks.map((t) => {
    if (!t || t.itemKey !== itemKey) return t;
    return { ...t, status: t.status === 'completed' ? 'pending' : 'completed' };
  });
}

function updatePurchaseTaskWeight(tasks, itemKey, rawValue) {
  if (!Array.isArray(tasks)) return [];
  const num = parseFloat(rawValue);
  const isValid = Number.isFinite(num) && num > 0;
  return tasks.map((t) => {
    if (!t || t.itemKey !== itemKey) return t;
    return isValid ? { ...t, estimatedWeight: num } : t;
  });
}

function formatPurchasePlanText(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return '';
  const lines = tasks.map((t) => {
    const box = t.status === 'completed' ? '☑' : '☐';
    return `${box} ${t.itemName} ${t.estimatedWeight}${t.unit}`;
  });
  lines.push(`（${PURCHASE_TASK_REMARK}）`);
  return lines.join('\n');
}

module.exports = {
  buildPurchasePlan,
  togglePurchaseTaskStatus,
  updatePurchaseTaskWeight,
  formatPurchasePlanText,
  INGREDIENT_ITEM_DEFS,
  PURCHASE_TASK_REMARK
};
