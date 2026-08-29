import { AuthService } from '../../utils/authService';
import { safeNavigateTo } from '../../utils/navHelper';
import { haversineDistanceKm, formatDistance } from '../../utils/geoUtils';
import { compressAndUploadImages, compressAndUploadScaledImage } from '../../utils/imageCompress';
import { setCurrentActiveStore } from '../../utils/storeManager';
import { callFunctionWithTimeout } from '../../utils/withTimeout';

const OPERATING_STATUS_LABELS: Record<string, string> = {
  operating: '运营中',
  preparing: '筹备中',
  paused: '暂停运营'
};

const CANVAS_ID = 'storePickerImgCompressCanvas';

// 🏢 平台类型选项：与 store-profile、statistics 大屏筛选器共用同一套 value 字面量，
// 存入 stores.orgType 字段；name 是前端展示文案
const ORG_TYPE_OPTIONS = [
  { name: '🌸 雨花斋', value: 'yuhuazhai' },
  { name: '👵👴 社区助老食堂/敬老家园', value: 'elderly_canteen' },
  { name: '🤝 社区义工服务站', value: 'volunteer_station' },
  { name: '🛟 应急救援队', value: 'rescue_team' },
  { name: '🧒 同心儿童院/青少年关爱', value: 'tongxin_children' },
  { name: '💫 其他爱心组织', value: 'other' }
];

// 🛡️ 与 processRoleAudit approve() 的权限分级口径对齐：店长/财长任命 + 新建门店
// 仅超管可批，义工/财务本店店长/家长即可批——用来决定"待审核"锁定文案该显示哪一档
const ELEVATED_REQUESTED_ROLES = new Set(['store_manager', 'store_patriarch']);

// 🛡️ user_roles 集合里"角色审核通过"的真实哨兵值是 'approved'（见 processRoleAudit /
// setupSuperAdmin 云函数落库逻辑），而不是 'active'（那是 stores 集合门店启停用的哨兵值）——
// 全国总览入口必须同时满足 role==='super_admin' 且 status==='approved' 才展示，
// 避免已被降级/尚未审核通过、但 user_roles 文档 role 字段仍残留 'super_admin' 的账号越权可见
function isVerifiedSuperAdmin(roleInfo: { role?: string; status?: string } | null | undefined): boolean {
  return !!(roleInfo && roleInfo.role === 'super_admin' && roleInfo.status === 'approved');
}

Component({
  // 🐛 Bug 修复：超管进入"雨花公益食堂专区"后打开本组件的【选择服务站点与身份】
  // 弹窗，此前 fetchStoreListFromCloud() 调用 getStoreList 云函数时完全没有
  // 传 orgType，只靠调用者自己的 tenantId 过滤——而"嵩屿街道敬老中心助餐点"
  // 这类历史脏数据即便不属于雨花斋（orgType 非 'yuhuazhai'），只要 tenantId
  // 恰好挂在超管所属的默认全国机构 yuhuazhai_national 下就会被一并放行，
  // 导致通用/社区长者食堂门店混进雨花专区的站点列表。宿主页面（index.ts）
  // 通过这个 property 把"当前所在专区"透传进来，组件按此收窄查询
  properties: {
    orgTypeFilter: { type: String, value: '' }
  },

  data: {
    showPickerSheet: false,
    showAuthModal: false,
    authTab: 'CODE',
    authCodeInput: '',
    applicantNameInput: '',
    applicantPhoneInput: '',
    targetAuthStoreId: '',
    targetAuthStoreName: '',
    targetAuthRole: '',
    targetAuthRoleLabel: '',
    // ➕ "找不到门店？申请新建/加入新门店" 入口表单状态
    showNewStoreForm: false,
    // 🏢 平台类型 picker 的绑定索引（与 orgTypeOptions 数组下标对应）
    orgTypeIndex: 0,
    orgTypeOptions: ORG_TYPE_OPTIONS,
    newStoreForm: {
      customStoreName: '',
      applyRole: 'volunteer' as 'store_patriarch' | 'store_manager' | 'finance' | 'volunteer' | 'store_family',
      // 🙋 申请人本人信息：processRoleAudit submitRoleApply 必填，与门店联系电话
      // （contactPhone，门店对外公示的号码）是两个不同的号码，不能互相顶替
      realName: '',
      phone: '',
      // 🔐 管理员密钥：大家长/店长/财务申请时由用户输入，提交后在服务端与 stores.adminKey 校验
      adminKey: '',
      // 🏪 新建门店档案补全：门店此刻还不存在，字段先收进申请表单本身，见
      // onSubmitNewStoreApply / processRoleAudit submitRoleApply 的完整性校验
      address: '',
      contactPhone: '',
      storePhotos: [] as string[],
      // 🆕 所属地区：<picker mode="region"> 原生省市区级联选择，regionArray 是
      // picker 本身要求的 [province, city, district] 数组绑定值，province/city/
      // district 是拆开后单独提交给 processRoleAudit 的字段（与 address 平级）
      regionArray: [] as string[],
      province: '',
      city: '',
      district: ''
    },
    newStorePhotoUploading: false,
    isSubmittingNewStore: false,

    // 🔒 申请人本人是否有正在 pending 的申请：用来在角色胶囊上锁定"⏳ 待审核"状态，
    // 防止重复提交。见 getMyApplicationStatus（processRoleAudit 新增 action）
    myPendingApplication: null as { requestedRole: string; storeId: string; storeSelectionType: string } | null,
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
      this.fetchMyApplicationStatus();
    },

    // 🔒 查询自己是否有正在 pending 的申请，用于锁定角色胶囊、防止重复提交。
    // 静默失败——查不到就当没有 pending，不阻断门店选择器本身的使用
    async fetchMyApplicationStatus() {
      try {
        const res = await callFunctionWithTimeout({
          name: 'processRoleAudit',
          data: { action: 'getMyApplicationStatus' }
        });
        const result = res.result as any;
        if (result && result.success && result.hasPending) {
          this.setData({
            myPendingApplication: {
              requestedRole: result.requestedRole || '',
              storeId: result.storeId || '',
              storeSelectionType: result.storeSelectionType || 'existing'
            }
          });
        } else {
          this.setData({ myPendingApplication: null });
        }
        this.refreshRolePermissions();
      } catch (err) {
        console.warn('[store-picker] fetchMyApplicationStatus 失败:', err);
      }
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

        // 🐛 Bug 修复：按宿主页面透传的当前专区（orgTypeFilter）收窄查询——
        // 在调用者自己 tenantId 过滤的基础上叠加 orgType 精确匹配，即使
        // tenantId 名下混入了跨专区的历史脏数据（如"嵩屿街道敬老中心助餐点"
        // 挂在雨花斋默认全国机构 yuhuazhai_national 下）也不会显示出来。
        // orgTypeFilter 为空（宿主未处于任何专区）时不传，行为与此前一致
        const res = await callFunctionWithTimeout({
          name: 'getStoreList',
          data: this.properties.orgTypeFilter ? { orgType: this.properties.orgTypeFilter } : {}
        });
        const result = res.result as any;
        // 🐛 防御性校验：此前只信"result.list 非空即可用"，未校验它真的是数组——
        // 一旦云函数在异常响应形状下返回非数组的 list，紧接着的 .map() 会直接
        // 抛错中断整个 fetchStoreListFromCloud，allStores/groupedStoreList
        // 停留在上一次的值，本组件正是宿主页面进入雨花/通用专区时新挂载的
        // <store-picker>，这类未兜底的异常在"首次进入工作区"这个时间点最容易暴露
        const rawList = (result && result.success) ? result.list : null;
        const list = Array.isArray(rawList) ? rawList : [];

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
        // 🐛 修复：这个分支本身就已经用 isVerifiedSuperAdmin(roleInfo) 核验过身份
        // （见上方 isSuperAdmin 赋值），isAuthorized 却硬编码成 false，导致已验真的
        // 超管点击自己的【管理员】胶囊也会被当成"未授权"弹去激活码弹窗，而
        // refreshRolePermissions() 又只遍历 allStores、从不回填这个独立存放的虚拟
        // 条目，isAuthorized 永远得不到纠正。这里既然已经验真，直接标记为已授权
        const nationalOverviewEntry = isSuperAdmin
          ? {
              storeId: 'national_overview',
              storeName: '全国总览',
              roles: [{ role: 'ADMIN', label: '管理员', isAuthorized: true }]
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

      // 🔒 待审核锁定：只有"申请成为已有门店的店长/家长/财务"这种绑定了 storeId 的
      // pending 申请才对应到某个具体胶囊；新建门店的 pending（storeId 为空）不落在
      // 任何门店卡片上，只影响"新建门店"表单本身（见 onSubmitNewStoreApply 里的拦截）
      const pending = this.data.myPendingApplication;
      const pillRoleToRequestedRole: Record<string, string> = {
        MANAGER: 'store_manager',
        FINANCE: 'finance',
        PATRIARCH: 'store_patriarch'
      };

      const updatedStores = this.data.allStores.map((store: any) => {
        const roles = store.roles.map((r: any) => {
          // ❤️ 家人（服务对象）与义工同级：自我声明式身份，无需邀请码/审批
          if (r.role === 'VOLUNTEER' || r.role === 'FAMILY') return { ...r, isAuthorized: true, isPending: false };
          if (isSuperAdmin && (r.role === 'MANAGER' || r.role === 'FINANCE' || r.role === 'PATRIARCH')) {
            return { ...r, isAuthorized: true, isPending: false };
          }

          const isPending = !!(
            pending &&
            pending.storeId === store.storeId &&
            pillRoleToRequestedRole[r.role] === pending.requestedRole
          );
          const pendingLabel = isPending
            ? (ELEVATED_REQUESTED_ROLES.has(pending!.requestedRole) ? '⏳ 待超管审核' : '⏳ 待店长审核')
            : '';

          if (r.role === 'PATRIARCH') {
            return { ...r, isAuthorized: isVerifiedPatriarch && patriarchStoreId === store.storeId, isPending, pendingLabel };
          }
          const key = `${store.storeId}_${r.role}`;
          const isAuth = Array.isArray(authKeys) && authKeys.includes(key);
          return { ...r, isAuthorized: isAuth, isPending, pendingLabel };
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

      // 🛡️ "全国总览"虚拟条目不再混入滚动列表——改由置顶固定卡片（superadmin-pinned-card）
      // 专门承载超管身份切换，视觉上始终置顶且不随普通门店一起被搜索/筛选过滤
      const groupedStoreList = filtered;
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
      const { storeId, storeName, role, authorized, pending } = e.currentTarget.dataset;
      const roleLabels: Record<string, string> = {
        'MANAGER': '店长',
        'FINANCE': '财务',
        'VOLUNTEER': '义工',
        'ADMIN': '管理员',
        'SUPER_ADMIN': '管理员',
        'PATRIARCH': '大家长',
        'FAMILY': '家人'
      };

      // 🔒 已有一份 pending 申请在审核中：直接提示，不再弹激活码/申请弹窗，
      // 防止同一身份重复提交多条申请
      if (pending) {
        wx.showToast({ title: '您的申请正在审核中，请勿重复提交', icon: 'none' });
        return;
      }

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
          applicantPhoneInput: '',
          targetAuthStoreId: storeId,
          targetAuthStoreName: storeName,
          targetAuthRole: role,
          targetAuthRoleLabel: roleLabels[role] || '管理身份'
        });
        return;
      }

      // 已授权：顺畅切换——本地存储 + _applyRoleSwitch 内部触发的 storechange
      // 事件负责通知宿主页面刷新数据，本方法自身绝不发起任何页面跳转
      this._applyRoleSwitch(storeId, storeName, role);

      // 🛡️ 显式白名单，而不是"其余角色隐式地什么都不做"：只有家长（PATRIARCH）
      // 才需要导向个人中心的【家长管理/资源兜底】卡片（原独立页面
      // pages/patriarch-dashboard 已废弃并入个人中心，家长切身份不只是"切视角"，
      // 这是家长角色的主入口）——店长/财务/义工/家人/全国总览-管理员这几个纯粹
      // "切视角"的身份，严禁触发 wx.switchTab/wx.navigateTo 跳去个人页，
      // 只留在当前页（首页/历史记录页等）即时刷新数据。若当前就已经在个人中心
      // （例如从该页自己内嵌的 store-picker 发起切换），也不重复跳转
      if (role !== 'PATRIARCH') {
        return;
      }
      const pages = getCurrentPages();
      const currentPage = pages[pages.length - 1];
      const currentRoute = currentPage ? '/' + currentPage.route : '';
      if (currentRoute !== '/pages/profile/profile') {
        safeNavigateTo({ url: '/pages/profile/profile' });
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

        const res = await callFunctionWithTimeout({
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

    // 🛡️ 超管置顶卡片：点击【系统超管】身份胶囊时直接切换至 national_overview 视角。
    // 全国总览是纯全局管理视角，不参与具体门店的义工现场服务，唯一合法身份即 ADMIN——
    // WXML 侧也已彻底删除"义工"胶囊，这里的 dataset.role 现在恒为 'ADMIN'
    onSuperAdminRoleTap(e: any) {
      const role = (e.currentTarget.dataset.role as string) || 'ADMIN';
      this._applyRoleSwitch('national_overview', '全国总览', role);
    },

    // 🐛 根因修复："切到全国总览/新建门店后，记账/公告/活动日志仍读到旧门店"：
    // 本组件此前有三处（本方法 _applyRoleSwitch、新建门店自动审批分支、超管
    // 直接建店 directCreateStoreAsSuperAdmin）各自手写 Storage 持久化，且各自
    // 遗漏的 key 都不一样——最典型的是全都漏写了 current_store_id（只写了
    // active_store_id）。dataService.ts saveReport() 兜底取 storeId、以及
    // daily-menu.ts/notice.ts/activity-log.ts 这三个页面读取"当前门店"时都
    // 只认 current_store_id 且没有任何 fallback（不像 history.ts/index.ts 那样
    // 还会兜底读 active_store_id 或调用 getSelectedStore()）——一旦经由本组件
    // 切换门店/角色，这几处会继续读到切换前的旧 storeId，把新记账/公告/活动
    // 日志错误地挂到旧门店名下，是"全局 storeId 与页面上下文不同步"的根因。
    // 收敛成一个统一的持久化方法，三处调用点都改走这里，一次性写全 5 个
    // canonical key（与 index.ts onStoreChanged 的既有持久化口径完全对齐），
    // 不再各自维护一份不完整的 key 清单。
    // 🐛 二次收敛：canonical key 的实际写入现在下沉到 storeManager.ts 的
    // setCurrentActiveStore()——index.ts 的 onStoreChanged/switchStoreTarget 与
    // 本方法三处都改调用同一个函数，彻底消灭"各自手写、各自漏 key"的重复实现，
    // 也是"首页/个人中心门店显示不一致"这类跨页面状态不同步 Bug 的根治点
    _persistStoreSelection(storeId: string, storeName: string, role: string) {
      const app = getApp() as any;
      if (app && app.switchStore) {
        app.switchStore(storeId, storeName, role);
      } else if (app && app.globalData) {
        app.globalData.currentStore = { storeId, storeName, role };
      }

      // 🛡️ role 入参在实践中恒为本组件胶囊裸值（PATRIARCH/FAMILY 等），
      // setCurrentActiveStore() 内部的归一化表已覆盖裸值与 STORE_ 前缀两种写法，
      // 不会静默落进它自己的 'volunteer' 兜底
      setCurrentActiveStore(storeId, storeName, role);
    },

    // 内部：执行角色切换 (公共逻辑)
    _applyRoleSwitch(storeId: string, storeName: string, role: string) {
      // 🆕 先只更新选中态，不立即收起面板——让用户先看到身份 tag 上的高亮边框/
      // ✔ 勾选反馈落地，200ms 后再自动关闭弹窗，体验上更接近"确认已生效"而不是
      // 点击瞬间面板突然消失
      this.setData({
        currentStore: {
          storeId,
          storeName,
          role: role as 'MANAGER' | 'FINANCE' | 'VOLUNTEER' | 'ADMIN' | 'PATRIARCH' | 'FAMILY'
        }
      });

      this._persistStoreSelection(storeId, storeName, role);

      this.triggerEvent('storechange', {
        storeId,
        storeName,
        role,
        currentRole: role
      });

      // 🆕 延迟 200ms 关闭选择弹窗 + 成功态 Toast，与上面"先展示选中态"的延迟
      // 关闭配合；宿主页面（index.ts onStoreChanged）已经在 triggerEvent 同步
      // 触发时完成角色标记位重算，这里的延迟只影响本组件自身面板的关闭时机
      setTimeout(() => {
        this.setData({ showPickerSheet: false });
        wx.showToast({ title: '已切换身份', icon: 'success' });
      }, 200);
    },

    // 激活弹窗：输入口令
    onAuthCodeInput(e: any) {
      this.setData({ authCodeInput: e.detail.value });
    },

    // 激活弹窗：输入申请人姓名
    onApplicantNameInput(e: any) {
      this.setData({ applicantNameInput: e.detail.value });
    },

    // 激活弹窗：输入申请人手机号（processRoleAudit submitRoleApply 必填）
    onApplicantPhoneInput(e: any) {
      this.setData({ applicantPhoneInput: e.detail.value });
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

        // ================= 2. 特权邀请码云端核验/核销 =================
        // 🛡️ 全链路重构：此前这里直接 wx.cloud.database().collection('store_invites')
        // .where(...).get()/.update() 校验+核销一次性口令——真正的权限判定只停留在
        // 客户端 JS，任何人打开开发者工具对同一个小程序会话直接调用 wx.cloud.database()
        // API 就能绕过（伪造 isUsed:false 查询条件、甚至直接把任意记录标记为已使用）。
        // 现改为服务端 cloudfunctions/manageStoreInviteCode 的 redeem 动作统一核验+核销，
        // 客户端这里只传一个邀请码，storeId/角色完全由服务端根据邀请码记录本身解析，
        // 不再信任/依赖 targetAuthStoreId/targetAuthRole 这两个"用户点了哪个胶囊进来"
        // 的客户端上下文作为权威值——邀请码本身才是唯一真源。
        if (!inputCode || inputCode.length < 4) {
          wx.showToast({ title: '请输入有效的邀请码', icon: 'none' });
          return;
        }

        wx.showLoading({ title: '安全核验中...' });

        try {
          const res = await callFunctionWithTimeout({
            name: 'manageStoreInviteCode',
            data: { action: 'redeem', code: inputCode }
          });
          const result = res.result as any;
          wx.hideLoading();

          if (!result || !result.success) {
            wx.showToast({ title: (result && result.error) || '邀请码无效或已被使用', icon: 'none', duration: 2500 });
            return;
          }

          const { storeId, storeName, role: serverRole } = result.data;
          // 服务端角色值（STORE_MANAGER/FINANCE/FAMILY/VOLUNTEER 或落库后的
          // store_manager/finance 等小写 role 字段）-> 本组件的本地胶囊角色词汇
          // （MANAGER/FINANCE/FAMILY/VOLUNTEER），复用既有的 _applyRoleSwitch/
          // roleText 文案映射，不需要另起一套
          const SERVER_ROLE_TO_PILL: Record<string, string> = {
            STORE_MANAGER: 'MANAGER',
            store_manager: 'MANAGER',
            FINANCE: 'FINANCE',
            finance: 'FINANCE',
            FAMILY: 'FAMILY',
            VOLUNTEER: 'VOLUNTEER',
            volunteer: 'VOLUNTEER'
          };
          const pillRole = SERVER_ROLE_TO_PILL[serverRole] || this.data.targetAuthRole;

          // 本地缓存特权关系：refreshRolePermissions() 仍按这份本地缓存即时判断
          // MANAGER/FINANCE 胶囊是否解锁——服务端 user_roles 现在才是真正的权限
          // 来源，这里只是让门店选择器胶囊墙的展示立即跟上，不用等下一次
          // fetchStoreListFromCloud 重新拉取
          const authKeys: string[] = wx.getStorageSync('my_authorized_roles') || [];
          const newKey = `${storeId}_${pillRole}`;
          if (!authKeys.includes(newKey)) {
            authKeys.push(newKey);
            wx.setStorageSync('my_authorized_roles', authKeys);
          }

          // 🛡️ 核销是服务端真正的角色晋升（写入 user_roles.role/roles 数组），
          // 不再只是本地演示态标记——核销成功后立即拉一次最新角色，让
          // AuthService 缓存（profile.ts/index.ts 等页面据此展示角色）跟上
          // 服务端的真实结果
          await AuthService.fetchUserRole();

          wx.showToast({ title: '🎉 身份激活成功！', icon: 'success' });
          this.setData({ showAuthModal: false });
          this.refreshRolePermissions();

          // 自动切换到刚核销到手的特权身份：以服务端返回的 storeId/storeName/role
          // 为准（邀请码本身就唯一决定了这三者）
          this._applyRoleSwitch(storeId, storeName, pillRole);
        } catch (err) {
          wx.hideLoading();
          console.warn('⚠️ [store-picker] 邀请码核销异常:', err);
          // 🛡️ 安全修复：此前云端校验异常时会退回硬编码临时动态码（YUHUA2026 等）直接放行，
          // 等同于又一处可反编译提取的权限后门，现已移除。校验失败时统一提示重试，
          // 绝不在网络异常时静默授予权限。
          wx.showToast({ title: '网络异常，请稍后重试', icon: 'none' });
        }
        return;
      }

      // 通道二：提交在线申请给店长
      //
      // 🐛 根因修复：此前这里直接写 role_requests 集合，那是一条从未被任何审批逻辑
      // （processRoleAudit / getPatriarchDashboard / store-management.ts）读取过的
      // 死路径——提交后永远不会被处理。现改为统一走 processRoleAudit(action:'apply')，
      // 与首页 onSubmitRoleApply、家长任命申请同一套服务端审批口径，写入的是真正
      // 会被审批的 user_roles 记录，同时也让"申请中锁定按钮"这个新功能能识别到它
      const name = (this.data.applicantNameInput || '').trim();
      if (!name) {
        wx.showToast({ title: '请输入姓名/义工号', icon: 'none' });
        return;
      }
      const phone = (this.data.applicantPhoneInput || '').trim();
      if (!phone) {
        wx.showToast({ title: '请输入手机号', icon: 'none' });
        return;
      }
      const targetRole = this.data.targetAuthRole;
      const requestedRoleMap: Record<string, string> = { MANAGER: 'store_manager', FINANCE: 'finance' };
      const requestedRole = requestedRoleMap[targetRole];
      if (!requestedRole) {
        wx.showToast({ title: '暂不支持该身份的在线申请', icon: 'none' });
        return;
      }

      wx.showLoading({ title: '提交申请中...' });

      try {
        const cachedRole = AuthService.getCachedRoleInfo();
        const tenantId = (cachedRole && cachedRole.tenantId) || '';

        const res = await callFunctionWithTimeout({
          name: 'processRoleAudit',
          data: {
            action: 'apply',
            storeId: this.data.targetAuthStoreId,
            storeName: this.data.targetAuthStoreName,
            storeSelectionType: 'existing',
            tenantId,
            requestedRole,
            realName: name,
            phone
          }
        });
        const result = res.result as any;
        wx.hideLoading();

        if (!result || !result.success) {
          wx.showToast({ title: (result && result.error) || '提交失败，请重试', icon: 'none' });
          return;
        }

        wx.showModal({
          title: '📩 申请已提交',
          content: `已将您的特权申请提交给【${this.data.targetAuthStoreName}】管理组，请等待现任店长在工作台审核通过。`,
          showCancel: false,
          confirmText: '我知道了',
          confirmColor: '#8C1D18'
        });
        this.setData({ showAuthModal: false });
        this.fetchMyApplicationStatus();
      } catch (err) {
        wx.hideLoading();
        console.warn('⚠️ [store-picker] 申请提交异常:', err);
        wx.showToast({ title: '提交失败，请重试', icon: 'none' });
      }
    },

    // 🏢 平台类型下拉 picker 切换
    onOrgTypeChange(e: any) {
      this.setData({ orgTypeIndex: parseInt(e.detail.value, 10) || 0 });
    },

    // ➕ 切换"门店列表" / "申请新门店表单"
    onToggleNewStoreForm() {
      this.setData({
        showNewStoreForm: !this.data.showNewStoreForm,
        orgTypeIndex: 0,
        newStoreForm: {
          customStoreName: '', applyRole: 'volunteer', realName: '', phone: '', adminKey: '',
          address: '', contactPhone: '', storePhotos: [], regionArray: [], province: '', city: '', district: ''
        }
      });
    },

    onNewStoreNameInput(e: any) {
      this.setData({ 'newStoreForm.customStoreName': e.detail.value });
    },

    onNewStoreRealNameInput(e: any) {
      this.setData({ 'newStoreForm.realName': e.detail.value });
    },

    onNewStorePhoneInput(e: any) {
      this.setData({ 'newStoreForm.phone': e.detail.value });
    },

    onSelectNewStoreRole(e: any) {
      // 切换角色时清空密钥，避免上一次输入的值残留给不同岗位
      this.setData({ 'newStoreForm.applyRole': e.detail.value, 'newStoreForm.adminKey': '' });
    },

    onAdminKeyInput(e: any) {
      this.setData({ 'newStoreForm.adminKey': e.detail.value });
    },

    onNewStoreAddressInput(e: any) {
      this.setData({ 'newStoreForm.address': e.detail.value });
    },

    // 🆕 原生省市区级联选择：e.detail.value 固定是 [province, city, district]
    // 三元字符串数组，随申请一并提交给 processRoleAudit，供全国大屏"按地区筛选"使用
    onNewStoreRegionChange(e: any) {
      const [province, city, district] = e.detail.value || [];
      this.setData({
        'newStoreForm.regionArray': e.detail.value || [],
        'newStoreForm.province': province || '',
        'newStoreForm.city': city || '',
        'newStoreForm.district': district || ''
      });
    },

    onNewStoreContactPhoneInput(e: any) {
      this.setData({ 'newStoreForm.contactPhone': e.detail.value });
    },

    // 🏪 新建门店档案照片：与 activity-log.ts/index.ts 同一套 chooseMedia +
    // compressAndUploadImages 模式，门店此刻还不存在，先挂在申请表单上
    async onChooseNewStorePhoto() {
      const MAX_PHOTOS = 9;
      const remaining = MAX_PHOTOS - this.data.newStoreForm.storePhotos.length;
      if (remaining <= 0) {
        wx.showToast({ title: `最多上传 ${MAX_PHOTOS} 张门店照片`, icon: 'none' });
        return;
      }

      try {
        const chooseRes = await wx.chooseMedia({
          count: remaining,
          mediaType: ['image'],
          sourceType: ['album', 'camera']
        });

        const paths = (chooseRes.tempFiles || []).map(f => f.tempFilePath);
        if (paths.length === 0) return;

        const insertStart = this.data.newStoreForm.storePhotos.length;
        this.setData({
          'newStoreForm.storePhotos': [...this.data.newStoreForm.storePhotos, ...paths],
          newStorePhotoUploading: true
        });

        try {
          let uploaded: { url: string; thumbUrl: string }[];
          const prefix = 'store_apply_photos/' + Date.now();
          try {
            // 优先走 Canvas 批量压缩上传（质量最优）
            uploaded = await compressAndUploadImages(CANVAS_ID, paths, prefix);
          } catch (canvasErr) {
            // Canvas 节点不可用时降级：用静态导入的 compressAndUploadScaledImage 直传原图，
            // 避免整体失败（注意：不使用 dynamic import()，小程序编译环境不支持）
            console.warn('[store-picker] canvas 批量压缩失败，降级为逐图直传:', canvasErr);
            try {
              uploaded = await Promise.all(paths.map(p => compressAndUploadScaledImage(p, prefix)));
            } catch (scaleErr) {
              // 两级压缩均失败时，直接将原图 tempFilePath 占位（仅供本次表单展示，
              // 不上传云存储），并 toast 提示，绝不崩溃
              console.warn('[store-picker] 图片上传失败，保留原图预览:', scaleErr);
              const finalPhotos = [...this.data.newStoreForm.storePhotos];
              // 原图 tempFilePath 已在 insertStart 处写入（前面 setData），保持不变
              this.setData({ 'newStoreForm.storePhotos': finalPhotos, newStorePhotoUploading: false });
              wx.showToast({ title: '图片上传失败，可继续填写其他信息后重试', icon: 'none', duration: 2500 });
              return;
            }
          }
          const finalPhotos = [...this.data.newStoreForm.storePhotos];
          uploaded.forEach((u, i) => { finalPhotos[insertStart + i] = u.url; });
          this.setData({ 'newStoreForm.storePhotos': finalPhotos });
        } catch (uploadErr) {
          const rolledBack = this.data.newStoreForm.storePhotos.filter((_: string, i: number) => i < insertStart || i >= insertStart + paths.length);
          this.setData({ 'newStoreForm.storePhotos': rolledBack });
          throw uploadErr;
        }

        this.setData({ newStorePhotoUploading: false });
      } catch (err) {
        this.setData({ newStorePhotoUploading: false });
        console.error('[store-picker] onChooseNewStorePhoto 异常:', err);
        wx.showToast({ title: '图片处理失败，请重试', icon: 'none' });
      }
    },

    onDeleteNewStorePhoto(e: any) {
      const index = e.currentTarget.dataset.index;
      const next = this.data.newStoreForm.storePhotos.filter((_: string, i: number) => i !== index);
      this.setData({ 'newStoreForm.storePhotos': next });
    },

    // 提交"新建门店"：
    // - super_admin：直接建店并自动绑定为该店管理者，免去二次审批流程（见 directCreateStoreAsSuperAdmin），
    //   不受下方门店档案补全校验约束——即时生效，档案可日后在门店档案页补充。
    // - 其他角色：统一走 processRoleAudit(action:'apply')（与首页 onSubmitRoleApply 同一套服务端
    //   审批口径），不再由客户端直接写 user_roles 的 status/role 字段。
    //   🛡️ 根因修复：此前这里客户端直接 db.collection('user_roles').add(...)，绕过服务端校验，
    //   与项目其余"服务端为唯一权威"的加固方向相悖，也导致这类申请无法被"申请中锁定"识别到。
    async onSubmitNewStoreApply() {
      if (this.data.isSubmittingNewStore) return;

      const customStoreName = (this.data.newStoreForm.customStoreName || '').trim();
      const applyRole = this.data.newStoreForm.applyRole;
      const realName = (this.data.newStoreForm.realName || '').trim();
      const phone = (this.data.newStoreForm.phone || '').trim();
      const adminKey = (this.data.newStoreForm.adminKey || '').trim();
      const address = (this.data.newStoreForm.address || '').trim();
      const contactPhone = (this.data.newStoreForm.contactPhone || '').trim();
      const storePhotos = this.data.newStoreForm.storePhotos || [];
      const province = this.data.newStoreForm.province || '';
      const city = this.data.newStoreForm.city || '';
      const district = this.data.newStoreForm.district || '';

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

      if (!realName) {
        wx.showToast({ title: '请填写真实姓名', icon: 'none' });
        return;
      }
      if (!phone) {
        wx.showToast({ title: '请填写手机号', icon: 'none' });
        return;
      }

      // 🛡️ 申请高阶角色（店长/财务/大家长）需先补全门店档案；义工直接加入无需补档案
      const needsStoreDetails = applyRole !== 'volunteer' && applyRole !== 'store_family';
      if (needsStoreDetails && (!address || !contactPhone || storePhotos.length === 0)) {
        wx.showModal({
          title: '门店档案未补全',
          content: '申请新建门店需先补全门店档案（地址、联系电话、门店照片）',
          showCancel: false
        });
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

      // 🤝 家人/义工属于自治角色：服务端直接 status:'approved' 写入，无需人工审批
      const isAutoApproveRole = applyRole === 'volunteer' || applyRole === 'store_family';

      this.setData({ isSubmittingNewStore: true });
      wx.showLoading({ title: '提交申请中...', mask: true });

      try {
        const orgType = ORG_TYPE_OPTIONS[this.data.orgTypeIndex]?.value || 'other';
        const res = await callFunctionWithTimeout({
          name: 'processRoleAudit',
          data: {
            action: 'apply',
            storeId: '',
            storeName: customStoreName,
            storeSelectionType: 'custom',
            customStoreName,
            address,
            contactPhone,
            storePhotos,
            province,
            city,
            district,
            orgType,
            tenantId,
            requestedRole: applyRole,
            realName,
            phone,
            adminKey,
            autoApprove: isAutoApproveRole
          }
        });
        const result = res.result as any;
        wx.hideLoading();

        if (!result || !result.success) {
          wx.showToast({ title: (result && result.error) || '提交失败，请重试', icon: 'none' });
          return;
        }

        // 🏛️ 大家长/店长新建门店一键自审：云函数直接建店并授权，前端立即切换到新门店
        if (result.autoApproved && result.storeId) {
          const newStoreId = result.storeId;
          const newStoreName = result.storeName || customStoreName;
          this.setData({
            currentStore: { storeId: newStoreId, storeName: newStoreName, role: 'PATRIARCH' },
            showNewStoreForm: false,
            showPickerSheet: false
          });
          this._persistStoreSelection(newStoreId, newStoreName, 'PATRIARCH');
          wx.showToast({ title: '新门店已建好，您已自动成为大家长兼店长！', icon: 'success', duration: 3000 });
          this.triggerEvent('storechange', { storeId: newStoreId, storeName: newStoreName, role: 'PATRIARCH', currentRole: 'PATRIARCH' });
          this.triggerEvent('storelistchange', {});
          return;
        }

        this.setData({ showNewStoreForm: false, showPickerSheet: false });
        const successMsg = isAutoApproveRole
          ? '已成功加入！欢迎来到雨花斋大家庭 🌸'
          : '申请已提交，请等待管理者审批！';
        wx.showToast({ title: successMsg, icon: 'success', duration: 2500 });
        this.fetchMyApplicationStatus();
      } catch (err) {
        wx.hideLoading();
        console.error('[store-picker] onSubmitNewStoreApply 提交失败:', err);
        wx.showToast({ title: '提交失败，请重试', icon: 'none' });
      } finally {
        this.setData({ isSubmittingNewStore: false });
      }
    },

    // 🛡️ 超级管理员新建门店：直接调用 createStore 云函数建店并绑定为管理者，
    // 免去"提交申请 -> 等待审批"的二次流程。云函数内部会自愈修复缺失的 tenantId
    // （回退到默认机构 yuhuazhai_national），不会再误报"账号尚未关联任何机构"。
    async directCreateStoreAsSuperAdmin(customStoreName: string) {
      wx.showLoading({ title: '新建门店中...', mask: true });

      try {
        const orgType = ORG_TYPE_OPTIONS[this.data.orgTypeIndex]?.value || 'other';
        const res = await callFunctionWithTimeout({
          name: 'createStore',
          data: { storeName: customStoreName, bindAsManager: true, orgType }
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

        this._persistStoreSelection(newStoreId, newStoreName, 'ADMIN');

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