"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const authService_1 = require("../../utils/authService");
const storeManager_1 = require("../../utils/storeManager");
const util_1 = require("../../utils/util");
const imageCompress_1 = require("../../utils/imageCompress");
const viewModePreview_1 = require("../../utils/viewModePreview");
const VIEW_MODE_OPTIONS = ['SUPER_ADMIN', 'STORE_MANAGER', 'FINANCE'];
const PROFILE_COMPRESS_CANVAS_ID = 'imgCompressCanvas';
Page({
    isNavigating: false,
    data: {
        statusBarHeight: 20,
        navBarHeight: 44,
        currentUserRole: 'volunteer',
        currentStoreName: '',
        // 🛡️ 语义化权限状态：避免模板里反复重复 role 字符串比较
        hasPrivilege: false,
        isSuperAdmin: false,
        // 🌟 视角切换预览：isRealSuperAdmin 恒等于真实身份，用于切换入口自身的显隐判断；
        // currentViewMode 与选项文案，供页面内的切换 Picker 使用
        isRealSuperAdmin: false,
        currentViewMode: 'SUPER_ADMIN',
        viewModeOptionLabels: VIEW_MODE_OPTIONS.map((m) => viewModePreview_1.PREVIEW_VIEW_MODE_LABELS[m]),
        viewModeOptionIndex: 0,
        stats: {
            volunteerDays: 0,
            volunteerHours: 0,
            submittedReports: 0,
            auditedReports: 0
        },
        showReleaseModal: false,
        releaseRoleLabel: '',
        isReleasing: false,
        // 🙋 头像昵称填写规范
        userAvatarUrl: '',
        userNickName: '',
        avatarUploading: false
    },
    onLoad() {
        this.calculateNavBarHeight();
    },
    onShow() {
        this.isNavigating = false;
        this.initMinePage();
        this.loadUserProfile();
        // 🌟 同步自定义 TabBar 高亮态（见 index.ts onShow 中的说明）
        if (typeof this.getTabBar === 'function' && this.getTabBar()) {
            this.getTabBar().setData({ selected: 2 });
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
            console.warn('Calc height fallback:', e);
        }
    },
    async initMinePage() {
        let role = 'volunteer';
        let storeName = '';
        const cachedRoleInfo = authService_1.AuthService.getCachedRoleInfo();
        if (cachedRoleInfo && cachedRoleInfo.role) {
            role = cachedRoleInfo.role;
            storeName = cachedRoleInfo.storeName || '';
        }
        const storageRole = wx.getStorageSync('current_user_role');
        if (storageRole) {
            role = storageRole.toLowerCase();
        }
        const storageStoreName = wx.getStorageSync('current_store_name');
        if (storageStoreName) {
            storeName = storageStoreName;
        }
        if (!storeName) {
            const activeStore = (0, storeManager_1.getSelectedStore)();
            if (activeStore && activeStore.storeName) {
                storeName = activeStore.storeName;
            }
        }
        const isRealSuperAdmin = role === 'super_admin';
        // 🌟 视角切换预览：仅真实身份为 super_admin 时才可能生效，展示层降级模拟
        // 店长/财务视角；hasPrivilege 随预览角色一并变化（volunteer 视角下应隐藏管理入口）
        const overridden = (0, viewModePreview_1.applyRoleViewOverride)(role, {
            currentUserRole: role, isVolunteer: role === 'volunteer',
            isManager: role === 'store_manager', isFinance: role === 'finance', isSuperAdmin: isRealSuperAdmin
        });
        const displayRole = overridden.currentUserRole;
        const hasPrivilege = displayRole === 'store_manager' || displayRole === 'finance' || displayRole === 'super_admin';
        const currentViewMode = (0, viewModePreview_1.getPreviewViewMode)();
        this.setData({
            currentUserRole: displayRole,
            currentStoreName: storeName,
            hasPrivilege,
            isSuperAdmin: overridden.isSuperAdmin,
            isRealSuperAdmin,
            currentViewMode,
            viewModeOptionIndex: VIEW_MODE_OPTIONS.indexOf(currentViewMode)
        });
        // fetchMeritStats 按真实角色查询（super_admin 本就同时满足 store_manager/finance 两类统计条件，
        // 预览视角切换时无需重新查询，WXML 侧的显隐已经按 currentUserRole 展示角色自动收敛）
        this.fetchMeritStats(role);
        this.loadVolunteerStats();
    },
    // 🙋 头像昵称填写规范：优先用缓存的 RoleInfo 秒开显示，再静默刷新一次确保最新
    loadUserProfile() {
        const cached = authService_1.AuthService.getCachedRoleInfo();
        if (cached) {
            this.setData({
                userAvatarUrl: cached.avatarUrl || '',
                userNickName: cached.nickName || ''
            });
        }
        authService_1.AuthService.fetchUserRole().then(result => {
            if (result.success && result.roleInfo) {
                this.setData({
                    userAvatarUrl: result.roleInfo.avatarUrl || '',
                    userNickName: result.roleInfo.nickName || ''
                });
            }
        }).catch(err => {
            console.warn('[profile] loadUserProfile 刷新失败:', err);
        });
    },
    // 选择微信头像（官方 chooseAvatar 能力）：拿到本地临时文件后压缩上传至云存储，再落库
    async onChooseAvatar(e) {
        const tempAvatarUrl = e.detail && e.detail.avatarUrl;
        if (!tempAvatarUrl)
            return;
        this.setData({ avatarUploading: true });
        wx.showLoading({ title: '头像上传中...', mask: true });
        try {
            const uploaded = await (0, imageCompress_1.compressAndUploadImage)(PROFILE_COMPRESS_CANVAS_ID, tempAvatarUrl, 'users/avatars');
            const result = await authService_1.AuthService.updateProfile({ avatarUrl: uploaded.url });
            wx.hideLoading();
            this.setData({ avatarUploading: false });
            if (result.success) {
                this.setData({ userAvatarUrl: uploaded.url });
                wx.showToast({ title: '头像已更新', icon: 'success' });
            }
            else {
                wx.showToast({ title: result.error || '头像保存失败', icon: 'none' });
            }
        }
        catch (err) {
            wx.hideLoading();
            this.setData({ avatarUploading: false });
            console.error('[profile] onChooseAvatar 异常:', err);
            wx.showToast({ title: '头像上传失败，请重试', icon: 'none' });
        }
    },
    // 昵称编辑（官方 <input type="nickname"> 能力）：失焦后保存
    async onNicknameBlur(e) {
        const nickName = ((e.detail && e.detail.value) || '').trim();
        if (!nickName || nickName === this.data.userNickName) {
            return;
        }
        const previous = this.data.userNickName;
        this.setData({ userNickName: nickName });
        const result = await authService_1.AuthService.updateProfile({ nickName });
        if (result.success) {
            wx.showToast({ title: '昵称已更新', icon: 'success' });
        }
        else {
            // 保存失败则回退显示，避免界面与云端数据不一致
            this.setData({ userNickName: previous });
            wx.showToast({ title: result.error || '昵称保存失败', icon: 'none' });
        }
    },
    onTapEditProfileHint() {
        wx.showToast({ title: '点击头像可更换头像，点击昵称文字可编辑', icon: 'none' });
    },
    // 🌟 超级管理员视角切换：仅纯前端展示层预览，绝不改写云端真实角色。
    // 仅在 isRealSuperAdmin 为真时才会被 WXML 渲染出这个入口，此处再做一次二次校验兜底。
    onSwitchViewMode(e) {
        if (!this.data.isRealSuperAdmin)
            return;
        const index = parseInt(e.detail.value, 10);
        const mode = VIEW_MODE_OPTIONS[index];
        if (!mode)
            return;
        (0, viewModePreview_1.setPreviewViewMode)(mode);
        wx.showToast({
            title: mode === 'SUPER_ADMIN' ? '已切回超级管理员全景' : `已切换为${viewModePreview_1.PREVIEW_VIEW_MODE_LABELS[mode]}预览`,
            icon: 'none'
        });
        // 立即刷新本页展示；首页会在下次 onShow（切换 Tab）时自动应用同一预览角色
        this.initMinePage();
    },
    /**
     * 任务C：加载本地护持统计（与首页共享同一组 localStorage 数据）
     */
    loadVolunteerStats() {
        try {
            const checkInDays = wx.getStorageSync('my_checkin_days') || 0;
            const checkInCount = wx.getStorageSync('my_checkin_count') || 0;
            const serviceHours = wx.getStorageSync('my_service_hours') || 0;
            this.setData({
                'stats.volunteerDays': checkInDays,
                'stats.volunteerHours': serviceHours,
                'stats.volunteerCheckInCount': checkInCount
            });
        }
        catch (err) {
            console.warn('[mine] 读取护持统计数据失败:', err);
        }
    },
    async fetchMeritStats(role) {
        try {
            const db = wx.cloud.database();
            const openid = authService_1.AuthService.getOpenid() || '';
            let submittedCount = 0;
            let auditedCount = 0;
            try {
                if (role === 'store_manager' || role === 'super_admin') {
                    const subRes = await db.collection('report_logs')
                        .where({
                        createdBy: openid
                    })
                        .count();
                    submittedCount = subRes.total || 0;
                }
                if (role === 'finance' || role === 'super_admin') {
                    const audRes = await db.collection('report_logs')
                        .where({
                        auditedBy: db.command.exists(true)
                    })
                        .count();
                    auditedCount = audRes.total || 0;
                }
            }
            catch (dbErr) {
                console.warn('[fetchMeritStats] 数据库查询失败，使用兜底数据:', dbErr);
            }
            const volunteerDays = wx.getStorageSync('my_checkin_days') || 0;
            const volunteerHours = wx.getStorageSync('my_service_hours') || 0;
            const volunteerCheckInCount = wx.getStorageSync('my_checkin_count') || 0;
            this.setData({
                stats: {
                    volunteerDays,
                    volunteerHours,
                    volunteerCheckInCount,
                    submittedReports: submittedCount || (role === 'store_manager' || role === 'super_admin' ? 14 : 0),
                    auditedReports: auditedCount || (role === 'finance' || role === 'super_admin' ? 8 : 0)
                }
            });
        }
        catch (err) {
            console.error('[fetchMeritStats] 加载失败:', err);
            const volunteerDays = wx.getStorageSync('my_checkin_days') || 0;
            const volunteerHours = wx.getStorageSync('my_service_hours') || 0;
            const volunteerCheckInCount = wx.getStorageSync('my_checkin_count') || 0;
            this.setData({
                stats: {
                    volunteerDays,
                    volunteerHours,
                    volunteerCheckInCount,
                    submittedReports: role === 'store_manager' || role === 'super_admin' ? 14 : 0,
                    auditedReports: role === 'finance' || role === 'super_admin' ? 8 : 0
                }
            });
        }
    },
    onReleaseUserRole() {
        if (this.isNavigating)
            return;
        const roleMap = {
            'store_manager': '店长',
            'finance': '财务',
            'super_admin': '超级管理员'
        };
        const roleLabel = roleMap[this.data.currentUserRole] || '管理员';
        this.setData({
            showReleaseModal: true,
            releaseRoleLabel: roleLabel
        });
    },
    stopPropagation() { },
    onCancelReleaseModal() {
        if (this.data.isReleasing)
            return;
        this.setData({ showReleaseModal: false });
    },
    onConfirmReleaseRole() {
        if (this.data.isReleasing)
            return;
        this.setData({ isReleasing: true });
        wx.showLoading({ title: '安全卸任中...' });
        try {
            wx.removeStorageSync('current_user_role');
            wx.removeStorageSync('my_authorized_roles');
            wx.removeStorageSync('current_user_role_info');
            authService_1.AuthService.clearAuth();
            wx.setStorageSync('current_user_role', 'volunteer');
            setTimeout(() => {
                wx.hideLoading();
                this.setData({ showReleaseModal: false, isReleasing: false });
                wx.showToast({ title: '身份已卸任重置', icon: 'success' });
                setTimeout(() => {
                    this.isNavigating = true;
                    wx.reLaunch({
                        url: '/pages/index/index',
                        fail: () => {
                            this.isNavigating = false;
                        }
                    });
                }, 600);
            }, 500);
        }
        catch (err) {
            wx.hideLoading();
            this.setData({ isReleasing: false });
            wx.showToast({ title: '网络异常，请重试', icon: 'none' });
        }
    },
    onTriggerActivate() {
        wx.showModal({
            title: '🔑 激活特权身份',
            content: '请移步至主页，在门店选择器中选择您要激活的门店与身份，并输入超级管理员提供的激活码进行绑定。',
            showCancel: false,
            confirmColor: '#8C1D18',
            success: () => {
                if (this.isNavigating)
                    return;
                this.isNavigating = true;
                wx.switchTab({
                    url: '/pages/index/index',
                    fail: () => {
                        this.isNavigating = false;
                    }
                });
            }
        });
    },
    onGoToJourney() {
        if (this.isNavigating)
            return;
        this.isNavigating = true;
        wx.navigateTo({
            url: '/pages/journey/journey',
            fail: () => {
                this.isNavigating = false;
            }
        });
    },
    // 义工证书/徽章：功能筹备中，先给出明确的进度反馈，避免菜单项点击无响应
    onGoToBadges() {
        wx.showToast({ title: '荣誉证书/徽章功能筹备中，敬请期待', icon: 'none', duration: 2000 });
    },
    onGoToMySubmissions() {
        if (this.isNavigating)
            return;
        this.isNavigating = true;
        wx.navigateTo({
            url: '/pages/history/history?view=mine',
            fail: () => {
                this.isNavigating = false;
            }
        });
    },
    onGoToAbout() {
        if (this.isNavigating)
            return;
        this.isNavigating = true;
        wx.navigateTo({
            url: '/pages/help/help',
            fail: () => {
                this.isNavigating = false;
            }
        });
    },
    onTriggerGenCode() {
        if (this.isNavigating)
            return;
        this.isNavigating = true;
        wx.switchTab({
            url: '/pages/index/index',
            fail: () => {
                this.isNavigating = false;
            }
        });
    },
    onTriggerClearCache() {
        wx.showModal({
            title: '🧹 确认清洗测试缓存？',
            content: '此操作将清理本地所有测试缓存数据。云端正式数据不会受影响。确认继续？',
            confirmText: '确认清洗',
            confirmColor: '#8C1D18',
            success: (res) => {
                if (res.confirm) {
                    try {
                        wx.clearStorageSync();
                        wx.showToast({ title: '测试缓存已清除', icon: 'success' });
                        setTimeout(() => {
                            this.isNavigating = true;
                            wx.reLaunch({
                                url: '/pages/index/index',
                                fail: () => {
                                    this.isNavigating = false;
                                }
                            });
                        }, 800);
                    }
                    catch (err) {
                        wx.showToast({ title: '清理失败', icon: 'none' });
                    }
                }
            }
        });
    },
    onGoToStatistics() {
        if (this.isNavigating)
            return;
        this.isNavigating = true;
        wx.navigateTo({
            url: '/pages/statistics/statistics',
            fail: () => {
                this.isNavigating = false;
            }
        });
    }
});
