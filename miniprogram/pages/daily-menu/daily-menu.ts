import { AuthService } from '../../utils/authService';
import { getSelectedStore } from '../../utils/storeManager';
import { compressAndUploadImages } from '../../utils/imageCompress';
import { createNavGuard, NavGuardInstance } from '../../utils/navGuard';
import { recordRecentVisit } from '../../utils/recentPages';

const CANVAS_ID = 'imgCompressCanvas';
const PAGE_SIZE = 10;

function getTodayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
    navTop: 0,
    contentTop: 0,

    currentStoreId: '',
    currentStoreName: '',
    canManage: false,

    // 🍱 今日食谱（顶部高亮区）
    todayDateStr: getTodayStr(),
    todayItem: null as any,
    todayLoading: false,

    // 📚 历史食谱（下方时间轴，不含今天，避免与顶部重复展示）
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
      menuText: '',
      images: [] as string[]
    },
    uploading: false,

    // 🛡️ 缩略图加载失败兜底：key 是图片路径本身。今日食谱/历史食谱/编辑表单三处
    // 图片网格结构各不相同（单条记录 / 列表套子数组 / 编辑中的数组），共用一张按
    // 路径查表的 map 比分别给每个嵌套结构维护 loadFailed 字段简单得多——反正每个
    // <image> 上早就都带着 data-url，直接拿来当 key 用
    thumbFailedMap: {} as Record<string, boolean>
  },

  async onLoad() {
    recordRecentVisit('/pages/daily-menu/daily-menu', '食谱管理中心');
    this.calculateNavBarHeight();
    // 🔑 需先拿到 currentStoreId 再查今日食谱（getByDate 要求 storeId 必填），故此处 await 顺序执行
    await this.initRoleAndStore();
    this.loadTodayMenu();
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

  calculateNavBarHeight() {
    const menuButton = wx.getMenuButtonBoundingClientRect();
    if (!menuButton) {
      this.setData({ navTop: 44, contentTop: 88 });
      return;
    }
    this.setData({
      navTop: menuButton.top,
      contentTop: menuButton.top + menuButton.height + 8
    });
  },

  async initRoleAndStore() {
    let roleInfo = AuthService.getCachedRoleInfo();
    if (!roleInfo) {
      const result = await AuthService.fetchUserRole();
      roleInfo = result.roleInfo || null;
    }

    const store = getSelectedStore();
    const storeId = (roleInfo && roleInfo.storeId) || store.storeId || '';
    const storeName = (roleInfo && roleInfo.storeName) || store.storeName || '';
    const canManage = (roleInfo && roleInfo.role === 'store_manager') || (roleInfo && roleInfo.role === 'super_admin');

    this.setData({ currentStoreId: storeId, currentStoreName: storeName, canManage });
  },

  // 🍱 查询今天是否已发布食谱，用于顶部高亮区展示 + 编辑表单预填
  async loadTodayMenu() {
    if (!this.data.currentStoreId) {
      this.setData({ todayItem: null });
      return;
    }

    this.setData({ todayLoading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageDailyMenu',
        data: { action: 'getByDate', storeId: this.data.currentStoreId, dateString: this.data.todayDateStr }
      });
      const result = res.result as any;
      const item = (result && result.success) ? result.data : null;
      if (item) {
        item.publishTimeStr = formatHHmm(item.updateTime);
      }
      this.setData({ todayItem: item });
    } catch (err) {
      console.error('[daily-menu] loadTodayMenu 异常:', err);
      this.setData({ todayItem: null });
    } finally {
      this.setData({ todayLoading: false });
    }
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
      const res = await wx.cloud.callFunction({
        name: 'manageDailyMenu',
        data: {
          action: 'list',
          storeId: this.data.currentStoreId,
          page: targetPage,
          pageSize: PAGE_SIZE
        }
      });
      const result = res.result as any;

      if (result && result.success) {
        const newList = reset ? (result.data || []) : this.data.list.concat(result.data || []);
        // 「历史食谱」区域不重复展示今天（今天已在顶部高亮区单独呈现）
        const historyList = newList.filter((item: any) => item.dateString !== this.data.todayDateStr);
        this.setData({
          list: newList,
          historyList,
          page: targetPage,
          total: result.total || 0,
          hasMore: !!result.hasMore
        });
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

  // 🍱 顶部【编辑/发布今日食谱】按钮：今日已发布则预填回显（更新模式），否则空白新建
  onOpenTodayEditForm() {
    if (!this.data.canManage) return;
    const item = this.data.todayItem;
    this.setData({
      showEditForm: true,
      editForm: {
        id: item ? item._id : '',
        dateString: this.data.todayDateStr,
        menuText: item ? (item.menuText || '') : '',
        // 🛡️ editForm.images 现在是纯字符串数组（与 receiptImages 同构，供 WXML
        // 直接 {{item}} 绑定），但数据库里已发布记录的 images 字段仍是 {url,thumbUrl}
        // 对象，回显进编辑表单时要摘出 url
        images: item ? this.toImagePathList(item.images) : []
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
        menuText: item.menuText || '',
        images: this.toImagePathList(item.images)
      }
    });
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

  // 🖼️ 微信标准九宫格：今日食谱最多 9 张配图
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

      // 🌟 与支出凭证(receiptImages)100% 同构：纯字符串数组，选完图立刻把本地
      // tempFilePath 塞进数组先渲染出来，不等压缩上传跑完才显示——本地文件选完
      // 那一刻就是有效路径，WXML 直接 {{item}} 绑定，不经过任何对象属性访问
      const insertStart = this.data.editForm.images.length;
      this.setData({ 'editForm.images': [...this.data.editForm.images, ...paths], uploading: true });

      try {
        // 逐张压缩上传：控制单张 ≤300KB / 长边 ≤1920px，并生成列表懒加载用的缩略图
        const uploaded = await compressAndUploadImages(CANVAS_ID, paths, `daily_menus/${this.data.currentStoreId}`);

        // 压缩上传跑完后，原地把本地路径字符串替换成云端 fileID 字符串——数组
        // 顺序与 paths/uploaded 一一对应，按下标原地替换，不按值反查
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
      console.error('[daily-menu] onChooseImage 异常:', err);
      wx.showToast({ title: '图片处理失败，请重试', icon: 'none' });
    }
  },

  async onSubmitEdit() {
    const { id, dateString, menuText, images } = this.data.editForm;

    if (!menuText.trim() && images.length === 0) {
      wx.showToast({ title: '请至少填写菜谱文字或上传一张配图', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '提交中...', mask: true });

    try {
      // 🛡️ images 在页面这一侧是纯字符串数组，但 manageDailyMenu 云函数的
      // sanitizeImages 需要 {url,thumbUrl} 对象——直接传字符串进去，img.url 取不到
      // 值会被云端过滤器整批丢弃，导致"提交成功但图片全没了"。这里转换回数据库
      // 期待的对象形状，字符串数组只是页面内部状态，不是持久化 schema
      const imagesForSubmit = images.map((url: string) => ({ url, thumbUrl: url }));
      const res = await wx.cloud.callFunction({
        name: 'manageDailyMenu',
        data: {
          action: id ? 'update' : 'create',
          id,
          storeId: this.data.currentStoreId,
          dateString,
          menuText: menuText.trim(),
          images: imagesForSubmit
        }
      });
      const result = res.result as any;

      wx.hideLoading();

      if (result && result.success) {
        wx.showToast({ title: result.message || '提交成功', icon: 'success' });
        this.setData({ showEditForm: false });
        // 提交的记录可能是今天（顶部区）或历史某天（下方区），两处都刷新一次以保持同步
        this.loadTodayMenu();
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
          const cbRes = await wx.cloud.callFunction({
            name: 'manageDailyMenu',
            data: { action: 'delete', id }
          });
          wx.hideLoading();
          const result = cbRes.result as any;
          if (result && result.success) {
            wx.showToast({ title: '已删除', icon: 'success' });
            this.setData({ showDetailModal: false });
            this.loadTodayMenu();
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

  // ✨ 一键复用为今日食谱：将历史食谱的菜名明细与配图直接带入今日食谱编辑框（同页内操作，无需跳转）
  onReuseToToday(e: any) {
    if (!this.data.canManage) return;
    const id = e.currentTarget.dataset.id;
    const item = this.data.list.find((r: any) => r._id === id);
    if (!item) return;

    wx.showModal({
      title: '一键复用为今日食谱',
      content: `将把【${item.dateString}】的菜品明细与配图带入今日食谱编辑框，确认后可微调再发布，是否继续？`,
      confirmText: '去确认发布',
      success: (res) => {
        if (!res.confirm) return;
        const todayItem = this.data.todayItem;
        this.setData({
          showEditForm: true,
          editForm: {
            // 今日若已有记录，复用仍落在"更新"模式下，避免产生重复的当天食谱记录
            id: todayItem ? todayItem._id : '',
            dateString: this.data.todayDateStr,
            menuText: item.menuText || '',
            images: item.images || []
          }
        });
      }
    });
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

  goBack() {
    if (this._navGuard) {
      this._navGuard.goHome();
      return;
    }
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.reLaunch({ url: '/pages/index/index' });
    }
  }
});
