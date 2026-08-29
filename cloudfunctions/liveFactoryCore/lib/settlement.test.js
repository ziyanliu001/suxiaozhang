'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeSettlementSplit, buildSettlementSnapshot, decideRefundReversal } = require('./settlement');

test('有推广人时三项加总恒等于实收金额', () => {
  const split = computeSettlementSplit({ payAmount: 10000, producerRate: 0.6, promoterRate: 0.1 });
  assert.equal(split.producerAmount + split.promoterAmount + split.platformFee, 10000);
});

test('无推广人（promoterRate=0）时 promoterAmount 为 0 且加总仍恒等', () => {
  const split = computeSettlementSplit({ payAmount: 10000, producerRate: 0.7, promoterRate: 0 });
  assert.equal(split.promoterAmount, 0);
  assert.equal(split.producerAmount + split.promoterAmount + split.platformFee, 10000);
});

test('奇数分金额取整时加总仍精确等于实收金额（不变式覆盖舍入误差）', () => {
  for (const payAmount of [999, 1, 3, 12345, 7]) {
    const split = computeSettlementSplit({ payAmount, producerRate: 0.618, promoterRate: 0.137 });
    assert.equal(
      split.producerAmount + split.promoterAmount + split.platformFee,
      payAmount,
      `payAmount=${payAmount} 加总应等于原始金额`
    );
  }
});

test('取整误差只会落入 platformFee，不会让 producer/promoter 多分', () => {
  const split = computeSettlementSplit({ payAmount: 100, producerRate: 0.333, promoterRate: 0.333 });
  assert.equal(split.producerAmount, 33);
  assert.equal(split.promoterAmount, 33);
  assert.equal(split.platformFee, 34);
});

test('buildSettlementSnapshot 生成的初始记录状态为 unsettled 且非冲销分录', () => {
  const snap = buildSettlementSnapshot({ tenantId: 't1', orderId: 'o1', payAmount: 5000, producerRate: 0.6, promoterRate: 0 });
  assert.equal(snap.settlementStatus, 'unsettled');
  assert.equal(snap.isReversal, false);
  assert.equal(snap.payAmount, 5000);
});

test('buildSettlementSnapshot 原样保留生效费率快照，供历史订单核对', () => {
  const snap = buildSettlementSnapshot({ tenantId: 't1', orderId: 'o1', payAmount: 5000, producerRate: 0.75, promoterRate: 0.2 });
  assert.equal(snap.producerRate, 0.75);
  assert.equal(snap.promoterRate, 0.2);
});

test('退款红冲：unsettled 状态直接原地标记 refunded，不生成冲销分录', () => {
  const settlement = { _id: 's1', tenantId: 't1', orderId: 'o1', payAmount: 5000, settlementStatus: 'unsettled', isReversal: false };
  const decision = decideRefundReversal(settlement, false);
  assert.equal(decision.action, 'mark_refunded');
});

test('退款红冲：settled 状态生成金额相反的冲销分录，原记录不变', () => {
  const settlement = {
    _id: 's1', tenantId: 't1', orderId: 'o1',
    payAmount: 5000, producerRate: 0.75, promoterRate: 0.1,
    producerAmount: 3000, promoterAmount: 500, platformFee: 1500,
    settlementStatus: 'settled', isReversal: false
  };
  const decision = decideRefundReversal(settlement, false);
  assert.equal(decision.action, 'create_reversal');
  assert.deepEqual(decision.reversalDoc, {
    tenantId: 't1', orderId: 'o1', originalSettlementId: 's1',
    payAmount: -5000, producerRate: 0.75, promoterRate: 0.1,
    producerAmount: -3000, promoterAmount: -500, platformFee: -1500,
    settlementStatus: 'refunded', isReversal: true
  });
});

test('退款红冲：已存在冲销分录时幂等跳过（回调重推场景）', () => {
  const settlement = { _id: 's1', tenantId: 't1', orderId: 'o1', settlementStatus: 'settled', isReversal: false };
  const decision = decideRefundReversal(settlement, true);
  assert.equal(decision.action, 'noop');
});

test('退款红冲：冲销分录本身不会被再次冲销', () => {
  const reversalDoc = { _id: 's2', tenantId: 't1', orderId: 'o1', settlementStatus: 'refunded', isReversal: true };
  const decision = decideRefundReversal(reversalDoc, false);
  assert.equal(decision.action, 'noop');
});

test('computeSettlementSplit 对非法 payAmount 抛出异常（负数/非整数分）', () => {
  assert.throws(() => computeSettlementSplit({ payAmount: -1, producerRate: 0.5, promoterRate: 0 }));
  assert.throws(() => computeSettlementSplit({ payAmount: 10.5, producerRate: 0.5, promoterRate: 0 }));
});
