'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MATERIAL_TRANSFER_ITEM_OPTIONS,
  MATERIAL_PURCHASE_ITEM_OPTIONS,
  computeMaterialTransferFormValid,
  computeMaterialPurchaseFormValid,
  computeSelectedStockJin,
  isOverStock,
  applyQuickStep,
  buildRecentPartnerChips
} = require('./materialTransferForm');

// ============ 1. 提交按钮禁用校验逻辑（必填项不完整时必须判定为 false） ============

test('computeMaterialTransferFormValid：四项全部合法填写时返回 true（happy path）', () => {
  assert.equal(computeMaterialTransferFormValid({
    partnerStoreId: 'store_abc',
    item: 'rice',
    quantityJin: '50',
    handledBy: '张三'
  }), true);
});

test('computeMaterialTransferFormValid：未选择门店（partnerStoreId 为空）时返回 false', () => {
  assert.equal(computeMaterialTransferFormValid({
    partnerStoreId: '',
    item: 'rice',
    quantityJin: '50',
    handledBy: '张三'
  }), false);
});

test('computeMaterialTransferFormValid：未选择物资类目（item 为空字符串/未知值）时返回 false', () => {
  assert.equal(computeMaterialTransferFormValid({
    partnerStoreId: 'store_abc',
    item: '',
    quantityJin: '50',
    handledBy: '张三'
  }), false);
  assert.equal(computeMaterialTransferFormValid({
    partnerStoreId: 'store_abc',
    item: 'not_a_real_item',
    quantityJin: '50',
    handledBy: '张三'
  }), false);
});

test('computeMaterialTransferFormValid：物资类目是时蔬（不在可调配三项内）时返回 false——时蔬保质期短不支持跨店调配', () => {
  assert.equal(computeMaterialTransferFormValid({
    partnerStoreId: 'store_abc',
    item: 'vegetable',
    quantityJin: '50',
    handledBy: '张三'
  }), false);
});

test('computeMaterialTransferFormValid：调配重量缺失/为 0/为负数/非数字时返回 false', () => {
  const base = { partnerStoreId: 'store_abc', item: 'rice', handledBy: '张三' };
  assert.equal(computeMaterialTransferFormValid({ ...base, quantityJin: '' }), false);
  assert.equal(computeMaterialTransferFormValid({ ...base, quantityJin: '0' }), false);
  assert.equal(computeMaterialTransferFormValid({ ...base, quantityJin: '-5' }), false);
  assert.equal(computeMaterialTransferFormValid({ ...base, quantityJin: 'abc' }), false);
});

test('computeMaterialTransferFormValid：经手人缺失/仅含空白字符时返回 false', () => {
  const base = { partnerStoreId: 'store_abc', item: 'rice', quantityJin: '50' };
  assert.equal(computeMaterialTransferFormValid({ ...base, handledBy: '' }), false);
  assert.equal(computeMaterialTransferFormValid({ ...base, handledBy: '   ' }), false);
  assert.equal(computeMaterialTransferFormValid({ ...base }), false); // handledBy 未传
});

test('computeMaterialTransferFormValid：整个 form 对象缺失/为 null 时安全返回 false，不抛异常', () => {
  assert.equal(computeMaterialTransferFormValid(null), false);
  assert.equal(computeMaterialTransferFormValid(undefined), false);
  assert.equal(computeMaterialTransferFormValid({}), false);
});

test('computeMaterialTransferFormValid：可调配三项（大米/食用油/面粉）均能通过校验，逐项验证不遗漏', () => {
  ['rice', 'oil', 'flour'].forEach((item) => {
    assert.equal(computeMaterialTransferFormValid({
      partnerStoreId: 'store_abc',
      item,
      quantityJin: '10',
      handledBy: '李四'
    }), true, `${item} 应当是合法的可调配类目`);
  });
});

test('computeMaterialPurchaseFormValid：重量是大于 0 的合法数字时返回 true', () => {
  assert.equal(computeMaterialPurchaseFormValid('50'), true);
  assert.equal(computeMaterialPurchaseFormValid('0.5'), true);
});

test('computeMaterialPurchaseFormValid：重量缺失/为 0/为负数/非数字时返回 false', () => {
  assert.equal(computeMaterialPurchaseFormValid(''), false);
  assert.equal(computeMaterialPurchaseFormValid('0'), false);
  assert.equal(computeMaterialPurchaseFormValid('-1'), false);
  assert.equal(computeMaterialPurchaseFormValid('abc'), false);
  assert.equal(computeMaterialPurchaseFormValid(undefined), false);
});

// ============ 2. 纯素类目数据完整性（不允许出现任何非素食类目） ============

// 🥬 独立维护的荤食/动物性原料关键词黑名单，不从 MATERIAL_*_ITEM_OPTIONS
// 反向派生——如果两份列表共用同一个来源，测试就只是在断言"数组等于它自己"，
// 起不到"未来有人手滑加错类目"的防护作用。关键词覆盖常见荤食品类/部位/
// 动物性调料，宁可覆盖面广一些
const NON_VEGETARIAN_KEYWORDS = [
  '肉', '荤', '蛋', '奶', '鱼', '虾', '蟹', '贝', '禽', '骨',
  '鸡', '鸭', '鹅', '猪', '牛', '羊', '兔', '海鲜', '腊', '腌',
  '火腿', '培根', '鱼翅', '鲍鱼', '燕窝', '明胶', '猪油', '牛油', '奶油', '黄油'
];

// 🥬 动物类 emoji 黑名单（视觉上最直接暴露"荤食"信号的地方），同样独立
// 维护，不反向派生自选项数据本身
const NON_VEGETARIAN_EMOJI = [
  '🍖', '🍗', '🥩', '🍤', '🍣', '🍥', '🥚', '🍳', '🐟', '🐷',
  '🐮', '🐔', '🐑', '🦀', '🦐', '🦪', '🥓', '🍔', '🌭', '🍕'
];

function assertAllVegetarian(options, listName) {
  options.forEach((opt) => {
    NON_VEGETARIAN_KEYWORDS.forEach((kw) => {
      assert.equal(
        opt.label.includes(kw),
        false,
        `${listName} 里的"${opt.label}"（value=${opt.value}）命中荤食关键词"${kw}"，违反纯素边界`
      );
    });
    NON_VEGETARIAN_EMOJI.forEach((emoji) => {
      assert.notEqual(
        opt.emoji,
        emoji,
        `${listName} 里的"${opt.label}"（value=${opt.value}）使用了荤食 emoji "${emoji}"，违反纯素边界`
      );
    });
  });
}

test('MATERIAL_TRANSFER_ITEM_OPTIONS：三项物资类目全部不含任何荤食关键词/荤食 emoji', () => {
  assertAllVegetarian(MATERIAL_TRANSFER_ITEM_OPTIONS, 'MATERIAL_TRANSFER_ITEM_OPTIONS');
});

test('MATERIAL_PURCHASE_ITEM_OPTIONS：四项物资类目全部不含任何荤食关键词/荤食 emoji', () => {
  assertAllVegetarian(MATERIAL_PURCHASE_ITEM_OPTIONS, 'MATERIAL_PURCHASE_ITEM_OPTIONS');
});

test('MATERIAL_TRANSFER_ITEM_OPTIONS：精确等于大米/食用油/面粉三项白名单，不多不少（时蔬保质期短，故意不在其中）', () => {
  assert.deepEqual(
    MATERIAL_TRANSFER_ITEM_OPTIONS.map((o) => o.value).sort(),
    ['flour', 'oil', 'rice'].sort()
  );
});

test('MATERIAL_PURCHASE_ITEM_OPTIONS：精确等于大米/食用油/面粉/时蔬四项白名单，不多不少', () => {
  assert.deepEqual(
    MATERIAL_PURCHASE_ITEM_OPTIONS.map((o) => o.value).sort(),
    ['flour', 'oil', 'rice', 'vegetable'].sort()
  );
});

test('两份类目数据：每一项都同时具备非空 value/emoji/label 三个字段，不存在残缺条目', () => {
  [...MATERIAL_TRANSFER_ITEM_OPTIONS, ...MATERIAL_PURCHASE_ITEM_OPTIONS].forEach((opt) => {
    assert.equal(typeof opt.value, 'string');
    assert.ok(opt.value.length > 0);
    assert.equal(typeof opt.emoji, 'string');
    assert.ok(opt.emoji.length > 0);
    assert.equal(typeof opt.label, 'string');
    assert.ok(opt.label.length > 0);
  });
});

test('MATERIAL_TRANSFER_ITEM_OPTIONS 是 MATERIAL_PURCHASE_ITEM_OPTIONS 的真子集（同一批 value 在两份列表里 label/emoji 必须一致，不允许同一物资在两处口径漂移）', () => {
  MATERIAL_TRANSFER_ITEM_OPTIONS.forEach((transferOpt) => {
    const purchaseOpt = MATERIAL_PURCHASE_ITEM_OPTIONS.find((o) => o.value === transferOpt.value);
    assert.ok(purchaseOpt, `${transferOpt.value} 应该同时存在于采购入库类目里`);
    assert.equal(purchaseOpt.label, transferOpt.label);
    assert.equal(purchaseOpt.emoji, transferOpt.emoji);
  });
});

// ============ 3. 智能库存余量联动 ============

const SAMPLE_STOCK = {
  rice: { jin: 30, status: 'normal' },
  oil: { jin: 5, status: 'urgent' },
  flour: { jin: 0, status: 'urgent' },
  vegetable: { jin: 200, status: 'surplus' }
};

test('computeSelectedStockJin：direction 为 "in"（调入接收）时恒返回 null——收多少都不存在超量风险，不需要展示余量', () => {
  assert.equal(computeSelectedStockJin('in', 'rice', SAMPLE_STOCK), null);
});

test('computeSelectedStockJin：direction 为 "out" 且物资已选中时，返回该物资的预估结存斤数', () => {
  assert.equal(computeSelectedStockJin('out', 'rice', SAMPLE_STOCK), 30);
  assert.equal(computeSelectedStockJin('out', 'flour', SAMPLE_STOCK), 0);
});

test('computeSelectedStockJin：结存数据尚未就绪（null）、或物资未选中（空字符串）时返回 null，不抛异常', () => {
  assert.equal(computeSelectedStockJin('out', 'rice', null), null);
  assert.equal(computeSelectedStockJin('out', '', SAMPLE_STOCK), null);
  assert.equal(computeSelectedStockJin('out', undefined, SAMPLE_STOCK), null);
});

test('computeSelectedStockJin：物资 value 在结存对象里没有对应条目（脏数据/未来新增类目未同步）时安全返回 null', () => {
  assert.equal(computeSelectedStockJin('out', 'not_a_real_item', SAMPLE_STOCK), null);
});

test('isOverStock：调配重量超过预估结存时返回 true', () => {
  assert.equal(isOverStock('50', 30), true);
});

test('isOverStock：调配重量等于/小于预估结存时返回 false（严格大于才算超量）', () => {
  assert.equal(isOverStock('30', 30), false);
  assert.equal(isOverStock('10', 30), false);
});

test('isOverStock：stockJin 为 null（调入方向/数据未就绪）时恒返回 false，不误报超量', () => {
  assert.equal(isOverStock('999', null), false);
  assert.equal(isOverStock('999', undefined), false);
});

test('isOverStock：调配重量本身非法（空/0/负数/非数字）时返回 false——这类输入已经被 computeMaterialTransferFormValid 拦在提交之前，这里不重复报错，只负责"合法输入下是否超量"这一件事', () => {
  assert.equal(isOverStock('', 30), false);
  assert.equal(isOverStock('0', 30), false);
  assert.equal(isOverStock('-5', 30), false);
  assert.equal(isOverStock('abc', 30), false);
});

// ============ 4. 快捷步进输入 ============

test('applyQuickStep：在已有合法数值基础上累加，保留一位小数', () => {
  assert.equal(applyQuickStep('10', 5), '15');
  assert.equal(applyQuickStep('10.5', 1), '11.5');
});

test('applyQuickStep：当前输入框为空/非法值时按 0 起步，不拒绝操作', () => {
  assert.equal(applyQuickStep('', 5), '5');
  assert.equal(applyQuickStep('abc', 10), '10');
  assert.equal(applyQuickStep('-5', 1), '1');
});

test('applyQuickStep：浮点误差被四舍五入到一位小数，不产生 19.999999999998 这类展示噪音', () => {
  assert.equal(applyQuickStep('0.1', 0.2), '0.3');
});

// ============ 5. 常用门店快捷标签 ============

const SAMPLE_RECORDS = [
  { fromStoreId: 'store_self', fromStoreName: '本店', toStoreId: 'store_a', toStoreName: 'A店', createTime: '2026-09-18T03:00:00Z' },
  { fromStoreId: 'store_b', fromStoreName: 'B店', toStoreId: 'store_self', toStoreName: '本店', createTime: '2026-09-17T03:00:00Z' },
  { fromStoreId: 'store_self', fromStoreName: '本店', toStoreId: 'store_a', toStoreName: 'A店', createTime: '2026-09-16T03:00:00Z' },
  { fromStoreId: 'store_c', fromStoreName: 'C店', toStoreId: 'store_self', toStoreName: '本店', createTime: '2026-09-15T03:00:00Z' }
];

test('buildRecentPartnerChips：按记录出现顺序提炼交易对手方（调用方需预先按 createTime desc 排好序），重复出现的门店去重只保留最近一次', () => {
  const chips = buildRecentPartnerChips(SAMPLE_RECORDS, 'store_self');
  assert.deepEqual(chips, [
    { storeId: 'store_a', storeName: 'A店' },
    { storeId: 'store_b', storeName: 'B店' },
    { storeId: 'store_c', storeName: 'C店' }
  ]);
});

test('buildRecentPartnerChips：无论本店是记录里的 from 还是 to，都能正确识别出"对方"是哪一家', () => {
  const asFrom = buildRecentPartnerChips([{ fromStoreId: 'store_self', fromStoreName: '本店', toStoreId: 'store_x', toStoreName: 'X店' }], 'store_self');
  const asTo = buildRecentPartnerChips([{ fromStoreId: 'store_y', fromStoreName: 'Y店', toStoreId: 'store_self', toStoreName: '本店' }], 'store_self');
  assert.deepEqual(asFrom, [{ storeId: 'store_x', storeName: 'X店' }]);
  assert.deepEqual(asTo, [{ storeId: 'store_y', storeName: 'Y店' }]);
});

test('buildRecentPartnerChips：受 limit 参数截断，默认上限 4', () => {
  const manyRecords = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
    fromStoreId: 'store_self', fromStoreName: '本店', toStoreId: `store_${id}`, toStoreName: `${id}店`
  }));
  assert.equal(buildRecentPartnerChips(manyRecords, 'store_self').length, 4);
  assert.equal(buildRecentPartnerChips(manyRecords, 'store_self', 2).length, 2);
});

test('buildRecentPartnerChips：记录既不含 from 也不含 to 等于本店的脏数据被跳过，不污染结果', () => {
  const dirty = [{ fromStoreId: 'store_x', fromStoreName: 'X店', toStoreId: 'store_y', toStoreName: 'Y店' }];
  assert.deepEqual(buildRecentPartnerChips(dirty, 'store_self'), []);
});

test('buildRecentPartnerChips：空数组/未传 currentStoreId 时安全返回空数组，不抛异常', () => {
  assert.deepEqual(buildRecentPartnerChips([], 'store_self'), []);
  assert.deepEqual(buildRecentPartnerChips(SAMPLE_RECORDS, ''), []);
  assert.deepEqual(buildRecentPartnerChips(null, 'store_self'), []);
});

test('buildRecentPartnerChips：partnerName 缺失时兜底展示"未命名门店"，不显示空白标签', () => {
  const noName = [{ fromStoreId: 'store_self', toStoreId: 'store_z', toStoreName: '' }];
  assert.deepEqual(buildRecentPartnerChips(noName, 'store_self'), [{ storeId: 'store_z', storeName: '未命名门店' }]);
});
