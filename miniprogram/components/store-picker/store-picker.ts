import { AuthService } from '../../utils/authService';

// 🛡️ user_roles 集合里"角色审核通过"的真实哨兵值是 'approved'（见 processRoleAudit /
// setupSuperAdmin 云函数落库逻辑），而不是 'active'（那是 stores 集合门店启停用的哨兵值）——
// 全国总览入口必须同时满足 role==='super_admin' 且 status==='approved' 才展示，
// 避免已被降级/尚未审核通过、但 user_roles 文档 role 字段仍残留 'super_admin' 的账号越权可见
function isVerifiedSuperAdmin(roleInfo: { role?: string; status?: string } | null | undefined): boolean {
  return !!(roleInfo && roleInfo.role === 'super_admin' && roleInfo.status === 'approved');
}

Component({
  properties: {},

  data: {
    showPickerSheet: false,
    showAuthModal: false,
    authTab: 'CODE',
    authCodeInput: '',
    applicantNameInput: '',
    targetAuthStoreId: '',
    targetAuthStoreName: '',
    targetAuthRole: '',
    targetAuthRoleLabel: '',
    // ➕ "找不到门店？申请新建/加入新门店" 入口表单状态
    showNewStoreForm: false,
    newStoreForm: {
      customStoreName: '',
      applyRole: 'volunteer' as 'store_manager' | 'finance' | 'volunteer'
    },
    currentStore: {
      storeId: 'haicang_yuhuazhai',
      storeName: '海沧区雨花斋',
      role: 'VOLUNTEER' as 'MANAGER' | 'FINANCE' | 'VOLUNTEER' | 'ADMIN'
    },
    // WXML 表达式不支持字符串下标 name[0]，胶囊头像的首字改由 observers 算好后绑定展示
    storeInitial: '海',
    // 🐛 曾经是写死的 3 条演示数据（海沧区雨花斋/湖里区雨花斋/全国总览），导致超管新建的
    // 门店永远不会出现在这里——现改为 onOpenSheet() 时向 getStoreList 云函数活查询。
    // 🛡️ 权限隔离：默认不再预置"全国总览"虚拟入口——是否插入该条目取决于当前账号是否为
    // 已审核通过的 super_admin，由 fetchStoreListFromCloud() 按真实角色动态决定，
    // 确保面板首次渲染（网络请求返回前）也不会对非超管账号闪现该选项
    storeListLoading: false,
    groupedStoreList: [] as any[]
  },

  lifetimes: {
    attached() {
      this.loadStoreInfo();
    }
  },

  observers: {
    'currentStore.storeName': function (this: any, storeName: string) {
      this.setData({ storeInitial: (storeName || '海').slice(0, 1) });
    }
  },

  methods: {
    loadStoreInfo() {
      const app = getApp() as any;
      if (app && app.globalData) {
        const raw = app.globalData.currentStore || {
          storeId: 'haicang_yuhuazhai',
          storeName: '海沧区雨花斋',
          role: 'VOLUNTEER'
        };
        this.setData({
          currentStore: {
            storeId: raw.storeId,
            storeName: raw.storeName,
            role: this._normalizeRole(raw.role) as 'MANAGER' | 'FINANCE' | 'VOLUNTEER' | 'ADMIN'
          }
        });
      }
    },

    // 开启弹窗
    onOpenSheet() {
      console.log('🔘 [store-picker] 执行打开 Bottom Sheet 面板');
      this.loadStoreInfo();
      this.setData({ showPickerSheet: true });
      this.fetchStoreListFromCloud();
    },

    // 🐛 修复"新建门店看不到"：每次打开面板都向 getStoreList 云函数活查询本机构最新门店列表，
    // 不加本地缓存（低频交互，没必要像首页 allStoresList 那样引入缓存陈旧的坑）。
    // 拉取失败时保留当前已有列表（通常是上一次成功的结果），不清空致整个面板变空。
    //
    // 🛡️ 权限隔离：是否插入"全国总览"虚拟条目，以服务端下发的角色信息为准（先用本地缓存，
    // 缓存缺失时现查一次 checkUserRole），绝不凭前端已有的 currentStore.role 展示态判断——
    // 那只是"当前正在预览的视角"，不代表账号真实身份，用它来决定入口可见性会被预览态污染。
    async fetchStoreListFromCloud() {
      this.setData({ storeListLoading: true });
      try {
        let roleInfo = AuthService.getCachedRoleInfo();
        if (!roleInfo) {
          const roleResult = await AuthService.fetchUserRole();
          roleInfo = roleResult.roleInfo || null;
        }
        const isSuperAdmin = isVerifiedSuperAdmin(roleInfo);

        const res = await wx.cloud.callFunction({ name: 'getStoreList' });
        const result = res.result as any;
        const list = (result && result.success) ? (result.list || []) : [];

        const fetchedStores = list.map((s: any) => ({
          storeId: s.storeId,
          storeName: s.storeName,
          roles: [
            { role: 'VOLUNTEER', label: '义工', isAuthorized: true },
            { role: 'MANAGER', label: '店长', isAuthorized: false },
            { role: 'FINANCE', label: '财务', isAuthorized: false }
          ]
        }));

        // 仅已核验的 super_admin 账号才在列表顶部插入"全国总览"；其余角色（店长/财务/义工）
        // 完全过滤掉该条目，只保留其真实绑定的具体门店
        const groupedStoreList = isSuperAdmin
          ? [{
              storeId: 'national_overview',
              storeName: '全国总览',
              roles: [{ role: 'ADMIN', label: '超级管理员', isAuthorized: false }]
            }, ...fetchedStores]
          : fetchedStores;

        this.setData({ groupedStoreList });
        this.refreshRolePermissions();
      } catch (err) {
        console.warn('[store-picker] fetchStoreListFromCloud 失败，保留现有列表:', err);
      } finally {
        this.setData({ storeListLoading: false });
      }
    },

    // 刷新角色鉴权状态 (义工默认 true，店长/财务/管理员校验 userAuthorizedKeys)
    refreshRolePermissions() {
      const authKeys = wx.getStorageSync('my_authorized_roles') || [];

      const updatedList = this.data.groupedStoreList.map((store: any) => {
        const roles = store.roles.map((r: any) => {
          if (r.role === 'VOLUNTEER') return { ...r, isAuthorized: true };
          const key = `${store.storeId}_${r.role}`;
          const isAuth = Array.isArray(authKeys) && authKeys.includes(key);
          return { ...r, isAuthorized: isAuth };
        });
        return { ...store, roles };
      });

      this.setData({ groupedStoreList: updatedList });
    },

    // 关闭弹窗
    onCloseSheet() {
      this.setData({ showPickerSheet: false });
    },

    // 阻止冒泡与触摸穿透
    stopBubble() {},
    preventTouchMove() {},

    _normalizeRole(role: string): string {
      const r = (role || 'VOLUNTEER').toUpperCase();
      if (r === 'SUPER_ADMIN') return 'ADMIN';
      return r;
    },

    // 点击角色胶囊 (带鉴权拦截)
    onRolePillClick(e: any) {
      const { storeId, storeName, role, authorized } = e.currentTarget.dataset;
      const roleLabels: Record<string, string> = {
        'MANAGER': '店长',
        'FINANCE': '财务',
        'VOLUNTEER': '义工',
        'ADMIN': '超级管理员',
        'SUPER_ADMIN': '超级管理员'
      };

      // 未授权：弹出激活核验弹窗
      if (!authorized) {
        this.setData({
          showAuthModal: true,
          authTab: 'CODE',
          authCodeInput: '',
          applicantNameInput: '',
          targetAuthStoreId: storeId,
          targetAuthStoreName: storeName,
          targetAuthRole: role,
          targetAuthRoleLabel: roleLabels[role] || '管理身份'
        });
        return;
      }

      // 已授权：顺畅切换
      this._applyRoleSwitch(storeId, storeName, role);
    },

    // 内部：执行角色切换 (公共逻辑)
    _applyRoleSwitch(storeId: string, storeName: string, role: string) {
      this.setData({
        currentStore: {
          storeId,
          storeName,
          role: role as 'MANAGER' | 'FINANCE' | 'VOLUNTEER' | 'ADMIN'
        },
        showPickerSheet: false
      });

      const app = getApp() as any;
      if (app && app.switchStore) {
        app.switchStore(storeId, storeName, role);
      } else if (app && app.globalData) {
        app.globalData.currentStore = { storeId, storeName, role };
      }

      wx.setStorageSync('active_store_id', storeId);
      wx.setStorageSync('active_role', role);

      const roleText = role === 'FINANCE' ? '财务' : (role === 'MANAGER' ? '店长' : (role === 'ADMIN' ? '超级管理员' : '义工'));
      wx.showToast({
        title: `已切至 ${storeName} (${roleText})`,
        icon: 'none'
      });

      this.triggerEvent('storechange', {
        storeId,
        storeName,
        role,
        currentRole: role
      });
    },

    // 激活弹窗：输入口令
    onAuthCodeInput(e: any) {
      this.setData({ authCodeInput: e.detail.value });
    },

    // 激活弹窗：输入申请人姓名
    onApplicantNameInput(e: any) {
      this.setData({ applicantNameInput: e.detail.value });
    },

    // 切换选项卡
    onSwitchAuthTab(e: any) {
      this.setData({ authTab: e.currentTarget.dataset.tab });
    },

    // 关闭激活弹窗
    onCloseAuthModal() {
      this.setData({ showAuthModal: false });
    },

    // 核心：动态邀请码校验 / 申请提交
    async onVerifyAuthSubmit() {
      // 通道一：一次性动态邀请码核验
      if (this.data.authTab === 'CODE') {
        const inputCode = (this.data.authCodeInput || '').trim().toUpperCase();
        const targetRole = this.data.targetAuthRole;

        console.log('🔑 [Auth Attempt]:', { inputCode, targetRole });

        // 🛡️ 安全修复：此前这里存在硬编码"创世根密钥"（ROOT8888/ADMIN2026/YUHUA888 等），
        // 任何人只要拿到小程序包反编译查看源码即可提取这些字符串，完全绕过云端校验直接
        // 自我提权为超级管理员——属于严重的权限防腐漏洞，现已彻底移除。
        // 超级管理员账号只能由平台方通过 setupSuperAdmin 云函数在控制台离线开通，
        // 小程序前端不再提供任何形式的自助激活入口。
        if (targetRole === 'SUPER_ADMIN' || targetRole === 'ADMIN') {
          wx.showModal({
            title: '无法自助激活',
            content: '超级管理员权限不支持在小程序内自助开通，请联系平台管理员为您的账号开通该角色。',
            showCancel: false
          });
          return;
        }

        // ================= 2. 普通店长/财务动态邀请码云端核验 =================
        if (!inputCode || inputCode.length < 4) {
          wx.showToast({ title: '请输入有效的邀请码', icon: 'none' });
          return;
        }

        wx.showLoading({ title: '安全核验中...' });

        try {
          const db = wx.cloud.database();
          const res = await db.collection('store_invites').where({
            inviteCode: inputCode,
            storeId: this.data.targetAuthStoreId,
            role: this.data.targetAuthRole,
            isUsed: false
          }).get();

          if (res.data && res.data.length > 0) {
            const inviteRecord = res.data[0];

            // 标记该邀请码已被使用 (销毁一次性凭证)
            // 🛡️ 修复：此前这里写入的是字面量字符串 '{openid}'（未做变量替换的占位符），
            // 导致邀请码使用记录里的"使用人"字段永远是假数据，审计时完全无法追溯真实用户
            await db.collection('store_invites').doc(inviteRecord._id).update({
              data: {
                isUsed: true,
                usedAt: db.serverDate(),
                usedByOpenId: AuthService.getOpenid() || ''
              }
            });

            wx.hideLoading();

            // 本地缓存特权关系
            const authKeys: string[] = wx.getStorageSync('my_authorized_roles') || [];
            const newKey = `${this.data.targetAuthStoreId}_${this.data.targetAuthRole}`;
            if (!authKeys.includes(newKey)) {
              authKeys.push(newKey);
              wx.setStorageSync('my_authorized_roles', authKeys);
            }

            wx.showToast({ title: '🎉 身份激活成功！', icon: 'success' });
            this.setData({ showAuthModal: false });
            this.refreshRolePermissions();

            // 自动切换到刚激活的特权身份
            this._applyRoleSwitch(
              this.data.targetAuthStoreId,
              this.data.targetAuthStoreName,
              this.data.targetAuthRole
            );
          } else {
            wx.hideLoading();
            wx.showToast({ title: '邀请码无效或已被使用', icon: 'none' });
          }
        } catch (err) {
          wx.hideLoading();
          console.warn('⚠️ [store-picker] 云数据库校验异常:', err);
          // 🛡️ 安全修复：此前云端校验异常时会退回硬编码临时动态码（YUHUA2026 等）直接放行，
          // 等同于又一处可反编译提取的权限后门，现已移除。校验失败时统一提示重试，
          // 绝不在网络异常时静默授予权限。
          wx.showToast({ title: '网络异常，请稍后重试', icon: 'none' });
        }
        return;
      }

      // 通道二：提交在线申请给店长
      const name = (this.data.applicantNameInput || '').trim();
      if (!name) {
        wx.showToast({ title: '请输入姓名/义工号', icon: 'none' });
        return;
      }

      wx.showLoading({ title: '提交申请中...' });

      try {
        const db = wx.cloud.database();
        await db.collection('role_requests').add({
          data: {
            applicantName: name,
            storeId: this.data.targetAuthStoreId,
            storeName: this.data.targetAuthStoreName,
            role: this.data.targetAuthRole,
            status: 'PENDING',
            createdAt: db.serverDate()
          }
        });

        wx.hideLoading();
        wx.showModal({
          title: '📩 申请已提交',
          content: `已将您的特权申请提交给【${this.data.targetAuthStoreName}】管理组，请等待现任店长在工作台审核通过。`,
          showCancel: false,
          confirmText: '我知道了',
          confirmColor: '#8C1D18'
        });
        this.setData({ showAuthModal: false });
      } catch (err) {
        wx.hideLoading();
        console.warn('⚠️ [store-picker] 申请提交异常:', err);
        wx.showToast({ title: '申请提交成功，请等待店长审核', icon: 'none' });
        this.setData({ showAuthModal: false });
      }
    },

    // ➕ 切换"门店列表" / "申请新门店表单"
    onToggleNewStoreForm() {
      this.setData({
        showNewStoreForm: !this.data.showNewStoreForm,
        newStoreForm: { customStoreName: '', applyRole: 'volunteer' }
      });
    },

    onNewStoreNameInput(e: any) {
      this.setData({ 'newStoreForm.customStoreName': e.detail.value });
    },

    onSelectNewStoreRole(e: any) {
      this.setData({ 'newStoreForm.applyRole': e.detail.value });
    },

    // 提交"新建门店"：
    // - super_admin：直接建店并自动绑定为该店管理者，免去二次审批流程（见 directCreateStoreAsSuperAdmin）
    // - 其他角色：走真实的角色申请体系（user_roles 集合 + processRoleAudit 云函数审批），
    //   而非本组件其余部分使用的本地演示态 role_requests/my_authorized_roles。
    //   字段命名与 pages/index/index.ts 的 onSubmitRoleApply 保持一致，
    //   确保 processRoleAudit 能正确识别 storeSelectionType==='custom' 的新建门店申请。
    async onSubmitNewStoreApply() {
      const customStoreName = (this.data.newStoreForm.customStoreName || '').trim();
      const applyRole = this.data.newStoreForm.applyRole;

      if (!customStoreName) {
        wx.showToast({ title: '请输入新门店名称', icon: 'none' });
        return;
      }

      const roleInfo = AuthService.getCachedRoleInfo();

      // 🛡️ 超级管理员：无需申请/审批，直接建店并自动获得管理权限
      if (roleInfo && roleInfo.role === 'super_admin') {
        await this.directCreateStoreAsSuperAdmin(customStoreName);
        return;
      }

      // 🏢 多租户边界（非超管场景）：申请必须归属一个明确的机构，否则待审批记录会缺少
      // tenantId，导致任何机构的超级管理员都可能审批到它——这里宁可拦截也不允许提交裸记录
      const tenantId = (roleInfo && roleInfo.tenantId) || '';
      if (!tenantId) {
        wx.showModal({
          title: '暂无法提交',
          content: '您的账号尚未关联任何机构，无法申请新建门店。请先通过邀请码/申请加入已有门店，或联系平台管理员开通机构。',
          showCancel: false
        });
        return;
      }

      wx.showLoading({ title: '提交申请中...', mask: true });

      try {
        const db = wx.cloud.database();
        await db.collection('user_roles').add({
          data: {
            storeId: '',
            storeName: customStoreName,
            storeSelectionType: 'custom',
            customStoreName: customStoreName,
            requestedRole: applyRole,
            role: 'volunteer',
            status: 'pending',
            tenantId,
            applyTime: db.serverDate()
          }
        });

        wx.hideLoading();
        this.setData({ showNewStoreForm: false, showPickerSheet: false });
        wx.showToast({ title: '申请已提交，请等待超级管理员审批开通！', icon: 'none', duration: 2500 });
      } catch (err) {
        wx.hideLoading();
        console.error('[store-picker] onSubmitNewStoreApply 提交失败:', err);
        wx.showToast({ title: '提交失败，请重试', icon: 'none' });
      }
    },

    // 🛡️ 超级管理员新建门店：直接调用 createStore 云函数建店并绑定为管理者，
    // 免去"提交申请 -> 等待审批"的二次流程。云函数内部会自愈修复缺失的 tenantId
    // （回退到默认机构 yuhuazhai_national），不会再误报"账号尚未关联任何机构"。
    async directCreateStoreAsSuperAdmin(customStoreName: string) {
      wx.showLoading({ title: '新建门店中...', mask: true });

      try {
        const res = await wx.cloud.callFunction({
          name: 'createStore',
          data: { storeName: customStoreName, bindAsManager: true }
        });
        const result = res.result as any;

        wx.hideLoading();

        if (!result || !result.success) {
          wx.showModal({ title: '建店失败', content: (result && result.error) || '未知错误', showCancel: false });
          return;
        }

        const newStoreId = result.storeId;
        const newStoreName = result.storeName || customStoreName;

        // 本地状态与缓存同步：切换到新建的门店，角色仍为超级管理员
        this.setData({
          currentStore: { storeId: newStoreId, storeName: newStoreName, role: 'ADMIN' },
          showNewStoreForm: false,
          showPickerSheet: false
        });

        const app = getApp() as any;
        if (app && app.switchStore) {
          app.switchStore(newStoreId, newStoreName, 'ADMIN');
        } else if (app && app.globalData) {
          app.globalData.currentStore = { storeId: newStoreId, storeName: newStoreName, role: 'ADMIN' };
        }
        wx.setStorageSync('active_store_id', newStoreId);
        wx.setStorageSync('active_role', 'ADMIN');

        wx.showToast({ title: '新门店已创建成功，您已自动获得该店店长管理权限！', icon: 'none', duration: 3000 });

        // 通知父页面：门店已切换 + 门店列表需要重新拉取（新店此前不在列表中）
        this.triggerEvent('storechange', {
          storeId: newStoreId,
          storeName: newStoreName,
          role: 'ADMIN',
          currentRole: 'ADMIN'
        });
        this.triggerEvent('storelistchange', {});
      } catch (err) {
        wx.hideLoading();
        console.error('[store-picker] directCreateStoreAsSuperAdmin 失败:', err);
        wx.showModal({ title: '调用失败', content: '请确认 createStore 云函数已部署', showCancel: false });
      }
    },

    // 提供给父页面的主动同步接口（带防循环守卫）
    updateCurrentStore(storeInfo: { storeId: string; storeName: string; role: string }) {
      if (!storeInfo) return;
      const newRole = this._normalizeRole(storeInfo.role);
      const newStoreId = storeInfo.storeId || 'haicang_yuhuazhai';
      const newStoreName = storeInfo.storeName || '海沧区雨花斋';
      const current = this.data.currentStore || {};

      // 值未改变则直接跳过，杜绝重复 setData 引发的循环
      if (
        current.storeId === newStoreId &&
        current.storeName === newStoreName &&
        current.role === newRole
      ) {
        return;
      }

      this.setData({
        currentStore: {
          storeId: newStoreId,
          storeName: newStoreName,
          role: newRole as 'MANAGER' | 'FINANCE' | 'VOLUNTEER' | 'ADMIN'
        }
      });
      console.log('🔘 [store-picker] 接收父页面同步，更新内部 UI:', { newStoreName, newRole });
      // 绝不调用 triggerEvent('storechange')，防止反向死循环
    }
  }
});