'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bucketSettlements, buildDetailRows } = require('./bucketSettlements');

test('空数组返回三个全零桶', () => {
  const b = bucketSettlements([]);
  assert.deepEqual(b.unsettled, { count: 0, payAmount: 0, producerAmount: 0, promoterAmount: 0, platformFee: 0 });
  assert.deepEqual(b.settled, { count: 0, payAmount: 0, producerAmount: 0, promoterAmount: 0, platformFee: 0 });
  assert.deepEqual(b.voided, { count: 0, payAmount: 0, producerAmount: 0, promoterAmount: 0, platformFee: 0 });
});

test('unsettled 记录归入待结算桶', () => {
  const docs = [
    { _id: 's1', isReversal: false, settlementStatus: 'unsettled', payAmount: 1000, producerAmount: 850, promoterAmount: 0, platformFee: 150 }
  ];
  const b = bucketSettlements(docs);
  assert.equal(b.unsettled.count, 1);
  assert.equal(b.unsettled.producerAmount, 850);
  assert.equal(b.settled.count, 0);
});

test('settled 后被红冲：净额归零，不会一直虚高', () => {
  const docs = [
    { _id: 's1', isReversal: false, settlementStatus: 'settled', payAmount: 1000, producerAmount: 850, promoterAmount: 50, platformFee: 100 },
    { _id: 's2', isReversal: true, originalSettlementId: 's1', settlementStatus: 'refunded', payAmount: -1000, producerAmount: -850, promoterAmount: -50, platformFee: -100 }
  ];
  const b = bucketSettlements(docs);
  assert.equal(b.settled.count, 1);
  assert.equal(b.settled.producerAmount, 0);
  assert.equal(b.voided.count, 0);
});

test('未结算即被撤销（mark_refunded 路径）计入 voided 桶，不计入 settled', () => {
  const docs = [
    { _id: 's1', isReversal: false, settlementStatus: 'refunded', payAmount: 1000, producerAmount: 850, promoterAmount: 0, platformFee: 150 }
  ];
  const b = bucketSettlements(docs);
  assert.equal(b.voided.count, 1);
  assert.equal(b.settled.count, 0);
});

test('buildDetailRows: 未被红冲的记录原样输出一行，带 settlementId', () => {
  const docs = [
    { _id: 's1', orderId: 'o1', isReversal: false, settlementStatus: 'settled', payAmount: 1000, producerAmount: 850, promoterAmount: 50, platformFee: 100, createdAt: 't1', settledAt: 't2' }
  ];
  const rows = buildDetailRows(docs);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].settlementId, 's1');
  assert.equal(rows[0].orderId, 'o1');
  assert.equal(rows[0].settlementStatus, 'settled');
});

test('buildDetailRows: 已结算后被红冲的订单合并成一行净额，标记 settled_then_reversed', () => {
  const docs = [
    { _id: 's1', orderId: 'o1', isReversal: false, settlementStatus: 'settled', payAmount: 1000, producerAmount: 850, promoterAmount: 50, platformFee: 100, createdAt: 't1', settledAt: 't2' },
    { _id: 's2', orderId: 'o1', isReversal: true, originalSettlementId: 's1', settlementStatus: 'refunded', payAmount: -1000, producerAmount: -850, promoterAmount: -50, platformFee: -100, createdAt: 't3' }
  ];
  const rows = buildDetailRows(docs);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].settlementStatus, 'settled_then_reversed');
  assert.equal(rows[0].producerAmount, 0);
  assert.equal(rows[0].reversedAt, 't3');
});

test('buildDetailRows: 空数组返回空数组', () => {
  assert.deepEqual(buildDetailRows([]), []);
});

test('originalSettlementId 找不到对应原始记录时（数据异常防御），不会导致崩溃', () => {
  const docs = [
    { _id: 'x-rev', isReversal: true, originalSettlementId: 'not_exist', settlementStatus: 'refunded', payAmount: -100, producerAmount: -100, promoterAmount: 0, platformFee: 0 }
  ];
  const b = bucketSettlements(docs);
  assert.equal(b.settled.count, 0);
  assert.equal(b.unsettled.count, 0);
  assert.equal(b.voided.count, 0);
});
