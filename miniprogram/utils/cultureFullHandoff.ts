// 个人页「雨花家训与文化全集」-> 首页 的交接标记：文化全集弹窗的唯一实现在
// index.ts（onShowFamilyMottoModal，十大模块完整原文），其他页面不复制这套内容，
// 只标记"用户想看文化全集"，首页 onShow 里据此打开已有的弹窗。
const OPEN_CULTURE_FULL_KEY = '__open_culture_full__';

export function requestOpenCultureFull(): void {
  wx.setStorageSync(OPEN_CULTURE_FULL_KEY, true);
}

export function takeOpenCultureFullRequest(): boolean {
  try {
    const flag = wx.getStorageSync(OPEN_CULTURE_FULL_KEY);
    wx.removeStorageSync(OPEN_CULTURE_FULL_KEY);
    return !!flag;
  } catch (err) {
    return false;
  }
}
