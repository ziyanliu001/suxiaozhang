'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTempleStyleLine, parseTempleMaterialLine, stripDonationVerbPrefix } = require('./parseTempleDonation');

test('"李某某 添香油 500元"：正确提取姓名与金额，不把"添香油"误当成姓名', () => {
  assert.deepEqual(parseTempleStyleLine('李某某 添香油 500元'), { name: '李某某', amount: 500 });
});

test('"陈某某合家 乐捐建庙 2000"：姓名保留"合家"落款后缀，"乐捐建庙"作为噪声丢弃', () => {
  assert.deepEqual(parseTempleStyleLine('陈某某合家 乐捐建庙 2000'), { name: '陈某某合家', amount: 2000 });
});

test('"林某某 添植物油2桶"：命中物资单位结尾，返回 null 交给 parseMaterials 处理', () => {
  assert.equal(parseTempleStyleLine('林某某 添植物油2桶'), null);
});

test('不含任何已知宫庙用语的普通行返回 null，不影响既有"姓名 金额"通用扫描路径', () => {
  assert.equal(parseTempleStyleLine('张三 100'), null);
});

test('多人一行（含逗号）即使命中宫庙用语也返回 null，不尝试单人结构解析', () => {
  assert.equal(parseTempleStyleLine('张三 添油50, 李四 供灯30'), null);
});

test('金额无"元/块"后缀同样能识别（"随喜"紧跟姓名，无空格）', () => {
  assert.deepEqual(parseTempleStyleLine('王某某随喜200'), { name: '王某某', amount: 200 });
});

test('"供灯"作为独立善款用语（非物资）：金额识别正常', () => {
  assert.deepEqual(parseTempleStyleLine('黄某某 供灯 88元'), { name: '黄某某', amount: 88 });
});

test('用语命中但金额为 0 或负数：视为无效，返回 null', () => {
  assert.equal(parseTempleStyleLine('李某某 随喜 0元'), null);
});

test('关键词前的文本超过 6 个连续中文字符（不像一个真实姓名）时返回 null（宁可漏识别也不猜）', () => {
  assert.equal(parseTempleStyleLine('这是一个很长的名字随喜100'), null);
});

test('姓名与用语之间没有空格也能正确切分（用关键词出现位置界定姓名右边界，不依赖空格）', () => {
  assert.deepEqual(parseTempleStyleLine('王某某随喜200'), { name: '王某某', amount: 200 });
});

test('“全家”“一家”“阖家”三种落款后缀同样被姓名捕获', () => {
  assert.deepEqual(parseTempleStyleLine('林某全家 乐捐 300'), { name: '林某全家', amount: 300 });
  assert.deepEqual(parseTempleStyleLine('林某一家 随喜 50'), { name: '林某一家', amount: 50 });
  assert.deepEqual(parseTempleStyleLine('林某阖家 敬献 60'), { name: '林某阖家', amount: 60 });
});

test('stripDonationVerbPrefix：剥离"添"前缀，保留物资名词本身', () => {
  assert.equal(stripDonationVerbPrefix('添植物油'), '植物油');
});

test('stripDonationVerbPrefix：剥离既有"赞助"前缀（雨花斋场景既有行为不变）', () => {
  assert.equal(stripDonationVerbPrefix('赞助食用油'), '食用油');
});

test('stripDonationVerbPrefix：剥离后为空字符串时回退原文，不让物资描述凭空消失', () => {
  assert.equal(stripDonationVerbPrefix('添'), '添');
});

test('stripDonationVerbPrefix：不含任何已知前缀的文本原样返回', () => {
  assert.equal(stripDonationVerbPrefix('大米'), '大米');
});

test('parseTempleMaterialLine："林某某 添植物油2桶" 正确提取捐赠人/物资/数量/单位', () => {
  assert.deepEqual(parseTempleMaterialLine('林某某 添植物油2桶'), { donor: '林某某', item: '植物油', quantity: '2', unit: '桶' });
});

test('parseTempleMaterialLine：善款行（无数量单位）返回 null，不与 parseTempleStyleLine 互相误判', () => {
  assert.equal(parseTempleMaterialLine('李某某 添香油 500元'), null);
});

test('parseTempleMaterialLine：供灯多盏也能识别为物资行', () => {
  assert.deepEqual(parseTempleMaterialLine('陈某某 供灯5盏'), { donor: '陈某某', item: '供灯', quantity: '5', unit: '盏' });
});

test('parseTempleMaterialLine：不含宫庙用语的普通行返回 null', () => {
  assert.equal(parseTempleMaterialLine('张三 大米50斤'), null);
});
