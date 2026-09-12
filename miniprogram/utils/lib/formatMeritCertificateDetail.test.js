'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatMeritCertificateDetailText } = require('./formatMeritCertificateDetail');

test('善款记录 + 事项标签：拼成"乐捐 事项 ¥金额"', () => {
  assert.equal(
    formatMeritCertificateDetailText({ eventTag: '岁次保生大帝巡安法会', amount: 500, itemDescription: '' }),
    '乐捐 岁次保生大帝巡安法会 ¥500'
  );
});

test('善款记录，事项标签为空：只拼"乐捐 ¥金额"，不留多余空格', () => {
  assert.equal(
    formatMeritCertificateDetailText({ eventTag: '', amount: 200, itemDescription: '' }),
    '乐捐 ¥200'
  );
});

test('实物供奉记录（amount 为 0）：展示物资描述而不是金额', () => {
  assert.equal(
    formatMeritCertificateDetailText({ eventTag: '', amount: 0, itemDescription: '添植物油2桶' }),
    '乐捐 添植物油2桶'
  );
});

test('实物供奉记录 + 事项标签：两者都拼进去', () => {
  assert.equal(
    formatMeritCertificateDetailText({ eventTag: '大殿修缮重修乐捐', amount: 0, itemDescription: '添植物油2桶' }),
    '乐捐 大殿修缮重修乐捐 添植物油2桶'
  );
});

test('amount 与 itemDescription 均缺失时不抛异常，展示为纯"乐捐 "兜底', () => {
  assert.equal(formatMeritCertificateDetailText({}), '乐捐 ');
});

test('模板文案不出现 CLAUDE.md 明确禁用的"随喜"一词', () => {
  const text = formatMeritCertificateDetailText({ eventTag: '中元普渡', amount: 100, itemDescription: '' });
  assert.equal(text.includes('随喜'), false);
});
