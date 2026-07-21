"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dataService_1 = require("../../utils/dataService");
const authService_1 = require("../../utils/authService");
const util_1 = require("../../utils/util");
Page({
    isNavigating: false,
    data: {
        statusBarHeight: 20,
        navBarHeight: 44,
        loading: true,
        isManagerRole: false,
        isFinanceRole: false,
        isSuperAdmin: false,
        notifications: [],
        systemMessages: [
            {
                id: 'sys_welcome',
                icon: '📢',
                title: '欢迎使用雨花爱心餐报助手',
                desc: '门店账务变动、待您处理的审核事项都会汇总展示在这里'
            }
        ]
    },
    onLoad() {
        this.calculateNavBarHeight();
    },
    onShow() {
        this.isNavigating = false;
        this.initPermissions();
        this.loadNotifications();
        // 🌟 同步自定义 TabBar 高亮态（见 index.ts onShow 中的说明）
        if (typeof this.getTabBar === 'function' && this.getTabBar()) {
            this.getTabBar().setData({ selected: 1 });
        }
    },
    calculateNavBarHeight() {
        try {
            const sysInfo = (0, util_1.getSafeSystemInfo)();
            const statusBarHeight = sysInfo.statusBarHeight || 20;
            const menuButton = wx.getMenuButtonBoundingClientRect();
            let navBarHeight = 44;
            if (menuButton) {
                navBarHeight = (menuButton.top - statusBarHeight) * 2 + menuButton.height;
            }
            this.setData({
                statusBarHeight,
                navBarHeight: navBarHeight || 44
            });
        }
        catch (e) {
            console.warn('[notice] Calc height fallback:', e);
        }
    },
    initPermissions() {
        const cached = authService_1.AuthService.getCachedRoleInfo();
        const role = ((cached && cached.role) || wx.getStorageSync('current_user_role') || 'volunteer').toLowerCase();
        const isSuperAdmin = role === 'super_admin';
        const isManagerRole = role === 'store_manager' || isSuperAdmin;
        const isFinanceRole = role === 'finance' || isSuperAdmin;
        this.setData({ isManagerRole, isFinanceRole, isSuperAdmin });
    },
    async loadNotifications() {
        this.setData({ loading: true });
        try {
            const result = await dataService_1.DataService.getReports({ viewMode: 'all', limit: 50 });
            const list = (result.data || []).filter((item) => !item.isVoid);
            const notifications = list
                .map((item) => this.buildNotificationItem(item))
                .sort((a, b) => {
                if (a.actionable !== b.actionable)
                    return a.actionable ? -1 : 1;
                return (b.dateString || '').localeCompare(a.dateString || '');
            })
                .slice(0, 30);
            this.setData({ notifications, loading: false });
        }
        catch (err) {
            console.error('[notice] 加载通知失败:', err);
            this.setData({ loading: false });
        }
    },
    buildNotificationItem(item) {
        const { isManagerRole, isFinanceRole, isSuperAdmin } = this.data;
        const yesterdayBalance = parseFloat(item.yesterdayBalance || '0') || 0;
        const totalIncome = (parseFloat(item.otherDonation || '0') || 0) + (parseFloat(item.listDonationTotal || '0') || 0);
        const expenseAmount = parseFloat(item.expenseAmount || '0') || 0;
        const actualBalance = parseFloat(item.todayBalance ?? item.calculatedTodayBalance ?? '0') || 0;
        const expected = Math.round((yesterdayBalance + totalIncome - expenseAmount) * 100) / 100;
        const diff = Math.round((actualBalance - expected) * 100) / 100;
        const isMismatch = Math.abs(diff) >= 0.01;
        const status = item.approvalStatus || 'PENDING_APPROVAL';
        let icon = '📋';
        let tag = '';
        let desc = '';
        let actionable = false;
        if (status === 'PENDING_APPROVAL') {
            icon = '⏳';
            tag = '待店长确认';
            actionable = isManagerRole || isSuperAdmin;
            desc = actionable ? '请核对当日账目并确认' : '等待店长核对确认';
        }
        else if (status === 'APPROVED') {
            icon = '🔒';
            tag = '待财务稽核';
            actionable = isFinanceRole || isSuperAdmin;
            desc = actionable ? '请完成稽核并封账' : '店长已确认，等待财务稽核';
        }
        else if (status === 'AUDITED_LOCKED') {
            icon = '✅';
            tag = '已封账归档';
            actionable = false;
            desc = `稽核人：${item.auditedBy || '财务'}`;
        }
        if (isMismatch) {
            icon = '⚠️';
            tag = tag ? `${tag} · 资金不平` : '资金不平';
            actionable = actionable || isManagerRole || isFinanceRole || isSuperAdmin;
        }
        return {
            id: item._id || item._localId || `${item.shopName}_${item.dateString}`,
            dateString: item.dateString || item.reportDate || '',
            shopName: item.shopName || '未命名门店',
            icon,
            tag,
            desc,
            actionable,
            isMismatch
        };
    },
    onTapNotification() {
        if (this.isNavigating)
            return;
        this.isNavigating = true;
        wx.navigateTo({
            url: '/pages/history/history',
            fail: () => {
                this.isNavigating = false;
            }
        });
    }
});
