// 设置页 -> 首页 的交接标记：合规声明弹窗的唯一实现在 index.ts（文案长且涉及法务），
// 设置页不复制文案，只是标记"用户想看一次完整声明"，首页 onShow 里据此打开已有的 review 场景弹窗。
const OPEN_COMPLIANCE_REVIEW_KEY = '__open_compliance_review__';

export function requestComplianceReview(): void {
  wx.setStorageSync(OPEN_COMPLIANCE_REVIEW_KEY, true);
}

export function takeComplianceReviewRequest(): boolean {
  try {
    const flag = wx.getStorageSync(OPEN_COMPLIANCE_REVIEW_KEY);
    wx.removeStorageSync(OPEN_COMPLIANCE_REVIEW_KEY);
    return !!flag;
  } catch (err) {
    return false;
  }
}
