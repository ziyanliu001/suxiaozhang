import { AuthService } from '../../../../utils/authService';
import { getSelectedStore, setSelectedStore } from '../../../../utils/storeManager';
import { compressAndUploadImages } from '../../../../utils/imageCompress';
import { createNavGuard, NavGuardInstance } from '../../../../utils/navGuard';
import { drawActivityPoster } from '../../../../utils/drawActivityPoster';
import { recordRecentVisit } from '../../../../utils/recentPages';
import { isVirtualStoreName } from '../../../../utils/storeIdentity';
import { callFunctionWithTimeout } from '../../../../utils/withTimeout';
import { getStorageAsync } from '../../../../utils/util';
import { ensurePrivacyAuthorized } from '../../../../utils/privacyAuthHub';

const CANVAS_ID = 'imgCompressCanvas';
const PAGE_SIZE = 10;

// 🛡️ "全国总览"/"全部门店" 的 storeId 哨兵值，与 statistics.ts 同一份定义
const NATIONAL_STORE_ID_SENTINELS = ['national_overview', 'ALL_STORES', 'all', 'ALL'];

// 🏷️ 分类 Tag：与云函数 manageActivityLog 的 CATEGORY_VALUES 同一份白名单
const CATEGORY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'daily', label: '日常运营' },
  { value: 'maintenance', label: '设备维护' },
  { value: 'donation', label: '爱心捐款/物资' },
  { value: 'visitor', label: '重要访客' },
  { value: 'incident', label: '异常提醒' }
];
const CATEGORY_LABEL_MAP: Record<string, string> = CATEGORY_OPTIONS.reduce((acc, opt) => {
  acc[opt.value] = opt.label;
  return acc;
}, {} as Record<string, string>);
function categoryLabel(category: string): string {
  return CATEGORY_LABEL_MAP[category] || '未分类';
}

function getTodayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 历史动态 ◀ 上一天/下一天 ▶ 快捷翻页：按天平移，跨月/跨年由 Date 对象自动处理
function shiftDateStr(dateStr: string, deltaDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return dateStr;
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  d.setDate(d.getDate() + deltaDays);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

// updateTime 是云端 db.serverDate() 读回的原生 Date 对象，格式化为 HH:mm 用于"已发布"提示
function formatHHmm(time: any): string {
  if (!time) return '';
  const d = time instanceof Date ? time : new Date(time);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

Page({
  _navGuard: null as NavGuardInstance | null,

  data: {
    contentTop: 0,
    // 🌟 "编辑"按钮浮层定位（独立于 <navigation-bar> 组件之外渲染，见 wxml
    // 说明），由 onNavLayout 接住组件上报的胶囊坐标算出
    navContentTop: 0,
    navContentHeight: 0,
    navRightGap: 0,

    currentStoreId: '',
    currentStoreName: '',
    canManage: false,
    // 🔑 当前登录者的 openid：用于"本人发布的记录可以自己编辑/删除"的按钮显隐判断，
    // 与云函数 manageActivityLog 的 isOwner（existing.createdBy === OPENID）口径一致
    currentUserOpenid: '',
    // 🛡️ 权限收紧：门店提示标签"📍 全国总览"只有超管才该看到（家人/义工/普通
    // 店长财务的 currentStoreName 理论上不该是这个虚拟门店名，但一旦发生—— 比如
    // 共用设备上超管上次选过"全国总览"、getSelectedStore() 缓存串号——也不能
    // 让非超管看到这个越权提示，见 applyRolePermissions/resolveEffectiveStoreIdentity
    isSuperAdmin: false,
    // 🛡️ 门店身份异步解析完成前的骨架占位标记，避免 currentStoreName 到达前的
    // 那一帧默认回退显示任何门店名/全国总览
    roleReady: false,
    // 🛡️ "📷 记录今日动态"发布按钮的权限位：canManage（店长/超管）或 isVolunteer
    // 才能发布，家人（服务对象）isFamily 恒为 false 时按钮不受影响，isFamily 为
    // true 时不会同时命中 canManage/isVolunteer（与 profile.ts/index.ts 同一套
    // 互斥口径），保持纯只读监督视图
    isVolunteer: false,
    isFamily: false,

    // 🌐 超管专属门店切换：只有超管才允许在顶部切换门店，非超管的 currentStoreName
    // 必须锁定为自己绑定的门店，见 applyRolePermissions
    superAdminStoreOptions: [] as Array<{ storeId: string; storeName: string }>,
    superAdminStoreIndex: 0,

    // 📌 今日大事记（顶部高亮区，取当天最新一条；同一天允许多条时其余的仍展示在下方时光轴）
    todayDateStr: getTodayStr(),
    todayItem: null as any,
    todayLoading: false,

    // 🕰 历史大事记（下方时光轴，不含顶部已展示的那一条）。支持按 historyFilterDate
    // 精确筛选某一天，为空时按原有全量分页时光轴展示
    list: [] as any[],
    historyList: [] as any[],
    page: 1,
    total: 0,
    hasMore: true,
    loading: false,
    loadingMore: false,
    historyFilterDate: '',

    showDetailModal: false,
    detailItem: null as any,

    showEditForm: false,
    editForm: {
      id: '',
      title: '',
      eventTime: getTodayStr(),
      content: '',
      category: '',
      images: [] as string[]
    },
    categoryOptions: CATEGORY_OPTIONS,
    uploading: false,

    // 📤 活动海报导出
    showPosterModal: false,
    posterTargetItem: null as any,
    posterReady: false,

    // 🛡️ 缩略图加载失败兜底：key 是图片路径本身，今日动态/历史动态/编辑表单三处
    // 图片网格结构各不相同，共用一张按路径查表的 map 比分别维护 loadFailed 字段简单
    thumbFailedMap: {} as Record<string, boolean>,

    // ⏳ 待确认的义工投稿：仅 canManage（店长/超管）可见，与下方公开时间轴彻底分开展示
    pendingList: [] as any[],
    pendingLoading: false
  },

  async onLoad() {
    recordRecentVisit('/subpackages/admin/pages/activity-log/activity-log', '门店日志');
    // 🔑 需先拿到 currentStoreId 再查今日大事记（list 按 storeId 过滤），故此处 await 顺序执行
    await this.initRoleAndStore();
    this.loadTodayActivity();
    this.fetchList(true);

    this._navGuard = createNavGuard({
      homePath: '/pages/index/index',
      alertMessage: '即将退出雨花爱心餐报助手，是否返回首页继续使用？'
    });
    this._navGuard.setupOnLoad();
  },

  // 🐛 根因修复："全国总览"标签/发布按钮偶发对非超管越权可见：此前角色/门店状态
  // 只在 onLoad（页面实例首次创建）同步一次。如果先在别的页面切换身份/门店
  // （store-picker 写 storage），页面实例仍在导航栈里，onLoad 不会重新触发，
  // 只有 onShow——不补上这个钩子，isFamily/isSuperAdmin/currentStoreName 会
  // 一直停留在第一次进入本页那一刻的旧值。onShow 本就会紧跟首次 onLoad 触发一次，
  // 这里重复调用是无害的（与 profile.ts initMinePage 的刷新时机口径一致）
  async onShow() {
    await this.initRoleAndStore();
  },

  onUnload() {
    if (this._navGuard) {
      this._navGuard.teardown();
      this._navGuard = null;
    }
  },

  // 🐛 根因修复：见 store-management.ts 同处修复记录，改用 <navigation-bar>
  // 共享组件。navContentTop/navContentHeight/navRightGap 额外接住组件上报的
  // 胶囊坐标，供"编辑"浮层按钮（独立于组件之外渲染）定位使用
  onNavLayout(e: { detail: { totalHeight: number; contentTop: number; contentHeight: number; rightGap: number } }) {
    this.setData({
      contentTop: e.detail.totalHeight + 8,
      navContentTop: e.detail.contentTop,
      navContentHeight: e.detail.contentHeight,
      navRightGap: e.detail.rightGap
    });
  },

  // 🐛 去重合并：本地手写的 resolveEffectiveRole 与 AuthService.resolveEffectiveRole
  // 行为已经一致——都是"storage 一旦有 current_user_role 就整体作为生效角色原样
  // 返回（含 'store_family' 这个不在服务端 UserRole 枚举里的本地展示态伪角色），
  // 不再理会服务端角色"，本页下方 applyRolePermissions 依赖的正是这份未被归一化
  // 的原始值来判断 isFamily。改用共享实现还多了一个好处：手动切换命中时会顺带
  // 同步持久化缓存，见 authService.ts resolveEffectiveRole 注释

  // 🐛 核心权限 Bug 修复：此前直接拿 roleInfo.storeName 当门店名用，完全没有过滤
  // "全国总览/全部门店"这类仅超管可用的虚拟聚合名——user_roles 文档一旦曾经是
  // super_admin，账号降级/切换预览视角后这个脏值会一直残留，非超管打开本页会在
  // 顶部误显示"全国总览"。解析口径与 statistics.ts resolveEffectiveStoreIdentity
  // 完全一致：非超管一律过滤虚拟名后退回本地已选中门店；超管允许 storeId 为空
  // （此时顶部展示"全国总览"，这是其真实身份状态）
  async resolveEffectiveStoreIdentity(roleInfo: any, isSuperAdmin: boolean): Promise<{ storeId: string; storeName: string }> {
    let storeId = (roleInfo && roleInfo.storeId) || '';
    let storeName = (roleInfo && roleInfo.storeName) || '';
    if (!isSuperAdmin && isVirtualStoreName(storeName)) {
      storeName = '';
    }

    if (!storeId || !storeName) {
      const activeStore = getSelectedStore();
      const activeStoreName = (activeStore && activeStore.storeName) || '';
      const activeStoreIsVirtual = isVirtualStoreName(activeStoreName);
      if (!storeName && activeStoreName && !(!isSuperAdmin && activeStoreIsVirtual)) {
        storeName = activeStoreName;
      }
      if (!storeId && activeStore && activeStore.storeId && !(!isSuperAdmin && activeStoreIsVirtual)) {
        storeId = activeStore.storeId;
      }
    }

    // 🐛 性能修复：改用异步 wx.getStorage——见 journey.ts/store-profile.ts
    // 同类修复记录
    if (!storeId) {
      const storedId = await getStorageAsync('current_store_id');
      storeId = NATIONAL_STORE_ID_SENTINELS.includes(storedId) ? '' : storedId;
    }
    if (!storeName) {
      const storedName = await getStorageAsync('current_store_name');
      storeName = (!isSuperAdmin && isVirtualStoreName(storedName)) ? '' : storedName;
    }

    return { storeId, storeName };
  },

  // 🛡️ 统一落地角色/门店权限位：canManage/isSuperAdmin/currentStoreName 等展示态
  // 只从这里写入，是本页唯一的权限收口
  applyRolePermissions(role: string, storeName: string, storeId: string) {
    const isFamily = role === 'store_family';
    const isSuperAdmin = !isFamily && role === 'super_admin';
    // 🐛 权限缺口修复：canManage 补上 store_patriarch——服务端
    // resolveWriteTarget/resolveReviewStoreId 对 store_patriarch 和 store_manager
    // 一视同仁（大家长天然继承店长的全套日常管理权限）
    const canManage = !isFamily && (role === 'store_manager' || role === 'store_patriarch' || isSuperAdmin);
    const isVolunteer = !isFamily && role === 'volunteer';
    const currentUserOpenid = AuthService.getOpenid() || '';

    // 🛡️ 展示口径：超管在没有选定具体门店时才允许显示"全国总览"（真实身份状态）；
    // 其余所有情况一律显示真实门店名，严禁出现虚拟聚合名
    const displayStoreName = (isSuperAdmin && !storeId) ? '全国总览' : storeName;

    this.setData({
      currentStoreId: storeId,
      currentStoreName: displayStoreName,
      canManage,
      isSuperAdmin,
      isVolunteer,
      isFamily,
      currentUserOpenid,
      roleReady: true
    });

    // ⏳ 待确认的义工投稿：与本页其余"管理入口"（编辑/删除按钮）同一套 canManage
    // 判定口径，只有店长/超管才需要发这个查询
    if (canManage) {
      this.fetchPendingList();
    }

    // 🌐 超管专属门店切换：只有真正解析出超管身份才需要拉取可选门店列表
    if (isSuperAdmin) {
      this.fetchSuperAdminStoreOptions(storeId);
    }
  },

  async initRoleAndStore() {
    let roleInfo = AuthService.getCachedRoleInfo();
    if (!roleInfo) {
      const result = await AuthService.fetchUserRole();
      roleInfo = result.roleInfo || null;
    }

    const effectiveRole = AuthService.resolveEffectiveRole(roleInfo ? roleInfo.role : '');
    const isSuperAdmin = effectiveRole === 'super_admin';
    const identity = await this.resolveEffectiveStoreIdentity(roleInfo, isSuperAdmin);
    this.applyRolePermissions(effectiveRole, identity.storeName, identity.storeId);
  },

  // 🌐 超管专属门店切换：复用 getStoreList 云函数（本就按 tenantId 收敛，不新建
  // 查询逻辑），前面拼一条"全国总览"虚拟聚合项，与 store-picker 组件的口径一致
  async fetchSuperAdminStoreOptions(currentStoreId: string) {
    try {
      const res = await callFunctionWithTimeout({ name: 'getStoreList', data: {} });
      const result = res.result as any;
      const stores = (result && result.success) ? (result.list || []) : [];
      const options = [{ storeId: '', storeName: '全国总览' }].concat(
        stores.map((s: any) => ({ storeId: s.storeId, storeName: s.storeName }))
      );
      const index = Math.max(0, options.findIndex((o) => o.storeId === currentStoreId));
      this.setData({ superAdminStoreOptions: options, superAdminStoreIndex: index });
    } catch (err) {
      console.warn('[activity-log] fetchSuperAdminStoreOptions 异常:', err);
    }
  },

  // 🌐 超管在顶部切换门店：切到"全国总览"清空 storeId（顶部展示全国总览，
  // 发布/管理入口按 applyRolePermissions 的口径自动收起）；切到具体门店则
  // 调用 setSelectedStore 同步全局态，与首页/其它页面的门店切换行为保持一致
  onSuperAdminStoreChange(e: any) {
    const index = parseInt(e.detail.value, 10) || 0;
    const option = this.data.superAdminStoreOptions[index];
    if (!option) return;

    this.setData({ superAdminStoreIndex: index });
    if (option.storeId) {
      setSelectedStore({ storeId: option.storeId, storeName: option.storeName });
    }
    this.applyRolePermissions('super_admin', option.storeName, option.storeId);
    this.loadTodayActivity();
    this.fetchList(true);
  },

  async fetchPendingList() {
    if (!this.data.currentStoreId) return;
    this.setData({ pendingLoading: true });

    try {
      const res = await callFunctionWithTimeout({
        name: 'manageActivityLog',
        data: { action: 'listPending', storeId: this.data.currentStoreId }
      });
      const result = res.result as any;
      if (result && result.success) {
        this.setData({ pendingList: result.data || [] });
      }
    } catch (err) {
      console.warn('[activity-log] fetchPendingList 异常:', err);
    } finally {
      this.setData({ pendingLoading: false });
    }
  },

  async onApprovePending(e: any) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;

    wx.showLoading({ title: '确认中...', mask: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageActivityLog',
        data: { action: 'approvePending', id }
      });
      wx.hideLoading();
      const result = res.result as any;
      if (result && result.success) {
        wx.showToast({ title: '已确认', icon: 'success' });
        this.fetchPendingList();
        // 刚确认的这条动态可能就是今天的，公开列表/今日高亮区需要一并刷新
        this.loadTodayActivity();
        this.fetchList(true);
      } else {
        wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[activity-log] onApprovePending 异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
  },

  onRejectPending(e: any) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;

    wx.showModal({
      title: '确认驳回这条投稿？',
      content: '驳回后该条护持动态将被删除，义工需要重新提交',
      confirmColor: '#D32F2F',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '处理中...', mask: true });
        try {
          const cbRes = await callFunctionWithTimeout({
            name: 'manageActivityLog',
            data: { action: 'rejectPending', id }
          });
          wx.hideLoading();
          const result = cbRes.result as any;
          if (result && result.success) {
            wx.showToast({ title: '已驳回', icon: 'success' });
            this.fetchPendingList();
          } else {
            wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[activity-log] onRejectPending 异常:', err);
          wx.showToast({ title: '网络异常，请重试', icon: 'none' });
        }
      }
    });
  },

  // 📌 查询今天最新一条大事记，用于顶部高亮区展示 + 编辑表单预填。
  // manageActivityLog 允许同一天存在多条记录（无 getByDate 动作），故用 list + 当天日期区间取最新一条。
  async loadTodayActivity() {
    if (!this.data.currentStoreId) {
      this.setData({ todayItem: null });
      return;
    }

    this.setData({ todayLoading: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageActivityLog',
        data: {
          action: 'list',
          storeId: this.data.currentStoreId,
          startDate: this.data.todayDateStr,
          endDate: this.data.todayDateStr,
          page: 1,
          pageSize: 1
        }
      });
      const result = res.result as any;
      const existing = (result && result.success && result.data && result.data.length > 0) ? result.data[0] : null;
      if (existing) {
        existing.publishTimeStr = formatHHmm(existing.updateTime);
        existing.categoryLabelText = categoryLabel(existing.category);
      }
      this.setData({ todayItem: existing });
      this.recomputeHistoryList();
    } catch (err) {
      console.error('[activity-log] loadTodayActivity 异常:', err);
      this.setData({ todayItem: null });
    } finally {
      this.setData({ todayLoading: false });
    }
  },

  // 「历史大事记」区域按 _id 排除顶部已展示的那一条，保留同一天的其余记录（活动大事记支持同日多条）
  // extra：额外要合并进同一次 setData 的字段（如 loading:false）——fetchList 成功回来后
  // 靠这个参数把"算好的新 historyList"和"loading 状态解除"合并成一次渲染，不拆两步
  recomputeHistoryList(extra: Record<string, any> = {}) {
    const todayId = this.data.todayItem ? this.data.todayItem._id : null;
    const historyList = todayId ? this.data.list.filter((item: any) => item._id !== todayId) : this.data.list;
    this.setData({ historyList, ...extra });
  },

  // 📅 历史动态支持按 historyFilterDate 精确筛选某一天：为空时是原有全量分页
  // 时光轴，有值时 startDate/endDate 都传这一天，服务端按 eventTime 区间过滤
  async fetchList(reset: boolean) {
    if (reset) {
      // 🐛 修复"切换日期/网络慢时，旧图片列表还留在视图上"：historyList 才是真正驱动
      // WXML wx:for 和空状态判断的字段，此前这里只清了 list（原始分页缓存），
      // historyList 要等云函数返回、recomputeHistoryList() 跑完才会跟着清空——
      // 这段等待期里用户仍看着上一个日期/上一轮的旧卡片。这里与 list 同步清空
      this.setData({ page: 1, list: [], historyList: [], hasMore: true, loading: true });
    } else {
      if (!this.data.hasMore || this.data.loadingMore) return;
      this.setData({ loadingMore: true });
    }

    const targetPage = reset ? 1 : this.data.page + 1;
    const filterDate = this.data.historyFilterDate;

    try {
      const res = await callFunctionWithTimeout({
        name: 'manageActivityLog',
        data: {
          action: 'list',
          storeId: this.data.currentStoreId,
          page: targetPage,
          pageSize: PAGE_SIZE,
          // 📌 置顶优先排序：仅历史时光轴需要，今日大事记查询（loadTodayActivity）
          // 不传这个参数，行为与改动前完全一致
          pinFirst: true,
          ...(filterDate ? { startDate: filterDate, endDate: filterDate } : {})
        }
      });
      const result = res.result as any;

      if (result && result.success) {
        // 🕐 与 loadTodayActivity 同一套处理：updateTime 是云端 db.serverDate() 读回的
        // 原生 Date，格式化成 HH:mm 供历史动态卡片展示"发布者 + 精确发布时间"；
        // categoryLabelText 供卡片展示分类 Tag，未分类的老记录展示"未分类"
        const pageItems = (result.data || []).map((item: any) => ({
          ...item,
          publishTimeStr: formatHHmm(item.updateTime),
          categoryLabelText: categoryLabel(item.category)
        }));
        const newList = reset ? pageItems : this.data.list.concat(pageItems);
        this.setData({
          list: newList,
          page: targetPage,
          total: result.total || 0,
          hasMore: !!result.hasMore
        });
        // 🐛 与上面的清空首尾呼应：新 historyList 算好后，和 loading:false 合并进
        // 同一次 setData 一起渲染，不再是"新列表已落地但 loading 还没解除"两步走
        this.recomputeHistoryList({ loading: false, loadingMore: false });
      } else {
        wx.showToast({ title: (result && result.error) || '加载失败', icon: 'none' });
        this.setData({ loading: false, loadingMore: false });
      }
    } catch (err) {
      console.error('[activity-log] fetchList 异常:', err);
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      this.setData({ loading: false, loadingMore: false });
    }
  },

  onReachBottom() {
    this.fetchList(false);
  },

  onPullDownRefresh() {
    this.fetchList(true).finally(() => wx.stopPullDownRefresh());
  },

  // 📅 历史动态日期筛选：日历 picker 直接选定某一天
  onHistoryDateChange(e: any) {
    this.setData({ historyFilterDate: e.detail.value });
    this.fetchList(true);
  },

  // ◀ 上一天 / 下一天 ▶：未设筛选时从"今天"起步，之后按天平移
  onHistoryPrevDay() {
    const base = this.data.historyFilterDate || this.data.todayDateStr;
    this.setData({ historyFilterDate: shiftDateStr(base, -1) });
    this.fetchList(true);
  },

  onHistoryNextDay() {
    const base = this.data.historyFilterDate || this.data.todayDateStr;
    this.setData({ historyFilterDate: shiftDateStr(base, 1) });
    this.fetchList(true);
  },

  onClearHistoryDateFilter() {
    if (!this.data.historyFilterDate) return;
    this.setData({ historyFilterDate: '' });
    this.fetchList(true);
  },

  onOpenDetail(e: any) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.list.find((r: any) => r._id === id);
    if (!item) return;
    this.setData({ showDetailModal: true, detailItem: item });
  },

  onCloseDetail() {
    this.setData({ showDetailModal: false, detailItem: null });
  },

  // 📌 顶部【编辑/追加今日大事记】按钮：今日已有记录则预填回显（更新模式），否则空白新建
  onOpenTodayEditForm() {
    // 🛡️ 与 WXML 按钮的 wx:if="{{!isFamily && (canManage || isVolunteer)}}"
    // 保持同一套判定（含显式 isFamily 硬性拦截，不完全依赖互斥前提），否则义工
    // 点得到按钮却被这里静默拦截、表单永远打不开
    if (this.data.isFamily || (!this.data.canManage && !this.data.isVolunteer)) return;
    // 🌟 义工提交的是"新的一条待确认动态"，服务端只放行 create（不放行 update），
    // 不能预填/接续今天已存在的正式记录——只有 canManage（店长/超管）才允许在
    // 今日已有记录的基础上继续编辑/追加
    const item = this.data.canManage ? this.data.todayItem : null;
    this.setData({
      showEditForm: true,
      editForm: {
        id: item ? item._id : '',
        title: item ? (item.title || '') : '',
        eventTime: this.data.todayDateStr,
        content: item ? (item.content || '') : '',
        category: item ? (item.category || '') : '',
        // 🛡️ editForm.images 现在是纯字符串数组（与 receiptImages 同构，供 WXML
        // 直接 {{item}} 绑定），但数据库里已发布记录的 images 字段仍是 {url,thumbUrl}
        // 对象，回显进编辑表单时要摘出 url
        images: item ? this.toImagePathList(item.images) : []
      }
    });
  },

  onOpenEditForm(e: any) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.list.find((r: any) => r._id === id);
    if (!item) return;
    // 🛡️ 与 WXML 按钮的 wx:if="{{canManage || item.createdBy === currentUserOpenid}}"
    // 保持同一套判定：店长/家长/超管可编辑任意本店记录，其余角色只能编辑自己
    // 发布的那一条（服务端 update 动作会再校验一次 isOwner，双重防线）
    const isOwner = !!item.createdBy && item.createdBy === this.data.currentUserOpenid;
    if (!this.data.canManage && !isOwner) return;
    this.setData({
      showEditForm: true,
      editForm: {
        id: item._id,
        title: item.title || '',
        eventTime: item.eventTime,
        content: item.content || '',
        category: item.category || '',
        images: this.toImagePathList(item.images)
      }
    });
  },

  // 🏷️ 分类 Tag Chips：单选，再次点击当前已选中的分类会清空（改回未分类）
  onSelectCategory(e: any) {
    const value = e.currentTarget.dataset.value;
    this.setData({ 'editForm.category': this.data.editForm.category === value ? '' : value });
  },

  // 数据库记录的 images 字段是 {url,thumbUrl}[]，editForm.images 页面内部状态是
  // 纯字符串数组，这里统一做一次转换；顺带兼容万一已经是字符串的数据
  toImagePathList(images: any): string[] {
    if (!Array.isArray(images)) return [];
    return images.map((img: any) => (img && img.url) || img).filter((u: any) => u && typeof u === 'string');
  },

  onCloseEditForm() {
    this.setData({ showEditForm: false });
  },

  onEditTitleInput(e: any) {
    this.setData({ 'editForm.title': e.detail.value });
  },

  onEditTimeChange(e: any) {
    this.setData({ 'editForm.eventTime': e.detail.value });
  },

  onEditContentInput(e: any) {
    this.setData({ 'editForm.content': e.detail.value });
  },

  onRemoveImage(e: any) {
    const index = e.currentTarget.dataset.index;
    const images = [...this.data.editForm.images];
    images.splice(index, 1);
    this.setData({ 'editForm.images': images });
  },

  // 🖼️ 微信标准双九宫格：门店日志最多 18 张配图，与今日记账表单的"门店今日日志/大事记"
  // 上传区（index.ts chooseActivityImages）保持同一上限，两处数据最终同步落在同一张
  // activity_logs 记录上，上限不一致会造成体验割裂。
  // 注：wx.chooseMedia 单次调用 count 参数硬性上限为 9（微信平台限制，非本项目自定），
  // 剩余额度超过 9 时仍按 9 请求，用户需多次点击"+ 添加"分批选够 18 张
  async onChooseImage() {
    const MAX_IMAGES = 18;
    const CHOOSE_MEDIA_MAX_COUNT = 9;
    const remaining = MAX_IMAGES - this.data.editForm.images.length;
    if (remaining <= 0) {
      wx.showToast({ title: `最多上传 ${MAX_IMAGES} 张配图`, icon: 'none' });
      return;
    }

    try {
      // 🛡️ 选图前先确保隐私授权已解决，避免遮罩挡住授权弹窗（见
      // utils/privacyAuthHub.ts ensurePrivacyAuthorized）
      await ensurePrivacyAuthorized();
      const chooseRes = await wx.chooseMedia({
        count: Math.min(remaining, CHOOSE_MEDIA_MAX_COUNT),
        mediaType: ['image'],
        sourceType: ['album', 'camera']
      });

      const paths = (chooseRes.tempFiles || []).map(f => f.tempFilePath);
      if (paths.length === 0) return;

      // 🌟 与支出凭证(receiptImages)100% 同构：纯字符串数组，选完图立刻把本地
      // tempFilePath 塞进数组先渲染出来，不等压缩上传跑完才显示
      const insertStart = this.data.editForm.images.length;
      this.setData({ 'editForm.images': [...this.data.editForm.images, ...paths], uploading: true });

      try {
        const uploaded = await compressAndUploadImages(CANVAS_ID, paths, `activity_logs/${this.data.currentStoreId}`);

        // 压缩上传跑完后，原地把本地路径字符串替换成云端 fileID 字符串
        const finalImages = [...this.data.editForm.images];
        uploaded.forEach((u, i) => {
          finalImages[insertStart + i] = u.url;
        });
        this.setData({ 'editForm.images': finalImages });
      } catch (uploadErr) {
        // 🛡️ 上传失败：撤回本轮插入的本地占位条目，不留下没有对应云端文件的死路径
        const rolledBack = this.data.editForm.images.filter((_, i) => i < insertStart || i >= insertStart + paths.length);
        this.setData({ 'editForm.images': rolledBack });
        throw uploadErr;
      }

      this.setData({ uploading: false });
    } catch (err) {
      this.setData({ uploading: false });
      console.error('[activity-log] onChooseImage 异常:', err);
      wx.showToast({ title: '图片处理失败，请重试', icon: 'none' });
    }
  },

  async onSubmitEdit() {
    const { id, title, eventTime, content, category, images } = this.data.editForm;

    if (!title.trim()) {
      wx.showToast({ title: '请填写标题', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '提交中...', mask: true });

    try {
      // 🛡️ images 在页面这一侧是纯字符串数组，但 manageActivityLog 云函数的
      // sanitizeImages 需要 {url,thumbUrl} 对象——直接传字符串进去，img.url 取不到
      // 值会被云端过滤器整批丢弃，导致"提交成功但图片全没了"。这里转换回数据库
      // 期待的对象形状，字符串数组只是页面内部状态，不是持久化 schema
      const imagesForSubmit = images.map((url: string) => ({ url, thumbUrl: url }));
      const res = await callFunctionWithTimeout({
        name: 'manageActivityLog',
        data: {
          action: id ? 'update' : 'create',
          id,
          storeId: this.data.currentStoreId,
          title: title.trim(),
          eventTime,
          content: content.trim(),
          category,
          images: imagesForSubmit
        }
      });
      const result = res.result as any;

      wx.hideLoading();

      if (result && result.success) {
        wx.showToast({ title: result.message || '提交成功', icon: 'success' });
        this.setData({ showEditForm: false });
        // 提交的记录可能是今天（顶部区）或历史某天（下方区），两处都刷新一次以保持同步
        this.loadTodayActivity();
        this.fetchList(true);
      } else {
        wx.showModal({ title: '提交失败', content: (result && result.error) || '未知错误', showCancel: false });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[activity-log] onSubmitEdit 异常:', err);
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
    }
  },

  onDeleteLog(e: any) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;

    wx.showModal({
      title: '确认删除该记录？',
      content: '删除后不可恢复',
      confirmColor: '#D32F2F',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '删除中...', mask: true });
        try {
          const cbRes = await callFunctionWithTimeout({
            name: 'manageActivityLog',
            data: { action: 'delete', id }
          });
          wx.hideLoading();
          const result = cbRes.result as any;
          if (result && result.success) {
            wx.showToast({ title: '已删除', icon: 'success' });
            this.setData({ showDetailModal: false });
            this.loadTodayActivity();
            this.fetchList(true);
          } else {
            wx.showToast({ title: (result && result.error) || '删除失败', icon: 'none' });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[activity-log] onDeleteLog 异常:', err);
          wx.showToast({ title: '删除失败，请重试', icon: 'none' });
        }
      }
    });
  },

  // 📌 置顶/取消置顶：店长/超管权限强化能力，与卡片右上角图标一一对应。
  // 服务端 togglePin 不放行 volunteer（哪怕是自己发布的动态），前端 WXML 也
  // 只在 canManage 时渲染这个入口，双重防线
  onTogglePin(e: any) {
    if (!this.data.canManage) return;
    const id = e.currentTarget.dataset.id;
    const pinned = !e.currentTarget.dataset.pinned;
    if (!id) return;

    wx.showLoading({ title: pinned ? '置顶中...' : '取消置顶中...', mask: true });
    callFunctionWithTimeout({
      name: 'manageActivityLog',
      data: { action: 'togglePin', id, pinned }
    }).then((res: any) => {
      wx.hideLoading();
      const result = res.result;
      if (result && result.success) {
        wx.showToast({ title: result.message || (pinned ? '已置顶' : '已取消置顶'), icon: 'success' });
        this.loadTodayActivity();
        this.fetchList(true);
      } else {
        wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
      }
    }).catch((err: any) => {
      wx.hideLoading();
      console.error('[activity-log] onTogglePin 异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    });
  },

  // 📤 导出活动海报：取该条大事记的标题/日期/首图/内容摘要绘制成可保存分享的海报图
  async onExportPoster(e: any) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.list.find((r: any) => r._id === id) || this.data.historyList.find((r: any) => r._id === id);
    if (!item) return;

    this.setData({ showPosterModal: true, posterTargetItem: item, posterReady: false });
    wx.showLoading({ title: '正在生成海报...', mask: true });

    let photoTempPath = '';
    // 配图落库存的是云存储 fileID（cloud://...），需用 wx.cloud.downloadFile 而非 wx.downloadFile 下载
    if (item.images && item.images.length > 0) {
      try {
        const cloudRes = await wx.cloud.downloadFile({ fileID: item.images[0].url });
        photoTempPath = cloudRes.tempFilePath;
      } catch (cloudErr) {
        console.warn('[activity-log] 海报配图下载失败，使用占位:', cloudErr);
      }
    }

    setTimeout(() => {
      const query = wx.createSelectorQuery();
      query.select('#activityPosterCanvas')
        .fields({ node: true, size: true })
        .exec(async (res) => {
          if (!res[0] || !res[0].node) {
            wx.hideLoading();
            wx.showToast({ title: 'Canvas 初始化失败', icon: 'none' });
            return;
          }
          const canvas = res[0].node;
          try {
            await drawActivityPoster({
              canvas,
              storeName: this.data.currentStoreName,
              title: item.title || '',
              eventTime: item.eventTime || '',
              content: item.content || '',
              photoTempPath,
              width: 320,
              height: 560
            });
            wx.hideLoading();
            this.setData({ posterReady: true });
          } catch (drawErr) {
            wx.hideLoading();
            console.error('[activity-log] 海报绘制失败:', drawErr);
            wx.showToast({ title: '海报绘制失败', icon: 'none' });
          }
        });
    }, 100);
  },

  onClosePosterModal() {
    this.setData({ showPosterModal: false, posterTargetItem: null, posterReady: false });
  },

  onSavePosterToAlbum() {
    if (!this.data.posterReady) {
      wx.showToast({ title: '海报尚未绘制完成', icon: 'none' });
      return;
    }
    const query = wx.createSelectorQuery();
    query.select('#activityPosterCanvas')
      .fields({ node: true })
      .exec((res) => {
        if (!res[0] || !res[0].node) return;
        wx.canvasToTempFilePath({
          canvas: res[0].node,
          success: (tempRes) => {
            wx.saveImageToPhotosAlbum({
              filePath: tempRes.tempFilePath,
              success: () => {
                wx.showToast({ title: '海报已保存至相册', icon: 'success' });
                this.onClosePosterModal();
              },
              fail: (err) => {
                if (err.errMsg && err.errMsg.indexOf('auth deny') >= 0) {
                  wx.showModal({
                    title: '需要相册权限',
                    content: '请在设置中允许小程序保存图片到您的相册',
                    success: (r) => {
                      if (r.confirm) wx.openSetting();
                    }
                  });
                } else {
                  wx.showToast({ title: '保存失败', icon: 'none' });
                }
              }
            });
          },
          fail: () => {
            wx.showToast({ title: '海报生成失败', icon: 'none' });
          }
        });
      });
  },

  onPreviewImage(e: any) {
    const url = e.currentTarget.dataset.url;
    const rawUrls = e.currentTarget.dataset.urls || [];
    if (!url) return;
    const mapped = rawUrls.length > 0 && typeof rawUrls[0] === 'object'
      ? rawUrls.map((img: any) => img && img.url)
      : (rawUrls.length > 0 ? rawUrls : [url]);
    // 🛡️ 防御性过滤：避免个别异常/空值数据卡住整个预览
    const urls = mapped.filter((u: any) => u && typeof u === 'string');
    wx.previewImage({ current: url, urls: urls.length > 0 ? urls : [url] });
  },

  stopPropagation() {
    // 阻止详情/编辑弹窗内部点击冒泡触发遮罩层关闭
  },

  // 🛡️ 门店日志缩略图加载失败：上报诊断日志（用于确认真机"图片空白"是云存储读权限
  // 问题——常见报错含 403/-1——还是别的原因，而不是盲猜），并把这张图记进
  // thumbFailedMap，驱动 WXML 切换成可点击重试的占位块，而不是放任裂图晾在那里
  onImageLoadError(e: any) {
    const url = e.currentTarget.dataset.thumbUrl;
    console.warn('[activity-log] 缩略图加载失败:', url, e.detail);
    if (!url) return;
    this.setData({ thumbFailedMap: { ...this.data.thumbFailedMap, [url]: true } });
  },

  // 点击"加载失败"占位块重试：从 map 里摘掉这张图的失败标记，wx:if/wx:else 会把
  // <image> 节点整个卸载重挂，强制小程序重新发起一次网络请求
  onRetryImage(e: any) {
    const url = e.currentTarget.dataset.thumbUrl;
    if (!url) return;
    const next = { ...this.data.thumbFailedMap };
    delete next[url];
    this.setData({ thumbFailedMap: next });
  },

  onShareAppMessage() {
    const item = this.data.posterTargetItem;
    const store = this.data.currentStoreName || '雨花斋';

    if (item) {
      const cover = (item.images && item.images[0]) ? item.images[0].url : '';
      return {
        title: `📌【${store}】${item.title || '今日动态'}`,
        path: '/pages/index/index',
        imageUrl: cover
      };
    }

    return {
      title: `📌【${store}】义工工作与门店日志`,
      path: '/pages/index/index'
    };
  }
});
