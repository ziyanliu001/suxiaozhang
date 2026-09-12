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

test('orgType 命中已知非雨花斋分类时，即使店名完全不含关键词也会被剔除', () => {
  const list = [
    { storeName: '随便起的名字', orgType: 'elderly_canteen' },
    { storeName: '另一家', orgType: 'elderly_care' },
    { storeName: '厦门海沧三泓愿', orgType: '' }
  ];
  const result = excludeKnownNonYuhuaStores('yuhuazhai', list);
  assert.deepEqual(result.map((s) => s.storeName), ['厦门海沧三泓愿']);
});

test('店名关键词与 orgType 两个信号任一命中即排除，不要求同时命中', () => {
  // 店名含"嵩屿"但 orgType 缺失——应被店名信号拦下
  const byName = excludeKnownNonYuhuaStores('yuhuazhai', [{ storeName: '嵩屿街道敬老中心助餐点' }]);
  assert.deepEqual(byName, []);
  // 店名不含关键词但 orgType 命中——应被 orgType 信号拦下
  const byOrgType = excludeKnownNonYuhuaStores('yuhuazhai', [{ storeName: '完全不相关的名字', orgType: 'elderly_canteen' }]);
  assert.deepEqual(byOrgType, []);
  // 两者都不命中——正常保留
  const kept = excludeKnownNonYuhuaStores('yuhuazhai', [{ storeName: '厦门海沧三泓愿', orgType: 'yuhuazhai' }]);
  assert.equal(kept.length, 1);
});
