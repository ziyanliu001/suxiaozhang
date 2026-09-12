'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveWorkspaceForOrgType } = require('./resolveWorkspace');

test('orgType 为空字符串时返回 null——未归属任何真实门店的账号不能替它猜专区', () => {
  assert.equal(resolveWorkspaceForOrgType(''), null);
});

test('orgType 为 undefined/null 时同样返回 null，不抛异常', () => {
  assert.equal(resolveWorkspaceForOrgType(undefined), null);
  assert.equal(resolveWorkspaceForOrgType(null), null);
});

test('orgType 为 yuhuazhai 时映射到 yuhua 专区', () => {
  assert.equal(resolveWorkspaceForOrgType('yuhuazhai'), 'yuhua');
});

test('orgType 为其余任何真实取值时统一映射到 general 专区', () => {
  assert.equal(resolveWorkspaceForOrgType('elderly_canteen'), 'general');
  assert.equal(resolveWorkspaceForOrgType('volunteer_station'), 'general');
  assert.equal(resolveWorkspaceForOrgType('rescue_team'), 'general');
  assert.equal(resolveWorkspaceForOrgType('tongxin_children'), 'general');
  assert.equal(resolveWorkspaceForOrgType('other'), 'general');
});
