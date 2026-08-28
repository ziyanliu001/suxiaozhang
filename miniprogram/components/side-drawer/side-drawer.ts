// 左侧滑出功能导航抽屉：纯展示 + 事件转发，不直接持有业务逻辑。
// 具体动作（记账/审核/统计/门店管理等）全部由宿主页面（index.ts）已有方法执行，
// 本组件只负责 UI 呈现与"用户点了哪一项"的事件转发，避免和 index.ts 产生逻辑重复。
import { getSafeSystemInfo } from '../../utils/util';
import { safeNavigateTo } from '../../utils/navHelper';

const RECENT_PAGES_KEY = 'recent_visited_pages';

Component({
  properties: {
    storeName: { type: String, value: '' },
    roleLabel: { type: String, value: '义工' },
    isManager: { type: Boolean, value: false },
    isFinance: { type: Boolean, value: false },
    isSuperAdmin: { type: Boolean, value: false },
    // 🦻 关怀模式开关当前状态，由宿主页面（index.ts）持有并回传，本组件不自己
    // 读写 app.globalData/storage，保持"纯展示+事件转发"的既定分工
    careMode: { type: Boolean, value: false }
  },

  data: {
    show: false,
    storeInitial: '素',
    recentList: [] as Array<{ path: string; title: string; ts: number }>,
    // 🛡️ 顶部安全区适配：挖孔屏/刘海屏的摄像头区域会挡住抽屉头部，改用安全区
    // 动态算出的 margin-top，不再用固定的 72rpx 硬编码猜测值（见 attached）
    sidebarTopMargin: 44
  },

  // WXML 表达式不支持字符串下标 `name[0]`（曾误用导致 "unexpected token `[`" 编译错误），
  // 改为在组件逻辑里算好 storeInitial 再绑定展示
  observers: {
    storeName(storeName: string) {
      this.setData({ storeInitial: (storeName || '素').slice(0, 1) });
    }
  },

  lifetimes: {
    attached() {
      this.calculateSafeAreaMargin();
    }
  },

  methods: {
    // 🛡️ 顶部安全区适配：优先取胶囊按钮的 top（微信保证胶囊本身一定画在安全区内，
    // 天然避开左侧挖孔屏摄像头/刘海），量不到才退回 safeArea.top/statusBarHeight；
    // 都拿不到时兜底 44px，与本项目其余页面 calculateNavBarHeight 的兜底值一致
    calculateSafeAreaMargin() {
      try {
        const menuButton = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null;
        if (menuButton && menuButton.top) {
          // +10px（约 20rpx）留一点呼吸间距，不紧贴胶囊
          this.setData({ sidebarTopMargin: menuButton.top + 10 });
          return;
        }

        const systemInfo = getSafeSystemInfo();
        const safeTop = (systemInfo && systemInfo.safeArea && systemInfo.safeArea.top) || (systemInfo && systemInfo.statusBarHeight) || 34;
        this.setData({ sidebarTopMargin: safeTop + 10 });
      } catch (err) {
        console.warn('[side-drawer] 安全区计算失败，使用兜底值:', err);
        this.setData({ sidebarTopMargin: 44 });
      }
    },
    open() {
      this.loadRecentList();
      this.setData({ show: true });
    },

    close() {
      this.setData({ show: false });
    },

    stopBubble() {},
    preventTouchMove() {},

    loadRecentList() {
      try {
        const list = wx.getStorageSync(RECENT_PAGES_KEY);
        this.setData({ recentList: Array.isArray(list) ? list.slice(0, 3) : [] });
      } catch (err) {
        console.warn('[side-drawer] 读取最近访问记录失败:', err);
        this.setData({ recentList: [] });
      }
    },

    onTapAction(e: any) {
      const type = e.currentTarget.dataset.type;
      this.setData({ show: false });
      this.triggerEvent('action', { type });
    },

    // 🦻 开关本身不关闭抽屉（用户可能想连续看效果），宿主页面负责实际写入
    // app.globalData.careMode + wx.setStorageSync('care_mode', ...)
    onToggleCareMode(e: any) {
      this.triggerEvent('toggleCareMode', { value: !!e.detail.value });
    },

    onTapRecent(e: any) {
      const path = e.currentTarget.dataset.path;
      this.setData({ show: false });
      if (!path) return;
      safeNavigateTo({
        url: path,
        fail: (err) => {
          console.warn('[side-drawer] 跳转最近访问页面失败:', err);
        }
      });
    }
  }
});
