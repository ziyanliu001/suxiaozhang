'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSpacesList } = require('./buildSpacesList');

test('空 memberships 返回空数组', () => {
  assert.deepEqual(buildSpacesList([], {}), []);
});

test('多个不同租户的成员记录，各自独立、互不污染（数据隔离）', () => {
  const memberships = [
    { tenantId: 't1', role: 'space_owner' },
    { tenantId: 't2', role: 'producer' }
  ];
  const spaces = buildSpacesList(memberships, { t1: '工坊A', t2: '工坊B' });
  assert.equal(spaces.length, 2);
  const byId = Object.fromEntries(spaces.map((s) => [s.tenantId, s]));
  assert.equal(byId.t1.tenantName, '工坊A');
  assert.equal(byId.t1.role, 'space_owner');
  assert.equal(byId.t2.tenantName, '工坊B');
  assert.equal(byId.t2.role, 'producer');
});

test('同一租户出现多条角色记录时按权限等级去重，只保留权限更高的那条', () => {
  const memberships = [
    { tenantId: 't1', role: 'producer' },
    { tenantId: 't1', role: 'space_owner' } // 后出现但权限更高，应该覆盖
  ];
  const spaces = buildSpacesList(memberships, { t1: '工坊A' });
  assert.equal(spaces.length, 1);
  assert.equal(spaces[0].role, 'space_owner');
});

test('去重时权限记录出现顺序不影响结果（低权限在后也不会覆盖高权限）', () => {
  const memberships = [
    { tenantId: 't1', role: 'space_owner' },
    { tenantId: 't1', role: 'producer' }
  ];
  const spaces = buildSpacesList(memberships, { t1: '工坊A' });
  assert.equal(spaces.length, 1);
  assert.equal(spaces[0].role, 'space_owner');
});

test('tenantNameMap 缺少对应条目时用兜底名称，不返回 undefined', () => {
  const spaces = buildSpacesList([{ tenantId: 't1', role: 'producer' }], {});
  assert.equal(spaces[0].tenantName, '未命名工坊');
});

test('tenantNameMap 为空/未传时同样兜底，不抛异常', () => {
  const spaces = buildSpacesList([{ tenantId: 't1', role: 'producer' }], undefined);
  assert.equal(spaces[0].tenantName, '未命名工坊');
});

test('缺少 tenantId 的脏记录被忽略，不产生垃圾条目', () => {
  const memberships = [{ role: 'producer' }, { tenantId: '', role: 'producer' }, { tenantId: 't1', role: 'producer' }];
  const spaces = buildSpacesList(memberships, { t1: '工坊A' });
  assert.equal(spaces.length, 1);
  assert.equal(spaces[0].tenantId, 't1');
});

test('三个及以上不同租户混合去重场景', () => {
  const memberships = [
    { tenantId: 't1', role: 'producer' },
    { tenantId: 't2', role: 'space_owner' },
    { tenantId: 't1', role: 'space_admin' }, // t1 应该升级为 space_admin
    { tenantId: 't3', role: 'space_owner' }
  ];
  const spaces = buildSpacesList(memberships, { t1: 'A', t2: 'B', t3: 'C' });
  assert.equal(spaces.length, 3);
  const byId = Object.fromEntries(spaces.map((s) => [s.tenantId, s.role]));
  assert.equal(byId.t1, 'space_admin');
  assert.equal(byId.t2, 'space_owner');
  assert.equal(byId.t3, 'space_owner');
});
