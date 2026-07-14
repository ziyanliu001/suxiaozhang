/**
 * 门店预设映射配置
 * 用于首页店铺名称选择、公众号自动联动、标语致谢词自动填充
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
 * 自定义门店选项标识
 */
export const CUSTOM_STORE_LABEL = '➕ 自定义新门店';

/**
 * 门店选择器显示的完整列表
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
