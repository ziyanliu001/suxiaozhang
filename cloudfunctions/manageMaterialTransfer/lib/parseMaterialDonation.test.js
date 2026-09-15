'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchMaterialCategory, parseMaterialDonationToJin } = require('./parseMaterialDonation');

test('matchMaterialCategory：大米/食用油/面粉/时蔬四类目关键词各自命中', () => {
  assert.equal(matchMaterialCategory('大米'), 'rice');
  assert.equal(matchMaterialCategory('香米'), 'rice');
  assert.equal(matchMaterialCategory('食用油'), 'oil');
  assert.equal(matchMaterialCategory('菜籽油'), 'oil');
  assert.equal(matchMaterialCategory('面粉'), 'flour');
  assert.equal(matchMaterialCategory('时蔬'), 'vegetable');
  assert.equal(matchMaterialCategory('青菜'), 'vegetable');
  assert.equal(matchMaterialCategory('土豆'), 'vegetable');
});

test('matchMaterialCategory：菜籽油/菜油优先命中 oil 而不是 vegetable（顺序保证互斥关键词不串类）', () => {
  assert.equal(matchMaterialCategory('菜籽油'), 'oil');
  assert.equal(matchMaterialCategory('菜油'), 'oil');
});

test('matchMaterialCategory：无法识别的品名/空字符串返回 null，不瞎猜', () => {
  assert.equal(matchMaterialCategory('香烛'), null);
  assert.equal(matchMaterialCategory('供灯'), null);
  assert.equal(matchMaterialCategory(''), null);
  assert.equal(matchMaterialCategory(undefined), null);
  assert.equal(matchMaterialCategory('  '), null);
});

test('matchMaterialCategory：单字"油"兜底关键词的已知局限——"香油"这类真实含油品名会正确命中 oil，如实记录这个行为而非隐藏', () => {
  assert.equal(matchMaterialCategory('香油'), 'oil');
});

test('parseMaterialDonationToJin：斤直接计入，公斤/kg 按 ×2 换算成斤', () => {
  assert.deepEqual(parseMaterialDonationToJin({ item: '大米', quantity: '50', unit: '斤' }), { category: 'rice', jin: 50 });
  assert.deepEqual(parseMaterialDonationToJin({ item: '面粉', quantity: '10', unit: '公斤' }), { category: 'flour', jin: 20 });
  assert.deepEqual(parseMaterialDonationToJin({ item: '食用油', quantity: '5', unit: 'kg' }), { category: 'oil', jin: 10 });
});

test('parseMaterialDonationToJin：单位不是斤/公斤/kg（箱/桶/瓶/份等计件单位）时返回 null，不瞎猜换算比例', () => {
  assert.equal(parseMaterialDonationToJin({ item: '食用油', quantity: '2', unit: '桶' }), null);
  assert.equal(parseMaterialDonationToJin({ item: '大米', quantity: '3', unit: '袋' }), null);
  assert.equal(parseMaterialDonationToJin({ item: '面粉', quantity: '1', unit: '份' }), null);
});

test('parseMaterialDonationToJin：品名不属于四类目时返回 null', () => {
  assert.equal(parseMaterialDonationToJin({ item: '香烛', quantity: '10', unit: '斤' }), null);
});

test('parseMaterialDonationToJin：数量缺失/非数字/非正数时返回 null', () => {
  assert.equal(parseMaterialDonationToJin({ item: '大米', quantity: '', unit: '斤' }), null);
  assert.equal(parseMaterialDonationToJin({ item: '大米', quantity: 'abc', unit: '斤' }), null);
  assert.equal(parseMaterialDonationToJin({ item: '大米', quantity: '0', unit: '斤' }), null);
  assert.equal(parseMaterialDonationToJin({ item: '大米', quantity: '-5', unit: '斤' }), null);
});

test('parseMaterialDonationToJin：整条记录缺失时返回 null，不抛异常', () => {
  assert.equal(parseMaterialDonationToJin(null), null);
  assert.equal(parseMaterialDonationToJin(undefined), null);
});
