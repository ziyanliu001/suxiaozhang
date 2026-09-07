'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProfitSharingReceivers } = require('./buildReceivers');

const SETTLEMENT = { producerAmount: 850, promoterAmount: 50, platformFee: 100 };
const ORDER_WITH_PROMOTER = { promoterOpenId: 'oPromoter1' };
const ORDER_NO_PROMOTER = { promoterOpenId: '' };
const PRODUCT_WITH_PRODUCER = { producerOpenId: 'oProducer1' };
const PRODUCT_NO_PRODUCER = { producerOpenId: '' };

test('producer + promoter 都配置齐全时生成两条接收方', () => {
  const receivers = buildProfitSharingReceivers({ settlement: SETTLEMENT, order: ORDER_WITH_PROMOTER, product: PRODUCT_WITH_PRODUCER });
  assert.equal(receivers.length, 2);
  assert.deepEqual(receivers[0], { type: 'PERSONAL_OPENID', account: 'oProducer1', amount: 850, description: '制作方分成' });
  assert.deepEqual(receivers[1], { type: 'PERSONAL_OPENID', account: 'oPromoter1', amount: 50, description: '推广分成' });
});

test('商品未配置 producerOpenId 时不生成 producer 接收方（不猜归属）', () => {
  const receivers = buildProfitSharingReceivers({ settlement: SETTLEMENT, order: ORDER_WITH_PROMOTER, product: PRODUCT_NO_PRODUCER });
  assert.equal(receivers.length, 1);
  assert.equal(receivers[0].account, 'oPromoter1');
});

test('订单无推广人时不生成 promoter 接收方', () => {
  const receivers = buildProfitSharingReceivers({ settlement: SETTLEMENT, order: ORDER_NO_PROMOTER, product: PRODUCT_WITH_PRODUCER });
  assert.equal(receivers.length, 1);
  assert.equal(receivers[0].account, 'oProducer1');
});

test('两者都未配置时返回空数组', () => {
  const receivers = buildProfitSharingReceivers({ settlement: SETTLEMENT, order: ORDER_NO_PROMOTER, product: PRODUCT_NO_PRODUCER });
  assert.deepEqual(receivers, []);
});

test('金额为 0 时即使配置了接收方也不生成该条（没有可分的钱）', () => {
  const zeroSettlement = { producerAmount: 0, promoterAmount: 0, platformFee: 1000 };
  const receivers = buildProfitSharingReceivers({ settlement: zeroSettlement, order: ORDER_WITH_PROMOTER, product: PRODUCT_WITH_PRODUCER });
  assert.deepEqual(receivers, []);
});

test('settlement/order/product 缺失时安全返回空数组，不抛异常', () => {
  assert.deepEqual(buildProfitSharingReceivers({}), []);
  assert.deepEqual(buildProfitSharingReceivers({ settlement: null, order: null, product: null }), []);
});
