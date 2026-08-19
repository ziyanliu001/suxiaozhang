'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeOpsStats, emptyStats } = require('./computeOpsStats');

const NOW = new Date('2026-08-19T12:00:00');

function daysAgo(n) {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

test('空订单数组返回全零统计', () => {
  assert.deepEqual(computeOpsStats([], {}, NOW, 7), emptyStats());
});

test('区间内的已发货订单正确累加单量/份数/结算金额', () => {
  const orders = [
    { _id: 'o1', quantity: 3, shippedAt: daysAgo(1) },
    { _id: 'o2', quantity: 5, shippedAt: daysAgo(2) }
  ];
  const settlements = {
    o1: { producerAmount: 800, promoterAmount: 50, platformFee: 150 },
    o2: { producerAmount: 1200, promoterAmount: 0, platformFee: 300 }
  };
  const stats = computeOpsStats(orders, settlements, NOW, 7);
  assert.equal(stats.orderCount, 2);
  assert.equal(stats.totalQuantity, 8);
  assert.equal(stats.producerAmount, 2000);
  assert.equal(stats.promoterAmount, 50);
  assert.equal(stats.platformFee, 450);
});

test('区间外（超过 rangeDays 天前）的订单不计入', () => {
  const orders = [
    { _id: 'o1', quantity: 1, shippedAt: daysAgo(10) } // 超出 7 天窗口
  ];
  const stats = computeOpsStats(orders, { o1: { producerAmount: 100, promoterAmount: 0, platformFee: 0 } }, NOW, 7);
  assert.equal(stats.orderCount, 0);
  assert.equal(stats.producerAmount, 0);
});

test('边界值：恰好 rangeDays 天前（含端点）计入', () => {
  const orders = [{ _id: 'o1', quantity: 2, shippedAt: daysAgo(7) }];
  const stats = computeOpsStats(orders, {}, NOW, 7);
  assert.equal(stats.orderCount, 1);
});

test('未来时间戳（异常数据/时钟偏差）不计入', () => {
  const future = new Date(NOW);
  future.setDate(future.getDate() + 1);
  const orders = [{ _id: 'o1', quantity: 1, shippedAt: future.toISOString() }];
  const stats = computeOpsStats(orders, {}, NOW, 7);
  assert.equal(stats.orderCount, 0);
});

test('缺少 shippedAt 的订单不计入，不猜测发货时间', () => {
  const orders = [{ _id: 'o1', quantity: 1 }];
  const stats = computeOpsStats(orders, {}, NOW, 7);
  assert.equal(stats.orderCount, 0);
});

test('找不到对应结算行的订单：单量正常计入，金额按 0 处理（防御性，不阻断统计）', () => {
  const orders = [{ _id: 'o_no_settlement', quantity: 4, shippedAt: daysAgo(1) }];
  const stats = computeOpsStats(orders, {}, NOW, 7);
  assert.equal(stats.orderCount, 1);
  assert.equal(stats.totalQuantity, 4);
  assert.equal(stats.producerAmount, 0);
});

test('7 天与 30 天窗口对同一批订单给出不同结果（区间筛选真的生效）', () => {
  const orders = [
    { _id: 'o1', quantity: 1, shippedAt: daysAgo(3) },  // 7天/30天都算
    { _id: 'o2', quantity: 1, shippedAt: daysAgo(15) }  // 只有30天算
  ];
  const last7 = computeOpsStats(orders, {}, NOW, 7);
  const last30 = computeOpsStats(orders, {}, NOW, 30);
  assert.equal(last7.orderCount, 1);
  assert.equal(last30.orderCount, 2);
});

test('rangeDays 非法（0/负数/非数字）时返回全零', () => {
  const orders = [{ _id: 'o1', quantity: 1, shippedAt: daysAgo(1) }];
  assert.deepEqual(computeOpsStats(orders, {}, NOW, 0), emptyStats());
  assert.deepEqual(computeOpsStats(orders, {}, NOW, -5), emptyStats());
  assert.deepEqual(computeOpsStats(orders, {}, NOW, NaN), emptyStats());
});

test('settlementByOrderId 缺省（undefined）时不抛异常，金额按 0 处理', () => {
  const orders = [{ _id: 'o1', quantity: 2, shippedAt: daysAgo(1) }];
  const stats = computeOpsStats(orders, undefined, NOW, 7);
  assert.equal(stats.orderCount, 1);
  assert.equal(stats.producerAmount, 0);
});

test('quantity 缺失/非数字时按 0 处理，不污染 NaN', () => {
  const orders = [{ _id: 'o1', shippedAt: daysAgo(1) }];
  const stats = computeOpsStats(orders, {}, NOW, 7);
  assert.equal(stats.totalQuantity, 0);
  assert.ok(!Number.isNaN(stats.totalQuantity));
});
