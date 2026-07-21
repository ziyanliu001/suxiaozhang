// 官方原生自定义 TabBar 组件（miniprogram/custom-tab-bar/index.*）
// 必须放在此保留路径下，并在 app.json 的 tabBar.custom 设为 true 才会被框架自动识别、
// 自动挂载到 tabBar.list 中声明的每个页面底部——无需在各页面 wxml 中手动引入。
Component({
    data: {
        selected: 0,
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
