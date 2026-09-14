'use strict';

// 纯逻辑：按新建门店已选的服务场景（orgType）动态适配四个角色的展示称谓，
// 不做 db I/O、不依赖 wx-server-sdk/小程序 API，便于单测；与 utils/lib/
// 目录下其余纯函数（resolveActiveRoleGrant.js 等）同一套写法，index.ts/
// store-picker.ts 通过 import { resolveRoleTitles } from './lib/roleTitleAdapter'
// 引入（allowJs 已开启，TS 侧可直接 import 这份 .js 模块）。
//
// 🛡️ 底层落库枚举完全不变：本文件只负责"这个角色在 UI 上该叫什么名字/
// 副标题"，永远不影响 processRoleAudit/createStore 实际写入的
// `requestedRole`/`role` 字段（那四个值——store_patriarch/store_manager/
// finance/volunteer——是全仓库权限判定的唯一真源，见 docs/SCHEMA.md 2.1 节，
// 本文件的返回值只用于展示层文案，两者是完全独立的两件事）。
//
// 🏛️ 场景覆盖范围：只有 temple_canteen（寺院宫庙）与 elderly_canteen（社区
// 助老）有专属称谓映射；其余任何 orgType（含 yuhuazhai/volunteer_station、
// 未选择/空字符串、以及本次 4 卡片快选之外的其余 5 个真实 orgType 值）一律
// 落到 DEFAULT_TITLES 这套经典称谓——不是"遗漏"，是任务本身要求"其余默认
// 场景保持经典称谓"，新增机构类型时不需要同步维护这份映射表。

const DEFAULT_TITLES = {
  store_patriarch: { emoji: '👑', title: '大家长', subtitle: '统筹发起 / 核心管理' },
  store_manager: { emoji: '👔', title: '店长', subtitle: '日常运营 / 排班餐报' },
  finance: { emoji: '💼', title: '财务', subtitle: '' },
  volunteer: { emoji: '🌸', title: '义工', subtitle: '' }
};

const TEMPLE_CANTEEN_TITLES = {
  store_patriarch: { emoji: '👑', title: '庙董 / 住持', subtitle: '管委会/理事会负责人' },
  store_manager: { emoji: '👔', title: '堂主 / 执事', subtitle: '殿堂主理人' },
  finance: { emoji: '💼', title: '账房', subtitle: '功德香油核算' },
  volunteer: { emoji: '🌸', title: '护法善信', subtitle: '发心护持义工' }
};

const ELDERLY_CANTEEN_TITLES = {
  store_patriarch: { emoji: '👑', title: '理事长 / 发起人', subtitle: '' },
  store_manager: { emoji: '👔', title: '站长 / 店长', subtitle: '' },
  finance: { emoji: '💼', title: '会计', subtitle: '助老专款核算' },
  volunteer: { emoji: '🌸', title: '志愿者', subtitle: '爱心助老志愿' }
};

const TITLES_BY_ORG_TYPE = {
  temple_canteen: TEMPLE_CANTEEN_TITLES,
  elderly_canteen: ELDERLY_CANTEEN_TITLES
};

/**
 * @param {string} [orgType] 当前已选服务场景（stores.orgType 取值，或空字符串/未选择）
 * @returns {{
 *   store_patriarch: {emoji:string, title:string, subtitle:string},
 *   store_manager: {emoji:string, title:string, subtitle:string},
 *   finance: {emoji:string, title:string, subtitle:string},
 *   volunteer: {emoji:string, title:string, subtitle:string}
 * }}
 */
function resolveRoleTitles(orgType) {
  return TITLES_BY_ORG_TYPE[orgType] || DEFAULT_TITLES;
}

module.exports = { resolveRoleTitles, DEFAULT_TITLES, TEMPLE_CANTEEN_TITLES, ELDERLY_CANTEEN_TITLES };
