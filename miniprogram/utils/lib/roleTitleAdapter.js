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
//
// 🏷️（2026-09-15 补充）family（家人/服务对象）是纯展示层的伪角色 key，
// 与 store_patriarch/store_manager/finance/volunteer 这四个真实落库枚举
// 值不是同一件事——backend 从不写入 role='family'，store-picker 的
// applyRole='store_family' 最终落库仍归一化为 volunteer（见 authService.ts
// ROLE_TIER 注释）。这里给它一个展示 key 纯粹是为了让 store-picker.wxml/
// index.wxml 能用同一套 {{roleDisplayTitles.xxx.title}} 语法动态绑定"家人"
// 这个入口的文案，不代表底层多了一个新角色。
//
// 🛠️ serviceToolsTitle：首页"义工现场服务工具"金刚区大标题，与四个角色 key
// 平级的字符串字段（不是 {emoji,title,subtitle} 形状），按场景切换措辞。

const DEFAULT_TITLES = {
  store_patriarch: { emoji: '👑', title: '大家长', subtitle: '统筹发起 / 核心管理' },
  store_manager: { emoji: '👔', title: '店长', subtitle: '日常运营 / 排班餐报' },
  finance: { emoji: '💼', title: '财务', subtitle: '' },
  volunteer: { emoji: '🌸', title: '义工', subtitle: '' },
  family: { emoji: '🏠', title: '家人', subtitle: '' },
  serviceToolsTitle: '义工现场服务工具'
};

const TEMPLE_CANTEEN_TITLES = {
  store_patriarch: { emoji: '👑', title: '庙董 / 住持', subtitle: '管委会/理事会负责人' },
  store_manager: { emoji: '👔', title: '堂主 / 执事', subtitle: '殿堂主理人' },
  finance: { emoji: '💼', title: '账房', subtitle: '功德香油核算' },
  volunteer: { emoji: '🌸', title: '护法善信', subtitle: '发心护持居士' },
  // 寺庙语境不用"家人"称呼普通食客/服务对象——改用"十方善信"（佛门对四方
  // 信众的通用敬称），副标题用更贴近日常场景的"随喜香客/结缘信众"
  family: { emoji: '❤️', title: '十方善信', subtitle: '随喜香客/结缘信众' },
  serviceToolsTitle: '善信现场护持工具'
};

const ELDERLY_CANTEEN_TITLES = {
  store_patriarch: { emoji: '👑', title: '理事长 / 发起人', subtitle: '' },
  store_manager: { emoji: '👔', title: '站长 / 店长', subtitle: '' },
  finance: { emoji: '💼', title: '会计', subtitle: '助老专款核算' },
  volunteer: { emoji: '🌸', title: '志愿者', subtitle: '爱心助老志愿' },
  family: { emoji: '❤️', title: '社区长者', subtitle: '就餐老人及家属' },
  serviceToolsTitle: '助老现场服务工具'
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
 *   volunteer: {emoji:string, title:string, subtitle:string},
 *   family: {emoji:string, title:string, subtitle:string},
 *   serviceToolsTitle: string
 * }}
 */
function resolveRoleTitles(orgType) {
  return TITLES_BY_ORG_TYPE[orgType] || DEFAULT_TITLES;
}

module.exports = { resolveRoleTitles, DEFAULT_TITLES, TEMPLE_CANTEEN_TITLES, ELDERLY_CANTEEN_TITLES };
