'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildShippingNoticePayload, truncateThing, truncateCharString } = require('./buildSubscribeMessagePayload');

const BASE = {
  buyerOpenId: 'oBuyer123',
  templateId: 'tmpl_abc',
  productName: '手工豆腐 500g',
  expressCompany: '顺丰',
  trackingNumber: 'SF1234567890',
  shippedAtStr: '2026-08-19'
};

test('buyerOpenId 缺失时返回 null（明确跳过，不是抛错）', () => {
  assert.equal(buildShippingNoticePayload({ ...BASE, buyerOpenId: '' }), null);
});

test('templateId 缺失时返回 null（模板未配置场景）', () => {
  assert.equal(buildShippingNoticePayload({ ...BASE, templateId: '' }), null);
});

test('字段齐全时正确拼装 touser/data/miniprogramState', () => {
  const payload = buildShippingNoticePayload(BASE);
  assert.equal(payload.touser, 'oBuyer123');
  assert.equal(payload.templateId, 'tmpl_abc');
  assert.equal(payload.miniprogramState, 'formal');
  assert.equal(payload.data.thing1.value, '手工豆腐 500g');
  assert.equal(payload.data.thing2.value, '顺丰');
  assert.equal(payload.data.character_string3.value, 'SF1234567890');
  assert.equal(payload.data.date4.value, '2026-08-19');
});

test('未传 page 时不包含 page 字段', () => {
  const payload = buildShippingNoticePayload(BASE);
  assert.equal('page' in payload, false);
});

test('传了 page 时原样带上', () => {
  const payload = buildShippingNoticePayload({ ...BASE, page: 'pages/storefront/storefront' });
  assert.equal(payload.page, 'pages/storefront/storefront');
});

test('truncateThing: 超过 20 字符时截断并加省略号', () => {
  const long = 'x'.repeat(25);
  const result = truncateThing(long);
  assert.equal(result.length, 20);
  assert.ok(result.endsWith('…'));
});

test('truncateThing: 恰好 20 字符时不截断', () => {
  const exact = 'x'.repeat(20);
  assert.equal(truncateThing(exact), exact);
});

test('truncateThing: 空值时返回占位符而不是空字符串（thing 类型不允许空值）', () => {
  assert.equal(truncateThing(''), '-');
  assert.equal(truncateThing(undefined), '-');
  assert.equal(truncateThing(null), '-');
});

test('truncateCharString: 超过 32 字符时截断（不加省略号，单号截断加省略号会误导）', () => {
  const long = 'A'.repeat(40);
  const result = truncateCharString(long);
  assert.equal(result.length, 32);
  assert.equal(result, 'A'.repeat(32));
});

test('truncateCharString: 空值时返回占位符', () => {
  assert.equal(truncateCharString(''), '-');
});

test('商品名/快递公司超长时不会导致拼装失败，只是被截断', () => {
  const payload = buildShippingNoticePayload({ ...BASE, productName: '超长商品名'.repeat(10) });
  assert.notEqual(payload, null);
  assert.ok(payload.data.thing1.value.length <= 20);
});
