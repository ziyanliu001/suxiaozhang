import { AuthService } from '../../../../utils/authService';
import { getSelectedStore } from '../../../../utils/storeManager';
import { compressAndUploadImages } from '../../../../utils/imageCompress';
import { createNavGuard, NavGuardInstance } from '../../../../utils/navGuard';
import { recordRecentVisit } from '../../utils/recentPages';
import { drawDailyMenuPoster, calcDailyMenuPosterHeight } from '../../utils/drawDailyMenuPoster';
import { GRATITUDE_TEXT } from '../../../../utils/cultureData';
import { isVirtualStoreName } from '../../../../utils/storeIdentity';
import { callFunctionWithTimeout } from '../../../../utils/withTimeout';
import { getStorageAsync, getSafeSystemInfo } from '../../../../utils/util';
import { ensurePrivacyAuthorized } from '../../../../utils/privacyAuthHub';
import {
  buildPurchasePlan,
  togglePurchaseTaskStatus,
  updatePurchaseTaskWeight,
  formatPurchasePlanText
} from './lib/buildPurchasePlan';

const CANVAS_ID = 'imgCompressCanvas';
const POSTER_CANVAS_ID = 'dailyMenuPosterCanvas';
const POSTER_WIDTH = 320;
const PAGE_SIZE = 10;

// 🆕 历史备注记忆：本地设备维度缓存，不区分门店/账号——同一台设备上管理员
// 常用的备注措辞（"食材紧张""正常供应"之类）跨门店/跨账号复用的价值大于
// 隔离的必要性，且这只是一份"快速填入"的辅助建议，不是业务数据，不需要
// 云端同步
const CACHE_KEY_DAILY_MENU_REMARKS = 'daily_menu_recent_remarks';
const MAX_RECENT_REMARKS = 8;

// 🍱 早/午/晚餐可独立发布食谱，云函数 manageDailyMenu 按 {storeId, dateString,
// mealType} 三元组区分记录（存量记录没有 mealType 字段，云函数兼容按 lunch 处理）
type MealType = 'breakfast' | 'lunch' | 'dinner';
const DEFAULT_MEAL_TYPE: MealType = 'lunch';
const MEAL_TYPE_OPTIONS: Array<{ value: MealType; label: string }> = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' }
];
const MEAL_LABEL_MAP: Record<string, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐'
};
function mealTypeLabel(mealType: string): string {
  return MEAL_LABEL_MAP[mealType] || MEAL_LABEL_MAP[DEFAULT_MEAL_TYPE];
}

// 🛡️ "全国总览"/"全部门店" 的 storeId 哨兵值，与 statistics.ts 同一份定义
// （见该文件 NATIONAL_STORE_ID_SENTINELS 头部注释），本地缓存兜底时同样要过滤
const NATIONAL_STORE_ID_SENTINELS = ['national_overview', 'ALL_STORES', 'all', 'ALL'];

// 🤖（2026-09-10 智能备餐与食材用量预测·一期原型）AI 备餐助手：天气取值
// 必须与云函数 manageDailyMenu/lib/predictMealDemand.js 的 WEATHER_MULTIPLIER
// 枚举 key 完全一致（rain/storm），"晴"不在枚举里、传什么都按 1 不折减，
// 这里仍然单独给一个 value 只是为了在 UI 上有一个"未选雨天/暴雨"的默认态
const MEAL_PREDICTION_WEATHER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'sunny', label: '☀️ 晴' },
  { value: 'rain', label: '🌧️ 雨' },
  { value: 'storm', label: '⛈️ 暴雨' }
];

// 🍚 食材换算展示单位，与 predictMealDemand.js 的 INGREDIENT_RATIO_PER_PERSON
// 字段一一对应，纯前端展示映射，不参与计算（换算比例的计算完全在服务端）
const INGREDIENT_DISPLAY_ROWS: Array<{ key: string; label: string; unit: string }> = [
  { key: 'riceJin', label: '🍚 大米', unit: '斤' },
  { key: 'oilLiter', label: '🛢️ 食用油', unit: '升' },
  { key: 'vegetableJin', label: '🥬 蔬菜', unit: '斤' },
  { key: 'seasoningJin', label: '🧂 调味品', unit: '斤' }
];

function buildIngredientRows(ingredients: any): Array<{ label: string; unit: string; value: number }> {
  if (!ingredients) return [];
  return INGREDIENT_DISPLAY_ROWS.map((row) => ({
    label: row.label,
    unit: row.unit,
    value: typeof ingredients[row.key] === 'number' ? ingredients[row.key] : 0
  }));
}

function getTodayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// "YYYY-MM-DD" -> "YYYY年M月D日"，用于食谱卡片顶部日期展示
function formatDisplayDate(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return dateStr || '';
  return `${m[1]}年${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`;
}

// 日期导航 ◀ 上一天/下一天 ▶：按天平移，跨月/跨年由 Date 对象自动处理
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

// 数据库 images 字段 {url, thumbUrl, name}[] -> 九宫格菜品卡片渲染用的 dishes 数组，
// 过滤掉没有 url 的脏数据（理论上 sanitizeImages 早已保证不会落库，这里仅作展示层兜底）
function buildDishList(images: any): Array<{ url: string; thumbUrl: string; name: string }> {
  if (!Array.isArray(images)) return [];
  return images
    .map((img: any) => ({
      url: (img && img.url) || '',
      thumbUrl: (img && (img.thumbUrl || img.url)) || '',
      name: (img && img.name) || ''
    }))
    .filter((d) => d.url);
}

Page({
  _navGuard: null as NavGuardInstance | null,
  // 🛒 采购清单重量微调的防抖定时器，按 itemKey 独立——不进 data，遵循
  // CLAUDE.md「临时变量（防抖定时器/锁）必须挂在页面实例上，不占用
  // setData 通讯通道」的既定规范
  _purchaseWeightSyncTimers: {} as Record<string, ReturnType<typeof setTimeout>>,

  data: {
    // 🐛 根因修复（2026-09-10 导航栏彻底重构）：与 platform-admin 同一处
    // 问题、同一套修复——放弃共享 <navigation-bar> 组件，改成页面自己维护
    // 标准的"fixed 顶栏 + 等高占位 view"结构（custom-nav-bar/nav-placeholder，
    // 见 wxml），statusBarHeight/navBarHeight 由 computeCustomNavLayout()
    // 在 onLoad 里直接同步算好。navRightGap 保留（原来由组件 bind:layout
    // 上报，现在由 computeCustomNavLayout() 自己测量），供右上角"编辑"按钮
    // 避让胶囊定位；navContentTop/navContentHeight 不再需要——新结构里
    // "编辑"按钮直接用 top:0;height:100% 撑满 .nav-content，不需要额外的
    // 像素级绝对定位
    contentTop: 0,
    statusBarHeight: 0,
    navBarHeight: 0,
    navRightGap: 0,

    currentStoreId: '',
    currentStoreName: '',
    canManage: false,
    isSuperAdmin: false,
    // 🛡️ 门店身份异步解析完成前的骨架占位标记，见 applyRolePermissions()——
    // 避免 currentStoreName 到达前的那一帧默认回退显示任何门店名/全国总览
    roleReady: false,

    // 🍱 当前查看/管理的日期+餐别（默认今天+午餐），顶部高亮区随之联动
    selectedDateStr: getTodayStr(),
    selectedDateDisplay: formatDisplayDate(getTodayStr()),
    isSelectedToday: true,
    selectedMealType: DEFAULT_MEAL_TYPE as MealType,
    mealLabel: mealTypeLabel(DEFAULT_MEAL_TYPE),
    mealTypeOptions: MEAL_TYPE_OPTIONS,
    todayItem: null as any,
    todayDishes: [] as any[],
    todayLoading: false,

    // 📚 历史食谱（下方时间轴，不含当前选中日期，避免与顶部重复展示；按
    // selectedMealType 服务端过滤，见 fetchList）
    list: [] as any[],
    historyList: [] as any[],
    page: 1,
    total: 0,
    hasMore: true,
    loading: false,
    loadingMore: false,

    showDetailModal: false,
    detailItem: null as any,

    showEditForm: false,
    // 🆕 历史备注记忆：最近提交成功过的文字备注，去重、最近使用排最前，
    // 见 loadRecentRemarks/rememberRecentRemark
    recentRemarks: [] as string[],
    editForm: {
      id: '',
      dateString: getTodayStr(),
      mealType: DEFAULT_MEAL_TYPE as MealType,
      menuText: '',
      // 🍱 每个元素对应一道菜：{url: 本地临时路径/云端 fileID, name: 菜品名称}
      images: [] as Array<{ url: string; name: string }>
    },
    uploading: false,

    // ✨ 引用历史食谱：从 historyList 里挑一条带入编辑表单，见 onOpenReuseTemplatePicker
    showReuseTemplateModal: false,

    // 📤 生成食谱宣传海报
    showPosterModal: false,
    posterReady: false,
    posterGenerating: false,
    posterCanvasWidth: POSTER_WIDTH,
    posterCanvasHeight: 400,
    // 海报画完后 canvasToTempFilePath 的结果，保存到相册/分享海报共用，避免重复生成
    posterTempFilePath: '',

    // 🛡️ 缩略图加载失败兜底：key 是图片路径本身。今日食谱/历史食谱/编辑表单三处
    // 图片网格结构各不相同（单条记录 / 列表套子数组 / 编辑中的数组），共用一张按
    // 路径查表的 map 比分别给每个嵌套结构维护 loadFailed 字段简单得多——反正每个
    // <image> 上早就都带着 data-url，直接拿来当 key 用
    thumbFailedMap: {} as Record<string, boolean>,

    // 🙏 餐前感恩词：默认折叠，不占今日食谱卡片的视觉重量
    gratitudeLines: GRATITUDE_TEXT,
    gratitudeExpanded: false,

    // 🐛 根因修复（2026-09-10 卡片全隐形）：这里最初按 canManage 门控整张
    // 卡片可见性，但云函数 manageDailyMenu 的 getMealPrediction action
    // 从一开始就没有按 canManage 收窄——只要求 caller.storeId 存在即可
    // 查看（预测是纯只读信息，不修改任何数据，不需要"能编辑菜单"这个更高
    // 权限），前端按 canManage 隐藏整张卡片是比后端更严格的、多余的限制，
    // 导致义工/财务等已绑定门店但不能编辑菜单的角色完全看不到这个功能。
    // 现在改为按 currentStoreId 是否已绑定门店门控（与后端真实权限边界
    // 对齐），canManage 不再影响这张卡片的可见性
    mealPredictionExpanded: false,
    mealPredictionForm: {
      targetDate: getTodayStr(),
      targetDateDisplay: formatDisplayDate(getTodayStr()),
      weather: 'sunny',
      isHoliday: false
    },
    mealPredictionWeatherOptions: MEAL_PREDICTION_WEATHER_OPTIONS,
    mealPredictionLoading: false,
    mealPredictionError: '',
    // 🐛 结果与展示行分开存：mealPredictionResult 是云函数原样返回的结构
    // （给"生效依据"标签行读 basis 字段），mealPredictionIngredientRows 是
    // 专门为 wx:for 准备好的 {label,unit,value} 数组，WXML 不用为了遍历一个
    // 固定 4 个 key 的对象再额外写一层转换逻辑
    mealPredictionResult: null as any,
    mealPredictionIngredientRows: [] as Array<{ label: string; unit: string; value: number }>,
    mealPredictionApplied: false,

    // 🛒（2026-09-11 AI 备餐预测一键流转后厨采买任务·方向2）与上面
    // mealPrediction* 系列是同一张卡片的下一步动作——生成结构化、可勾选/
    // 可微调的采买待办清单，落地到本机 storage（见 onGeneratePurchasePlan
    // 头部注释的诚实能力边界说明），不是重新拉一次云函数
    showPurchasePlanModal: false,
    purchasePlanTasks: [] as Array<{
      itemKey: string; itemName: string; estimatedWeight: number; unit: string;
      status: 'pending' | 'completed'; remark: string;
    }>
  },

  async onLoad() {
    recordRecentVisit('/subpackages/admin/pages/daily-menu/daily-menu', '食谱管理中心');
    this.computeCustomNavLayout();
    this.loadRecentRemarks();
    // 🔑 需先拿到 currentStoreId 再查今日食谱（getByDate 要求 storeId 必填），故此处 await 顺序执行
    await this.applyRolePermissions();
    this.loadSelectedMenu();
    this.fetchList(true);

    this._navGuard = createNavGuard({
      homePath: '/pages/index/index',
      alertMessage: '即将退出雨花爱心餐报助手，是否返回首页继续使用？'
    });
    this._navGuard.setupOnLoad();
  },

  onUnload() {
    if (this._navGuard) {
      this._navGuard.teardown();
      this._navGuard = null;
    }
    // 🛒 页面卸载前把所有还在防抖等待中的重量修改立即补发一次，避免用户
    // 打完最后几个数字就退出页面，那次输入永远没同步到云端
    this._flushPendingPurchaseWeightSync();
  },

  // 🐛 根因修复（2026-09-10 导航栏彻底重构）：与 platform-admin 同一处问题
  // 同一套修复方案——不再依赖共享 <navigation-bar> 组件的 attached()/
  // _layout() + bind:layout 事件上报，页面自己在 onLoad 里同步测量。公式
  // 与 navigation-bar.ts 的 _layout() 完全一致（胶囊 top/height 反推 gap，
  // gap*2+胶囊高度），保证不用共享组件也能算出与其余用该组件的页面视觉对齐
  // 的顶栏高度；rightGap 供右上角"编辑"按钮避让胶囊定位
  computeCustomNavLayout() {
    const sysInfo = getSafeSystemInfo();
    const statusBarHeight = sysInfo.statusBarHeight || 20;
    const isAndroid = sysInfo.platform === 'android';
    let navBarHeight: number;
    let rightGap: number;
    try {
      const menuButtonInfo = wx.getMenuButtonBoundingClientRect();
      if (!menuButtonInfo || !menuButtonInfo.height) throw new Error('胶囊测量值为空');
      const gap = menuButtonInfo.top - statusBarHeight;
      navBarHeight = gap * 2 + menuButtonInfo.height;
      rightGap = sysInfo.windowWidth - menuButtonInfo.left;
    } catch (err) {
      console.warn('[daily-menu] 胶囊测量异常，使用兜底导航栏高度:', err);
      const fallbackContentHeight = isAndroid ? 48 : 44;
      const fallbackGap = isAndroid ? 4 : 6;
      navBarHeight = fallbackGap * 2 + fallbackContentHeight;
      rightGap = 90;
    }
    this.setData({
      statusBarHeight,
      navBarHeight,
      contentTop: statusBarHeight + navBarHeight,
      navRightGap: rightGap
    });
  },

  // 🆕（2026-09-10 导航栏彻底重构）自定义顶栏"‹"返回按钮——与 navGuard 处理
  // 物理返回键是两条独立路径，这里是点击 UI 上的返回箭头：有上一页就
  // navigateBack，没有就退回首页 Tab，与 platform-admin 的 onNavigateBack
  // 同一套策略
  onNavigateBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
  },

  // 🐛 去重合并：本地曾维护过一份手写的 resolveEffectiveRole（cachedRole/服务端
  // 下发的角色只是"最近一次校验/查询到的角色"，手动切换身份时写入的
  // current_user_role 才是真正的生效角色），与 AuthService.resolveEffectiveRole
  // 几乎一样，只是多做了一步"store_family 归一化成 volunteer"——但本页唯一的
  // 用法只判断 effectiveRole === 'super_admin'/'store_manager'/'store_patriarch'，
  // 从不关心 volunteer 和 store_family 的区别，归一化与否结果一致，可以安全收敛成
  // 共享实现。改用 AuthService.resolveEffectiveRole 还多了一个好处：命中手动切换
  // 时会顺带把持久化缓存同步更新，其余直接读缓存的调用点不会再撞见残留旧角色

  // 🐛 核心权限 Bug 修复：此前直接拿 roleInfo.storeName 当门店名用，完全没有过滤
  // "全国总览/全部门店"这类仅超管可用的虚拟聚合名——user_roles 文档一旦曾经是
  // super_admin（storeId:'' storeName:'全国总览'），账号降级后这个脏值会一直残留，
  // 非超管账号打开本页就会在顶部误显示"全国总览"。解析口径与 statistics.ts
  // resolveEffectiveStoreIdentity 完全一致：
  // 1. 非超管：storeName 命中虚拟聚合名一律当作"没有真实门店"，退回本地已选中门店；
  // 2. 真超管：允许 storeId 为空（此时顶部展示"全国总览"，但必须先在全局
  //    store-picker 选定具体门店才允许发布/编辑，否则 getByDate/create 都会因
  //    storeId 缺失被云函数拒绝）。
  async applyRolePermissions() {
    let roleInfo = AuthService.getCachedRoleInfo();
    if (!roleInfo) {
      const result = await AuthService.fetchUserRole();
      roleInfo = result.roleInfo || null;
    }

    const effectiveRole = AuthService.resolveEffectiveRole(roleInfo ? roleInfo.role : 'volunteer');
    const isSuperAdmin = effectiveRole === 'super_admin';

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
    // 同类修复记录，onLoad 里能异步化的同步 storage 读取都异步化，缩短跳转到
    // 本页后骨架屏可交互前的同步执行栈
    if (!storeId) {
      const storedId = await getStorageAsync('current_store_id');
      storeId = NATIONAL_STORE_ID_SENTINELS.includes(storedId) ? '' : storedId;
    }
    if (!storeName) {
      const storedName = await getStorageAsync('current_store_name');
      storeName = (!isSuperAdmin && isVirtualStoreName(storedName)) ? '' : storedName;
    }

    // 🛡️ 展示口径：超管在没有选定具体门店时才允许显示"全国总览"（这是其真实身份
    // 状态）；除此之外的所有情况（非超管，或超管已选定门店）一律显示真实门店名，
    // 严禁出现虚拟聚合名
    const displayStoreName = (isSuperAdmin && !storeId) ? '全国总览' : storeName;

    // 🛡️ canManage：与云函数 manageDailyMenu.resolveWriteTarget 的权限模型对齐——
    // store_manager/store_patriarch（大家长天然继承店长的日常管理权限）可管理本店，
    // 超管仅在已选定具体门店时才允许管理（全国总览态下没有 storeId，发布/编辑一定会
    // 被云函数拒绝，前端索性不放行，避免用户点了却报错）
    const canManage = effectiveRole === 'store_manager'
      || effectiveRole === 'store_patriarch'
      || (isSuperAdmin && !!storeId);

    this.setData({
      currentStoreId: storeId,
      currentStoreName: displayStoreName,
      canManage,
      isSuperAdmin,
      roleReady: true
    });
  },

  // 🍱 查询当前选中日期+餐别是否已发布食谱，用于顶部高亮区展示 + 编辑表单预填
  async loadSelectedMenu() {
    if (!this.data.currentStoreId) {
      this.setData({ todayItem: null, todayDishes: [] });
      return;
    }

    this.setData({ todayLoading: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageDailyMenu',
        data: {
          action: 'getByDate',
          storeId: this.data.currentStoreId,
          dateString: this.data.selectedDateStr,
          mealType: this.data.selectedMealType
        }
      });
      const result = res.result as any;
      const item = (result && result.success) ? result.data : null;
      if (item) {
        item.publishTimeStr = formatHHmm(item.updateTime);
      }
      this.setData({ todayItem: item, todayDishes: buildDishList(item && item.images) });
    } catch (err) {
      console.error('[daily-menu] loadSelectedMenu 异常:', err);
      this.setData({ todayItem: null, todayDishes: [] });
    } finally {
      this.setData({ todayLoading: false });
    }
  },

  // 📚 历史食谱按 selectedMealType 服务端过滤；historyList 只需按日期排重
  // （list 结果里的每一条都已经是当前选中餐别，见下方 recomputeHistoryList）
  recomputeHistoryList() {
    const historyList = this.data.list.filter((item: any) => item.dateString !== this.data.selectedDateStr);
    this.setData({ historyList });
  },

  async fetchList(reset: boolean) {
    if (reset) {
      this.setData({ page: 1, list: [], hasMore: true, loading: true });
    } else {
      if (!this.data.hasMore || this.data.loadingMore) return;
      this.setData({ loadingMore: true });
    }

    const targetPage = reset ? 1 : this.data.page + 1;

    try {
      const res = await callFunctionWithTimeout({
        name: 'manageDailyMenu',
        data: {
          action: 'list',
          storeId: this.data.currentStoreId,
          mealType: this.data.selectedMealType,
          page: targetPage,
          pageSize: PAGE_SIZE
        }
      });
      const result = res.result as any;

      if (result && result.success) {
        const rawList = result.data || [];
        // 附加展示层派生字段：格式化日期、九宫格菜品卡片数组
        rawList.forEach((item: any) => {
          item.dateDisplay = formatDisplayDate(item.dateString);
          item.dishes = buildDishList(item.images);
        });
        const newList = reset ? rawList : this.data.list.concat(rawList);
        this.setData({
          list: newList,
          page: targetPage,
          total: result.total || 0,
          hasMore: !!result.hasMore
        });
        this.recomputeHistoryList();
      } else {
        wx.showToast({ title: (result && result.error) || '加载失败', icon: 'none' });
      }
    } catch (err) {
      console.error('[daily-menu] fetchList 异常:', err);
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      this.setData({ loading: false, loadingMore: false });
    }
  },

  // ◀ 上一天 / 下一天 ▶：只影响顶部高亮区 + historyList 的排重日期，list 本身
  // 已按 selectedMealType 拉取完毕，不需要重新分页请求
  onPrevDay() {
    this.changeSelectedDate(shiftDateStr(this.data.selectedDateStr, -1));
  },

  onNextDay() {
    this.changeSelectedDate(shiftDateStr(this.data.selectedDateStr, 1));
  },

  onSelectedDateChange(e: any) {
    this.changeSelectedDate(e.detail.value);
  },

  changeSelectedDate(dateStr: string) {
    if (!dateStr || dateStr === this.data.selectedDateStr) return;
    this.setData({
      selectedDateStr: dateStr,
      selectedDateDisplay: formatDisplayDate(dateStr),
      isSelectedToday: dateStr === getTodayStr()
    });
    this.loadSelectedMenu();
    this.recomputeHistoryList();
  },

  // [早餐][午餐][晚餐] 分段控件：切换餐别后服务端过滤条件变了，list 必须重新分页拉取
  onSelectMealType(e: any) {
    const mealType = e.currentTarget.dataset.meal as MealType;
    if (!mealType || mealType === this.data.selectedMealType) return;
    this.setData({ selectedMealType: mealType, mealLabel: mealTypeLabel(mealType) });
    this.loadSelectedMenu();
    this.fetchList(true);
  },

  onReachBottom() {
    this.fetchList(false);
  },

  onPullDownRefresh() {
    this.fetchList(true).finally(() => wx.stopPullDownRefresh());
  },

  // 详情懒加载：仅在点击时才展示原图（此前列表只渲染压缩缩略图）
  onOpenDetail(e: any) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.list.find((r: any) => r._id === id);
    if (!item) return;
    this.setData({ showDetailModal: true, detailItem: item });
  },

  onCloseDetail() {
    this.setData({ showDetailModal: false, detailItem: null });
  },

  // 🍱 顶部【编辑/发布该日食谱】按钮：当前选中日期+餐别已发布则预填回显（更新模式），
  // 否则空白新建
  onOpenTodayEditForm() {
    if (!this.data.canManage) return;
    const item = this.data.todayItem;
    this.setData({
      showEditForm: true,
      editForm: {
        id: item ? item._id : '',
        dateString: this.data.selectedDateStr,
        mealType: this.data.selectedMealType,
        menuText: item ? (item.menuText || '') : '',
        images: item ? this.toEditableDishList(item.images) : []
      }
    });
  },

  onOpenEditForm(e: any) {
    if (!this.data.canManage) return;
    const id = e.currentTarget.dataset.id;
    const item = this.data.list.find((r: any) => r._id === id);
    if (!item) return;
    this.setData({
      showEditForm: true,
      editForm: {
        id: item._id,
        dateString: item.dateString,
        mealType: item.mealType || DEFAULT_MEAL_TYPE,
        menuText: item.menuText || '',
        images: this.toEditableDishList(item.images)
      }
    });
  },

  // 数据库记录的 images 字段是 {url,thumbUrl,name}[]，editForm.images 页面内部状态是
  // {url,name}[]（url 先是本地临时路径，压缩上传完成后原地替换成云端 fileID），这里
  // 统一做一次转换，供发布/编辑/一键复用三处入口共用
  toEditableDishList(images: any): Array<{ url: string; name: string }> {
    if (!Array.isArray(images)) return [];
    return images
      .map((img: any) => ({ url: (img && img.url) || '', name: (img && img.name) || '' }))
      .filter((d) => d.url);
  },

  onCloseEditForm() {
    this.setData({ showEditForm: false });
  },

  onEditDateChange(e: any) {
    this.setData({ 'editForm.dateString': e.detail.value });
  },

  onEditTextInput(e: any) {
    this.setData({ 'editForm.menuText': e.detail.value });
  },

  // 🆕 历史备注记忆：从本地缓存读取最近提交成功过的备注列表，onLoad 时读一次；
  // 不在每次打开编辑弹窗时重新读——本页存活期间列表只会通过 rememberRecentRemark/
  // onClearRecentRemarks 变化，没有其它写入方，读一次内存态足够
  loadRecentRemarks() {
    try {
      const cached = wx.getStorageSync(CACHE_KEY_DAILY_MENU_REMARKS);
      this.setData({ recentRemarks: Array.isArray(cached) ? cached : [] });
    } catch (err) {
      console.warn('[daily-menu] 读取历史备注缓存失败:', err);
    }
  },

  // 提交成功后调用：去空白/过滤空文本，已存在则移到最前（LRU），截断到
  // MAX_RECENT_REMARKS 条再持久化
  rememberRecentRemark(text: string) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    try {
      const existing: string[] = Array.isArray(this.data.recentRemarks) ? this.data.recentRemarks : [];
      const next = [trimmed, ...existing.filter((t) => t !== trimmed)].slice(0, MAX_RECENT_REMARKS);
      wx.setStorageSync(CACHE_KEY_DAILY_MENU_REMARKS, next);
      this.setData({ recentRemarks: next });
    } catch (err) {
      console.warn('[daily-menu] 保存历史备注缓存失败:', err);
    }
  },

  // 🆕 点击快捷标签填入：输入框为空直接设为该文本；已有内容则用中文逗号追加
  // 在末尾（两条备注拼读起来更自然），不做整段替换——误触一下不会丢掉刚打的字
  onSelectQuickRemark(e: any) {
    const text = e.currentTarget.dataset.text;
    if (!text) return;
    const current = (this.data.editForm.menuText || '').trim();
    const merged = current ? `${current}，${text}` : text;
    this.setData({ 'editForm.menuText': merged });
    wx.showToast({ title: '已填入', icon: 'none', duration: 800 });
  },

  onClearRecentRemarks() {
    try {
      wx.removeStorageSync(CACHE_KEY_DAILY_MENU_REMARKS);
    } catch (err) {
      console.warn('[daily-menu] 清空历史备注缓存失败:', err);
    }
    this.setData({ recentRemarks: [] });
    wx.showToast({ title: '已清空', icon: 'none' });
  },

  onRemoveImage(e: any) {
    const index = e.currentTarget.dataset.index;
    const images = [...this.data.editForm.images];
    images.splice(index, 1);
    this.setData({ 'editForm.images': images });
  },

  // 🍱 每道菜的名称输入框：与其配图同一个 editForm.images[index] 对象，只改 name 字段
  onDishNameInput(e: any) {
    const index = e.currentTarget.dataset.index;
    this.setData({ [`editForm.images[${index}].name`]: e.detail.value });
  },

  // 🖼️ 微信标准九宫格：今日食谱最多 9 道菜（每道菜一张实拍图）
  async onChooseImage() {
    const MAX_IMAGES = 9;
    const remaining = MAX_IMAGES - this.data.editForm.images.length;
    if (remaining <= 0) {
      wx.showToast({ title: `食谱最多上传 ${MAX_IMAGES} 张配图`, icon: 'none' });
      return;
    }

    try {
      // 🛡️ 选图前先确保隐私授权已解决，避免遮罩挡住授权弹窗（见
      // utils/privacyAuthHub.ts ensurePrivacyAuthorized）
      await ensurePrivacyAuthorized();
      const chooseRes = await wx.chooseMedia({
        count: remaining,
        mediaType: ['image'],
        sourceType: ['album', 'camera']
      });

      const paths = (chooseRes.tempFiles || []).map(f => f.tempFilePath);
      if (paths.length === 0) return;

      // 选完图立刻把本地 tempFilePath 塞进数组先渲染出来（name 先留空待管理员填写），
      // 不等压缩上传跑完才显示——本地文件选完那一刻就是有效路径
      const insertStart = this.data.editForm.images.length;
      const placeholders = paths.map((p) => ({ url: p, name: '' }));
      this.setData({ 'editForm.images': [...this.data.editForm.images, ...placeholders], uploading: true });

      try {
        // 逐张压缩上传：控制单张 ≤300KB / 长边 ≤1920px，并生成列表懒加载用的缩略图
        const uploaded = await compressAndUploadImages(CANVAS_ID, paths, `daily_menus/${this.data.currentStoreId}`);

        // 压缩上传跑完后，原地把每个条目的本地路径 url 替换成云端 fileID——数组
        // 顺序与 paths/uploaded 一一对应，按下标原地替换 url，保留管理员此时已输入的 name
        const finalImages = [...this.data.editForm.images];
        uploaded.forEach((u, i) => {
          finalImages[insertStart + i] = { ...finalImages[insertStart + i], url: u.url };
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
      console.error('[daily-menu] onChooseImage 异常:', err);
      wx.showToast({ title: '图片处理失败，请重试', icon: 'none' });
    }
  },

  async onSubmitEdit() {
    const { id, dateString, mealType, menuText, images } = this.data.editForm;

    if (!menuText.trim() && images.length === 0) {
      wx.showToast({ title: '请至少填写菜谱文字或上传一张配图', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '提交中...', mask: true });

    try {
      const imagesForSubmit = images.map((img) => ({ url: img.url, thumbUrl: img.url, name: (img.name || '').trim() }));
      const res = await callFunctionWithTimeout({
        name: 'manageDailyMenu',
        data: {
          action: id ? 'update' : 'create',
          id,
          storeId: this.data.currentStoreId,
          dateString,
          mealType: mealType || DEFAULT_MEAL_TYPE,
          menuText: menuText.trim(),
          images: imagesForSubmit
        }
      });
      const result = res.result as any;

      wx.hideLoading();

      if (result && result.success) {
        wx.showToast({ title: result.message || '提交成功', icon: 'success' });
        // 🆕 只在提交真正成功后才记入历史备注——半途放弃/提交失败的草稿文字
        // 不该污染这份"确实用过的常用备注"列表
        this.rememberRecentRemark(menuText);
        this.setData({ showEditForm: false });
        // 提交的记录可能是当前选中日期（顶部区）或历史某天（下方区），两处都刷新一次以保持同步
        this.loadSelectedMenu();
        this.fetchList(true);
      } else {
        wx.showModal({ title: '提交失败', content: (result && result.error) || '未知错误', showCancel: false });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[daily-menu] onSubmitEdit 异常:', err);
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
    }
  },

  onDeleteMenu(e: any) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;

    wx.showModal({
      title: '确认删除该菜单？',
      content: '删除后不可恢复',
      confirmColor: '#D32F2F',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '删除中...', mask: true });
        try {
          const cbRes = await callFunctionWithTimeout({
            name: 'manageDailyMenu',
            data: { action: 'delete', id }
          });
          wx.hideLoading();
          const result = cbRes.result as any;
          if (result && result.success) {
            wx.showToast({ title: '已删除', icon: 'success' });
            this.setData({ showDetailModal: false });
            this.loadSelectedMenu();
            this.fetchList(true);
          } else {
            wx.showToast({ title: (result && result.error) || '删除失败', icon: 'none' });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[daily-menu] onDeleteMenu 异常:', err);
          wx.showToast({ title: '删除失败，请重试', icon: 'none' });
        }
      }
    });
  },

  // ✨ 一键复用为该日食谱：将历史食谱的菜名明细与配图直接带入当前选中日期+餐别的
  // 编辑框（同页内操作，无需跳转）。history-list 卡片按钮与"引用历史食谱"弹窗
  // （见 onOpenReuseTemplatePicker）共用这一份逻辑，唯一区别是触发确认弹窗的文案
  reuseItemToSelected(item: any) {
    const todayItem = this.data.todayItem;
    this.setData({
      showEditForm: true,
      editForm: {
        // 当前选中日期+餐别若已有记录，复用仍落在"更新"模式下，避免产生重复记录
        id: todayItem ? todayItem._id : '',
        dateString: this.data.selectedDateStr,
        mealType: this.data.selectedMealType,
        menuText: item.menuText || '',
        images: this.toEditableDishList(item.images)
      }
    });
  },

  onReuseToToday(e: any) {
    if (!this.data.canManage) return;
    const id = e.currentTarget.dataset.id;
    const item = this.data.list.find((r: any) => r._id === id);
    if (!item) return;

    wx.showModal({
      title: `一键复用为${this.data.isSelectedToday ? '今日' : '该日'}食谱`,
      content: `将把【${item.dateString}】的菜品明细与配图带入编辑框，确认后可微调再发布，是否继续？`,
      confirmText: '去确认发布',
      success: (res) => {
        if (!res.confirm) return;
        this.reuseItemToSelected(item);
      }
    });
  },

  // 📖 引用历史食谱：未发布状态下的辅助入口，弹出 historyList 供挑选，
  // 免去先划到下方历史区再点复用的来回操作
  onOpenReuseTemplatePicker() {
    if (!this.data.canManage) return;
    if (this.data.historyList.length === 0) {
      wx.showToast({ title: '暂无历史食谱可引用，请先发布一次', icon: 'none' });
      return;
    }
    this.setData({ showReuseTemplateModal: true });
  },

  onCloseReuseTemplateModal() {
    this.setData({ showReuseTemplateModal: false });
  },

  onPickReuseTemplate(e: any) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.historyList.find((r: any) => r._id === id);
    if (!item) return;
    this.setData({ showReuseTemplateModal: false });
    this.reuseItemToSelected(item);
  },

  onPreviewImage(e: any) {
    const url = e.currentTarget.dataset.url;
    const rawUrls = e.currentTarget.dataset.urls || [];
    if (!url) return;
    // data-urls 绑定的是 {url, thumbUrl} 对象数组，wx.previewImage 需要纯字符串数组
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

  // 🛡️ 食谱缩略图加载失败：上报诊断日志（用于确认真机"图片空白"是云存储读权限
  // 问题——常见报错含 403/-1——还是别的原因，而不是盲猜），并把这张图记进
  // thumbFailedMap，驱动 WXML 切换成可点击重试的占位块，而不是放任裂图晾在那里
  onImageLoadError(e: any) {
    const url = e.currentTarget.dataset.thumbUrl;
    console.warn('[daily-menu] 缩略图加载失败:', url, e.detail);
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

  // 📤 生成今日食谱宣传海报：下载每道菜的云端实拍图到本地临时路径后，绘制成
  // 3 列九宫格菜品卡片（图+菜名）+ 感恩词摘要 + 小程序码的可保存/分享海报
  async onGenerateMenuPoster() {
    if (!this.data.todayItem) {
      wx.showToast({ title: '暂无食谱，无法生成海报', icon: 'none' });
      return;
    }
    if (this.data.posterGenerating) return;

    this.setData({ showPosterModal: true, posterReady: false, posterGenerating: true, posterTempFilePath: '' });
    wx.showLoading({ title: '正在生成海报...', mask: true });

    try {
      const dishes = this.data.todayDishes;
      // 配图落库存的是云存储 fileID（cloud://...），需用 wx.cloud.downloadFile 而非 wx.downloadFile 下载
      const downloaded = await Promise.all(
        dishes.map(async (dish: any) => {
          if (!dish.url) return { name: dish.name, photoTempPath: '' };
          try {
            const res = await wx.cloud.downloadFile({ fileID: dish.url });
            return { name: dish.name, photoTempPath: res.tempFilePath };
          } catch (err) {
            console.warn('[daily-menu] 海报配图下载失败，使用占位:', err);
            return { name: dish.name, photoTempPath: '' };
          }
        })
      );

      // 门店推广二维码：与 index.ts onGenerateStorePoster 同款获取方式，失败时
      // 优雅降级为不画（不阻断海报生成）
      let qrLocalPath = '';
      try {
        const qrRes = await callFunctionWithTimeout({
          name: 'getStoreQRCode',
          data: { storeId: this.data.currentStoreId, storeName: this.data.currentStoreName }
        });
        const qrResult = qrRes.result as any;
        if (qrResult && qrResult.success && qrResult.fileID) {
          const downRes = await wx.cloud.downloadFile({ fileID: qrResult.fileID });
          qrLocalPath = downRes.tempFilePath;
        }
      } catch (qrErr) {
        console.warn('[daily-menu] 海报二维码获取失败，跳过:', qrErr);
      }

      const gratitudeLine = GRATITUDE_TEXT[0] || '';
      const mealLabelText = mealTypeLabel(this.data.todayItem.mealType || DEFAULT_MEAL_TYPE);
      const posterHeight = calcDailyMenuPosterHeight(
        downloaded.length,
        !!this.data.todayItem.menuText,
        POSTER_WIDTH,
        !!gratitudeLine,
        !!qrLocalPath
      );
      this.setData({ posterCanvasHeight: posterHeight });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const query = wx.createSelectorQuery();
      query.select(`#${POSTER_CANVAS_ID}`)
        .fields({ node: true, size: true })
        .exec(async (res) => {
          if (!res[0] || !res[0].node) {
            wx.hideLoading();
            this.setData({ posterGenerating: false });
            wx.showToast({ title: 'Canvas 初始化失败', icon: 'none' });
            return;
          }
          const canvas = res[0].node;
          try {
            await drawDailyMenuPoster({
              canvas,
              storeName: this.data.currentStoreName,
              dateDisplay: this.data.selectedDateDisplay,
              mealLabel: mealLabelText,
              menuText: this.data.todayItem.menuText,
              dishes: downloaded,
              width: POSTER_WIDTH,
              height: posterHeight,
              gratitudeLine,
              qrLocalPath
            });
            // 海报画完立即生成一次临时文件路径，保存到相册/分享海报共用，
            // 避免两处各自重复调用 canvasToTempFilePath
            wx.canvasToTempFilePath({
              canvas,
              success: (tempRes) => {
                this.setData({ posterReady: true, posterGenerating: false, posterTempFilePath: tempRes.tempFilePath });
                wx.hideLoading();
              },
              fail: () => {
                // 生成临时文件失败不影响海报本身已经画好，只是保存/分享按钮暂不可用
                this.setData({ posterReady: true, posterGenerating: false });
                wx.hideLoading();
              }
            });
          } catch (drawErr) {
            wx.hideLoading();
            this.setData({ posterGenerating: false });
            console.error('[daily-menu] 海报绘制失败:', drawErr);
            wx.showToast({ title: '海报绘制失败', icon: 'none' });
          }
        });
    } catch (err) {
      wx.hideLoading();
      this.setData({ posterGenerating: false });
      console.error('[daily-menu] onGenerateMenuPoster 异常:', err);
      wx.showToast({ title: '海报生成失败，请重试', icon: 'none' });
    }
  },

  onClosePosterModal() {
    this.setData({ showPosterModal: false, posterReady: false });
  },

  onSavePosterToAlbum() {
    if (!this.data.posterReady || !this.data.posterTempFilePath) {
      wx.showToast({ title: '海报尚未绘制完成', icon: 'none' });
      return;
    }
    wx.saveImageToPhotosAlbum({
      filePath: this.data.posterTempFilePath,
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

  // 📤 一键分享海报到微信群/朋友圈：wx.showShareImageMenu 是微信提供的、专门
  // 用于把一张本地图片直接分享到聊天/朋友圈的原生面板 API，比 open-type="share"
  // （分享的是小程序卡片，不是这张具体的海报图片）更贴合"把海报发出去"的诉求。
  // miniprogram-api-typings 还没收录这个较新的 API，用 (wx as any) 显式绕过，
  // 与仓库里其它地方对新版 wx API/云函数返回值的处理手法一致
  onShareMenuPoster() {
    if (!this.data.posterReady || !this.data.posterTempFilePath) {
      wx.showToast({ title: '海报尚未绘制完成', icon: 'none' });
      return;
    }
    (wx as any).showShareImageMenu({
      path: this.data.posterTempFilePath,
      fail: (err: any) => {
        console.warn('[daily-menu] 分享海报失败:', err);
        wx.showToast({ title: '分享失败', icon: 'none' });
      }
    });
  },

  onToggleGratitude() {
    this.setData({ gratitudeExpanded: !this.data.gratitudeExpanded });
  },

  // ============ 🤖 AI 备餐助手（2026-09-10 智能备餐与食材用量预测·一期原型） ============

  // 🐛 根因修复（2026-09-10 卡片全隐形）：不再判断 canManage——这张卡片的
  // 可见性现在由 wxml 的 wx:if="{{currentStoreId}}" 门控，能展开这个卡片
  // 就意味着已经满足了显示条件，这里不需要重复判断
  onToggleMealPrediction() {
    this.setData({ mealPredictionExpanded: !this.data.mealPredictionExpanded });
  },

  onMealPredictionDateChange(e: any) {
    const dateStr = e.detail.value;
    this.setData({
      'mealPredictionForm.targetDate': dateStr,
      'mealPredictionForm.targetDateDisplay': formatDisplayDate(dateStr),
      // 换了目标日期后，上一次的预测结果不再对应当前表单，清空避免误导
      mealPredictionResult: null,
      mealPredictionIngredientRows: [],
      mealPredictionApplied: false,
      mealPredictionError: ''
    });
  },

  onSelectMealPredictionWeather(e: any) {
    this.setData({ 'mealPredictionForm.weather': e.currentTarget.dataset.value });
  },

  onToggleMealPredictionHoliday() {
    this.setData({ 'mealPredictionForm.isHoliday': !this.data.mealPredictionForm.isHoliday });
  },

  // 🐛 权限收口：这里不重复判断 canManage——onToggleMealPrediction 已经拦过一次
  // "整个卡片是否可见/可展开"，展开之后表单内的具体操作（选日期/选天气/点生成）
  // 是同一个已经过权限校验的展开态里的子操作，不需要每个子操作各自再判一遍
  async onRunMealPrediction() {
    if (this.data.mealPredictionLoading) return;
    if (!this.data.currentStoreId) {
      this.setData({ mealPredictionError: '尚未确定门店，无法生成预测' });
      return;
    }

    this.setData({ mealPredictionLoading: true, mealPredictionError: '', mealPredictionApplied: false });
    try {
      const res: any = await callFunctionWithTimeout({
        name: 'manageDailyMenu',
        data: {
          action: 'getMealPrediction',
          storeId: this.data.currentStoreId,
          targetDate: this.data.mealPredictionForm.targetDate,
          weatherFactor: this.data.mealPredictionForm.weather,
          isHoliday: this.data.mealPredictionForm.isHoliday
        }
      });
      const result = res && res.result;
      if (!result || !result.success) {
        this.setData({ mealPredictionError: (result && result.error) || '预测失败，请重试' });
        return;
      }

      this.setData({
        mealPredictionResult: result,
        mealPredictionIngredientRows: buildIngredientRows(result.ingredients)
      });
    } catch (err) {
      console.error('[daily-menu] onRunMealPrediction 异常:', err);
      this.setData({ mealPredictionError: '网络异常，请重试' });
    } finally {
      this.setData({ mealPredictionLoading: false });
    }
  },

  // 📋（2026-09-10）"一键套用"一期原型如实做法：本仓库目前没有一个真实的
  // "后厨采购清单/备餐看板"集合或页面可以写入——与其假装接了一个不存在的
  // 模块，这里先落地成"一键复制格式化文本到剪贴板"，管理员可以直接粘贴进
  // 微信群/采购台账/任何后续真正建起来的看板里。等后续真的建了采购清单
  // 模块，这里再改成调用那个模块的写入接口，不是这一期的范围
  onApplyMealPrediction() {
    const result = this.data.mealPredictionResult;
    if (!result || result.insufficientData) return;

    const lines = [
      `【AI 备餐建议】${this.data.mealPredictionForm.targetDateDisplay}`,
      `推荐备餐总人次：${result.recommendedHeadcount} 人（堂食+外送预估）`,
      '基础食材清单：'
    ];
    this.data.mealPredictionIngredientRows.forEach((row: any) => {
      lines.push(`- ${row.label}：${row.value} ${row.unit}`);
    });

    wx.setClipboardData({
      data: lines.join('\n'),
      success: () => {
        this.setData({ mealPredictionApplied: true });
        wx.showToast({ title: '已复制备餐清单', icon: 'success' });
      },
      fail: () => {
        wx.showToast({ title: '复制失败，请重试', icon: 'none' });
      }
    });
  },

  // 🛒（2026-09-11 离线兜底缓存）本机 storage 键名——按门店+日期隔离，
  // 权威数据来源始终是云端 daily_purchase_plans，这份缓存只在网络异常时
  // 兜底展示、不参与正常路径下的展示决策，避免"云端已经有新进度，本地
  // 缓存却更旧"这种双写不一致
  _purchasePlanStorageKey(): string {
    return `dm_purchase_plan_${this.data.currentStoreId}_${this.data.mealPredictionForm.targetDate}`;
  },

  _persistPurchasePlanCache(tasks: any[]) {
    try {
      wx.setStorageSync(this._purchasePlanStorageKey(), tasks);
    } catch (e) {
      // 本机 storage 写入失败不阻断交互，只是离线兜底缓存少了一份
    }
  },

  _loadPurchasePlanCache(): any[] | null {
    try {
      const cached = wx.getStorageSync(this._purchasePlanStorageKey());
      return Array.isArray(cached) && cached.length > 0 ? cached : null;
    } catch (e) {
      return null;
    }
  },

  // 📋（2026-09-11 云端持久化）生成后厨采买清单：与 onApplyMealPrediction
  // （纯文本复制）是并存的两条独立能力——本方法产出结构化、可勾选/可微调
  // 重量的任务清单，在专门的弹窗里展示，而不是直接扔进剪贴板。
  // 🛒 权威数据来源是云端 daily_purchase_plans 集合（见 cloudfunctions/
  // manageDailyMenu 新增的 getPurchasePlan/createPurchasePlan 两个
  // action）——同一门店的义工/财务/店长在不同设备上打开，看到的是同一份
  // 进度。本机 storage 只在云端请求彻底失败（离线/网络异常）时才读取，
  // 正常路径下每次都以云端返回为准并覆盖写入缓存，确保前端状态与云端
  // 强一致，不会出现"缓存比云端新"的分叉。
  // 🛡️ 权限收口：与 onRunMealPrediction 同一处校验口径——currentStoreId
  // 是否已绑定门店是这张卡片能否使用的唯一门槛（预测结果本身只在已绑店
  // 时才可能存在，这里再显式判一次是防御性收口，不是多此一举，避免未来
  // UI 结构调整后这个按钮意外脱离预测结果区单独可点）
  async onGeneratePurchasePlan() {
    if (!this.data.currentStoreId) {
      wx.showToast({ title: '尚未确定门店，无法生成采买清单', icon: 'none' });
      return;
    }
    const result = this.data.mealPredictionResult;
    if (!result || result.insufficientData) return;

    wx.showLoading({ title: '加载采买清单...', mask: true });
    try {
      // 先查云端是否已经有人（可能是自己，也可能是同店其他角色）生成过
      // 今天这份清单——有就直接展示已有进度，不重置回全 pending
      const getRes: any = await callFunctionWithTimeout({
        name: 'manageDailyMenu',
        data: {
          action: 'getPurchasePlan',
          storeId: this.data.currentStoreId,
          dateString: this.data.mealPredictionForm.targetDate
        }
      });
      const getResult = getRes && getRes.result;
      if (getResult && getResult.success && getResult.exists && Array.isArray(getResult.tasks) && getResult.tasks.length > 0) {
        wx.hideLoading();
        this.setData({ purchasePlanTasks: getResult.tasks, showPurchasePlanModal: true });
        this._persistPurchasePlanCache(getResult.tasks);
        return;
      }

      // 云端还没有：本地先算出一版初始清单，调用 createPurchasePlan 落库。
      // 服务端用确定性 _id + 主键唯一性兜底防并发重复创建，返回的 tasks
      // 才是权威版本（万一同一时刻另一台设备也在创建，会拿到那一份而不是
      // 这里本地算的这份）
      const freshTasks = buildPurchasePlan(result.ingredients);
      if (freshTasks.length === 0) {
        wx.hideLoading();
        wx.showToast({ title: '暂无可生成的采买项', icon: 'none' });
        return;
      }

      const createRes: any = await callFunctionWithTimeout({
        name: 'manageDailyMenu',
        data: {
          action: 'createPurchasePlan',
          storeId: this.data.currentStoreId,
          dateString: this.data.mealPredictionForm.targetDate,
          tasks: freshTasks
        }
      });
      wx.hideLoading();
      const createResult = createRes && createRes.result;
      if (!createResult || !createResult.success) {
        wx.showToast({ title: (createResult && createResult.error) || '生成采买清单失败', icon: 'none' });
        return;
      }
      const finalTasks = createResult.tasks || freshTasks;
      this.setData({ purchasePlanTasks: finalTasks, showPurchasePlanModal: true });
      this._persistPurchasePlanCache(finalTasks);
    } catch (err) {
      wx.hideLoading();
      console.error('[daily-menu] onGeneratePurchasePlan 异常:', err);
      // 🛒 离线兜底：云端请求彻底失败（网络异常/超时）时退回本机缓存，
      // 让义工至少能看到、继续勾选上次已同步过的进度，而不是完全无法使用；
      // 缓存里没有任何数据时才提示"网络异常，请重试"这条最终兜底文案
      const cached = this._loadPurchasePlanCache();
      if (cached) {
        this.setData({ purchasePlanTasks: cached, showPurchasePlanModal: true });
        wx.showToast({ title: '网络异常，已展示离线缓存清单', icon: 'none' });
      } else {
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      }
    }
  },

  // 🛒 勾选/取消勾选某一项采买任务——先乐观更新本地展示（避免网络延迟让
  // 用户以为点击没反应），云端确认失败时回滚到点击前的状态并提示重试。
  // 无论成败，最终展示的状态都会同步写入离线兜底缓存，保持"缓存=当前
  // 展示内容"这条不变式。
  // 🛡️ 读改写非严格 CAS（没有加乐观锁版本号），如实标注边界：几个人同时、
  // 毫秒级窗口内勾选*不同*任务时存在理论上的覆盖风险——这是给一份最多
  // 4 条的门店采购清单设计的协同能力，不是高并发交易系统，上事务/版本号
  // 是过度设计；真出现并发覆盖，后果也只是"某一次勾选被下一次读改写覆盖
  // 掉"，补勾一次即可恢复，不构成数据损坏或资金风险
  async onTogglePurchaseTask(e: any) {
    const itemKey = e.currentTarget.dataset.key;
    const previous = this.data.purchasePlanTasks;
    const optimistic = togglePurchaseTaskStatus(previous, itemKey);
    this.setData({ purchasePlanTasks: optimistic });
    try {
      const res: any = await callFunctionWithTimeout({
        name: 'manageDailyMenu',
        data: {
          action: 'togglePurchaseTask',
          storeId: this.data.currentStoreId,
          dateString: this.data.mealPredictionForm.targetDate,
          itemKey
        }
      });
      const result = res && res.result;
      if (result && result.success && Array.isArray(result.tasks)) {
        this.setData({ purchasePlanTasks: result.tasks });
        this._persistPurchasePlanCache(result.tasks);
      } else {
        this.setData({ purchasePlanTasks: previous });
        this._persistPurchasePlanCache(previous);
        wx.showToast({ title: (result && result.error) || '同步失败，请重试', icon: 'none' });
      }
    } catch (err) {
      this.setData({ purchasePlanTasks: previous });
      this._persistPurchasePlanCache(previous);
      console.error('[daily-menu] onTogglePurchaseTask 异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
  },

  // 🛒（2026-09-11 防抖持久化）把某一项预估重量的最新输入值真正同步到
  // 云端——从 onInputPurchaseTaskWeight 的防抖定时器触发，也在弹窗关闭/
  // 页面卸载时被 _flushPendingPurchaseWeightSync 立即调用一次，确保防抖
  // 窗口内的最后一次输入不会因为用户随手关闭弹窗而丢失。
  // 🛡️ 与 onTogglePurchaseTask 不同，这里不做失败回滚/弹 toast 打断——
  // 用户可能还在连续输入下一项，网络抖动时强行回滚或弹提示会打断输入
  // 体验；本地乐观值本就是用户刚输入的内容，静默保留即可，云端最终会在
  // 下一次输入/操作时重新尝试同步
  async _syncPurchaseTaskWeight(itemKey: string, rawValue: string) {
    try {
      const res: any = await callFunctionWithTimeout({
        name: 'manageDailyMenu',
        data: {
          action: 'updatePurchaseTaskWeight',
          storeId: this.data.currentStoreId,
          dateString: this.data.mealPredictionForm.targetDate,
          itemKey,
          estimatedWeight: rawValue
        }
      });
      const result = res && res.result;
      if (result && result.success && Array.isArray(result.tasks)) {
        this.setData({ purchasePlanTasks: result.tasks });
        this._persistPurchasePlanCache(result.tasks);
      }
    } catch (err) {
      console.error('[daily-menu] _syncPurchaseTaskWeight 异常:', err);
    }
  },

  // 🛒 义工弹窗微调预估重量——非法输入（空/0/负数/非数字）由
  // updatePurchaseTaskWeight 自己兜底保留旧值，这里不重复校验。本地展示
  // 与离线缓存随每次按键立即更新（乐观、免费），但真正打到云端的请求按
  // 每个 itemKey 独立防抖 500ms——用户连续输入数字时（如从"3"改成"30"）
  // 只在停顿后发一次请求，不会每敲一位数字就打一次云函数。定时器挂在页面
  // 实例 this 上而不是 data，遵循本仓库"临时变量不占用 setData 通讯通道"
  // 的既定规范。
  onInputPurchaseTaskWeight(e: any) {
    const itemKey = e.currentTarget.dataset.key;
    const rawValue = e.detail.value;
    const nextTasks = updatePurchaseTaskWeight(this.data.purchasePlanTasks, itemKey, rawValue);
    this.setData({ purchasePlanTasks: nextTasks });
    this._persistPurchasePlanCache(nextTasks);

    if (this._purchaseWeightSyncTimers[itemKey]) {
      clearTimeout(this._purchaseWeightSyncTimers[itemKey]);
    }
    this._purchaseWeightSyncTimers[itemKey] = setTimeout(() => {
      delete this._purchaseWeightSyncTimers[itemKey];
      this._syncPurchaseTaskWeight(itemKey, rawValue);
    }, 500);
  },

  // 🛒 立即补发所有还在防抖等待中的重量修改，用于弹窗关闭/页面卸载这类
  // "用户即将离开、防抖定时器可能再也不会自然触发"的时机，避免最后一次
  // 输入悄悄丢失、云端永远停留在倒数第二次的值
  _flushPendingPurchaseWeightSync() {
    if (!this._purchaseWeightSyncTimers) return;
    Object.keys(this._purchaseWeightSyncTimers).forEach((itemKey) => {
      clearTimeout(this._purchaseWeightSyncTimers[itemKey]);
      delete this._purchaseWeightSyncTimers[itemKey];
      const task = (this.data.purchasePlanTasks || []).find((t: any) => t.itemKey === itemKey);
      if (task) this._syncPurchaseTaskWeight(itemKey, String(task.estimatedWeight));
    });
  },

  // 🛒 一键复制采买清单到剪贴板——云端持久化落地后，这个按钮的定位从"唯一
  // 的跨人协作手段"变成"额外的分发渠道"（分享到微信群/纸质台账），本店
  // 内部协同已经靠云端清单本身完成，不再需要靠复制粘贴同步进度。文本永远
  // 从当前内存里的 purchasePlanTasks 格式化，无论这份数据来自云端还是
  // 离线兜底缓存，复制出来的都是"用户此刻在弹窗里实际看到的内容"。
  onCopyPurchasePlan() {
    const text = formatPurchasePlanText(this.data.purchasePlanTasks);
    if (!text) return;
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制采买清单', icon: 'success' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' })
    });
  },

  onClosePurchasePlanModal() {
    // 🛒 关闭前立即补发所有还在防抖等待中的重量修改，见
    // _flushPendingPurchaseWeightSync 注释
    this._flushPendingPurchaseWeightSync();
    this.setData({ showPurchasePlanModal: false });
  },

  // 🔗 顶部原生"…"菜单的分享入口（与海报弹窗里 onShareMenuPoster 分享的是同一张
  // 海报图片这件事无关，这里分享的是小程序卡片）：参照 history.ts 同款写法，
  // title 用门店+日期+餐别拼一句话，path 回退到首页，imageUrl 留空用系统默认截图
  onShareAppMessage() {
    const store = this.data.currentStoreName || '雨花斋';
    const date = this.data.selectedDateDisplay || '';
    const meal = this.data.mealLabel || '';
    return {
      title: `🍱【${store}】${date}${meal}食谱，欢迎参考！`,
      path: '/pages/index/index',
      imageUrl: ''
    };
  },

  onShareTimeline() {
    const store = this.data.currentStoreName || '雨花斋';
    return {
      title: `${store}·今日食谱 · 雨花斋餐报助手`,
      query: ''
    };
  }
});
