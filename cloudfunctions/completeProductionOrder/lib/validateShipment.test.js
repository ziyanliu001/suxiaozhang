'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateShipment } = require('./validateShipment');

test('都不填时合法，视为"暂无物流信息"', () => {
  const res = validateShipment({ expressCompany: '', trackingNumber: '' });
  assert.equal(res.valid, true);
  assert.equal(res.provided, false);
});

test('只填快递公司不填单号时拒绝', () => {
  const res = validateShipment({ expressCompany: '顺丰', trackingNumber: '' });
  assert.equal(res.valid, false);
  assert.match(res.error, /必须同时填写/);
});

test('只填单号不填快递公司时拒绝', () => {
  const res = validateShipment({ expressCompany: '', trackingNumber: 'SF1234567890' });
  assert.equal(res.valid, false);
  assert.match(res.error, /必须同时填写/);
});

test('快递公司不在白名单内时拒绝', () => {
  const res = validateShipment({ expressCompany: '某不存在的快递', trackingNumber: 'SF1234567890' });
  assert.equal(res.valid, false);
  assert.match(res.error, /不支持的快递公司/);
});

test('六家指定快递公司全部通过', () => {
  const companies = ['顺丰', '中通', '圆通', '韵达', '极兔', '邮政'];
  for (const c of companies) {
    const res = validateShipment({ expressCompany: c, trackingNumber: 'SF1234567890' });
    assert.equal(res.valid, true, `${c} 应该通过`);
  }
});

test('"其他"选项也通过（真实场景总有白名单外的小众快递）', () => {
  const res = validateShipment({ expressCompany: '其他', trackingNumber: 'ABC123456' });
  assert.equal(res.valid, true);
});

test('单号过短（少于 6 位）时拒绝', () => {
  const res = validateShipment({ expressCompany: '顺丰', trackingNumber: '123' });
  assert.equal(res.valid, false);
  assert.match(res.error, /格式不正确/);
});

test('单号过长（超过 30 位）时拒绝', () => {
  const res = validateShipment({ expressCompany: '顺丰', trackingNumber: 'A'.repeat(31) });
  assert.equal(res.valid, false);
});

test('单号含非法字符（空格/中文/特殊符号）时拒绝', () => {
  assert.equal(validateShipment({ expressCompany: '顺丰', trackingNumber: 'SF 123456' }).valid, false);
  assert.equal(validateShipment({ expressCompany: '顺丰', trackingNumber: '快递单号123456' }).valid, false);
  assert.equal(validateShipment({ expressCompany: '顺丰', trackingNumber: 'SF#123456' }).valid, false);
});

test('单号含短横线时通过（部分承运商单号格式带短横线）', () => {
  const res = validateShipment({ expressCompany: '邮政', trackingNumber: 'EMS-123456-CN' });
  assert.equal(res.valid, true);
});

test('单号前后有空白时 trim 后再校验/返回', () => {
  const res = validateShipment({ expressCompany: '中通', trackingNumber: '  ZT1234567890  ' });
  assert.equal(res.valid, true);
  assert.equal(res.trackingNumber, 'ZT1234567890');
});

test('边界值：恰好 6 位与恰好 30 位都通过', () => {
  assert.equal(validateShipment({ expressCompany: '圆通', trackingNumber: '123456' }).valid, true);
  assert.equal(validateShipment({ expressCompany: '圆通', trackingNumber: 'A'.repeat(30) }).valid, true);
});
