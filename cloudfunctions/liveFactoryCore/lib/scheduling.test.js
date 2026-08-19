'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assignProductionBatch, makeDbReserveFn, makeDbReleaseFn, MAX_LOOKAHEAD_DAYS } = require('./scheduling');
const { createFakeDb } = require('./testUtils/fakeDb');

const ORDER_TIME = new Date('2026-08-19T10:00:00');

function inMemoryReserveFn(state) {
  // state: { [dateStr]: reservedCount }
  return async function reserveFn(dateStr, quantity, limit) {
    const reserved = state[dateStr] || 0;
    if (reserved + quantity > limit) return false;
    state[dateStr] = reserved + quantity;
    return true;
  };
}

test('首选批次日有余量时直接命中 leadTimeDays 推算出的日期', async () => {
  const state = {};
  const res = await assignProductionBatch({
    dailyCapacityLimit: 10, leadTimeDays: 2, quantity: 3,
    orderCreateTime: ORDER_TIME, reserveFn: inMemoryReserveFn(state)
  });
  assert.equal(res.success, true);
  assert.equal(res.batchDate, '2026-08-21');
  assert.equal(res.estimatedShippingDate, '2026-08-22');
});

test('单日产能售罄自动顺延至下一可用生产日', async () => {
  const state = { '2026-08-21': 10 }; // 首选日已满
  const res = await assignProductionBatch({
    dailyCapacityLimit: 10, leadTimeDays: 2, quantity: 5,
    orderCreateTime: ORDER_TIME, reserveFn: inMemoryReserveFn(state)
  });
  assert.equal(res.success, true);
  assert.equal(res.batchDate, '2026-08-22');
});

test('连续多天售罄时顺延到第一个仍有余量的日期', async () => {
  const state = { '2026-08-21': 10, '2026-08-22': 10, '2026-08-23': 10 };
  const res = await assignProductionBatch({
    dailyCapacityLimit: 10, leadTimeDays: 2, quantity: 1,
    orderCreateTime: ORDER_TIME, reserveFn: inMemoryReserveFn(state)
  });
  assert.equal(res.success, true);
  assert.equal(res.batchDate, '2026-08-24');
});

test('单次下单数量超过单日产能上限直接拒绝，不进入日期搜索', async () => {
  let called = false;
  const res = await assignProductionBatch({
    dailyCapacityLimit: 10, leadTimeDays: 2, quantity: 11,
    orderCreateTime: ORDER_TIME,
    reserveFn: async () => { called = true; return true; }
  });
  assert.equal(res.success, false);
  assert.match(res.error, /超过该商品单日产能上限/);
  assert.equal(called, false);
});

test('近期排期全部售罄时返回明确错误而不是无限循环', async () => {
  const res = await assignProductionBatch({
    dailyCapacityLimit: 10, leadTimeDays: 0, quantity: 1,
    orderCreateTime: ORDER_TIME,
    reserveFn: async () => false // 永远占用失败，模拟排期已满
  });
  assert.equal(res.success, false);
  assert.match(res.error, /排期已满/);
});

test('前置天数被正确应用：即使更早的日期有空余也不会提前排期', async () => {
  const state = {}; // 所有日期都空
  const res = await assignProductionBatch({
    dailyCapacityLimit: 10, leadTimeDays: 5, quantity: 1,
    orderCreateTime: ORDER_TIME, reserveFn: inMemoryReserveFn(state)
  });
  assert.equal(res.batchDate, '2026-08-24');
});

// ── preferredDate：买家在预售日历上选定具体批次日 ──────────────────────────

test('preferredDate：买家选中的日期有余量时精确命中该日，不做顺延', async () => {
  const state = { '2026-08-21': 5 }; // 首选日已占用一部分但没满
  const res = await assignProductionBatch({
    dailyCapacityLimit: 10, leadTimeDays: 2, quantity: 3,
    orderCreateTime: ORDER_TIME, reserveFn: inMemoryReserveFn(state),
    preferredDate: '2026-08-25'
  });
  assert.equal(res.success, true);
  assert.equal(res.batchDate, '2026-08-25');
  assert.equal(res.estimatedShippingDate, '2026-08-26');
});

test('preferredDate：选中日期已约满时明确拒绝，不静默改派到别的日期', async () => {
  const state = { '2026-08-25': 10 };
  const res = await assignProductionBatch({
    dailyCapacityLimit: 10, leadTimeDays: 2, quantity: 1,
    orderCreateTime: ORDER_TIME, reserveFn: inMemoryReserveFn(state),
    preferredDate: '2026-08-25'
  });
  assert.equal(res.success, false);
  assert.match(res.error, /已约满/);
  // 关键：没有被改派到别的日期——state 里除了 2026-08-25 以外都不应该被占用
  assert.equal(state['2026-08-26'], undefined);
});

test('preferredDate：早于最短前置天数允许的最早日期时拒绝', async () => {
  const state = {};
  const res = await assignProductionBatch({
    dailyCapacityLimit: 10, leadTimeDays: 5, quantity: 1,
    orderCreateTime: ORDER_TIME, reserveFn: inMemoryReserveFn(state),
    preferredDate: '2026-08-20' // 最早只能选 2026-08-24（leadTimeDays=5）
  });
  assert.equal(res.success, false);
  assert.match(res.error, /最早可选/);
});

test('preferredDate：恰好等于最早可选日期时允许（边界值）', async () => {
  const state = {};
  const res = await assignProductionBatch({
    dailyCapacityLimit: 10, leadTimeDays: 2, quantity: 1,
    orderCreateTime: ORDER_TIME, reserveFn: inMemoryReserveFn(state),
    preferredDate: '2026-08-21'
  });
  assert.equal(res.success, true);
  assert.equal(res.batchDate, '2026-08-21');
});

test('preferredDate：格式非法时拒绝', async () => {
  const res = await assignProductionBatch({
    dailyCapacityLimit: 10, leadTimeDays: 2, quantity: 1,
    orderCreateTime: ORDER_TIME, reserveFn: async () => true,
    preferredDate: '08/21/2026'
  });
  assert.equal(res.success, false);
  assert.match(res.error, /格式不正确/);
});

test('preferredDate：单次下单量超过单日产能上限时优先拒绝，不进入日期校验', async () => {
  const res = await assignProductionBatch({
    dailyCapacityLimit: 10, leadTimeDays: 2, quantity: 11,
    orderCreateTime: ORDER_TIME, reserveFn: async () => true,
    preferredDate: '2026-08-25'
  });
  assert.equal(res.success, false);
  assert.match(res.error, /超过该商品单日产能上限/);
});

test('未传 preferredDate 时行为与此前完全一致（自动找最早可用日）', async () => {
  const state = { '2026-08-21': 10 };
  const res = await assignProductionBatch({
    dailyCapacityLimit: 10, leadTimeDays: 2, quantity: 1,
    orderCreateTime: ORDER_TIME, reserveFn: inMemoryReserveFn(state)
  });
  assert.equal(res.success, true);
  assert.equal(res.batchDate, '2026-08-22');
});

// ── CAS 适配层（makeDbReserveFn / makeDbReleaseFn）：验证并发安全逻辑本身 ──

test('makeDbReserveFn：容量充足时原子占用成功', async () => {
  const db = createFakeDb([{ tenantId: 't1', productId: 'p1', batchDate: '2026-08-21', reserved: 3, limit: 10 }]);
  const reserveFn = makeDbReserveFn(db, 't1', 'p1');
  const ok = await reserveFn('2026-08-21', 5, 10);
  assert.equal(ok, true);
  assert.equal(db._dump()[0].reserved, 8);
});

test('makeDbReserveFn：容量不足时占用失败且不改变已占用数', async () => {
  const db = createFakeDb([{ tenantId: 't1', productId: 'p1', batchDate: '2026-08-21', reserved: 8, limit: 10 }]);
  const reserveFn = makeDbReserveFn(db, 't1', 'p1');
  const ok = await reserveFn('2026-08-21', 5, 10);
  assert.equal(ok, false);
  assert.equal(db._dump()[0].reserved, 8);
});

test('makeDbReserveFn：日期首次被占用时惰性建档', async () => {
  const db = createFakeDb([]); // 该批次日尚无计数器文档
  const reserveFn = makeDbReserveFn(db, 't1', 'p1');
  const ok = await reserveFn('2026-08-21', 4, 10);
  assert.equal(ok, true);
  assert.equal(db._dump().length, 1);
  assert.equal(db._dump()[0].reserved, 4);
});

test('makeDbReleaseFn：退款释放产能后 reserved 正确回退', async () => {
  const db = createFakeDb([{ tenantId: 't1', productId: 'p1', batchDate: '2026-08-21', reserved: 8, limit: 10 }]);
  const releaseFn = makeDbReleaseFn(db, 't1', 'p1');
  await releaseFn('2026-08-21', 5);
  assert.equal(db._dump()[0].reserved, 3);
});

test('makeDbReleaseFn：释放数量超过已占用数时不会减到负数（防御性丢弃）', async () => {
  const db = createFakeDb([{ tenantId: 't1', productId: 'p1', batchDate: '2026-08-21', reserved: 2, limit: 10 }]);
  const releaseFn = makeDbReleaseFn(db, 't1', 'p1');
  await releaseFn('2026-08-21', 5); // gte(5) 条件不满足，where 匹配不到，静默跳过
  assert.equal(db._dump()[0].reserved, 2);
});

test('MAX_LOOKAHEAD_DAYS 是一个有限的正数（防止顺延算法失控）', () => {
  assert.ok(MAX_LOOKAHEAD_DAYS > 0 && MAX_LOOKAHEAD_DAYS < 365);
});
