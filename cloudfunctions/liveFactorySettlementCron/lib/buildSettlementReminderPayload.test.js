'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSettlementReminderPayload, truncateThing } = require('./buildSettlementReminderPayload');

const BASE = {
  ownerOpenId: 'oOwner123',
  templateId: 'tmpl_settlement',
  tenantName: '小林豆坊',
  pendingCount: 3,
  pendingAmountYuan: '256.80'
};

test('ownerOpenId 缺失时返回 null（明确跳过，不是抛错）', () => {
  assert.equal(buildSettlementReminderPayload({ ...BASE, ownerOpenId: '' }), null);
});

test('templateId 缺失时返回 null（模板未配置场景）', () => {
  assert.equal(buildSettlementReminderPayload({ ...BASE, templateId: '' }), null);
});

test('pendingCount 为 0 或负数时返回 null（没有待确认的事，不该打扰）', () => {
  assert.equal(buildSettlementReminderPayload({ ...BASE, pendingCount: 0 }), null);
  assert.equal(buildSettlementReminderPayload({ ...BASE, pendingCount: -1 }), null);
});

test('字段齐全时正确拼装 touser/data/miniprogramState', () => {
  const payload = buildSettlementReminderPayload(BASE);
  assert.equal(payload.touser, 'oOwner123');
  assert.equal(payload.templateId, 'tmpl_settlement');
  assert.equal(payload.miniprogramState, 'formal');
  assert.equal(payload.data.thing1.value, '小林豆坊');
  assert.equal(payload.data.number2.value, '3');
  assert.equal(payload.data.amount3.value, '256.80');
});

test('tenantName 缺失时用占位文案兜底', () => {
  const payload = buildSettlementReminderPayload({ ...BASE, tenantName: '' });
  assert.equal(payload.data.thing1.value, '您的工坊');
});

test('pendingAmountYuan 缺失时用 0.00 兜底', () => {
  const payload = buildSettlementReminderPayload({ ...BASE, pendingAmountYuan: '' });
  assert.equal(payload.data.amount3.value, '0.00');
});

test('未传 page 时不包含 page 字段，传了则原样带上', () => {
  const p1 = buildSettlementReminderPayload(BASE);
  assert.equal('page' in p1, false);
  const p2 = buildSettlementReminderPayload({ ...BASE, page: 'subpackages/admin/pages/settlement-summary/settlement-summary' });
  assert.equal(p2.page, 'subpackages/admin/pages/settlement-summary/settlement-summary');
});

test('truncateThing: 超过 20 字符时截断并加省略号', () => {
  const long = 'x'.repeat(25);
  const result = truncateThing(long);
  assert.equal(result.length, 20);
  assert.ok(result.endsWith('…'));
});

test('truncateThing: 空值时返回占位符', () => {
  assert.equal(truncateThing(''), '-');
  assert.equal(truncateThing(undefined), '-');
});
