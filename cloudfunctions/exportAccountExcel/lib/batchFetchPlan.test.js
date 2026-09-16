'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SINGLE_QUERY_MAX, nextBatchSize, isPastDeadline } = require('./batchFetchPlan');

test('nextBatchSize 未接近上限时返回单次查询硬上限（1000）', () => {
  assert.equal(nextBatchSize(0, 5000), SINGLE_QUERY_MAX);
  assert.equal(nextBatchSize(1000, 5000), SINGLE_QUERY_MAX);
});

test('nextBatchSize 接近 maxTotal 时收窄到剩余条数，不超发', () => {
  assert.equal(nextBatchSize(4500, 5000), 500);
  assert.equal(nextBatchSize(4999, 5000), 1);
});

test('nextBatchSize 已拉满或超过 maxTotal 时返回 0（调用方据此停止循环）', () => {
  assert.equal(nextBatchSize(5000, 5000), 0);
  assert.equal(nextBatchSize(5001, 5000), 0);
});

test('nextBatchSize 即使 maxTotal 小于单次上限，也不会返回超过 maxTotal 的值', () => {
  assert.equal(nextBatchSize(0, 200), 200);
});

test('isPastDeadline 未传 deadline 时永不视为超时', () => {
  assert.equal(isPastDeadline(undefined, Date.now() + 999999), false);
});

test('isPastDeadline 当前时间已达到或超过截止时间戳时返回 true', () => {
  assert.equal(isPastDeadline(1000, 1000), true);
  assert.equal(isPastDeadline(1000, 1001), true);
});

test('isPastDeadline 当前时间早于截止时间戳时返回 false', () => {
  assert.equal(isPastDeadline(2000, 1000), false);
});
