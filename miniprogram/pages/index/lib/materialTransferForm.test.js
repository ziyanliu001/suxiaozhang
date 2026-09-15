'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MATERIAL_TRANSFER_ITEM_OPTIONS,
  MATERIAL_PURCHASE_ITEM_OPTIONS,
  computeMaterialTransferFormValid,
  computeMaterialPurchaseFormValid
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
