// 统计页/其他页 → 个人中心「开通专业版」的交接标记：
// 大家长/超管在统计页点击升级时，先设此标记再 switchTab 到个人中心；
// 个人中心 onShow 检测到标记后自动唤起已有的套餐订购弹窗，避免出现
// "请在个人中心开通专业版"的死循环 Toast。
const OPEN_SUBSCRIPTION_KEY = '__open_subscription_modal__';

export function requestOpenSubscription(): void {
  wx.setStorageSync(OPEN_SUBSCRIPTION_KEY, true);
}

export function takeOpenSubscriptionRequest(): boolean {
  try {
    const flag = wx.getStorageSync(OPEN_SUBSCRIPTION_KEY);
    wx.removeStorageSync(OPEN_SUBSCRIPTION_KEY);
    return !!flag;
  } catch (err) {
    return false;
  }
}
