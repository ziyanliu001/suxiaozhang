'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PHOTO_FIELD_LABELS,
  decideQualificationPhotoTap,
  resolveQualificationActionSheetChoice
} = require('./qualificationPhotoActions');

// 🛡️（2026-09-10）门店资质与实景公示"重新编辑与覆盖逻辑"缺口修复的回归测试——
// 这份测试盯的是"点击一张已上传的资质照片该弹出什么、每一项对应什么动作"
// 这一个纯决策分支，不覆盖 wx.showActionSheet/wx.previewImage 等小程序 API
// 本身（那些是宿主环境提供的能力，本仓库测试基础设施不 mock wx 全局对象）。

test('canManage 为 false（只读角色）时永远直接预览，不弹任何管理选项', () => {
  const result = decideQualificationPhotoTap(false, 'storefrontPhotos');
  assert.deepEqual(result, { mode: 'preview' });
});

test('canManage 为 false 时与传入的 category 无关，三个分类结果一致', () => {
  ['storefrontPhotos', 'civilAffairsPhotos', 'foodSafetyPledgePhotos', 'unknown_category'].forEach((category) => {
    assert.deepEqual(decideQualificationPhotoTap(false, category), { mode: 'preview' });
  });
});

test('canManage 为 true 时弹出 ActionSheet，itemList 第一项固定是"预览大图"', () => {
  const result = decideQualificationPhotoTap(true, 'storefrontPhotos');
  assert.equal(result.mode, 'action-sheet');
  assert.equal(result.itemList[0], '预览大图');
  assert.equal(result.itemList.length, 2);
});

test('canManage 为 true 时第二项文案带上对应分类的中文标签', () => {
  assert.match(decideQualificationPhotoTap(true, 'storefrontPhotos').itemList[1], /门头照/);
  assert.match(decideQualificationPhotoTap(true, 'civilAffairsPhotos').itemList[1], /民政备案复印件/);
  assert.match(decideQualificationPhotoTap(true, 'foodSafetyPledgePhotos').itemList[1], /食品安全承诺/);
});

test('canManage 为 true 但 category 是未知值时兜底用"照片"二字，不抛异常、不显示 undefined', () => {
  const result = decideQualificationPhotoTap(true, 'not_a_real_category');
  assert.match(result.itemList[1], /照片/);
  assert.doesNotMatch(result.itemList[1], /undefined/);
});

test('resolveQualificationActionSheetChoice：tapIndex 0 解析为 preview', () => {
  assert.equal(resolveQualificationActionSheetChoice(0), 'preview');
});

test('resolveQualificationActionSheetChoice：tapIndex 1 解析为 manage', () => {
  assert.equal(resolveQualificationActionSheetChoice(1), 'manage');
});

test('resolveQualificationActionSheetChoice：非 0 的任意 tapIndex（含未来追加的第三个选项）都归为 manage，不是只认严格的 1', () => {
  assert.equal(resolveQualificationActionSheetChoice(2), 'manage');
  assert.equal(resolveQualificationActionSheetChoice(99), 'manage');
});

test('PHOTO_FIELD_LABELS 覆盖三个资质分类，且与 store-profile.ts 里的同名常量取值一致（人工核对，非自动同步）', () => {
  assert.equal(PHOTO_FIELD_LABELS.storefrontPhotos, '门头照');
  assert.equal(PHOTO_FIELD_LABELS.civilAffairsPhotos, '民政备案复印件');
  assert.equal(PHOTO_FIELD_LABELS.foodSafetyPledgePhotos, '食品安全承诺');
});
