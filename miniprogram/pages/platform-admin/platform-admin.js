"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const authService_1 = require("../../utils/authService");
const navGuard_1 = require("../../utils/navGuard");
const PLAN_LABELS = {
    basic: '基础版',
    pro: '专业版',
    enterprise: '旗舰版'
};
Page({
    _navGuard: null,
    data: {
        navTop: 0,
        contentTop: 0,
        checkedAccess: false,
        isPlatformAdmin: false,
        loading: false,
        overview: null,
        tenants: [],
        planLabels: PLAN_LABELS,
        showCreateForm: false,
        createForm: { name: '', contactName: '', contactPhone: '' },
        showRenewForm: false,
        renewForm: {
            tenantId: '',
            tenantName: '',
            planType: 'basic',
            serviceStartDate: '',
            serviceExpireDate: '',
            storeLimit: '',
            reason: ''
        }
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
        const isPlatformAdmin = cached?.role === 'platform_admin';
        this.setData({ checkedAccess: true, isPlatformAdmin });
        if (isPlatformAdmin) {
            this.loadOverview();
            this.loadTenants();
        }
    },
    async loadOverview() {
        try {
            const res = await wx.cloud.callFunction({ name: 'getPlatformOverview' });
            const result = res.result;
            if (result && result.success) {
                this.setData({ overview: result });
            }
            else {
                wx.showToast({ title: result?.error || '概览加载失败', icon: 'none' });
            }
        }
        catch (err) {
            console.error('[platform-admin] loadOverview 异常:', err);
            wx.showToast({ title: '概览加载异常', icon: 'none' });
        }
    },
    async loadTenants() {
        this.setData({ loading: true });
        try {
            const res = await wx.cloud.callFunction({
                name: 'manageTenantSubscription',
                data: { action: 'listTenants' }
            });
            const result = res.result;
            if (result && result.success) {
                this.setData({ tenants: result.tenants || [] });
            }
            else {
                wx.showToast({ title: result?.error || '机构列表加载失败', icon: 'none' });
            }
        }
        catch (err) {
            console.error('[platform-admin] loadTenants 异常:', err);
            wx.showToast({ title: '机构列表加载异常', icon: 'none' });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    onToggleCreateForm() {
        this.setData({ showCreateForm: !this.data.showCreateForm });
    },
    onCreateFormInput(e) {
        const field = e.currentTarget.dataset.field;
        this.setData({ [`createForm.${field}`]: e.detail.value });
    },
    async onSubmitCreateTenant() {
        const { name, contactName, contactPhone } = this.data.createForm;
        if (!name || !name.trim()) {
            wx.showToast({ title: '请填写机构名称', icon: 'none' });
            return;
        }
        wx.showLoading({ title: '创建中...', mask: true });
        try {
            const res = await wx.cloud.callFunction({
                name: 'manageTenantSubscription',
                data: { action: 'createTenant', name, contactName, contactPhone }
            });
            wx.hideLoading();
            const result = res.result;
            if (result && result.success) {
                wx.showToast({ title: '机构创建成功', icon: 'success' });
                this.setData({
                    showCreateForm: false,
                    createForm: { name: '', contactName: '', contactPhone: '' }
                });
                this.loadTenants();
                this.loadOverview();
            }
            else {
                wx.showModal({ title: '创建失败', content: result?.error || '未知错误', showCancel: false });
            }
        }
        catch (err) {
            wx.hideLoading();
            console.error('[platform-admin] createTenant 异常:', err);
            wx.showModal({ title: '调用失败', content: '请确认 manageTenantSubscription 云函数已部署', showCancel: false });
        }
    },
    onOpenRenewForm(e) {
        const { tenantid, tenantname } = e.currentTarget.dataset;
        const todayStr = new Date().toISOString().slice(0, 10);
        const nextYear = new Date();
        nextYear.setFullYear(nextYear.getFullYear() + 1);
        this.setData({
            showRenewForm: true,
            renewForm: {
                tenantId: tenantid,
                tenantName: tenantname,
                planType: 'basic',
                serviceStartDate: todayStr,
                serviceExpireDate: nextYear.toISOString().slice(0, 10),
                storeLimit: '5',
                reason: ''
            }
        });
    },
    onCloseRenewForm() {
        this.setData({ showRenewForm: false });
    },
    onRenewFormInput(e) {
        const field = e.currentTarget.dataset.field;
        this.setData({ [`renewForm.${field}`]: e.detail.value });
    },
    onSelectPlan(e) {
        const plan = e.currentTarget.dataset.plan;
        this.setData({ 'renewForm.planType': plan });
    },
    async onSubmitRenew() {
        const { tenantId, planType, serviceStartDate, serviceExpireDate, storeLimit, reason } = this.data.renewForm;
        if (!reason || !reason.trim()) {
            wx.showToast({ title: '请填写开通/续费原因', icon: 'none' });
            return;
        }
        if (!serviceStartDate || !serviceExpireDate) {
            wx.showToast({ title: '请填写服务起止日期', icon: 'none' });
            return;
        }
        wx.showLoading({ title: '提交中...', mask: true });
        try {
            const res = await wx.cloud.callFunction({
                name: 'manageTenantSubscription',
                data: {
                    action: 'createOrRenewSubscription',
                    tenantId,
                    planType,
                    serviceStartDate,
                    serviceExpireDate,
                    cloudQuota: { storeLimit: parseInt(storeLimit, 10) || 5 },
                    reason
                }
            });
            wx.hideLoading();
            const result = res.result;
            if (result && result.success) {
                wx.showToast({ title: '订阅已更新', icon: 'success' });
                this.setData({ showRenewForm: false });
                this.loadTenants();
                this.loadOverview();
            }
            else {
                wx.showModal({ title: '操作失败', content: result?.error || '未知错误', showCancel: false });
            }
        }
        catch (err) {
            wx.hideLoading();
            console.error('[platform-admin] renew 异常:', err);
            wx.showModal({ title: '调用失败', content: '请确认 manageTenantSubscription 云函数已部署', showCancel: false });
        }
    },
    onToggleTenantStatus(e) {
        const { tenantid, currentstatus } = e.currentTarget.dataset;
        const nextStatus = currentstatus === 'suspended' ? 'active' : 'suspended';
        const actionLabel = nextStatus === 'suspended' ? '暂停' : '恢复';
        wx.showModal({
            title: `确认${actionLabel}该机构服务？`,
            editable: true,
            placeholderText: `请填写${actionLabel}原因`,
            confirmText: '确认',
            success: async (res) => {
                if (!res.confirm)
                    return;
                const reason = String(res.content || '').trim();
                if (!reason) {
                    wx.showToast({ title: '请填写原因', icon: 'none' });
                    return;
                }
                wx.showLoading({ title: '处理中...', mask: true });
                try {
                    const cbRes = await wx.cloud.callFunction({
                        name: 'manageTenantSubscription',
                        data: { action: 'updateTenantStatus', tenantId: tenantid, status: nextStatus, reason }
                    });
                    wx.hideLoading();
                    const result = cbRes.result;
                    if (result && result.success) {
                        wx.showToast({ title: `已${actionLabel}`, icon: 'success' });
                        this.loadTenants();
                    }
                    else {
                        wx.showModal({ title: '操作失败', content: result?.error || '未知错误', showCancel: false });
                    }
                }
                catch (err) {
                    wx.hideLoading();
                    console.error('[platform-admin] updateTenantStatus 异常:', err);
                }
            }
        });
    },
    noop() {
        // 用于阻止弹窗内部点击事件冒泡触发遮罩层的关闭逻辑
    },
    onGoBack() {
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
