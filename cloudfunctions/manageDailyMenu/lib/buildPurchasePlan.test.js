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

// ==================== buildPurchasePlan ====================

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
  tasks.forEach((t) => {
    assert.equal(t.status, 'pending');
    assert.equal(t.remark, PURCHASE_TASK_REMARK);
  });
});

test('buildPurchasePlan：数量为 0 或缺失的品类直接跳过，不生成"0斤"的空任务', () => {
  const tasks = buildPurchasePlan({ riceJin: 30, oilLiter: 0, vegetableJin: 50 });
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map((t) => t.itemKey), ['riceJin', 'vegetableJin']);
});

test('buildPurchasePlan：负数/非数字（字符串、null）品类一并跳过，不编造数据', () => {
  const tasks = buildPurchasePlan({ riceJin: -5, oilLiter: '3', vegetableJin: null, seasoningJin: 1.5 });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].itemKey, 'seasoningJin');
});

test('buildPurchasePlan：insufficientData 场景（推荐人次为 0，四项食材皆为 0）返回空数组', () => {
  const tasks = buildPurchasePlan({ riceJin: 0, oilLiter: 0, vegetableJin: 0, seasoningJin: 0 });
  assert.deepEqual(tasks, []);
});

test('buildPurchasePlan：ingredients 为 null/undefined/非对象时返回空数组，不抛异常', () => {
  assert.deepEqual(buildPurchasePlan(null), []);
  assert.deepEqual(buildPurchasePlan(undefined), []);
  assert.deepEqual(buildPurchasePlan('not an object'), []);
  assert.deepEqual(buildPurchasePlan(42), []);
});

test('INGREDIENT_ITEM_DEFS：与 predictMealDemand.js 的 computeIngredients 字段一一对应（四项，非五项/三项）', () => {
  assert.equal(INGREDIENT_ITEM_DEFS.length, 4);
  assert.deepEqual(INGREDIENT_ITEM_DEFS.map((d) => d.key), ['riceJin', 'oilLiter', 'vegetableJin', 'seasoningJin']);
});

// ==================== togglePurchaseTaskStatus ====================

test('togglePurchaseTaskStatus：pending 切换为 completed，其余任务不受影响', () => {
  const tasks = buildPurchasePlan({ riceJin: 30, oilLiter: 3 });
  const next = togglePurchaseTaskStatus(tasks, 'riceJin');
  assert.equal(next.find((t) => t.itemKey === 'riceJin').status, 'completed');
  assert.equal(next.find((t) => t.itemKey === 'oilLiter').status, 'pending');
  // 原数组不应被原地修改，仍是 pending，供 setData 场景对比前后差异
  assert.equal(tasks.find((t) => t.itemKey === 'riceJin').status, 'pending');
});

test('togglePurchaseTaskStatus：再次切换 completed 会切回 pending（可逆）', () => {
  const tasks = buildPurchasePlan({ riceJin: 30 });
  const once = togglePurchaseTaskStatus(tasks, 'riceJin');
  const twice = togglePurchaseTaskStatus(once, 'riceJin');
  assert.equal(twice[0].status, 'pending');
});

test('togglePurchaseTaskStatus：itemKey 不存在时原样返回，不抛异常', () => {
  const tasks = buildPurchasePlan({ riceJin: 30 });
  const next = togglePurchaseTaskStatus(tasks, 'not_exist');
  assert.deepEqual(next, tasks);
});

test('togglePurchaseTaskStatus：非数组输入兜底返回空数组', () => {
  assert.deepEqual(togglePurchaseTaskStatus(null, 'riceJin'), []);
  assert.deepEqual(togglePurchaseTaskStatus(undefined, 'riceJin'), []);
});

// ==================== updatePurchaseTaskWeight ====================

test('updatePurchaseTaskWeight：合法正数能正确更新对应任务的预估重量', () => {
  const tasks = buildPurchasePlan({ riceJin: 30 });
  const next = updatePurchaseTaskWeight(tasks, 'riceJin', '25.5');
  assert.equal(next[0].estimatedWeight, 25.5);
});

test('updatePurchaseTaskWeight：非法输入（空字符串/0/负数/非数字）原样保留旧值，不清零', () => {
  const tasks = buildPurchasePlan({ riceJin: 30 });
  assert.equal(updatePurchaseTaskWeight(tasks, 'riceJin', '')[0].estimatedWeight, 30);
  assert.equal(updatePurchaseTaskWeight(tasks, 'riceJin', '0')[0].estimatedWeight, 30);
  assert.equal(updatePurchaseTaskWeight(tasks, 'riceJin', '-5')[0].estimatedWeight, 30);
  assert.equal(updatePurchaseTaskWeight(tasks, 'riceJin', 'abc')[0].estimatedWeight, 30);
});

test('updatePurchaseTaskWeight：itemKey 不存在时原样返回，不抛异常', () => {
  const tasks = buildPurchasePlan({ riceJin: 30 });
  const next = updatePurchaseTaskWeight(tasks, 'not_exist', '10');
  assert.deepEqual(next, tasks);
});

// ==================== formatPurchasePlanText ====================

test('formatPurchasePlanText：未完成打空框、已完成打勾选框，末尾附生成备注', () => {
  let tasks = buildPurchasePlan({ riceJin: 30, oilLiter: 3 });
  tasks = togglePurchaseTaskStatus(tasks, 'riceJin');
  const text = formatPurchasePlanText(tasks);
  assert.equal(text, '☑ 大米 30斤\n☐ 食用油 3升\n（AI备餐生成）');
});

test('formatPurchasePlanText：空数组返回空字符串，不生成只有备注的无意义文本', () => {
  assert.equal(formatPurchasePlanText([]), '');
  assert.equal(formatPurchasePlanText(null), '');
});
