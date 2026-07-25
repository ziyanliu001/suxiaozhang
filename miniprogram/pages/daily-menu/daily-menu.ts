import { AuthService } from '../../utils/authService';
import { getSelectedStore } from '../../utils/storeManager';
import { compressAndUploadImages } from '../../utils/imageCompress';
import { createNavGuard, NavGuardInstance } from '../../utils/navGuard';
import { recordRecentVisit } from '../../utils/recentPages';
import { drawDailyMenuPoster, calcDailyMenuPosterHeight } from '../../utils/drawDailyMenuPoster';
import { GRATITUDE_TEXT } from '../../utils/cultureData';

const CANVAS_ID = 'imgCompressCanvas';
const POSTER_CANVAS_ID = 'dailyMenuPosterCanvas';
const POSTER_WIDTH = 320;
const PAGE_SIZE = 10;
// 🍱 本项目雨花爱心餐目前每店每日仅供应一次午餐（无早/晚餐场次），"餐次"因此是
// 固定文案，不是需要落库的字段——见 pages/index/index.ts 中"午餐正常供应中"等既有措辞
const MEAL_LABEL = '午餐';

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
    navTop: 0,
    contentTop: 0,

    currentStoreId: '',
    currentStoreName: '',
    canManage: false,

    // 🍱 今日食谱（顶部高亮区）
    todayDateStr: getTodayStr(),
    todayDateDisplay: formatDisplayDate(getTodayStr()),
    mealLabel: MEAL_LABEL,
    todayItem: null as any,
    todayDishes: [] as any[],
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
      // 🍱 每个元素对应一道菜：{url: 本地临时路径/云端 fileID, name: 菜品名称}
      images: [] as Array<{ url: string; name: string }>
    },
    uploading: false,

    // 📤 生成食谱宣传海报
    showPosterModal: false,
    posterReady: false,
    posterGenerating: false,
    posterCanvasWidth: POSTER_WIDTH,
    posterCanvasHeight: 400,

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
      this.setData({ todayItem: item, todayDishes: buildDishList(item && item.images) });
    } catch (err) {
      console.error('[daily-menu] loadTodayMenu 异常:', err);
      this.setData({ todayItem: null, todayDishes: [] });
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
        const rawList = result.data || [];
        // 附加展示层派生字段：格式化日期、九宫格菜品卡片数组
        rawList.forEach((item: any) => {
          item.dateDisplay = formatDisplayDate(item.dateString);
          item.dishes = buildDishList(item.images);
        });
        const newList = reset ? rawList : this.data.list.concat(rawList);
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
    const { id, dateString, menuText, images } = this.data.editForm;

    if (!menuText.trim() && images.length === 0) {
      wx.showToast({ title: '请至少填写菜谱文字或上传一张配图', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '提交中...', mask: true });

    try {
      const imagesForSubmit = images.map((img) => ({ url: img.url, thumbUrl: img.url, name: (img.name || '').trim() }));
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
            images: this.toEditableDishList(item.images)
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

  // 📤 生成今日食谱宣传海报：下载每道菜的云端实拍图到本地临时路径后，绘制成
  // 3 列九宫格菜品卡片（图+菜名）的可保存/分享海报
  async onGenerateMenuPoster() {
    if (!this.data.todayItem) {
      wx.showToast({ title: '今日暂无食谱，无法生成海报', icon: 'none' });
      return;
    }
    if (this.data.posterGenerating) return;

    this.setData({ showPosterModal: true, posterReady: false, posterGenerating: true });
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

      const posterHeight = calcDailyMenuPosterHeight(downloaded.length, !!this.data.todayItem.menuText, POSTER_WIDTH);
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
              dateDisplay: this.data.todayDateDisplay,
              menuText: this.data.todayItem.menuText,
              dishes: downloaded,
              width: POSTER_WIDTH,
              height: posterHeight
            });
            wx.hideLoading();
            this.setData({ posterReady: true, posterGenerating: false });
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
    if (!this.data.posterReady) {
      wx.showToast({ title: '海报尚未绘制完成', icon: 'none' });
      return;
    }
    const query = wx.createSelectorQuery();
    query.select(`#${POSTER_CANVAS_ID}`)
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

  onToggleGratitude() {
    this.setData({ gratitudeExpanded: !this.data.gratitudeExpanded });
  },

  // 🛡️ 全局返回逻辑排查修复：goHome() 是给分享直入场景的物理返回键设计的，不该
  // 挪用给自定义导航栏的"←"按钮——那会导致不管从哪个页面点进来都被强制跳回首页
  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
  }
});
