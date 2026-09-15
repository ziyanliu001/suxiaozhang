'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeMaterialStock, HEALTH_THRESHOLDS } = require('./computeMaterialStock');

test('computeMaterialStock：只有初始存量，无任何流水时原样返回并按阈值判定健康度', () => {
  const result = computeMaterialStock({ baseline: { rice: 50, oil: 10, flour: 0, vegetable: 200 } });
  assert.deepEqual(result.rice, { jin: 50, status: 'normal' });
  assert.deepEqual(result.oil, { jin: 10, status: 'normal' });
  assert.deepEqual(result.flour, { jin: 0, status: 'urgent' });
  assert.deepEqual(result.vegetable, { jin: 200, status: 'surplus' });
});

test('computeMaterialStock：捐赠 + 采购入库都正向累加（核心诉求——买了米不会被漏算）', () => {
  const result = computeMaterialStock({
    baseline: { rice: 0, oil: 0, flour: 0, vegetable: 0 },
    donations: [{ category: 'rice', jin: 30 }],
    purchases: [{ item: 'rice', quantityJin: 40 }]
  });
  assert.equal(result.rice.jin, 70);
});

test('computeMaterialStock：消耗抵减库存，但采购入库能把消耗掉的部分补回来，不会误判成负库存', () => {
  // 场景：初始 20 斤大米，今天后厨消耗了 30 斤（riceCount:30），但今天也用小票采购了 35 斤——
  // 补充前会是 20-30=-10（钳制展示为 0，告急），补充后应为 20-30+35=25（正常，rice 阈值 urgent<20<=normal<100<=surplus）
  const withoutPurchase = computeMaterialStock({
    baseline: { rice: 20, oil: 0, flour: 0, vegetable: 0 },
    consumptions: [{ riceCount: 30 }]
  });
  assert.equal(withoutPurchase.rice.jin, 0, '负库存钳制展示为 0');
  assert.equal(withoutPurchase.rice.status, 'urgent');

  const withPurchase = computeMaterialStock({
    baseline: { rice: 20, oil: 0, flour: 0, vegetable: 0 },
    consumptions: [{ riceCount: 30 }],
    purchases: [{ item: 'rice', quantityJin: 35 }]
  });
  assert.equal(withPurchase.rice.jin, 25);
  assert.equal(withPurchase.rice.status, 'normal');
});

test('computeMaterialStock：调入调出正确增减各自类目，不影响其余类目', () => {
  const result = computeMaterialStock({
    baseline: { rice: 50, oil: 20, flour: 10, vegetable: 10 },
    transfersIn: [{ item: 'rice', quantityJin: 30 }],
    transfersOut: [{ item: 'oil', quantityJin: 5 }]
  });
  assert.equal(result.rice.jin, 80);
  assert.equal(result.oil.jin, 15);
  assert.equal(result.flour.jin, 10);
  assert.equal(result.vegetable.jin, 10);
});

test('computeMaterialStock：多条 consumptions 记录（多次消耗提交）按四个字段各自累加', () => {
  const result = computeMaterialStock({
    baseline: { rice: 100, oil: 100, flour: 100, vegetable: 100 },
    consumptions: [
      { riceCount: 10, oilCount: 2, flourCount: 5, vegetableCount: 8 },
      { riceCount: 15, oilCount: 3, flourCount: 0, vegetableCount: 12 }
    ]
  });
  assert.equal(result.rice.jin, 75);
  assert.equal(result.oil.jin, 95);
  assert.equal(result.flour.jin, 95);
  assert.equal(result.vegetable.jin, 80);
});

test('computeMaterialStock：健康度边界值——urgent 严格小于阈值，surplus 大于等于阈值', () => {
  const rice = HEALTH_THRESHOLDS.rice;
  const atUrgentBoundary = computeMaterialStock({ baseline: { rice: rice.urgent, oil: 0, flour: 0, vegetable: 0 } });
  assert.equal(atUrgentBoundary.rice.status, 'normal', 'jin === urgent 边界值应判定为 normal，不是 urgent');

  const belowUrgent = computeMaterialStock({ baseline: { rice: rice.urgent - 0.01, oil: 0, flour: 0, vegetable: 0 } });
  assert.equal(belowUrgent.rice.status, 'urgent');

  const atSurplusBoundary = computeMaterialStock({ baseline: { rice: rice.surplus, oil: 0, flour: 0, vegetable: 0 } });
  assert.equal(atSurplusBoundary.rice.status, 'surplus', 'jin === surplus 边界值应判定为 surplus');

  const belowSurplus = computeMaterialStock({ baseline: { rice: rice.surplus - 0.01, oil: 0, flour: 0, vegetable: 0 } });
  assert.equal(belowSurplus.rice.status, 'normal');
});

test('computeMaterialStock：缺失字段/空数组/空 baseline 安全兜底为 0，不抛异常', () => {
  const result = computeMaterialStock({});
  assert.deepEqual(result.rice, { jin: 0, status: 'urgent' });
  assert.deepEqual(result.oil, { jin: 0, status: 'urgent' });
  assert.deepEqual(result.flour, { jin: 0, status: 'urgent' });
  assert.deepEqual(result.vegetable, { jin: 0, status: 'urgent' });

  const resultUndefined = computeMaterialStock(undefined);
  assert.deepEqual(resultUndefined.rice, { jin: 0, status: 'urgent' });
});

test('computeMaterialStock：畸形条目（缺 category/item/jin 字段）被安全跳过，不污染其余类目', () => {
  const result = computeMaterialStock({
    baseline: { rice: 10, oil: 10, flour: 10, vegetable: 10 },
    donations: [null, {}, { category: 'unknown_category', jin: 999 }, { category: 'rice', jin: 5 }],
    purchases: [null, { item: 'not_a_real_category', quantityJin: 999 }]
  });
  assert.equal(result.rice.jin, 15, '只有合法的 rice 条目生效，非法类目/畸形条目被跳过');
  assert.equal(result.oil.jin, 10);
});
