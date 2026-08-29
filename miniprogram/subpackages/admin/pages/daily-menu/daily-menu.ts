import { AuthService } from '../../../../utils/authService';
import { getSelectedStore } from '../../../../utils/storeManager';
import { compressAndUploadImages } from '../../../../utils/imageCompress';
import { createNavGuard, NavGuardInstance } from '../../../../utils/navGuard';
import { recordRecentVisit } from '../../../../utils/recentPages';
import { drawDailyMenuPoster, calcDailyMenuPosterHeight } from '../../../../utils/drawDailyMenuPoster';
import { GRATITUDE_TEXT } from '../../../../utils/cultureData';
import { isVirtualStoreName } from '../../../../utils/storeIdentity';
import { callFunctionWithTimeout } from '../../../../utils/withTimeout';
import { getStorageAsync } from '../../../../utils/util';

const CANVAS_ID = 'imgCompressCanvas';
const POSTER_CANVAS_ID = 'dailyMenuPosterCanvas';
const POSTER_WIDTH = 320;
const PAGE_SIZE = 10;

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

  data: {
    contentTop: 0,
    navContentTop: 0,
    navContentHeight: 0,
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
    gratitudeExpanded: false
  },

  async onLoad() {
    recordRecentVisit('/subpackages/admin/pages/daily-menu/daily-menu', '食谱管理中心');
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
  },

  // 🐛 根因修复：见 store-management.ts 同处修复记录，改用 <navigation-bar>
  // 共享组件
  onNavLayout(e: { detail: { totalHeight: number; contentTop: number; contentHeight: number; rightGap: number } }) {
    this.setData({
      contentTop: e.detail.totalHeight + 8,
      navContentTop: e.detail.contentTop,
      navContentHeight: e.detail.contentHeight,
      navRightGap: e.detail.rightGap
    });
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
