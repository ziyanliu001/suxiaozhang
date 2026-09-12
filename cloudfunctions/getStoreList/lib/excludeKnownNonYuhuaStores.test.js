'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { excludeKnownNonYuhuaStores } = require('./excludeKnownNonYuhuaStores');

test('orgType 不是 yuhuazhai 时原样返回，不做任何过滤', () => {
  const list = [{ storeName: '嵩屿街道敬老中心' }, { storeName: '海沧长者食堂' }];
  assert.deepEqual(excludeKnownNonYuhuaStores('elderly_canteen', list), list);
  assert.deepEqual(excludeKnownNonYuhuaStores('', list), list);
  assert.deepEqual(excludeKnownNonYuhuaStores(undefined, list), list);
});

test('orgType 为 yuhuazhai 时，剔除店名包含已知非雨花斋关键词的门店', () => {
  const list = [
    { storeName: '嵩屿街道敬老中心' },
    { storeName: '厦门海沧三泓愿' },
    { storeName: '漳州白礁保生雨花斋' }
  ];
  const result = excludeKnownNonYuhuaStores('yuhuazhai', list);
  assert.deepEqual(result.map((s) => s.storeName), ['厦门海沧三泓愿', '漳州白礁保生雨花斋']);
});

test('店名带"助餐点"等后缀变体依然能被关键词命中并剔除', () => {
  const list = [{ storeName: '嵩屿街道敬老中心助餐点' }, { storeName: '厦门海沧三泓愿' }];
  const result = excludeKnownNonYuhuaStores('yuhuazhai', list);
  assert.deepEqual(result.map((s) => s.storeName), ['厦门海沧三泓愿']);
});

test('列表为空/undefined 时不抛异常，返回空数组', () => {
  assert.deepEqual(excludeKnownNonYuhuaStores('yuhuazhai', []), []);
  assert.deepEqual(excludeKnownNonYuhuaStores('yuhuazhai', undefined), []);
  assert.deepEqual(excludeKnownNonYuhuaStores('elderly_canteen', undefined), []);
});

test('列表里混入 null/畸形条目（缺 storeName）不抛异常，正常保留（不含已知关键词）', () => {
  const list = [null, {}, { storeName: '' }, { storeName: '厦门海沧三泓愿' }];
  const result = excludeKnownNonYuhuaStores('yuhuazhai', list);
  assert.equal(result.length, 4);
  assert.equal(result[0], null);
  assert.deepEqual(result[1], {});
  assert.equal(result[2].storeName, '');
  assert.equal(result[3].storeName, '厦门海沧三泓愿');
});
