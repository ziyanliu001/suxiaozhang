// 官方原生自定义 TabBar 组件（miniprogram/custom-tab-bar/index.*）
// 必须放在此保留路径下，并在 app.json 的 tabBar.custom 设为 true 才会被框架自动识别、
// 自动挂载到 tabBar.list 中声明的每个页面底部——无需在各页面 wxml 中手动引入。
Component({
    data: {
        selected: 0,
        // 🐛 根因修复：全屏/半屏弹窗（套餐升级卡片、加入门店申请表单等）此前
        // 无论把自己的 z-index 调多高都盖不住这个自定义 tabBar——因为它是框架
        // 自动挂载的原生层组件，不受页面自身层叠上下文约束，纯 CSS 层面无法
        // 覆盖。宿主页面唤起这类弹窗时改为显式调用 utils/tabBarVisibility.ts
        // 的 setTabBarHidden(this, true) 隐藏本组件，关闭弹窗时再恢复
        hide: false,
        tabs: [
            { key: 'home', pagePath: '/pages/index/index', text: '主页' },
            { key: 'inbox', pagePath: '/pages/notice/notice', text: '通知' },
            { key: 'mine', pagePath: '/pages/profile/profile', text: '你' }
        ]
    },
    lifetimes: {
        attached() {
            this.syncSelectedFromRoute();
        }
    },
    pageLifetimes: {
        // 所属页面每次 onShow（含 switchTab 切回）都会触发，自动同步高亮态，
        // 无需在各业务页面里手动调用 getTabBar().setData()
        show() {
            this.syncSelectedFromRoute();
        }
    },
    methods: {
        syncSelectedFromRoute() {
            const pages = getCurrentPages();
            const current = pages[pages.length - 1];
            if (!current)
                return;
            const route = `/${current.route}`;
            const idx = this.data.tabs.findIndex((t) => t.pagePath === route);
            if (idx > -1 && idx !== this.data.selected) {
                this.setData({ selected: idx });
            }
        },
        onTapTab(e) {
            const { index, path } = e.currentTarget.dataset;
            if (!path || index === this.data.selected)
                return;
            wx.switchTab({
                url: path,
                success: () => {
                    this.setData({ selected: index });
                },
                fail: (err) => {
                    console.error('[custom-tab-bar] switchTab 失败:', err);
                }
            });
        }
    }
});
