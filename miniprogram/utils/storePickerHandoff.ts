// 个人页「切换关注门店」-> 首页 的交接标记：门店选择器（store-picker）唯一的可见
// 实例挂载在首页 index.wxml（id="storePicker"），其他页面不重复挂载自己的实例
// （曾经在个人页里用 width:0/height:0 隐藏挂载一份，结果因自定义组件宿主标签
// 默认 display:inline、宽高不生效而在页面底部露出一个失控的胶囊按钮），
// 现在只标记"用户想切换门店"，首页 onShow 里据此直接拉起已有的选择器面板。
const OPEN_STORE_PICKER_KEY = '__open_store_picker__';

export function requestOpenStorePicker(): void {
  wx.setStorageSync(OPEN_STORE_PICKER_KEY, true);
}

export function takeOpenStorePickerRequest(): boolean {
  try {
    const flag = wx.getStorageSync(OPEN_STORE_PICKER_KEY);
    wx.removeStorageSync(OPEN_STORE_PICKER_KEY);
    return !!flag;
  } catch (err) {
    return false;
  }
}
