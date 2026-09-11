'use strict';

// 🛒（2026-09-11 AI 备餐预测一键流转后厨采买任务·方向2）纯逻辑：把
// predictMealDemand() 算出的 ingredients（见同目录 predictMealDemand.js
// computeIngredients()，形状固定为 {riceJin, oilLiter, vegetableJin,
// seasoningJin}）转成结构化的后厨采买待办清单。不做 db I/O、不依赖
// wx-server-sdk，配套单测同目录 buildPurchasePlan.test.js。
//
// 🛒（2026-09-11 云端持久化）本文件最初的"诚实能力边界"注释记录过"本仓库
// 目前没有一个真实的后厨采购清单云端集合"——这一版已经不成立：见
// index.js 新增的 daily_purchase_plans 集合 + getPurchasePlan/
// createPurchasePlan/togglePurchaseTask/updatePurchaseTaskWeight 四个
// action，支持同一门店的多个角色（义工/财务/店长/大家长）共享同一份
// 采购清单、跨设备/跨班次协同勾选。前端 daily-menu.ts 的本机 storage
// 缓存现在只是"进入弹窗前的乐观展示/离线兜底"，权威数据来源是云端。
// sanitizePurchasePlanTasks 是这次新增的服务端防线：绝不信任客户端提交的
// itemName/unit/remark 字段，一律按 itemKey 白名单重新从 INGREDIENT_ITEM_DEFS
// 派生，只信任客户端提交的 estimatedWeight（校验为正数）与 status
// （校验属于白名单）。

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

/**
 * 服务端防线：把客户端提交的 tasks 数组清洗成只包含白名单字段/取值的
 * 安全版本，供 createPurchasePlan 落库前调用。itemName/unit/remark 一律
 * 不信任客户端提交的文本，按 itemKey 从 INGREDIENT_ITEM_DEFS 重新派生——
 * 防止恶意/异常客户端往这三个展示字段里注入任意字符串。itemKey 不在
 * 白名单里、或 estimatedWeight 不是合法正数的任务整条丢弃，不做"尽量
 * 保留"的宽松兜底——采购清单的准确性直接影响真实采买行为，宁可少一条
 * 也不能有一条数据可疑的任务混进去。
 * @param {Array} rawTasks
 * @returns {Array<{itemKey:string, itemName:string, estimatedWeight:number, unit:string, status:'pending'|'completed', remark:string}>}
 */
function sanitizePurchasePlanTasks(rawTasks) {
  if (!Array.isArray(rawTasks)) return [];
  return rawTasks
    .map((t) => {
      if (!t || typeof t !== 'object') return null;
      const def = INGREDIENT_ITEM_DEFS.find((d) => d.key === t.itemKey);
      if (!def) return null;
      const weight = Number(t.estimatedWeight);
      if (!Number.isFinite(weight) || weight <= 0) return null;
      const status = TASK_STATUSES.includes(t.status) ? t.status : 'pending';
      return {
        itemKey: def.key,
        itemName: def.itemName,
        estimatedWeight: weight,
        unit: def.unit,
        status,
        remark: PURCHASE_TASK_REMARK
      };
    })
    .filter(Boolean);
}

/**
 * 采购清单文档的确定性 _id——同一家门店同一天只有一份清单，用
 * `storeId+dateString` 直接拼出主键，天然具备"重复创建时数据库主键唯一性
 * 兜底拒绝"的能力，与本仓库 liveFactoryCore 的 buildSettlement 确定性
 * _id 手法一致，不需要额外的"先查是否存在再决定插入/更新"两次往返。
 * @param {string} storeId
 * @param {string} dateString
 * @returns {string}
 */
function buildPurchasePlanId(storeId, dateString) {
  return `purchase_plan_${storeId}_${dateString}`;
}

module.exports = {
  buildPurchasePlan,
  togglePurchaseTaskStatus,
  updatePurchaseTaskWeight,
  formatPurchasePlanText,
  sanitizePurchasePlanTasks,
  buildPurchasePlanId,
  INGREDIENT_ITEM_DEFS,
  PURCHASE_TASK_REMARK,
  TASK_STATUSES
};
