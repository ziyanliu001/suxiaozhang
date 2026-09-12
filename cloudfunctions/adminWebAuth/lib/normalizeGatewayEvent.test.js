'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGatewayEvent } = require('./normalizeGatewayEvent');

test('event.body 为合法 JSON 字符串时，解析后返回业务字段对象', () => {
  const result = normalizeGatewayEvent({ body: JSON.stringify({ action: 'login', username: 'admin' }) });
  assert.deepEqual(result, { action: 'login', username: 'admin' });
});

test('event.body 为非法 JSON 字符串时，兜底返回空对象而不抛异常', () => {
  const result = normalizeGatewayEvent({ body: '{not json' });
  assert.deepEqual(result, {});
});

test('event.body 为空字符串时，兜底返回空对象而不抛异常', () => {
  const result = normalizeGatewayEvent({ body: '' });
  assert.deepEqual(result, {});
});

test('event.body 解析结果为 JSON null 时，兜底返回空对象而不是 null', () => {
  const result = normalizeGatewayEvent({ body: 'null' });
  assert.deepEqual(result, {});
});

test('event.body 本身已经是对象（非字符串）时，原样返回该对象', () => {
  const body = { action: 'logout', token: 'tok123' };
  const result = normalizeGatewayEvent({ body });
  assert.equal(result, body);
});

test('event 没有 body 字段时（直接调用/云端测试场景），原样返回 event 本身', () => {
  const event = { action: 'verifySession', token: 'tok123' };
  const result = normalizeGatewayEvent(event);
  assert.equal(result, event);
});

test('event 为 null/undefined 时，兜底返回空对象', () => {
  assert.deepEqual(normalizeGatewayEvent(null), {});
  assert.deepEqual(normalizeGatewayEvent(undefined), {});
});

test('event 为非对象类型（如字符串/数字）时，兜底返回空对象', () => {
  assert.deepEqual(normalizeGatewayEvent('oops'), {});
  assert.deepEqual(normalizeGatewayEvent(42), {});
});
