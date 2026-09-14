'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTenantDisplayName, buildPlanLabel } = require('./tenantInfoLabels');

test('resolveTenantDisplayName: 优先取 name 字段', () => {
  assert.equal(resolveTenantDisplayName({ name: '雨花斋总部', tenantName: '备用名' }), '雨花斋总部');
});

test('resolveTenantDisplayName: name 缺失时兜底 tenantName', () => {
  assert.equal(resolveTenantDisplayName({ tenantName: '嵩屿助餐点机构' }), '嵩屿助餐点机构');
});

test('resolveTenantDisplayName: 两个字段都缺失时返回空字符串', () => {
  assert.equal(resolveTenantDisplayName({}), '');
});

test('resolveTenantDisplayName: 文档本身为 null/undefined 时返回空字符串', () => {
  assert.equal(resolveTenantDisplayName(null), '');
  assert.equal(resolveTenantDisplayName(undefined), '');
});

test('buildPlanLabel: pro -> 专业版', () => {
  assert.equal(buildPlanLabel('pro'), '专业版');
});

test('buildPlanLabel: enterprise -> 旗舰版', () => {
  assert.equal(buildPlanLabel('enterprise'), '旗舰版');
});

test('buildPlanLabel: basic -> 基础免费版', () => {
  assert.equal(buildPlanLabel('basic'), '基础免费版');
});

test('buildPlanLabel: 未知/缺失 planType 兜底为基础免费版', () => {
  assert.equal(buildPlanLabel(undefined), '基础免费版');
  assert.equal(buildPlanLabel(''), '基础免费版');
  assert.equal(buildPlanLabel('some_future_plan'), '基础免费版');
});
