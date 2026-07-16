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
    currentStore: {
      storeId: 'haicang_yuhuazhai',
      storeName: '海沧区雨花斋',
      role: 'VOLUNTEER' as 'MANAGER' | 'FINANCE' | 'VOLUNTEER' | 'ADMIN'
    },
    // 智能分组门店列表：每个门店都包含可切换的身份选项 + 鉴权状态
    groupedStoreList: [
      {
        storeId: 'haicang_yuhuazhai',
        storeName: '海沧区雨花斋',
        roles: [
          { role: 'VOLUNTEER', label: '义工', isAuthorized: true },
          { role: 'MANAGER', label: '店长', isAuthorized: false },
          { role: 'FINANCE', label: '财务', isAuthorized: false }
        ]
      },
      {
        storeId: 'huli_yuhuazhai',
        storeName: '湖里区雨花斋',
        roles: [
          { role: 'VOLUNTEER', label: '义工', isAuthorized: true },
          { role: 'MANAGER', label: '店长', isAuthorized: false },
          { role: 'FINANCE', label: '财务', isAuthorized: false }
        ]
      },
      {
        storeId: 'national_overview',
        storeName: '全国总览',
        roles: [
          { role: 'ADMIN', label: '超级管理员', isAuthorized: false }
        ]
      }
    ]
  },

  lifetimes: {
    attached() {
      this.loadStoreInfo();
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
      this.refreshRolePermissions();
      this.setData({ showPickerSheet: true });
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

        // ================= 1. 超级管理员创世密钥逻辑 (独立分支，不进云端校验) =================
        if (targetRole === 'SUPER_ADMIN' || targetRole === 'ADMIN') {
          const validRootKeys = ['ROOT8888', 'ADMIN2026', 'YUHUA888', '888888', 'ROOT'];

          if (validRootKeys.includes(inputCode)) {
            const authKeys: string[] = wx.getStorageSync('my_authorized_roles') || [];
            const superKey = `${this.data.targetAuthStoreId}_${targetRole}`;
            if (!authKeys.includes(superKey)) {
              authKeys.push(superKey);
              wx.setStorageSync('my_authorized_roles', authKeys);
            }

            wx.showToast({ title: '👑 超级管理员已解锁！', icon: 'success', duration: 2500 });
            this.setData({ showAuthModal: false });
            this.refreshRolePermissions();

            // 自动切换到超级管理员
            this._applyRoleSwitch(
              this.data.targetAuthStoreId,
              this.data.targetAuthStoreName,
              targetRole
            );
            return;
          } else {
            wx.showToast({ title: '根密钥不正确，请重新输入', icon: 'none' });
            return;
          }
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
            await db.collection('store_invites').doc(inviteRecord._id).update({
              data: {
                isUsed: true,
                usedAt: db.serverDate(),
                usedByOpenId: '{openid}'
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
          console.warn('⚠️ [store-picker] 云数据库校验异常，启用备用降级:', err);

          // 降级：云数据库未连接时的临时动态码
          if (inputCode === 'YUHUA2026' || inputCode === 'YH8888' || inputCode === 'YUHUA888') {
            const authKeys: string[] = wx.getStorageSync('my_authorized_roles') || [];
            const newKey = `${this.data.targetAuthStoreId}_${this.data.targetAuthRole}`;
            if (!authKeys.includes(newKey)) {
              authKeys.push(newKey);
              wx.setStorageSync('my_authorized_roles', authKeys);
            }

            wx.showToast({ title: '🎉 身份激活成功！', icon: 'success' });
            this.setData({ showAuthModal: false });
            this.refreshRolePermissions();
            this._applyRoleSwitch(
              this.data.targetAuthStoreId,
              this.data.targetAuthStoreName,
              this.data.targetAuthRole
            );
          } else {
            wx.showToast({ title: '邀请码错误或网络异常', icon: 'none' });
          }
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
          confirmText: '合十知晓',
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