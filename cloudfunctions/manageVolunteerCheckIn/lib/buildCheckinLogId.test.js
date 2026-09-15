'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildCheckinLogId } = require('./buildCheckinLogId');

test('相同五元组产出相同 _id（可重复推导，供并发冲突后重新定位同一条记录）', () => {
  const a = buildCheckinLogId('t1', 's1', 'openid1', '2026-09-16', 'lunch');
  const b = buildCheckinLogId('t1', 's1', 'openid1', '2026-09-16', 'lunch');
  assert.strictEqual(a, b);
});

test('五元组任一字段不同则 _id 不同，不会误判成同一条打卡记录', () => {
  const base = buildCheckinLogId('t1', 's1', 'openid1', '2026-09-16', 'lunch');
  assert.notStrictEqual(buildCheckinLogId('t2', 's1', 'openid1', '2026-09-16', 'lunch'), base);
  assert.notStrictEqual(buildCheckinLogId('t1', 's2', 'openid1', '2026-09-16', 'lunch'), base);
  assert.notStrictEqual(buildCheckinLogId('t1', 's1', 'openid2', '2026-09-16', 'lunch'), base);
  assert.notStrictEqual(buildCheckinLogId('t1', 's1', 'openid1', '2026-09-17', 'lunch'), base);
  assert.notStrictEqual(buildCheckinLogId('t1', 's1', 'openid1', '2026-09-16', 'dinner'), base);
});

test('返回值以 checkin_ 前缀开头，便于日后按前缀识别记录类型', () => {
  const id = buildCheckinLogId('t1', 's1', 'openid1', '2026-09-16', 'lunch');
  assert.ok(id.startsWith('checkin_'));
});
