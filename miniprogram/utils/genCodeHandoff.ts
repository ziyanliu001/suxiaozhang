// 门店管理页「生成邀请码」快捷按钮 -> 首页 的交接标记：不在门店管理页重新实现一套
// 邀请码生成 UI（会导致两处逻辑各自维护），而是跳回首页并带上目标门店，首页 onShow 里
// 据此打开已有的 onOpenGenCodeModal 并直接预选中该门店。
const GEN_CODE_TARGET_KEY = '__gen_code_target_store__';

export interface GenCodeTargetStore {
  storeId: string;
  storeName: string;
}

export function setGenCodeHandoff(target: GenCodeTargetStore): void {
  wx.setStorageSync(GEN_CODE_TARGET_KEY, target);
}

export function takeGenCodeHandoff(): GenCodeTargetStore | null {
  try {
    const target = wx.getStorageSync(GEN_CODE_TARGET_KEY);
    wx.removeStorageSync(GEN_CODE_TARGET_KEY);
    return target && target.storeId ? target : null;
  } catch (err) {
    return null;
  }
}
