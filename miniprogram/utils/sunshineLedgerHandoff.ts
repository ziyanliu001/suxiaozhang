// 个人页「关于雨花斋与阳光账本」-> 首页 的交接标记：阳光账本弹窗的唯一实现在
// index.ts（sunshineLedgerData/onOpenSunshineLedger），其他页面不复制这套数据管线，
// 只标记"用户想看阳光账本"，首页 onShow 里据此打开已有的弹窗。
const OPEN_SUNSHINE_LEDGER_KEY = '__open_sunshine_ledger__';

export function requestOpenSunshineLedger(): void {
  wx.setStorageSync(OPEN_SUNSHINE_LEDGER_KEY, true);
}

export function takeOpenSunshineLedgerRequest(): boolean {
  try {
    const flag = wx.getStorageSync(OPEN_SUNSHINE_LEDGER_KEY);
    wx.removeStorageSync(OPEN_SUNSHINE_LEDGER_KEY);
    return !!flag;
  } catch (err) {
    return false;
  }
}
