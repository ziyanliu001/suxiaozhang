'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProductInput } = require('./validateProduct');

const BASE = { name: '手工豆腐 500g', price: 1500, dailyCapacityLimit: 20, leadTimeDays: 1 };

test('合法商品字段通过校验', () => {
  const res = validateProductInput(BASE);
  assert.equal(res.valid, true);
  assert.equal(res.name, '手工豆腐 500g');
});

test('商品名称为空时拒绝', () => {
  assert.equal(validateProductInput({ ...BASE, name: '  ' }).valid, false);
});

test('价格为 0/负数/非整数时拒绝', () => {
  assert.equal(validateProductInput({ ...BASE, price: 0 }).valid, false);
  assert.equal(validateProductInput({ ...BASE, price: -100 }).valid, false);
  assert.equal(validateProductInput({ ...BASE, price: 15.5 }).valid, false);
});

test('单日产能上限为 0/负数/非整数时拒绝', () => {
  assert.equal(validateProductInput({ ...BASE, dailyCapacityLimit: 0 }).valid, false);
  assert.equal(validateProductInput({ ...BASE, dailyCapacityLimit: -1 }).valid, false);
  assert.equal(validateProductInput({ ...BASE, dailyCapacityLimit: 2.5 }).valid, false);
});

test('前置天数为负数/非整数时拒绝，为 0 时允许（当日即可排产）', () => {
  assert.equal(validateProductInput({ ...BASE, leadTimeDays: -1 }).valid, false);
  assert.equal(validateProductInput({ ...BASE, leadTimeDays: 0.5 }).valid, false);
  assert.equal(validateProductInput({ ...BASE, leadTimeDays: 0 }).valid, true);
});

test('materialList 未提供时跳过物料校验', () => {
  assert.equal(validateProductInput(BASE).valid, true);
});

test('materialList 合法时通过', () => {
  const res = validateProductInput({ ...BASE, materialList: [{ materialName: '黄豆', qtyPerUnit: 0.3, unit: 'kg' }] });
  assert.equal(res.valid, true);
});

test('materialList 项缺少 materialName 时拒绝', () => {
  const res = validateProductInput({ ...BASE, materialList: [{ qtyPerUnit: 0.3 }] });
  assert.equal(res.valid, false);
});

test('materialList 项 qtyPerUnit 非正数时拒绝', () => {
  const res = validateProductInput({ ...BASE, materialList: [{ materialName: '黄豆', qtyPerUnit: 0 }] });
  assert.equal(res.valid, false);
});

test('materialList 不是数组时拒绝', () => {
  const res = validateProductInput({ ...BASE, materialList: '黄豆' });
  assert.equal(res.valid, false);
});

test('producerOpenId 未提供时合法，返回空字符串（不编造归属）', () => {
  const res = validateProductInput(BASE);
  assert.equal(res.valid, true);
  assert.equal(res.producerOpenId, '');
});

test('producerOpenId 提供时原样（trim 后）返回', () => {
  const res = validateProductInput({ ...BASE, producerOpenId: '  oProducerOpenId123  ' });
  assert.equal(res.valid, true);
  assert.equal(res.producerOpenId, 'oProducerOpenId123');
});

test('producerOpenId 超长时拒绝', () => {
  const res = validateProductInput({ ...BASE, producerOpenId: 'x'.repeat(200) });
  assert.equal(res.valid, false);
});
