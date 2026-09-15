'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRoleTitles, DEFAULT_TITLES, TEMPLE_CANTEEN_TITLES, ELDERLY_CANTEEN_TITLES } = require('./roleTitleAdapter');

// 真实落库角色枚举——4 个真实值 + family 这个纯展示伪角色（backend 从不写入
// role='family'，见 roleTitleAdapter.js 头部 2026-09-15 补充注释）
const ROLE_KEYS = ['store_patriarch', 'store_manager', 'finance', 'volunteer', 'family'];

test('temple_canteen：五个角色（含 family）均返回专属称谓与副标题，serviceToolsTitle 同步切换', () => {
  const titles = resolveRoleTitles('temple_canteen');
  assert.equal(titles.store_patriarch.title, '庙董 / 住持');
  assert.equal(titles.store_patriarch.subtitle, '管委会/理事会负责人');
  assert.equal(titles.store_manager.title, '堂主 / 执事');
  assert.equal(titles.store_manager.subtitle, '殿堂主理人');
  assert.equal(titles.finance.title, '账房');
  assert.equal(titles.finance.subtitle, '功德香油核算');
  assert.equal(titles.volunteer.title, '护法善信');
  assert.equal(titles.volunteer.subtitle, '发心护持居士');
  assert.equal(titles.family.emoji, '❤️');
  assert.equal(titles.family.title, '十方善信');
  assert.equal(titles.family.subtitle, '随喜香客/结缘信众');
  assert.equal(titles.serviceToolsTitle, '善信现场护持工具');
});

test('elderly_canteen：财务/义工/family 有专属副标题，店长/大家长称谓变化但无副标题，serviceToolsTitle 同步切换', () => {
  const titles = resolveRoleTitles('elderly_canteen');
  assert.equal(titles.store_patriarch.title, '理事长 / 发起人');
  assert.equal(titles.store_patriarch.subtitle, '');
  assert.equal(titles.store_manager.title, '站长 / 店长');
  assert.equal(titles.store_manager.subtitle, '');
  assert.equal(titles.finance.title, '会计');
  assert.equal(titles.finance.subtitle, '助老专款核算');
  assert.equal(titles.volunteer.title, '志愿者');
  assert.equal(titles.volunteer.subtitle, '爱心助老志愿');
  assert.equal(titles.family.emoji, '❤️');
  assert.equal(titles.family.title, '社区长者');
  assert.equal(titles.family.subtitle, '就餐老人及家属');
  assert.equal(titles.serviceToolsTitle, '助老现场服务工具');
});

test('yuhuazhai/volunteer_station：保持经典称谓（默认映射），serviceToolsTitle 为经典"义工现场服务工具"', () => {
  assert.deepEqual(resolveRoleTitles('yuhuazhai'), DEFAULT_TITLES);
  assert.deepEqual(resolveRoleTitles('volunteer_station'), DEFAULT_TITLES);
  assert.equal(resolveRoleTitles('yuhuazhai').serviceToolsTitle, '义工现场服务工具');
  assert.equal(resolveRoleTitles('yuhuazhai').family.title, '家人');
});

test('未选择场景（空字符串/undefined）时兜底为经典称谓，不抛异常', () => {
  assert.deepEqual(resolveRoleTitles(''), DEFAULT_TITLES);
  assert.deepEqual(resolveRoleTitles(undefined), DEFAULT_TITLES);
});

test('4 卡片快选之外的其余真实 orgType（如 rescue_team）同样兜底为经典称谓', () => {
  assert.deepEqual(resolveRoleTitles('rescue_team'), DEFAULT_TITLES);
  assert.deepEqual(resolveRoleTitles('tongxin_children'), DEFAULT_TITLES);
  assert.deepEqual(resolveRoleTitles('commercial_vegetarian'), DEFAULT_TITLES);
});

test('未知/非法字符串同样安全兜底，不抛异常', () => {
  assert.deepEqual(resolveRoleTitles('not_a_real_org_type'), DEFAULT_TITLES);
});

test('每个场景的返回对象都覆盖全部 5 个角色 key（含 family），每个角色都有 emoji/title/subtitle 三个字段，且 serviceToolsTitle 是独立的字符串字段', () => {
  ['temple_canteen', 'elderly_canteen', '', 'yuhuazhai'].forEach((orgType) => {
    const titles = resolveRoleTitles(orgType);
    ROLE_KEYS.forEach((key) => {
      assert.ok(titles[key], `${orgType} 场景缺少 ${key}`);
      assert.equal(typeof titles[key].emoji, 'string');
      assert.equal(typeof titles[key].title, 'string');
      assert.equal(typeof titles[key].subtitle, 'string');
    });
    assert.equal(typeof titles.serviceToolsTitle, 'string');
    assert.ok(titles.serviceToolsTitle.length > 0);
  });
});

test('返回对象的 key 集合 = 4 个真实落库枚举值 + family 伪角色 + serviceToolsTitle 字符串字段，不多不少', () => {
  const titles = resolveRoleTitles('temple_canteen');
  assert.deepEqual(Object.keys(titles).sort(), [...ROLE_KEYS, 'serviceToolsTitle'].sort());
});

test('DEFAULT_TITLES/TEMPLE_CANTEEN_TITLES/ELDERLY_CANTEEN_TITLES 三份映射互不共享引用（防止调用方误改一份连带污染另一份）', () => {
  assert.notEqual(DEFAULT_TITLES, TEMPLE_CANTEEN_TITLES);
  assert.notEqual(DEFAULT_TITLES, ELDERLY_CANTEEN_TITLES);
  assert.notEqual(TEMPLE_CANTEEN_TITLES, ELDERLY_CANTEEN_TITLES);
});
