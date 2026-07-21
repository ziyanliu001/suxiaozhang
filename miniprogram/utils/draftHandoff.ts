// 草稿箱 -> 首页 的交接标记：草稿箱页面本身不重写草稿加载逻辑，只是告诉首页
// "用户选了哪一天/哪个门店的草稿"，首页 onShow 里用已有的 loadDraftByDate() 去真正加载。
const RESUME_DRAFT_KEY = '__resume_draft__';

export interface ResumeDraftPayload {
  dateValue: string;
  shopName: string;
}

export function setResumeDraftHandoff(payload: ResumeDraftPayload): void {
  wx.setStorageSync(RESUME_DRAFT_KEY, payload);
}

export function takeResumeDraftHandoff(): ResumeDraftPayload | null {
  try {
    const payload = wx.getStorageSync(RESUME_DRAFT_KEY);
    wx.removeStorageSync(RESUME_DRAFT_KEY);
    return payload && payload.dateValue ? payload : null;
  } catch (err) {
    return null;
  }
}
