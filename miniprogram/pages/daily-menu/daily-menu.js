"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const authService_1 = require("../../utils/authService");
const storeManager_1 = require("../../utils/storeManager");
const imageCompress_1 = require("../../utils/imageCompress");
const navGuard_1 = require("../../utils/navGuard");
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
        // 🍱 今日食谱（顶部高亮区）
        todayDateStr: getTodayStr(),
        todayItem: null,
        todayLoading: false,
        // 📚 历史食谱（下方时间轴，不含今天，避免与顶部重复展示）
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
            dateString: getTodayStr(),
            menuText: '',
            images: []
        },
        uploading: false
    },
    async onLoad() {
        this.calculateNavBarHeight();
        // 🔑 需先拿到 currentStoreId 再查今日食谱（getByDate 要求 storeId 必填），故此处 await 顺序执行
        await this.initRoleAndStore();
        this.loadTodayMenu();
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
            const result = res.result;
            const item = (result && result.success) ? result.data : null;
            if (item) {
                item.publishTimeStr = formatHHmm(item.updateTime);
            }
            this.setData({ todayItem: item });
        }
        catch (err) {
            console.error('[daily-menu] loadTodayMenu 异常:', err);
            this.setData({ todayItem: null });
        }
        finally {
            this.setData({ todayLoading: false });
        }
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
                name: 'manageDailyMenu',
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
                // 「历史食谱」区域不重复展示今天（今天已在顶部高亮区单独呈现）
                const historyList = newList.filter((item) => item.dateString !== this.data.todayDateStr);
                this.setData({
                    list: newList,
                    historyList,
                    page: targetPage,
                    total: result.total || 0,
                    hasMore: !!result.hasMore
                });
            }
            else {
                wx.showToast({ title: result?.error || '加载失败', icon: 'none' });
            }
        }
        catch (err) {
            console.error('[daily-menu] fetchList 异常:', err);
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
    // 详情懒加载：仅在点击时才展示原图（此前列表只渲染压缩缩略图）
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
    // 🍱 顶部【编辑/发布今日食谱】按钮：今日已发布则预填回显（更新模式），否则空白新建
    onOpenTodayEditForm() {
        if (!this.data.canManage)
            return;
        const item = this.data.todayItem;
        this.setData({
            showEditForm: true,
            editForm: {
                id: item ? item._id : '',
                dateString: this.data.todayDateStr,
                menuText: item ? (item.menuText || '') : '',
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
                dateString: item.dateString,
                menuText: item.menuText || '',
                images: item.images || []
            }
        });
    },
    onCloseEditForm() {
        this.setData({ showEditForm: false });
    },
    onEditDateChange(e) {
        this.setData({ 'editForm.dateString': e.detail.value });
    },
    onEditTextInput(e) {
        this.setData({ 'editForm.menuText': e.detail.value });
    },
    onRemoveImage(e) {
        const index = e.currentTarget.dataset.index;
        const images = [...this.data.editForm.images];
        images.splice(index, 1);
        this.setData({ 'editForm.images': images });
    },
    // 🖼️ 防爆空间：今日食谱最多 1 张配图
    async onChooseImage() {
        if (this.data.editForm.images.length >= 1) {
            wx.showToast({ title: '食谱最多上传 1 张配图', icon: 'none' });
            return;
        }
        try {
            const chooseRes = await wx.chooseMedia({
                count: 1 - this.data.editForm.images.length,
                mediaType: ['image'],
                sourceType: ['album', 'camera']
            });
            const paths = (chooseRes.tempFiles || []).map(f => f.tempFilePath);
            if (paths.length === 0)
                return;
            this.setData({ uploading: true });
            wx.showLoading({ title: '图片压缩上传中...', mask: true });
            // 逐张压缩上传：控制单张 ≤300KB / 长边 ≤1920px，并生成列表懒加载用的缩略图
            const uploaded = await (0, imageCompress_1.compressAndUploadImages)(CANVAS_ID, paths, `daily_menus/${this.data.currentStoreId}`);
            const images = [...this.data.editForm.images, ...uploaded];
            this.setData({ 'editForm.images': images });
            wx.hideLoading();
            this.setData({ uploading: false });
        }
        catch (err) {
            wx.hideLoading();
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
            const res = await wx.cloud.callFunction({
                name: 'manageDailyMenu',
                data: {
                    action: id ? 'update' : 'create',
                    id,
                    storeId: this.data.currentStoreId,
                    dateString,
                    menuText: menuText.trim(),
                    images
                }
            });
            const result = res.result;
            wx.hideLoading();
            if (result && result.success) {
                wx.showToast({ title: result.message || '提交成功', icon: 'success' });
                this.setData({ showEditForm: false });
                // 提交的记录可能是今天（顶部区）或历史某天（下方区），两处都刷新一次以保持同步
                this.loadTodayMenu();
                this.fetchList(true);
            }
            else {
                wx.showModal({ title: '提交失败', content: result?.error || '未知错误', showCancel: false });
            }
        }
        catch (err) {
            wx.hideLoading();
            console.error('[daily-menu] onSubmitEdit 异常:', err);
            wx.showToast({ title: '提交失败，请重试', icon: 'none' });
        }
    },
    onDeleteMenu(e) {
        const id = e.currentTarget.dataset.id;
        if (!id)
            return;
        wx.showModal({
            title: '确认删除该菜单？',
            content: '删除后不可恢复',
            confirmColor: '#D32F2F',
            success: async (res) => {
                if (!res.confirm)
                    return;
                wx.showLoading({ title: '删除中...', mask: true });
                try {
                    const cbRes = await wx.cloud.callFunction({
                        name: 'manageDailyMenu',
                        data: { action: 'delete', id }
                    });
                    wx.hideLoading();
                    const result = cbRes.result;
                    if (result && result.success) {
                        wx.showToast({ title: '已删除', icon: 'success' });
                        this.setData({ showDetailModal: false });
                        this.loadTodayMenu();
                        this.fetchList(true);
                    }
                    else {
                        wx.showToast({ title: result?.error || '删除失败', icon: 'none' });
                    }
                }
                catch (err) {
                    wx.hideLoading();
                    console.error('[daily-menu] onDeleteMenu 异常:', err);
                    wx.showToast({ title: '删除失败，请重试', icon: 'none' });
                }
            }
        });
    },
    // ✨ 一键复用为今日食谱：将历史食谱的菜名明细与配图直接带入今日食谱编辑框（同页内操作，无需跳转）
    onReuseToToday(e) {
        if (!this.data.canManage)
            return;
        const id = e.currentTarget.dataset.id;
        const item = this.data.list.find((r) => r._id === id);
        if (!item)
            return;
        wx.showModal({
            title: '一键复用为今日食谱',
            content: `将把【${item.dateString}】的菜品明细与配图带入今日食谱编辑框，确认后可微调再发布，是否继续？`,
            confirmText: '去确认发布',
            success: (res) => {
                if (!res.confirm)
                    return;
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
    onPreviewImage(e) {
        const url = e.currentTarget.dataset.url;
        const rawUrls = e.currentTarget.dataset.urls || [];
        if (!url)
            return;
        // data-urls 绑定的是 {url, thumbUrl} 对象数组，wx.previewImage 需要纯字符串数组
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
    }
});
