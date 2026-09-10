'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPurchasePlan,
  togglePurchaseTaskStatus,
  updatePurchaseTaskWeight,
  formatPurchasePlanText,
  INGREDIENT_ITEM_DEFS,
  PURCHASE_TASK_REMARK
} = require('./buildPurchasePlan');

// 与 cloudfunctions/manageDailyMenu/lib/buildPurchasePlan.test.js 覆盖同一套
// 行为契约（两处独立维护的镜像模块，见该文件头部注释）——保持两份用例
// 逐条对应，任一处逻辑漂移都能被各自的单测立刻抓到。

test('buildPurchasePlan：四项食材齐全时生成四条采买待办，字段与顺序正确', () => {
  const tasks = buildPurchasePlan({ riceJin: 30, oilLiter: 3, vegetableJin: 50, seasoningJin: 2 });
  assert.equal(tasks.length, 4);
  assert.deepEqual(tasks.map((t) => t.itemKey), ['riceJin', 'oilLiter', 'vegetableJin', 'seasoningJin']);
  assert.deepEqual(tasks[0], {
    itemKey: 'riceJin',
    itemName: '大米',
    estimatedWeight: 30,
    unit: '斤',
    status: 'pending',
    remark: 'AI备餐生成'
  });
});

test('buildPurchasePlan：数量为 0 或缺失的品类直接跳过，不生成"0斤"的空任务', () => {
  const tasks = buildPurchasePlan({ riceJin: 30, oilLiter: 0, vegetableJin: 50 });
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map((t) => t.itemKey), ['riceJin', 'vegetableJin']);
});

test('buildPurchasePlan：负数/非数字（字符串、null）品类一并跳过', () => {
  const tasks = buildPurchasePlan({ riceJin: -5, oilLiter: '3', vegetableJin: null, seasoningJin: 1.5 });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].itemKey, 'seasoningJin');
});

test('buildPurchasePlan：insufficientData 场景（四项食材皆为 0）返回空数组', () => {
  assert.deepEqual(buildPurchasePlan({ riceJin: 0, oilLiter: 0, vegetableJin: 0, seasoningJin: 0 }), []);
});

test('buildPurchasePlan：ingredients 为 null/undefined/非对象时返回空数组，不抛异常', () => {
  assert.deepEqual(buildPurchasePlan(null), []);
  assert.deepEqual(buildPurchasePlan(undefined), []);
  assert.deepEqual(buildPurchasePlan('not an object'), []);
});

test('INGREDIENT_ITEM_DEFS：四项且字段名与 predictMealDemand.js 的 computeIngredients 一致', () => {
  assert.equal(INGREDIENT_ITEM_DEFS.length, 4);
  assert.deepEqual(INGREDIENT_ITEM_DEFS.map((d) => d.key), ['riceJin', 'oilLiter', 'vegetableJin', 'seasoningJin']);
});

test('togglePurchaseTaskStatus：pending 与 completed 之间可逆切换，不影响其余任务', () => {
  const tasks = buildPurchasePlan({ riceJin: 30, oilLiter: 3 });
  const once = togglePurchaseTaskStatus(tasks, 'riceJin');
  assert.equal(once.find((t) => t.itemKey === 'riceJin').status, 'completed');
  assert.equal(once.find((t) => t.itemKey === 'oilLiter').status, 'pending');
  const twice = togglePurchaseTaskStatus(once, 'riceJin');
  assert.equal(twice.find((t) => t.itemKey === 'riceJin').status, 'pending');
});

test('togglePurchaseTaskStatus：itemKey 不存在或非数组输入时安全兜底', () => {
  const tasks = buildPurchasePlan({ riceJin: 30 });
  assert.deepEqual(togglePurchaseTaskStatus(tasks, 'not_exist'), tasks);
  assert.deepEqual(togglePurchaseTaskStatus(null, 'riceJin'), []);
});

test('updatePurchaseTaskWeight：合法正数更新，非法输入（空/0/负数/非数字）保留旧值不清零', () => {
  const tasks = buildPurchasePlan({ riceJin: 30 });
  assert.equal(updatePurchaseTaskWeight(tasks, 'riceJin', '25.5')[0].estimatedWeight, 25.5);
  assert.equal(updatePurchaseTaskWeight(tasks, 'riceJin', '')[0].estimatedWeight, 30);
  assert.equal(updatePurchaseTaskWeight(tasks, 'riceJin', '0')[0].estimatedWeight, 30);
  assert.equal(updatePurchaseTaskWeight(tasks, 'riceJin', '-5')[0].estimatedWeight, 30);
  assert.equal(updatePurchaseTaskWeight(tasks, 'riceJin', 'abc')[0].estimatedWeight, 30);
});

test('formatPurchasePlanText：勾选框状态正确展示，末尾附生成备注；空清单返回空字符串', () => {
  let tasks = buildPurchasePlan({ riceJin: 30, oilLiter: 3 });
  tasks = togglePurchaseTaskStatus(tasks, 'riceJin');
  assert.equal(formatPurchasePlanText(tasks), '☑ 大米 30斤\n☐ 食用油 3升\n（AI备餐生成）');
  assert.equal(formatPurchasePlanText([]), '');
  assert.equal(formatPurchasePlanText(null), '');
});
