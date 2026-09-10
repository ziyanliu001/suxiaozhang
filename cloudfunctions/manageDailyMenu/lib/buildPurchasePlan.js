'use strict';

// 🛒（2026-09-11 AI 备餐预测一键流转后厨采买任务·方向2）纯逻辑：把
// predictMealDemand() 算出的 ingredients（见同目录 predictMealDemand.js
// computeIngredients()，形状固定为 {riceJin, oilLiter, vegetableJin,
// seasoningJin}）转成结构化的后厨采买待办清单。不做 db I/O、不依赖
// wx-server-sdk，配套单测同目录 buildPurchasePlan.test.js。
//
// 🛡️ 诚实的能力边界：本仓库目前没有一个真实的"后厨采购清单/备餐看板"云端
// 集合（见 daily-menu.ts onApplyMealPrediction 头部注释同一处如实说明）。
// 这里产出的任务列表由前端落地到本机 storage（当前设备当天可查看/勾选，
// 不是跨设备/跨班次共享的云端看板）+ 一键复制到剪贴板（供分享到微信群/
// 纸质台账等真正的跨人协作渠道），不假装接了一个不存在的云端持久化模块。

// 品类 -> 采买品名/单位映射，与 predictMealDemand.js 的 INGREDIENT_RATIO_PER_PERSON
// 字段一一对应，顺序即清单展示顺序（主食粮油优先，调味品收尾）
const INGREDIENT_ITEM_DEFS = [
  { key: 'riceJin', itemName: '大米', unit: '斤' },
  { key: 'oilLiter', itemName: '食用油', unit: '升' },
  { key: 'vegetableJin', itemName: '蔬菜', unit: '斤' },
  { key: 'seasoningJin', itemName: '调味品', unit: '斤' }
];

const PURCHASE_TASK_REMARK = 'AI备餐生成';

const TASK_STATUSES = ['pending', 'completed'];

/**
 * 将 predictMealDemand 的 ingredients 转成结构化采买待办数组。
 * 数量缺失/非数字/小于等于 0 的品类直接跳过——不生成"0斤大米"这种毫无
 * 意义的采买项，也不对无法识别的输入编造假数据。
 * @param {{riceJin?:number, oilLiter?:number, vegetableJin?:number, seasoningJin?:number}} ingredients
 * @returns {Array<{itemKey:string, itemName:string, estimatedWeight:number, unit:string, status:'pending', remark:string}>}
 */
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

/**
 * 切换某一条采买任务的 pending/completed 状态，返回全新数组（不原地修改
 * 入参，方便直接喂给 setData）。itemKey 不存在时原样返回，不抛异常。
 * @param {Array} tasks
 * @param {string} itemKey
 * @returns {Array}
 */
function togglePurchaseTaskStatus(tasks, itemKey) {
  if (!Array.isArray(tasks)) return [];
  return tasks.map((t) => {
    if (!t || t.itemKey !== itemKey) return t;
    return { ...t, status: t.status === 'completed' ? 'pending' : 'completed' };
  });
}

/**
 * 义工弹窗微调预估重量——只在合法正数时才写入，非法输入（空字符串/负数/
 * 非数字）原样保留旧值，不把用户还没输完的中间态（如刚删空准备重新输入）
 * 当成"清零"提交上去。
 * @param {Array} tasks
 * @param {string} itemKey
 * @param {number|string} rawValue
 * @returns {Array}
 */
function updatePurchaseTaskWeight(tasks, itemKey, rawValue) {
  if (!Array.isArray(tasks)) return [];
  const num = parseFloat(rawValue);
  const isValid = Number.isFinite(num) && num > 0;
  return tasks.map((t) => {
    if (!t || t.itemKey !== itemKey) return t;
    return isValid ? { ...t, estimatedWeight: num } : t;
  });
}

/**
 * 把采买清单格式化成一段纯文本，供"一键复制"到剪贴板——已完成项打勾、
 * 未完成项打空框，末尾统一带上生成备注，格式与既有
 * onApplyMealPrediction 的复制文案保持同一套"• "/emoji 视觉语言，不另起
 * 一套排版规则。
 * @param {Array} tasks
 * @returns {string}
 */
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
  PURCHASE_TASK_REMARK,
  TASK_STATUSES
};
