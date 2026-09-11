/**
 * 应用产品名称（品牌中性，适用于所有入驻机构）
 */
export const APP_NAME = '素小账';

/**
 * 🏛️ 机构类型（orgType）唯一权威枚举
 *
 * 🐛 根因修复（2026-09-04 两套 orgType 枚举体系不统一）：此前 createTenant
 * 云函数的 ORG_TYPES（'charity'/'elderly_care'/'community'/'vegetarian'/
 * 'rescue'/'other'）与 manageStoreProfile 云函数的 VALID_ORG_TYPES
 * （'yuhuazhai'/'elderly_canteen'/'volunteer_station'/'rescue_team'/
 * 'tongxin_children'/'tongxin_cancer_care'/'other'）是两套几乎完全不重叠
 * 的取值——所有通过新用户"新建组织"引导流程创建的门店，写入的 orgType
 * 是前者，而 getNationalDashboard 的大屏分组 Tab、computeOrgDisplayCopy/
 * getNoticeTemplate 的品牌文化文案分支、门店信息配置弹窗的机构类型选择器
 * 等全部只认后者——前者的值在这些下游消费方眼里全部等价于"未识别"，
 * 静默落入默认/兜底分支，从未真正生效过。
 *
 * manageStoreProfile 的 VALID_ORG_TYPES 是深度集成、被十余处下游消费的
 * 真实权威口径（与本文件 CLAUDE.md 文档记录的 orgType 域基本一致），本次
 * 以它为准统一收敛——createTenant/createStore 两个云函数的白名单、以及
 * 本文件这份前端选择器共用同一份取值，不再各自维护互相对不上的列表。
 *
 * 🛡️ 云函数之间没有跨文件共享模块的机制（本仓库一贯做法），
 * cloudfunctions/createTenant/index.js、cloudfunctions/createStore/index.js、
 * cloudfunctions/manageStoreProfile/index.js、cloudfunctions/processRoleAudit/index.js
 * 四处各自维护一份同源拷贝——修改这里的取值域时，务必同步改这四个文件，否则又会退回
 * "两套体系"的老问题
 *
 * ✅（2026-09-11 DRY 收口）前端侧此前存在两处独立手写拷贝
 * （`components/store-picker/store-picker.ts` 与
 * `subpackages/admin/pages/store-profile/store-profile.ts` 各自的
 * `ORG_TYPE_OPTIONS`，emoji 风格文案），一度脱节漏掉 3 个值（真机复现过
 * 用户选不到这三类机构）。现已消灭这两处手写拷贝——两个文件改为直接
 * `import { ORG_TYPE_EMOJI_OPTIONS } from '.../utils/constants'`（见下方），
 * 全仓库前端侧收敛成本文件一处真源，不再需要"改这里要同步改另外 N 处"
 * 的人工提醒，也不需要额外的比对单测。`pages/profile/profile.ts` 的
 * "组织信息配置"弹窗场景文案风格不同（纯文本，不带 emoji），继续复用下方
 * `ORG_TYPES` 本身，两个导出的 value 取值集合始终保持一致（`ORG_TYPE_EMOJI_OPTIONS`
 * 由 `ORG_TYPES.map()` 派生，不是独立字面量，新增/删除枚举值只需要改
 * `ORG_TYPES` 这一处，`ORG_TYPE_EMOJI_OPTIONS` 自动跟上）。
 *
 * 🛡️ 云函数之间没有跨文件共享模块的机制（本仓库一贯做法），
 * cloudfunctions/createTenant/index.js、cloudfunctions/createStore/index.js、
 * cloudfunctions/manageStoreProfile/index.js、cloudfunctions/processRoleAudit/index.js
 * 四处仍然各自维护一份同源拷贝（TS 前端模块无法被云函数 `require()`）——
 * 修改这里的取值域时，前端侧现在只需要改这一处，但云函数侧仍需同步改这四个文件。
 *
 * 🏛️（2026-09-09 工作空间正名 + 机构类型扩展）"社区普惠与社会互助专区"（原"民间爱心
 * 食堂"，纯前端展示名，不对应任何落库字段，见 docs/architecture/01_.../03_...md）下
 * 新增 temple_canteen/commercial_vegetarian 两类机构类型，同步补齐
 * cloudfunctions/getNationalDashboard/index.js 的 SUPPORTED_ORG_TYPES 与
 * pages/profile/profile.ts 的 ORG_CONFIG_CURATED_VALUES/ORG_CONFIG_TYPE_META
 */
export const ORG_TYPES: Array<{ value: string; label: string }> = [
  { value: 'yuhuazhai', label: '雨花斋' },
  { value: 'elderly_canteen', label: '社区助餐 / 敬老家园' },
  { value: 'volunteer_station', label: '义工服务站 / 互助团队' },
  { value: 'rescue_team', label: '应急救援队' },
  { value: 'tongxin_children', label: '同心 · 儿童关爱' },
  { value: 'tongxin_cancer_care', label: '同心 · 抗癌关爱' },
  { value: 'temple_canteen', label: '寺院斋堂 / 十方过斋' },
  { value: 'commercial_vegetarian', label: '商业素餐 / 结缘供斋' },
  { value: 'other', label: '其他互助组织' }
];

export const ORG_TYPE_VALUES: string[] = ORG_TYPES.map(item => item.value);

/**
 * 🌸 emoji 风格机构类型选项——供 store-picker（新建门店/选择平台类型）与
 * store-profile（门店档案编辑）两个场景共用。文案与上面纯文本 `ORG_TYPES.label`
 * 不同（这两个场景历史上就是 emoji 风格，问题不大，保留既有视觉习惯，不强行
 * 统一成纯文本），但 **不是独立字面量**——从 `ORG_TYPES` `.map()` 派生，
 * value 集合与 `ORG_TYPES`/`ORG_TYPE_VALUES` 天然保持一致，新增枚举值时
 * 即使忘记在 `ORG_TYPE_EMOJI_LABELS` 里补一条 emoji 文案，也会用
 * `ORG_TYPES` 的纯文本 `label` 兜底展示，不会像过去的手写拷贝那样直接
 * 从下拉列表里彻底消失。
 */
const ORG_TYPE_EMOJI_LABELS: Record<string, string> = {
  yuhuazhai: '🌸 雨花斋',
  elderly_canteen: '👵👴 社区助老食堂/敬老家园',
  volunteer_station: '🤝 社区义工服务站',
  rescue_team: '🛟 应急救援队',
  tongxin_children: '🧒 同心儿童院/青少年关爱',
  tongxin_cancer_care: '🎗️ 同心癌友关怀会',
  temple_canteen: '🙏 寺院斋堂/十方过斋',
  commercial_vegetarian: '🍱 商业素餐/结缘供斋',
  other: '💫 其他爱心组织'
};

export const ORG_TYPE_EMOJI_OPTIONS: Array<{ name: string; value: string }> = ORG_TYPES.map((item) => ({
  name: ORG_TYPE_EMOJI_LABELS[item.value] || item.label,
  value: item.value
}));

/**
 * 门店预设映射配置
 * 🌐 多租户说明：这些预设仅供"雨花斋原始账套"内已有门店的快捷匹配使用
 * （如海报生成时自动填充公众号名称/标语），不作为新用户的默认门店。
 * 新机构/门店通过 createTenant 云函数自助创建，所有字段动态从云数据库读取。
 */
export interface StorePreset {
  storeName: string;
  officialAccount: string;
  thanksWord: string;
  slogan1: string;
  slogan2: string;
}

export const STORE_PRESETS: StorePreset[] = [
  {
    storeName: '海沧区雨花斋',
    officialAccount: '厦门海沧雨花斋',
    thanksWord: '感谢各位爱心人士的鼎力支持，感恩默默付出的义工团队！',
    slogan1: '吃素一日 健康一天',
    slogan2: '清晰记账 透明运行'
  },
  {
    storeName: '湖里区雨花斋',
    officialAccount: '厦门湖里雨花斋',
    thanksWord: '感谢各位爱心人士的鼎力支持，感恩默默付出的义工团队！',
    slogan1: '吃素一日 健康一天',
    slogan2: '清晰记账 透明运行'
  },
  {
    storeName: '白礁保生',
    officialAccount: '白礁保生',
    thanksWord: '感谢各位爱心人士的鼎力支持，感恩默默付出的义工团队！',
    slogan1: '吃素一日 健康一天',
    slogan2: '清晰记账 透明运行'
  }
];

/**
 * 通用兜底标语：新机构在门店档案未配置自定义标语时使用
 */
export const DEFAULT_SLOGAN: Pick<StorePreset, 'thanksWord' | 'slogan1' | 'slogan2'> = {
  thanksWord: '感谢各位爱心人士的鼎力支持，感恩默默付出的义工团队！',
  slogan1:    '用心服务 传递温暖',
  slogan2:    '清晰记账 透明运行'
};

/**
 * 自定义门店选项标识
 */
export const CUSTOM_STORE_LABEL = '➕ 自定义新门店';

/**
 * 门店选择器显示的完整列表（仅雨花斋账套内使用，新机构动态从云端拉取）
 */
export const STORE_PICKER_LIST: string[] = [
  ...STORE_PRESETS.map(item => item.storeName),
  CUSTOM_STORE_LABEL
];

/**
 * 根据门店名称查找对应预设
 * @param storeName 门店名称
 */
export function findStorePreset(storeName: string): StorePreset | undefined {
  if (!storeName) return undefined;
  return STORE_PRESETS.find(p => p.storeName === storeName);
}

/**
 * 清洗门店名称，移除行政区划等易少打字的干扰字符
 * 用于模糊匹配历史记录
 * @param name 原始门店名称
 */
export function normalizeStoreName(name: string): string {
  return (name || '').replace(/[区市省店]/g, '').trim();
}

/**
 * 判断两个门店名称是否模糊匹配
 * 支持双向包含判定，兼容历史数据少字/多字的情况
 * @param storeA 门店A
 * @param storeB 门店B
 */
export function isStoreNameFuzzyMatch(storeA: string, storeB: string): boolean {
  if (!storeA || !storeB) return false;
  const cleanA = normalizeStoreName(storeA);
  const cleanB = normalizeStoreName(storeB);
  if (!cleanA || !cleanB) return false;
  return cleanA.includes(cleanB) || cleanB.includes(cleanA);
}
