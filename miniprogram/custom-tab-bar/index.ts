// 官方原生自定义 TabBar 组件（miniprogram/custom-tab-bar/index.*）
// 必须放在此保留路径下，并在 app.json 的 tabBar.custom 设为 true 才会被框架自动识别、
// 自动挂载到 tabBar.list 中声明的每个页面底部——无需在各页面 wxml 中手动引入。
import { DataService } from '../utils/dataService';
import { AuthService } from '../utils/authService';
import { computeActionableCount } from '../utils/approvalBadge';

// 模块级节流标记：custom-tab-bar 会随每个 tab 页面各自挂载一个组件实例，
// 但 JS 模块本身在一次会话内只加载一次，用模块级变量即可让节流在多个实例间共享，
// 避免用户来回切 Tab 时把"通知"云端查询打成高频轮询。
let lastBadgeFetchTs = 0;
const BADGE_FETCH_THROTTLE_MS = 60000;

Component({
  data: {
    selected: 0,
    // 🐛 根因修复：全屏/半屏弹窗（套餐升级卡片、加入门店申请表单等）此前
    // 无论把自己的 z-index 调多高都盖不住这个自定义 tabBar——它是微信客户端
    // 框架在 tabBar.custom=true 时自动挂载到 tabBar.list 声明页面上的原生层
    // 组件，不在页面自己的 WXML 树/层叠上下文里，纯 CSS z-index 天然覆盖不到
    // （微信官方确认过的平台限制，不是本项目样式写错）。宿主页面唤起这类
    // 弹窗时改为显式调用 utils/tabBarVisibility.ts 的
    // setTabBarHidden(this, true) 隐藏本组件，关闭弹窗时再恢复
    hide: false,
    tabs: [
      { key: 'home', pagePath: '/pages/index/index', text: '主页' },
      { key: 'inbox', pagePath: '/pages/notice/notice', text: '通知' },
      { key: 'mine', pagePath: '/pages/profile/profile', text: '你' }
    ],
    badge: 0
  },

  lifetimes: {
    attached() {
      this.syncSelectedFromRoute();
      this.syncBadgeFromGlobal();
      this.refreshBadge();
    }
  },

  pageLifetimes: {
    // 所属页面每次 onShow（含 switchTab 切回）都会触发，自动同步高亮态，
    // 无需在各业务页面里手动调用 getTabBar().setData()
    show() {
      this.syncSelectedFromRoute();
      this.syncBadgeFromGlobal();
      this.refreshBadge();
    }
  },

  methods: {
    syncSelectedFromRoute() {
      const pages = getCurrentPages();
      const current = pages[pages.length - 1];
      if (!current) return;

      const route = `/${current.route}`;
      const idx = this.data.tabs.findIndex((t: any) => t.pagePath === route);
      if (idx > -1 && idx !== this.data.selected) {
        this.setData({ selected: idx });
      }
    },

    onTapTab(e: any) {
      const { index, path } = e.currentTarget.dataset;
      if (!path || index === this.data.selected) return;

      wx.switchTab({
        url: path,
        success: () => {
          this.setData({ selected: index });
        },
        fail: (err) => {
          console.error('[custom-tab-bar] switchTab 失败:', err);
        }
      });
    },

    // 先用 app.globalData 里已知的最新值即时渲染一次，避免等云端查询期间徽标空白/闪烁；
    // pages/notice/notice.ts 每次成功拉取列表后都会把最新计数写回这里
    syncBadgeFromGlobal() {
      const app = getApp() as any;
      const count = app && app.globalData && app.globalData.pendingApprovalCount;
      if (typeof count === 'number' && count !== this.data.badge) {
        this.setData({ badge: count });
      }
    },

    // 徽标自给自足：即使用户还没打开过"通知"页，Tab 上也能显示正确的待处理数量，
    // 60s 节流，失败静默降级（不影响其余 Tab 功能）
    async refreshBadge() {
      const now = Date.now();
      if (now - lastBadgeFetchTs < BADGE_FETCH_THROTTLE_MS) return;
      lastBadgeFetchTs = now;

      try {
        const cached = AuthService.getCachedRoleInfo();
        const role = ((cached && cached.role) || wx.getStorageSync('current_user_role') || 'volunteer').toLowerCase();
        const isSuperAdmin = role === 'super_admin';
        const isManagerRole = role === 'store_manager' || isSuperAdmin;
        const isFinanceRole = role === 'finance' || isSuperAdmin;

        const result = await DataService.getReports({ viewMode: 'all', limit: 50 });
        const badge = computeActionableCount(result.data || [], { isManagerRole, isFinanceRole, isSuperAdmin });

        const app = getApp() as any;
        if (app && app.globalData) {
          app.globalData.pendingApprovalCount = badge;
        }
        this.setData({ badge });
      } catch (err) {
        console.warn('[custom-tab-bar] 徽标刷新失败:', err);
      }
    }
  }
});
