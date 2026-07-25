import { AuthService } from '../../utils/authService';
import { haversineDistanceKm, formatDistance } from '../../utils/geoUtils';

const OPERATING_STATUS_LABELS: Record<string, string> = {
  operating: '运营中',
  preparing: '筹备中',
  paused: '暂停运营'
};

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
      applyRole: 'volunteer' as 'store_patriarch' | 'store_manager' | 'finance' | 'volunteer'
    },
    currentStore: {
      storeId: 'haicang_yuhuazhai',
      storeName: '海沧区雨花斋',
      role: 'VOLUNTEER' as 'MANAGER' | 'FINANCE' | 'VOLUNTEER' | 'ADMIN' | 'PATRIARCH' | 'FAMILY'
    },
    // WXML 表达式不支持字符串下标 name[0]，胶囊头像的首字改由 observers 算好后绑定展示
    storeInitial: '海',
    // 🐛 曾经是写死的 3 条演示数据（海沧区雨花斋/湖里区雨花斋/全国总览），导致超管新建的
    // 门店永远不会出现在这里——现改为 onOpenSheet() 时向 getStoreList 云函数活查询。
    // 🛡️ 权限隔离：默认不再预置"全国总览"虚拟入口——是否插入该条目取决于当前账号是否为
    // 已审核通过的 super_admin，由 fetchStoreListFromCloud() 按真实角色动态决定，
    // 确保面板首次渲染（网络请求返回前）也不会对非超管账号闪现该选项
    storeListLoading: false,
    groupedStoreList: [] as any[],

    // 🌐 全国家园网络：完整门店数据（不含"全国总览"虚拟条目）+ 搜索/省市筛选/附近排序，
    // groupedStoreList 是 allStores 按当前筛选/排序条件派生出的展示态，"全国总览"条目
    // 不参与筛选/排序，单独存着按需拼在展示列表最前面
    allStores: [] as any[],
    nationalOverviewEntry: null as any,
    searchKeyword: '',
    provinceOptions: [] as string[],
    cityOptions: [] as string[],
    // <picker mode="selector"> 的 range 需要一个现成数组（WXML 绑定表达式不支持展开
    // 语法拼接"全部省份"/"全部城市"占位项），这里在 TS 侧提前拼好
    provinceOptionsWithAll: ['全部省份'] as string[],
    cityOptionsWithAll: ['全部城市'] as string[],
    selectedProvince: '',
    selectedCity: '',
    sortMode: 'default' as 'default' | 'nearby',
    userLocation: null as { latitude: number; longitude: number } | null,
    locationLoading: false,

    // 🛡️ 已核验的 super_admin：由 fetchStoreListFromCloud 用服务端下发的角色信息判定
    // （与"全国总览"虚拟条目是否插入用同一个 isVerifiedSuperAdmin 判断口径），
    // 供 refreshRolePermissions 解锁本机构内所有门店的店长/财务身份切换——
    // getStoreList 云函数本身已按 tenantId 过滤，这里拿到的门店列表天然就是本机构范围
    isSuperAdmin: false,

    // 🏛️ 大家长任命申请弹窗：与店长/财务共用的 showAuthModal 完全独立——家长任命
    // 走真实的 processRoleAudit(action:'apply') 服务端审批（仅超管可批），不提供
    // 任何客户端口令/邀请码通道，避免出现可被反编译绕过的自我提权入口
    showPatriarchApplyModal: false,
    patriarchApplyStoreId: '',
    patriarchApplyStoreName: '',
    patriarchApplyRealName: '',
    patriarchApplyPhone: '',
    patriarchApplySubmitting: false
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
            role: this._normalizeRole(raw.role) as 'MANAGER' | 'FINANCE' | 'VOLUNTEER' | 'ADMIN' | 'PATRIARCH' | 'FAMILY'
          }
        });
      }
    },

    // 开启弹窗
    onOpenSheet() {
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
          operatingStatus: s.operatingStatus || 'operating',
          operatingStatusLabel: OPERATING_STATUS_LABELS[s.operatingStatus] || '运营中',
          province: s.province || '',
          city: s.city || '',
          latitude: typeof s.latitude === 'number' ? s.latitude : undefined,
          longitude: typeof s.longitude === 'number' ? s.longitude : undefined,
          roles: [
            { role: 'FAMILY', label: '家人', isAuthorized: true },
            { role: 'VOLUNTEER', label: '义工', isAuthorized: true },
            { role: 'MANAGER', label: '店长', isAuthorized: false },
            { role: 'FINANCE', label: '财务', isAuthorized: false },
            { role: 'PATRIARCH', label: '家长', isAuthorized: false }
          ]
        }));

        // 仅已核验的 super_admin 账号才展示"全国总览"；其余角色（店长/财务/义工）
        // 完全过滤掉该条目，只保留其真实绑定的具体门店。该条目不参与筛选/排序，
        // 单独存着，展示时始终拼在筛选结果最前面
        const nationalOverviewEntry = isSuperAdmin
          ? {
              storeId: 'national_overview',
              storeName: '全国总览',
              roles: [{ role: 'ADMIN', label: '超级管理员', isAuthorized: false }]
            }
          : null;

        // 省份筛选选项：从实际门店数据里动态推导，不维护全国行政区划静态数据集——
        // 门店铺开到新省市时选项会自动出现，不需要额外维护数据文件
        const provinceOptions = Array.from(new Set(fetchedStores.map((s: any) => s.province).filter(Boolean))) as string[];

        this.setData({
          allStores: fetchedStores,
          nationalOverviewEntry,
          provinceOptions,
          provinceOptionsWithAll: ['全部省份', ...provinceOptions],
          isSuperAdmin
        });
        this.refreshRolePermissions();
      } catch (err) {
        console.warn('[store-picker] fetchStoreListFromCloud 失败，保留现有列表:', err);
      } finally {
        this.setData({ storeListLoading: false });
      }
    },

    // 刷新角色鉴权状态 (义工默认 true，店长/财务/管理员校验 userAuthorizedKeys)
    //
    // 🐛 修复：super_admin 此前和普通账号走同一套 my_authorized_roles 邀请码校验，
    // 导致超管在自己机构内的门店上也会看到店长/财务胶囊锁住、点了只会弹激活码
    // 弹窗——超管本就该对本机构门店有管理权限，不应该还要逐店领邀请码。这里
    // isSuperAdmin 为 true 时，店长/财务两个胶囊直接解锁；allStores 本身已经是
    // getStoreList 云函数按 tenantId 过滤后的结果，不会解锁到其他机构的门店
    //
    // 🏛️ 家长胶囊鉴权走另一套口径：不查 my_authorized_roles（那是店长/财务的本地
    // 演示态邀请码缓存，客户端可自行写入，不能用来判定"仅超管可批"的家长任命）——
    // 而是直接读服务端下发、经 processRoleAudit 审批落地的真实角色缓存
    // （role==='store_patriarch' && status==='approved'）。当前数据模型下一个账号
    // 只会缓存一条角色记录（对应其唯一绑定的门店），尚不支持"一人同时是多店家长"，
    // 这里只按这一条真实记录判断，不做多店位扩展
    refreshRolePermissions() {
      const authKeys = wx.getStorageSync('my_authorized_roles') || [];
      const isSuperAdmin = this.data.isSuperAdmin;
      const cachedRole = AuthService.getCachedRoleInfo();
      const isVerifiedPatriarch = !!(cachedRole && cachedRole.role === 'store_patriarch' && cachedRole.status === 'approved');
      const patriarchStoreId = isVerifiedPatriarch && cachedRole ? cachedRole.storeId : '';

      const updatedStores = this.data.allStores.map((store: any) => {
        const roles = store.roles.map((r: any) => {
          // ❤️ 家人（服务对象）与义工同级：自我声明式身份，无需邀请码/审批
          if (r.role === 'VOLUNTEER' || r.role === 'FAMILY') return { ...r, isAuthorized: true };
          if (isSuperAdmin && (r.role === 'MANAGER' || r.role === 'FINANCE' || r.role === 'PATRIARCH')) {
            return { ...r, isAuthorized: true };
          }
          if (r.role === 'PATRIARCH') {
            return { ...r, isAuthorized: isVerifiedPatriarch && patriarchStoreId === store.storeId };
          }
          const key = `${store.storeId}_${r.role}`;
          const isAuth = Array.isArray(authKeys) && authKeys.includes(key);
          return { ...r, isAuthorized: isAuth };
        });
        return { ...store, roles };
      });

      this.setData({ allStores: updatedStores });
      this.applyFilters();
    },

    // 🌐 搜索/省市筛选/附近排序：从 allStores 派生出 groupedStoreList 展示态，
    // "全国总览"虚拟条目不参与筛选/排序，始终拼在结果最前面
    applyFilters() {
      const { allStores, nationalOverviewEntry, searchKeyword, selectedProvince, selectedCity, sortMode, userLocation } = this.data;

      let filtered = allStores;

      const keyword = (searchKeyword || '').trim();
      if (keyword) {
        filtered = filtered.filter((s: any) => (s.storeName || '').includes(keyword));
      }
      if (selectedProvince) {
        filtered = filtered.filter((s: any) => s.province === selectedProvince);
      }
      if (selectedCity) {
        filtered = filtered.filter((s: any) => s.city === selectedCity);
      }

      if (sortMode === 'nearby' && userLocation) {
        filtered = filtered.map((s: any) => {
          if (typeof s.latitude !== 'number' || typeof s.longitude !== 'number') {
            return { ...s, distanceKm: Infinity, distanceLabel: '' };
          }
          const distanceKm = haversineDistanceKm(userLocation.latitude, userLocation.longitude, s.latitude, s.longitude);
          return { ...s, distanceKm, distanceLabel: formatDistance(distanceKm) };
        });
        filtered = [...filtered].sort((a: any, b: any) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
      }

      const groupedStoreList = nationalOverviewEntry ? [nationalOverviewEntry, ...filtered] : filtered;
      this.setData({ groupedStoreList });
    },

    onSearchInput(e: any) {
      this.setData({ searchKeyword: e.detail.value });
      this.applyFilters();
    },

    onProvinceChange(e: any) {
      const index = parseInt(e.detail.value, 10);
      // 选项数组第 0 项固定是"全部省份"
      const selectedProvince = index === 0 ? '' : this.data.provinceOptions[index - 1];
      const cityOptions = Array.from(
        new Set(
          this.data.allStores
            .filter((s: any) => !selectedProvince || s.province === selectedProvince)
            .map((s: any) => s.city)
            .filter(Boolean)
        )
      ) as string[];
      this.setData({
        selectedProvince,
        cityOptions,
        cityOptionsWithAll: ['全部城市', ...cityOptions],
        selectedCity: ''
      });
      this.applyFilters();
    },

    onCityChange(e: any) {
      const index = parseInt(e.detail.value, 10);
      const selectedCity = index === 0 ? '' : this.data.cityOptions[index - 1];
      this.setData({ selectedCity });
      this.applyFilters();
    },

    onClearFilters() {
      this.setData({
        searchKeyword: '',
        selectedProvince: '',
        selectedCity: '',
        cityOptions: [],
        cityOptionsWithAll: ['全部城市'],
        sortMode: 'default'
      });
      this.applyFilters();
    },

    // 📍 附近门店：首次开启时请求定位，成功后按距离升序排列；用户拒绝授权/定位失败时
    // 优雅降级为原有默认排序 + toast 提示，不阻断使用
    async onToggleNearbySort() {
      if (this.data.sortMode === 'nearby') {
        this.setData({ sortMode: 'default' });
        this.applyFilters();
        return;
      }

      if (this.data.userLocation) {
        this.setData({ sortMode: 'nearby' });
        this.applyFilters();
        return;
      }

      this.setData({ locationLoading: true });
      try {
        const res: any = await wx.getLocation({ type: 'gcj02' });
        this.setData({
          userLocation: { latitude: res.latitude, longitude: res.longitude },
          sortMode: 'nearby'
        });
        this.applyFilters();
      } catch (err: any) {
        console.warn('[store-picker] 获取定位失败:', err);
        // 🛡️ 定位失败不再用阻塞式 Error Dialog 打断用户："附近门店"只是可选的排序方式，
        // 不是必须完成的流程。只有"用户明确拒绝过授权"这一种情况才值得主动弹一次引导——
        // 因为 wx.openSetting 必须由用户点击触发，没法用 toast 代替；其余情况（模拟器未
        // 开定位、网络超时等）一律轻量 toast 提示，并静默降级为默认排序，不打断使用
        const isDenied = !!(err && err.errMsg && err.errMsg.indexOf('auth deny') >= 0);
        if (isDenied) {
          wx.showModal({
            title: '开启位置权限',
            content: '如需按距离显示附近门店，请前往设置开启位置权限',
            confirmText: '去设置',
            cancelText: '暂不',
            success: (modalRes) => {
              if (modalRes.confirm) {
                wx.openSetting();
              }
            }
          });
        } else {
          wx.showToast({ title: '未获取到位置，已为您切换至默认排序', icon: 'none' });
        }
        this.setData({ sortMode: 'default' });
        this.applyFilters();
      } finally {
        this.setData({ locationLoading: false });
      }
    },

    // 关闭弹窗
    onCloseSheet() {
      this.setData({ showPickerSheet: false });
    },

    // 阻止冒泡与触摸穿透
    stopBubble() {},
    preventTouchMove() {},

    // 🛡️ 全局排查修复：这里的入参既可能是本组件自己胶囊点击产生的裸值（'PATRIARCH'/
    // 'FAMILY'，见 onRolePillClick/_applyRoleSwitch），也可能是 app.ts 多店权限加载
    // （fetchMultiStorePermissions）里对数据库 snake_case 角色值直接 toUpperCase() 得到的
    // 'STORE_PATRIARCH'/'STORE_FAMILY'——两种拼法都要能归一化成本组件角色胶囊使用的
    // 裸值形式，否则 currentStore.role 会停留在无法匹配任何胶囊的 'STORE_PATRIARCH'，
    // 导致"当前生效"提示与选中态 checkmark 都对不上真实身份
    _normalizeRole(role: string): string {
      const r = (role || 'VOLUNTEER').toUpperCase();
      if (r === 'SUPER_ADMIN') return 'ADMIN';
      if (r === 'STORE_PATRIARCH') return 'PATRIARCH';
      if (r === 'STORE_MANAGER') return 'MANAGER';
      if (r === 'STORE_FAMILY') return 'FAMILY';
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
        'SUPER_ADMIN': '超级管理员',
        'PATRIARCH': '大家长',
        'FAMILY': '家人'
      };

      if (!authorized) {
        // 🏛️ 大家长任命走独立的真实申请流程（processRoleAudit action:'apply'，
        // 仅超级管理员可审批），不复用店长/财务的邀请码/本地申请弹窗——那条通道
        // 写入的是店长可自行审批的 role_requests 演示态数据，家长任命绝不能走这条
        if (role === 'PATRIARCH') {
          this.setData({
            showPatriarchApplyModal: true,
            patriarchApplyStoreId: storeId,
            patriarchApplyStoreName: storeName,
            patriarchApplyRealName: '',
            patriarchApplyPhone: ''
          });
          return;
        }

        // 未授权：弹出激活核验弹窗
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

      // 已授权：顺畅切换。家长身份额外导向个人中心的【家长管理/资源兜底】卡片
      // （原独立页面 pages/patriarch-dashboard 已废弃并入个人中心），不只是切换
      // "当前预览身份"就结束——这是家长角色的主入口，与店长/财务/义工纯粹的
      // "切视角"语义不同。若当前就已经在个人中心（例如从该页自己内嵌的
      // store-picker 发起切换），不重复跳转——_applyRoleSwitch 触发的
      // storechange 事件会由该页自己的处理函数刷新面板数据
      this._applyRoleSwitch(storeId, storeName, role);
      if (role === 'PATRIARCH') {
        const pages = getCurrentPages();
        const currentPage = pages[pages.length - 1];
        const currentRoute = currentPage ? '/' + currentPage.route : '';
        if (currentRoute !== '/pages/profile/profile') {
          wx.navigateTo({ url: '/pages/profile/profile' });
        }
      }
    },

    // 大家长任命申请弹窗：输入框
    onPatriarchApplyRealNameInput(e: any) {
      this.setData({ patriarchApplyRealName: e.detail.value });
    },

    onPatriarchApplyPhoneInput(e: any) {
      this.setData({ patriarchApplyPhone: e.detail.value });
    },

    onClosePatriarchApplyModal() {
      if (this.data.patriarchApplySubmitting) return;
      this.setData({ showPatriarchApplyModal: false });
    },

    // 🏛️ 大家长任命申请：统一走 processRoleAudit(action:'apply')，与首页
    // onSubmitRoleApply 同一套服务端审批口径（仅 super_admin 可批准，见该云函数
    // approve 分支的 requestedRole==='store_patriarch' 校验），客户端只负责收集
    // 必填的真实姓名/手机号并提交，不掺杂任何本地口令/自助激活逻辑
    async onSubmitPatriarchApply() {
      if (this.data.patriarchApplySubmitting) return;
      const realName = (this.data.patriarchApplyRealName || '').trim();
      const phone = (this.data.patriarchApplyPhone || '').trim();

      if (!realName) {
        wx.showToast({ title: '请填写真实姓名', icon: 'none' });
        return;
      }
      if (!phone) {
        wx.showToast({ title: '请填写手机号', icon: 'none' });
        return;
      }

      this.setData({ patriarchApplySubmitting: true });
      wx.showLoading({ title: '提交申请中...', mask: true });

      try {
        const cachedRole = AuthService.getCachedRoleInfo();
        const tenantId = (cachedRole && cachedRole.tenantId) || '';

        const res = await wx.cloud.callFunction({
          name: 'processRoleAudit',
          data: {
            action: 'apply',
            storeId: this.data.patriarchApplyStoreId,
            storeName: this.data.patriarchApplyStoreName,
            storeSelectionType: 'existing',
            tenantId,
            requestedRole: 'store_patriarch',
            realName,
            phone
          }
        });
        const result = res.result as any;
        wx.hideLoading();

        if (!result || !result.success) {
          wx.showToast({ title: (result && result.error) || '提交失败，请重试', icon: 'none' });
          return;
        }

        this.setData({ showPatriarchApplyModal: false });
        wx.showModal({
          title: '📩 申请已提交',
          content: `已提交【${this.data.patriarchApplyStoreName}】大家长任命申请，仅限超级管理员审批，请耐心等待审核结果。`,
          showCancel: false,
          confirmText: '我知道了'
        });
      } catch (err) {
        wx.hideLoading();
        console.error('[store-picker] onSubmitPatriarchApply 提交失败:', err);
        wx.showToast({ title: '提交失败，请重试', icon: 'none' });
      } finally {
        this.setData({ patriarchApplySubmitting: false });
      }
    },

    // 内部：执行角色切换 (公共逻辑)
    //
    // 🐛 根因修复："切到家长身份后个人中心仍显示志工"：本方法此前只写了
    // active_store_id/active_role 两个 key，从没写过 current_user_role/
    // current_store_name——而 profile.ts 的 initMinePage() 恰恰优先读
    // current_user_role（有值就用它覆盖 AuthService 缓存里的真实角色），这个
    // key 此前只有 index.ts 自己的 onStoreChanged 会写。于是任何"只经过
    // store-picker、没有先在首页触发过 onStoreChanged"的角色切换，profile.ts
    // 重新计算角色时读到的都是这个滞留的旧值——现在这里也补上同一份持久化，
    // 与 index.ts onStoreChanged 的 roleMap 保持同一套映射口径
    _applyRoleSwitch(storeId: string, storeName: string, role: string) {
      this.setData({
        currentStore: {
          storeId,
          storeName,
          role: role as 'MANAGER' | 'FINANCE' | 'VOLUNTEER' | 'ADMIN' | 'PATRIARCH' | 'FAMILY'
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

      // 🛡️ 全局排查修复：role 入参在实践中恒为本组件胶囊裸值（PATRIARCH/FAMILY 等），
      // 但仍额外补上 STORE_ 前缀键做防御性冗余——万一将来有调用方直接传入服务端
      // snake_case 值转大写后的形式，也不会静默落进下面的 || 'volunteer' 兜底
      const roleStorageMap: Record<string, string> = {
        MANAGER: 'store_manager',
        STORE_MANAGER: 'store_manager',
        FINANCE: 'finance',
        VOLUNTEER: 'volunteer',
        PATRIARCH: 'store_patriarch',
        STORE_PATRIARCH: 'store_patriarch',
        ADMIN: 'super_admin',
        FAMILY: 'store_family',
        STORE_FAMILY: 'store_family'
      };
      wx.setStorageSync('current_user_role', roleStorageMap[role] || 'volunteer');
      wx.setStorageSync('current_store_name', storeName);

      const roleText = role === 'FINANCE' ? '财务' : (role === 'MANAGER' ? '店长' : (role === 'PATRIARCH' ? '大家长' : (role === 'ADMIN' ? '超级管理员' : (role === 'FAMILY' ? '家人' : '义工'))));
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
          role: newRole as 'MANAGER' | 'FINANCE' | 'VOLUNTEER' | 'ADMIN' | 'PATRIARCH' | 'FAMILY'
        }
      });
      // 绝不调用 triggerEvent('storechange')，防止反向死循环
    }
  }
});