// 用户本地展示偏好：pages/settings/settings.ts 写入，其余业务页面读取后据此调整
// 展示/导航行为。Storage key 与默认值集中维护在这一个文件里，避免各页面各自
// 复制一份容易长期漂移不一致的字符串常量（历史教训见 feedback_stale_lookup_table_after_refactor）。

export const STORAGE_KEY_DEFAULT_HOME_VIEW = 'setting_default_home_view';
export const STORAGE_KEY_PRIVACY_MASK = 'setting_privacy_mask_mode';

export type DefaultHomeView = 'store' | 'personal';

// 默认首页视图：门店汇总 / 个人记录。目前落地在 pages/index/index.ts 的
// "凭证与账本" 通用入口（goToHistory）——未带 anomalyType/statusTab 等精准
// 追溯参数的泛入口跳转时，按这里的偏好决定落在 history.ts 的门店视角还是
// 个人视角（与已有的 ?view=mine 机制复用同一套 viewMode/mineEntryMode）
export function getDefaultHomeView(): DefaultHomeView {
  try {
    const v = wx.getStorageSync(STORAGE_KEY_DEFAULT_HOME_VIEW);
    return v === 'personal' ? 'personal' : 'store';
  } catch (err) {
    return 'store';
  }
}

// 隐私与脱敏模式：开启后，敏感经办人姓名做掩码展示（复用全项目统一的
// utils/core/privacy.ts maskName，不在这里重新发明一套脱敏规则）、金额默认
// 模糊直到用户主动点击"眼睛"图标临时显示（会话内展示态，不改变这个持久化
// 开关本身）
export function isPrivacyMaskEnabled(): boolean {
  try {
    return !!wx.getStorageSync(STORAGE_KEY_PRIVACY_MASK);
  } catch (err) {
    return false;
  }
}
