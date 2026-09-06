// 跨 Tab 交接标记：门店选择抽屉（store-picker 组件）发现调用者压根没有归属
// 任何机构（tenantId 为空）时，不能像小程序 Tab 内页面那样直接 setData 唤起
// 个人中心的"创建全新机构"引导弹窗（showOnboardingModal），因为个人中心是
// 独立的 Tab 页面，组件所在的首页 Tab 无法直接操作它的 data。与
// subscriptionHandoff.ts 同一套"先落一个 Storage 标记，switchTab 过去后
// 由目标页面自己在 onShow 里读取并消费"手法。
const OPEN_ONBOARDING_CREATE_KEY = '__open_onboarding_create__';

export function requestOpenOnboardingCreate(): void {
  wx.setStorageSync(OPEN_ONBOARDING_CREATE_KEY, true);
}

export function takeOpenOnboardingCreateRequest(): boolean {
  try {
    const flag = wx.getStorageSync(OPEN_ONBOARDING_CREATE_KEY);
    wx.removeStorageSync(OPEN_ONBOARDING_CREATE_KEY);
    return !!flag;
  } catch (err) {
    return false;
  }
}
