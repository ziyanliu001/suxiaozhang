"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const authService_1 = require("../../utils/authService");
const navGuard_1 = require("../../utils/navGuard");
Page({
    _navGuard: null,
    data: {
        navTop: 0,
        contentTop: 0,
        checkedAccess: false,
        isSuperAdmin: false,
        loading: false,
        list: [],
        showRenameModal: false,
        renameForm: {
            storeId: '',
            oldName: '',
            newName: ''
        },
        submitting: false
    },
    onLoad() {
        this.calculateNavBarHeight();
        this.checkAccess();
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
    async checkAccess() {
        let cached = authService_1.AuthService.getCachedRoleInfo();
        if (!cached) {
            const result = await authService_1.AuthService.fetchUserRole();
            cached = result.roleInfo || null;
        }
        const isSuperAdmin = cached?.role === 'super_admin';
        this.setData({ checkedAccess: true, isSuperAdmin });
        if (isSuperAdmin) {
            this.loadStoreList();
        }
    },
    async loadStoreList() {
        this.setData({ loading: true });
        try {
            const res = await wx.cloud.callFunction({ name: 'getStoreList' });
            const result = res.result;
            if (result && result.success) {
                this.setData({ list: result.list || [] });
            }
            else {
                wx.showToast({ title: result?.error || '门店列表加载失败', icon: 'none' });
            }
        }
        catch (err) {
            console.error('[store-management] loadStoreList 异常:', err);
            wx.showToast({ title: '门店列表加载异常', icon: 'none' });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    onPullDownRefresh() {
        this.loadStoreList().finally(() => wx.stopPullDownRefresh());
    },
    onOpenRename(e) {
        const { storeid, storename } = e.currentTarget.dataset;
        this.setData({
            showRenameModal: true,
            renameForm: { storeId: storeid, oldName: storename, newName: storename }
        });
    },
    onCloseRename() {
        if (this.data.submitting)
            return;
        this.setData({ showRenameModal: false });
    },
    onRenameInput(e) {
        this.setData({ 'renameForm.newName': e.detail.value });
    },
    async onSubmitRename() {
        const { storeId, oldName, newName } = this.data.renameForm;
        const trimmed = (newName || '').trim();
        if (!trimmed) {
            wx.showToast({ title: '请输入新的门店名称', icon: 'none' });
            return;
        }
        if (trimmed === oldName) {
            wx.showToast({ title: '名称未发生变化', icon: 'none' });
            return;
        }
        this.setData({ submitting: true });
        wx.showLoading({ title: '提交中...', mask: true });
        try {
            const res = await wx.cloud.callFunction({
                name: 'updateStoreName',
                data: { storeId, newStoreName: trimmed }
            });
            const result = res.result;
            wx.hideLoading();
            this.setData({ submitting: false });
            if (result && result.success) {
                const updatedName = result.storeName || trimmed;
                const list = this.data.list.map((item) => item.storeId === storeId ? { ...item, storeName: updatedName } : item);
                this.setData({ list, showRenameModal: false });
                wx.showToast({ title: '门店名称已更新', icon: 'success' });
            }
            else {
                wx.showToast({ title: result?.error || '修改失败', icon: 'none' });
            }
        }
        catch (err) {
            wx.hideLoading();
            this.setData({ submitting: false });
            console.error('[store-management] onSubmitRename 异常:', err);
            wx.showToast({ title: '修改失败，请重试', icon: 'none' });
        }
    },
    stopPropagation() {
        // 阻止弹窗内部点击冒泡触发遮罩层关闭
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
