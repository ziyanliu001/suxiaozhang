'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MERIT_TAGS, sanitizeMeritTags } = require('./sanitizeMeritTags');

test('未传值（undefined）时返回空数组，不抛异常', () => {
  assert.deepEqual(sanitizeMeritTags(undefined), []);
});

test('null 时返回空数组', () => {
  assert.deepEqual(sanitizeMeritTags(null), []);
});

test('非数组（字符串/对象/数字）时返回空数组，不当成可迭代对象处理', () => {
  assert.deepEqual(sanitizeMeritTags('almsgiving'), []);
  assert.deepEqual(sanitizeMeritTags({ value: 'almsgiving' }), []);
  assert.deepEqual(sanitizeMeritTags(42), []);
});

test('空数组原样返回空数组', () => {
  assert.deepEqual(sanitizeMeritTags([]), []);
});

test('全部合法值原样保留，顺序不变', () => {
  const input = ['almsgiving', 'kindwords', 'thrift', 'cleaning'];
  assert.deepEqual(sanitizeMeritTags(input), input);
});

test('过滤掉不在白名单内的非法值，只保留合法项', () => {
  assert.deepEqual(
    sanitizeMeritTags(['almsgiving', 'not_a_real_tag', 'thrift', '功过格']),
    ['almsgiving', 'thrift']
  );
});

test('全部是非法值时返回空数组', () => {
  assert.deepEqual(sanitizeMeritTags(['foo', 'bar']), []);
});

test('重复值不去重——白名单校验本身不负责去重，调用方如需去重应自行处理', () => {
  assert.deepEqual(
    sanitizeMeritTags(['almsgiving', 'almsgiving']),
    ['almsgiving', 'almsgiving']
  );
});

test('数组元素为 null/undefined/数字等非字符串类型时，includes 比较不匹配，一律过滤掉', () => {
  assert.deepEqual(sanitizeMeritTags([null, undefined, 1, 'thrift']), ['thrift']);
});

test('MERIT_TAGS 白名单本身是 4 个值，且与 sanitizeMeritTags 校验依据的是同一份引用', () => {
  assert.deepEqual(MERIT_TAGS, ['almsgiving', 'kindwords', 'thrift', 'cleaning']);
  // 遍历白名单里的每一个值单独传入，都应该原样通过校验——防止未来有人改了
  // MERIT_TAGS 数组却忘了同步更新这份测试，用同一份数据源反过来驱动断言
  MERIT_TAGS.forEach((tag) => {
    assert.deepEqual(sanitizeMeritTags([tag]), [tag]);
  });
});
