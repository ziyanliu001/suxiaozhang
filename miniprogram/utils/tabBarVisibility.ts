// 🐛 根因修复：自定义 tabBar（miniprogram/custom-tab-bar）是微信客户端框架
// 在 app.json tabBar.custom=true 时自动挂载到 tabBar.list 声明页面上的原生层
// 组件，不是页面自己 WXML 树里的普通子节点——这是微信官方确认过的平台限制：
// 页面内任何 position:fixed 元素（包括本项目的 .apply-modal-mask/
// .sub-modal-container 等全屏/半屏弹窗），无论把 z-index 调多高，都无法盖住
// 自定义 tabBar，因为两者根本不在同一个 CSS 层叠上下文里。这不是本项目的
// WXSS 样式 bug，之前反复调整弹窗的 z-index/height 都不可能解决这个问题。
//
// 官方推荐做法：唤起会遮挡到屏幕底部的弹窗时，显式调用 getTabBar().setData()
// 隐藏 tabBar；关闭弹窗时再显式恢复。两者必须成对出现——每一处 setData
// { showXxxModal: true } 都要配一处隐藏 tabBar，每一处收起弹窗（无论是用户
// 主动关闭、提交成功后自动关闭，还是其它任何会让弹窗消失的分支）都要配一处
// 恢复 tabBar，缺一处都会导致 tabBar 状态和弹窗显隐状态脱节。
export function setTabBarHidden(page: any, hidden: boolean): void {
  try {
    const tabBar = page && typeof page.getTabBar === 'function' ? page.getTabBar() : null;
    if (tabBar && typeof tabBar.setData === 'function') {
      tabBar.setData({ hide: hidden });
    }
  } catch (err) {
    console.warn('[tabBarVisibility] setTabBarHidden 失败:', err);
  }
}
