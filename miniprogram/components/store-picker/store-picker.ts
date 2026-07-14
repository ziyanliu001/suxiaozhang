Component({
  properties: {},

  data: {
    showPickerSheet: false,
    currentStore: {
      storeId: 'haicang_yuhuazhai',
      storeName: '海沧区雨花斋',
      role: 'VOLUNTEER' as 'MANAGER' | 'FINANCE' | 'VOLUNTEER' | 'ADMIN'
    },
    // 智能分组门店列表：每个门店都包含可切换的身份选项
    groupedStoreList: [
      {
        storeId: 'haicang_yuhuazhai',
        storeName: '海沧区雨花斋',
        roles: [
          { role: 'VOLUNTEER', label: '义工' },
          { role: 'MANAGER', label: '店长' },
          { role: 'FINANCE', label: '财务' }
        ]
      },
      {
        storeId: 'huli_yuhuazhai',
        storeName: '湖里区雨花斋',
        roles: [
          { role: 'VOLUNTEER', label: '义工' },
          { role: 'MANAGER', label: '店长' },
          { role: 'FINANCE', label: '财务' }
        ]
      },
      {
        storeId: 'national_overview',
        storeName: '全国总览',
        roles: [
          { role: 'ADMIN', label: '超级管理员' }
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
      this.setData({ showPickerSheet: true });
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

    // 选定门店与身份处理函数（新版解耦逻辑）
    onSelectStoreAndRole(e: any) {
      const { storeId, storeName, role } = e.currentTarget.dataset;

      console.log('🔄 [StorePicker] 用户选择了门店与身份:', storeName, role);

      this.setData({
        currentStore: {
          storeId,
          storeName,
          role: role as 'MANAGER' | 'FINANCE' | 'VOLUNTEER' | 'ADMIN'
        },
        showPickerSheet: false
      });

      // 同步 app globalData
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

      // 向父页面抛出事件
      this.triggerEvent('storechange', {
        storeId,
        storeName,
        role,
        currentRole: role
      });
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