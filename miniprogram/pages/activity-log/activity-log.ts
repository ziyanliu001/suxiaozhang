import { AuthService } from '../../utils/authService';
import { getSelectedStore } from '../../utils/storeManager';
import { compressAndUploadImages } from '../../utils/imageCompress';
import { createNavGuard, NavGuardInstance } from '../../utils/navGuard';
import { drawActivityPoster } from '../../utils/drawActivityPoster';
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

    // 📌 今日大事记（顶部高亮区，取当天最新一条；同一天允许多条时其余的仍展示在下方时光轴）
    todayDateStr: getTodayStr(),
    todayItem: null as any,
    todayLoading: false,

    // 🕰 历史大事记（下方时光轴，不含顶部已展示的那一条）
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
      title: '',
      eventTime: getTodayStr(),
      content: '',
      images: [] as string[]
    },
    uploading: false,

    // 📤 活动海报导出
    showPosterModal: false,
    posterTargetItem: null as any,
    posterReady: false,

    // 🛡️ 缩略图加载失败兜底：key 是图片路径本身，今日动态/历史动态/编辑表单三处
    // 图片网格结构各不相同，共用一张按路径查表的 map 比分别维护 loadFailed 字段简单
    thumbFailedMap: {} as Record<string, boolean>
  },

  async onLoad() {
    recordRecentVisit('/pages/activity-log/activity-log', '门店日志');
    this.calculateNavBarHeight();
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

  // 📌 查询今天最新一条大事记，用于顶部高亮区展示 + 编辑表单预填。
  // manageActivityLog 允许同一天存在多条记录（无 getByDate 动作），故用 list + 当天日期区间取最新一条。
  async loadTodayActivity() {
    if (!this.data.currentStoreId) {
      this.setData({ todayItem: null });
      return;
    }

    this.setData({ todayLoading: true });
    try {
      const res = await wx.cloud.callFunction({
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
  recomputeHistoryList() {
    const todayId = this.data.todayItem ? this.data.todayItem._id : null;
    const historyList = todayId ? this.data.list.filter((item: any) => item._id !== todayId) : this.data.list;
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
      const res = await wx.cloud.callFunction({
        name: 'manageActivityLog',
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
      console.error('[activity-log] fetchList 异常:', err);
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
    if (!this.data.canManage) return;
    const item = this.data.todayItem;
    this.setData({
      showEditForm: true,
      editForm: {
        id: item ? item._id : '',
        title: item ? (item.title || '') : '',
        eventTime: this.data.todayDateStr,
        content: item ? (item.content || '') : '',
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
        title: item.title || '',
        eventTime: item.eventTime,
        content: item.content || '',
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
    const { id, title, eventTime, content, images } = this.data.editForm;

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
      const res = await wx.cloud.callFunction({
        name: 'manageActivityLog',
        data: {
          action: id ? 'update' : 'create',
          id,
          storeId: this.data.currentStoreId,
          title: title.trim(),
          eventTime,
          content: content.trim(),
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
          const cbRes = await wx.cloud.callFunction({
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

  // 🛡️ 全局返回逻辑排查修复：goHome() 是给分享直入场景的物理返回键设计的，不该
  // 挪用给自定义导航栏的"←"按钮——那会导致不管从哪个页面点进来都被强制跳回首页
  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
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
