"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const authService_1 = require("../../utils/authService");
const storeManager_1 = require("../../utils/storeManager");
const imageCompress_1 = require("../../utils/imageCompress");
const navGuard_1 = require("../../utils/navGuard");
const drawActivityPoster_1 = require("../../utils/drawActivityPoster");
const CANVAS_ID = 'imgCompressCanvas';
const PAGE_SIZE = 10;
function getTodayStr() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
// updateTime 是云端 db.serverDate() 读回的原生 Date 对象，格式化为 HH:mm 用于"已发布"提示
function formatHHmm(time) {
    if (!time)
        return '';
    const d = time instanceof Date ? time : new Date(time);
    if (isNaN(d.getTime()))
        return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
Page({
    _navGuard: null,
    data: {
        navTop: 0,
        contentTop: 0,
        currentStoreId: '',
        currentStoreName: '',
        canManage: false,
        // 📌 今日大事记（顶部高亮区，取当天最新一条；同一天允许多条时其余的仍展示在下方时光轴）
        todayDateStr: getTodayStr(),
        todayItem: null,
        todayLoading: false,
        // 🕰 历史大事记（下方时光轴，不含顶部已展示的那一条）
        list: [],
        historyList: [],
        page: 1,
        total: 0,
        hasMore: true,
        loading: false,
        loadingMore: false,
        showDetailModal: false,
        detailItem: null,
        showEditForm: false,
        editForm: {
            id: '',
            title: '',
            eventTime: getTodayStr(),
            content: '',
            images: []
        },
        uploading: false,
        // 📤 活动海报导出
        showPosterModal: false,
        posterTargetItem: null,
        posterReady: false
    },
    async onLoad() {
        this.calculateNavBarHeight();
        // 🔑 需先拿到 currentStoreId 再查今日大事记（list 按 storeId 过滤），故此处 await 顺序执行
        await this.initRoleAndStore();
        this.loadTodayActivity();
        this.fetchList(true);
        this._navGuard = (0, navGuard_1.createNavGuard)({
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
        let roleInfo = authService_1.AuthService.getCachedRoleInfo();
        if (!roleInfo) {
            const result = await authService_1.AuthService.fetchUserRole();
            roleInfo = result.roleInfo || null;
        }
        const store = (0, storeManager_1.getSelectedStore)();
        const storeId = roleInfo?.storeId || store.storeId || '';
        const storeName = roleInfo?.storeName || store.storeName || '';
        const canManage = roleInfo?.role === 'store_manager' || roleInfo?.role === 'super_admin';
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
            const result = res.result;
            const existing = (result && result.success && result.data && result.data.length > 0) ? result.data[0] : null;
            if (existing) {
                existing.publishTimeStr = formatHHmm(existing.updateTime);
            }
            this.setData({ todayItem: existing });
            this.recomputeHistoryList();
        }
        catch (err) {
            console.error('[activity-log] loadTodayActivity 异常:', err);
            this.setData({ todayItem: null });
        }
        finally {
            this.setData({ todayLoading: false });
        }
    },
    // 「历史大事记」区域按 _id 排除顶部已展示的那一条，保留同一天的其余记录（活动大事记支持同日多条）
    recomputeHistoryList() {
        const todayId = this.data.todayItem ? this.data.todayItem._id : null;
        const historyList = todayId ? this.data.list.filter((item) => item._id !== todayId) : this.data.list;
        this.setData({ historyList });
    },
    async fetchList(reset) {
        if (reset) {
            this.setData({ page: 1, list: [], hasMore: true, loading: true });
        }
        else {
            if (!this.data.hasMore || this.data.loadingMore)
                return;
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
            const result = res.result;
            if (result && result.success) {
                const newList = reset ? (result.data || []) : this.data.list.concat(result.data || []);
                this.setData({
                    list: newList,
                    page: targetPage,
                    total: result.total || 0,
                    hasMore: !!result.hasMore
                });
                this.recomputeHistoryList();
            }
            else {
                wx.showToast({ title: result?.error || '加载失败', icon: 'none' });
            }
        }
        catch (err) {
            console.error('[activity-log] fetchList 异常:', err);
            wx.showToast({ title: '加载失败，请重试', icon: 'none' });
        }
        finally {
            this.setData({ loading: false, loadingMore: false });
        }
    },
    onReachBottom() {
        this.fetchList(false);
    },
    onPullDownRefresh() {
        this.fetchList(true).finally(() => wx.stopPullDownRefresh());
    },
    onOpenDetail(e) {
        const id = e.currentTarget.dataset.id;
        const item = this.data.list.find((r) => r._id === id);
        if (!item)
            return;
        this.setData({ showDetailModal: true, detailItem: item });
    },
    onCloseDetail() {
        this.setData({ showDetailModal: false, detailItem: null });
    },
    // 📌 顶部【编辑/追加今日大事记】按钮：今日已有记录则预填回显（更新模式），否则空白新建
    onOpenTodayEditForm() {
        if (!this.data.canManage)
            return;
        const item = this.data.todayItem;
        this.setData({
            showEditForm: true,
            editForm: {
                id: item ? item._id : '',
                title: item ? (item.title || '') : '',
                eventTime: this.data.todayDateStr,
                content: item ? (item.content || '') : '',
                images: item ? (item.images || []) : []
            }
        });
    },
    onOpenEditForm(e) {
        if (!this.data.canManage)
            return;
        const id = e.currentTarget.dataset.id;
        const item = this.data.list.find((r) => r._id === id);
        if (!item)
            return;
        this.setData({
            showEditForm: true,
            editForm: {
                id: item._id,
                title: item.title || '',
                eventTime: item.eventTime,
                content: item.content || '',
                images: item.images || []
            }
        });
    },
    onCloseEditForm() {
        this.setData({ showEditForm: false });
    },
    onEditTitleInput(e) {
        this.setData({ 'editForm.title': e.detail.value });
    },
    onEditTimeChange(e) {
        this.setData({ 'editForm.eventTime': e.detail.value });
    },
    onEditContentInput(e) {
        this.setData({ 'editForm.content': e.detail.value });
    },
    onRemoveImage(e) {
        const index = e.currentTarget.dataset.index;
        const images = [...this.data.editForm.images];
        images.splice(index, 1);
        this.setData({ 'editForm.images': images });
    },
    // 🖼️ 防爆空间：大事记最多 3 张配图
    async onChooseImage() {
        if (this.data.editForm.images.length >= 3) {
            wx.showToast({ title: '大事记最多上传 3 张配图', icon: 'none' });
            return;
        }
        try {
            const remainCount = 3 - this.data.editForm.images.length;
            const chooseRes = await wx.chooseMedia({
                count: remainCount,
                mediaType: ['image'],
                sourceType: ['album', 'camera']
            });
            const paths = (chooseRes.tempFiles || []).map(f => f.tempFilePath);
            if (paths.length === 0)
                return;
            this.setData({ uploading: true });
            wx.showLoading({ title: '图片压缩上传中...', mask: true });
            const uploaded = await (0, imageCompress_1.compressAndUploadImages)(CANVAS_ID, paths, `activity_logs/${this.data.currentStoreId}`);
            const images = [...this.data.editForm.images, ...uploaded];
            this.setData({ 'editForm.images': images });
            wx.hideLoading();
            this.setData({ uploading: false });
        }
        catch (err) {
            wx.hideLoading();
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
            const res = await wx.cloud.callFunction({
                name: 'manageActivityLog',
                data: {
                    action: id ? 'update' : 'create',
                    id,
                    storeId: this.data.currentStoreId,
                    title: title.trim(),
                    eventTime,
                    content: content.trim(),
                    images
                }
            });
            const result = res.result;
            wx.hideLoading();
            if (result && result.success) {
                wx.showToast({ title: result.message || '提交成功', icon: 'success' });
                this.setData({ showEditForm: false });
                // 提交的记录可能是今天（顶部区）或历史某天（下方区），两处都刷新一次以保持同步
                this.loadTodayActivity();
                this.fetchList(true);
            }
            else {
                wx.showModal({ title: '提交失败', content: result?.error || '未知错误', showCancel: false });
            }
        }
        catch (err) {
            wx.hideLoading();
            console.error('[activity-log] onSubmitEdit 异常:', err);
            wx.showToast({ title: '提交失败，请重试', icon: 'none' });
        }
    },
    onDeleteLog(e) {
        const id = e.currentTarget.dataset.id;
        if (!id)
            return;
        wx.showModal({
            title: '确认删除该记录？',
            content: '删除后不可恢复',
            confirmColor: '#D32F2F',
            success: async (res) => {
                if (!res.confirm)
                    return;
                wx.showLoading({ title: '删除中...', mask: true });
                try {
                    const cbRes = await wx.cloud.callFunction({
                        name: 'manageActivityLog',
                        data: { action: 'delete', id }
                    });
                    wx.hideLoading();
                    const result = cbRes.result;
                    if (result && result.success) {
                        wx.showToast({ title: '已删除', icon: 'success' });
                        this.setData({ showDetailModal: false });
                        this.loadTodayActivity();
                        this.fetchList(true);
                    }
                    else {
                        wx.showToast({ title: result?.error || '删除失败', icon: 'none' });
                    }
                }
                catch (err) {
                    wx.hideLoading();
                    console.error('[activity-log] onDeleteLog 异常:', err);
                    wx.showToast({ title: '删除失败，请重试', icon: 'none' });
                }
            }
        });
    },
    // 📤 导出活动海报：取该条大事记的标题/日期/首图/内容摘要绘制成可保存分享的海报图
    async onExportPoster(e) {
        const id = e.currentTarget.dataset.id;
        const item = this.data.list.find((r) => r._id === id) || this.data.historyList.find((r) => r._id === id);
        if (!item)
            return;
        this.setData({ showPosterModal: true, posterTargetItem: item, posterReady: false });
        wx.showLoading({ title: '正在生成海报...', mask: true });
        let photoTempPath = '';
        // 配图落库存的是云存储 fileID（cloud://...），需用 wx.cloud.downloadFile 而非 wx.downloadFile 下载
        if (item.images && item.images.length > 0) {
            try {
                const cloudRes = await wx.cloud.downloadFile({ fileID: item.images[0].url });
                photoTempPath = cloudRes.tempFilePath;
            }
            catch (cloudErr) {
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
                    await (0, drawActivityPoster_1.drawActivityPoster)({
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
                }
                catch (drawErr) {
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
            if (!res[0] || !res[0].node)
                return;
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
                                        if (r.confirm)
                                            wx.openSetting();
                                    }
                                });
                            }
                            else {
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
    onPreviewImage(e) {
        const url = e.currentTarget.dataset.url;
        const rawUrls = e.currentTarget.dataset.urls || [];
        if (!url)
            return;
        const urls = rawUrls.length > 0 && typeof rawUrls[0] === 'object'
            ? rawUrls.map((img) => img.url)
            : (rawUrls.length > 0 ? rawUrls : [url]);
        wx.previewImage({ current: url, urls });
    },
    stopPropagation() {
        // 阻止详情/编辑弹窗内部点击冒泡触发遮罩层关闭
    },
    goBack() {
        if (this._navGuard) {
            this._navGuard.goHome();
            return;
        }
        const pages = getCurrentPages();
        if (pages.length > 1) {
            wx.navigateBack();
        }
        else {
            wx.reLaunch({ url: '/pages/index/index' });
        }
    },
    onShareAppMessage() {
        const item = this.data.posterTargetItem;
        const store = this.data.currentStoreName || '雨花斋';
        if (item) {
            const cover = (item.images && item.images[0]) ? item.images[0].url : '';
            return {
                title: `📌【${store}】${item.title || '活动大事记'}`,
                path: '/pages/index/index',
                imageUrl: cover
            };
        }
        return {
            title: `📌【${store}】义工工作与活动大事记`,
            path: '/pages/index/index'
        };
    }
});
