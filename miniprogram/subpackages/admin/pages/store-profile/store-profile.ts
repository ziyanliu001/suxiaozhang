import { AuthService } from '../../../../utils/authService';
import { getSelectedStore } from '../../../../utils/storeManager';
import { createNavGuard, NavGuardInstance } from '../../../../utils/navGuard';
import { recordRecentVisit } from '../../../../utils/recentPages';
import { compressAndUploadImages } from '../../../../utils/imageCompress';
import { callFunctionWithTimeout } from '../../../../utils/withTimeout';
import { getStorageAsync } from '../../../../utils/util';
import { ensurePrivacyAuthorized } from '../../../../utils/privacyAuthHub';

const CANVAS_ID = 'storeProfileImgCompressCanvas';
const MAX_STORE_PHOTOS = 9;

// 门店人员与服务人群画像：7 项人数指标，字段名与 manageStoreProfile 云函数一致
const PROFILE_FIELDS = [
  'partyMembers',
  'socialWorkers',
  'volunteersCount',
  'dineInSeniorsCount',
  'deliverySeniorsCount',
  'listeningSeniorsCount',
  'otherCount'
] as const;

type ProfileField = typeof PROFILE_FIELDS[number];

// 门店档案信息：文本/日期类字段，字段名与 manageStoreProfile 云函数的 TEXT_PROFILE_FIELDS 一致。
// contactPhone（门店对外公示联系电话）是 processRoleAudit 申请高阶角色/新建门店档案补全校验
// 依赖的字段之一，此前门店档案页从未提供编辑入口，只能通过建店/申请流程写入，这里补齐
const TEXT_PROFILE_FIELDS = ['address', 'contactPhone', 'openDate', 'registeredName', 'background', 'characteristics', 'province', 'city'] as const;
type TextProfileField = typeof TEXT_PROFILE_FIELDS[number];

// 🏢 平台类型：与 store-picker、getNationalDashboard 大屏筛选共用同一套 value 字面量
const ORG_TYPE_OPTIONS = [
  { name: '🌸 雨花斋', value: 'yuhuazhai' },
  { name: '👵👴 社区助老食堂/敬老家园', value: 'elderly_canteen' },
  { name: '🤝 社区义工服务站', value: 'volunteer_station' },
  { name: '🛟 应急救援队', value: 'rescue_team' },
  { name: '🧒 同心儿童院/青少年关爱', value: 'tongxin_children' },
  { name: '🎗️ 同心癌友关怀会', value: 'tongxin_cancer_care' },
  { name: '💫 其他爱心组织', value: 'other' }
];

// 🏮 品牌矩阵归属：将多个 orgType 的站点归并到同一品牌，
// 用于全国大屏"同心慈善会矩阵 / 雨花矩阵"聚合筛选
const PLATFORM_FAMILY_OPTIONS = [
  { name: '不设（独立站点）', value: '' },
  { name: '🏮 同心慈善会', value: 'tongxin' },
  { name: '🌸 雨花品牌', value: 'yuhuazhai' }
];
const PLATFORM_FAMILY_LABEL_MAP: Record<string, string> = Object.fromEntries(
  PLATFORM_FAMILY_OPTIONS.filter(o => o.value).map(o => [o.value, o.name])
);

// 🏷️ 各业态默认服务受众标签：未配置自定义 serviceTargetConfig 时的兜底文案
export const ORG_TYPE_DEFAULT_TARGET_LABELS: Record<string, {
  dineInLabel: string; deliveryLabel: string; listenLabel: string; takeoutLabel: string;
}> = {
  yuhuazhai:        { dineInLabel: '堂食长者',     deliveryLabel: '送餐长者',     listenLabel: '倾听陪伴',      takeoutLabel: '打包份数'     },
  elderly_canteen:  { dineInLabel: '堂食老人',     deliveryLabel: '送餐老人',     listenLabel: '倾听陪伴',      takeoutLabel: '打包份数'     },
  volunteer_station:{ dineInLabel: '服务人次',     deliveryLabel: '上门服务',     listenLabel: '陪伴关怀',      takeoutLabel: '物资包'       },
  rescue_team:      { dineInLabel: '现场救援人次', deliveryLabel: '外出救援',     listenLabel: '心理疏导',      takeoutLabel: '物资包'       },
  tongxin_children:     { dineInLabel: '院内儿童用餐',   deliveryLabel: '外送关爱儿童',    listenLabel: '心理疏导/陪伴',  takeoutLabel: '打包爱心餐'   },
  tongxin_cancer_care:  { dineInLabel: '探访关怀人次',   deliveryLabel: '营养膳食/抗癌物资', listenLabel: '心理疏导人次',   takeoutLabel: '社工陪伴工时'  },
  other:                { dineInLabel: '堂食服务',       deliveryLabel: '送餐服务',        listenLabel: '关爱陪伴',       takeoutLabel: '打包份数'     },
};
const DEFAULT_TARGET_LABELS = { dineInLabel: '堂食服务人次', deliveryLabel: '送餐服务', listenLabel: '关爱陪伴', takeoutLabel: '打包份数' };
const ORG_TYPE_LABEL_MAP: Record<string, string> = Object.fromEntries(ORG_TYPE_OPTIONS.map(o => [o.value, o.name]));

const TEXT_PROFILE_FIELD_LABELS: Record<TextProfileField, string> = {
  address: '详细地址',
  contactPhone: '联系电话',
  openDate: '开业日期',
  registeredName: '民政登记名称',
  background: '发起背景',
  characteristics: '家园特色',
  province: '省份',
  city: '城市'
};

const OPERATING_STATUS_LABELS: Record<string, string> = {
  operating: '运营中',
  preparing: '筹备中',
  paused: '暂停运营'
};

// 🐛 门店档案图片 500 报错修复：门店照片/资质图片理论上都应该是云存储 fileID
// （cloud://...），但上传中断/历史脏数据等场景可能残留本地临时路径（wxfile://、
// http(s)://127.0.0.1、localhost、__tmp__ 这类小程序沙箱内部临时文件标识）——
// 这类路径离开当次上传会话就必然失效，直接塞给 <image src> 会在控制台抛网络
// 错误。加载时统一过滤掉，不等到渲染报错才补救；binderror 兜底见 onImageLoadError，
// 覆盖"路径格式看着正常但云端文件已被删除"这类过滤规则本身catch不住的场景
function isValidPhotoUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url.trim()) return false;
  return !/127\.0\.0\.1|localhost|__tmp__|^wxfile:\/\//i.test(url);
}
function sanitizePhotoUrls(arr: unknown): string[] {
  return Array.isArray(arr) ? arr.filter(isValidPhotoUrl) : [];
}

// 🏪 门店资质与实景公示：门头照/民政备案复印件/食品安全承诺，与原有的门店环境照
// （storePhotos）是四个各自独立的照片分类，字段名与 manageStoreProfile 云函数一致；
// 沿用同一套 onChoosePhoto/onDeletePhoto 通用逻辑（用 data-category 区分），不为
// 每个分类各写一份几乎一样的上传/删除代码
const PHOTO_FIELDS = ['storePhotos', 'storefrontPhotos', 'civilAffairsPhotos', 'foodSafetyPledgePhotos'] as const;
type PhotoField = typeof PHOTO_FIELDS[number];
const PHOTO_FIELD_MAX: Record<PhotoField, number> = {
  storePhotos: 9,
  storefrontPhotos: 6,
  civilAffairsPhotos: 6,
  foodSafetyPledgePhotos: 6
};
const PHOTO_FIELD_LABELS: Record<PhotoField, string> = {
  storePhotos: '门店照片',
  storefrontPhotos: '门头照',
  civilAffairsPhotos: '民政备案复印件',
  foodSafetyPledgePhotos: '食品安全承诺'
};

// 🌾 物资健康度展示：与 material-usage-modal 组件三档选择器、statistics.ts
// STOCK_STATUS_DISPLAY_MAP 同一套 sufficient/normal/urgent 语义
const STOCK_STATUS_RANK: Record<string, number> = { sufficient: 0, normal: 1, urgent: 2 };
const STOCK_STATUS_LABEL: Record<string, string> = { sufficient: '充裕', normal: '一般', urgent: '告急' };

Page({
  _navGuard: null as NavGuardInstance | null,

  data: {
    contentTop: 0,

    currentStoreId: '',
    currentStoreName: '',
    canManage: false,
    // 🔐 仅大家长/超管可设置密钥（店长只读，不能修改）
    canSetAdminKey: false,
    loading: true,

    // 📊 门店动态健康看板：今日开餐 / 物资健康度 / 今日护持 / 今日服务，见
    // fetchHealthDashboard()。数据来自 manageVolunteerSubmission 的 statsSummary，
    // 与首页 index.ts fetchLatestMaterialStatus 同一个数据源，杜绝多处口径不一致
    todayMealStatusLabel: '待录入',
    todayMealStatusClass: 'neutral',
    materialHealthLabel: '暂无数据',
    materialHealthClass: 'neutral',
    todayVolunteerCount: 0,
    todayDiningCount: 0,

    // 展示态：7 项人数指标
    partyMembers: 0,
    socialWorkers: 0,
    volunteersCount: 0,
    dineInSeniorsCount: 0,
    deliverySeniorsCount: 0,
    listeningSeniorsCount: 0,
    otherCount: 0,

    // 展示态：门店档案信息（文本/日期）+ 运营状态 + 坐标
    address: '',
    contactPhone: '',
    openDate: '',
    registeredName: '',
    background: '',
    characteristics: '',
    province: '',
    city: '',
    // 🏢 平台类型：存储 value 字面量（如 'yuhuazhai'）+ 展示用标签（含 emoji）。
    // 已改为进入首页时的工作空间选择一次性确定，本页只读展示，不再提供编辑 picker
    orgType: '',
    orgTypeLabel: '',
    // 🏮 品牌矩阵归属：'tongxin'/'yuhuazhai'/''
    platformFamily: '',
    platformFamilyLabel: '',
    platformFamilyPickerIndex: 0,
    platformFamilyOptions: PLATFORM_FAMILY_OPTIONS,
    // 🍚 供餐餐次配置：绝大多数雨花斋只供午餐，默认单餐次。打卡弹窗"今日留店用餐"
    // Chip 行、岗位班次列表、餐报文本/公示海报的供餐人数汇总均按这里读取的真实值
    // 动态适配（见 index.ts loadStoreTargetConfig/buildMealBreakdown）
    supportedMeals: ['lunch'] as string[],
    // 🏷️ 服务受众标签配置：platformBrand（品牌名）+ targetLabels（填报表单自适应文案）
    serviceTargetConfig: null as null | {
      platformBrand?: string;
      targetLabels?: { dineInLabel?: string; deliveryLabel?: string; listenLabel?: string; takeoutLabel?: string };
      enabledFeatures?: string[];
    },
    operatingStatus: 'operating',
    operatingStatusLabel: '运营中',
    latitude: null as number | null,
    longitude: null as number | null,
    locationLabel: '',
    // 🏪 门店照片 + 门头照/民政备案复印件/食品安全承诺：均为云存储 fileID 数组，
    // 与 manageStoreProfile 云函数的同名字段一致
    storePhotos: [] as string[],
    storefrontPhotos: [] as string[],
    civilAffairsPhotos: [] as string[],
    foodSafetyPledgePhotos: [] as string[],
    // 🐛 图片加载失败兜底：与 activity-log.ts/daily-menu.ts 同款 xxxFailedMap 模式，
    // key 是失败的图片 URL，命中后 wx:if 让对应 <image> 让位给"加载失败"占位块，
    // 点击占位块可重试（见 onRetryImage）
    imageFailedMap: {} as Record<string, boolean>,
    storePhotoUploading: false,

    // 🏛️ 家长风控锁：本店若绑定了家长/督导，店长发起的画像变更会先落到这里等待确认，
    // 不为空时页面显示"有一份更新正在等待审批"提示；数据结构与 manageStoreProfile
    // 云函数的 pendingProfileUpdate 字段一致（人员画像 + 档案信息 + 运营状态/坐标 +
    // requestedBy/requestedAt）
    pendingProfileUpdate: null as any,

    // 编辑态：与展示态字段同名，人员画像走字符串（数字输入框），档案信息走字符串（文本/日期），
    // 运营状态/坐标走各自专属控件（胶囊单选 / "设置门店位置"按钮），不提供手工经纬度输入框
    editing: false,
    saving: false,
    editForm: {
      partyMembers: '0',
      socialWorkers: '0',
      volunteersCount: '0',
      dineInSeniorsCount: '0',
      deliverySeniorsCount: '0',
      listeningSeniorsCount: '0',
      otherCount: '0',
      address: '',
      contactPhone: '',
      openDate: '',
      registeredName: '',
      background: '',
      characteristics: '',
      province: '',
      city: '',
      orgType: '',
      platformFamily: '',
      // 🍚 供餐餐次配置：与展示态同步，编辑态用 Checkbox 多选
      supportedMeals: ['lunch'] as string[],
      // 🏷️ 服务受众标签配置：与展示态同步，编辑时直接修改这四项文案
      platformBrand: '',
      dineInLabel: '',
      deliveryLabel: '',
      listenLabel: '',
      takeoutLabel: '',
      operatingStatus: 'operating' as 'operating' | 'preparing' | 'paused',
      latitude: undefined as number | undefined,
      longitude: undefined as number | undefined,
      locationLabel: '',
      storePhotos: [] as string[]
    },

    // 👥 门店人员与服务人群画像 · 快捷修改弹窗：只改这 7 项人数指标的独立轻量弹窗，
    // 与上面整页的 editing/editForm 相互独立——那个模式会一并带出地址/开业日期等
    // 一大堆档案字段，日常只想改改人数时没必要整页进编辑态
    showProfileCountModal: false,
    profileCountSaving: false,
    profileCountForm: {
      partyMembers: '0',
      socialWorkers: '0',
      volunteersCount: '0',
      dineInSeniorsCount: '0',
      deliverySeniorsCount: '0',
      listeningSeniorsCount: '0',
      otherCount: '0'
    },

    // 🏅 门店资质与实景公示 · 快捷修改弹窗：同 showProfileCountModal 的设计——
    // 只改门头照/民政备案复印件/食品安全承诺这 3 个照片分类的独立轻量弹窗，
    // 与整页 editing/editForm 相互独立，日常只想传一张资质照片没必要进整页编辑态
    // （也避免了一次提交同时带出 7 项人数指标，历史上曾因此误把它们清零，见
    // manageStoreProfile 云函数 update/approveProfileUpdate 分支的字段级修复）
    showQualificationModal: false,
    qualificationSaving: false,
    qualificationForm: {
      storefrontPhotos: [] as string[],
      civilAffairsPhotos: [] as string[],
      foodSafetyPledgePhotos: [] as string[]
    },

    // 🔐 管理员密钥设置弹窗（仅大家长/超管可操作）
    adminKeySet: false,
    adminKeyCurrentVal: '',   // 仅大家长/超管可见的当前值（get 时服务端按权限返回）
    showAdminKeyModal: false,
    adminKeySaving: false,
    adminKeyInput: ''
  },

  async onLoad() {
    recordRecentVisit('/subpackages/admin/pages/store-profile/store-profile', '门店档案');

    this._navGuard = createNavGuard({
      homePath: '/pages/index/index',
      alertMessage: '即将退出雨花爱心餐报助手，是否返回首页继续使用？'
    });
    this._navGuard.setupOnLoad();
  },

  // 🛡️ 本页此前把角色/数据拉取全放在 onLoad（只在页面实例首次创建时跑一次），
  // 从未在 onShow 里重新同步——如果用户是"先进入本页，再切到别的页面用
  // store-picker 切换身份/门店，然后返回本页"（页面实例仍在导航栈里，只触发
  // onShow 不触发 onLoad），canManage 会一直停留在第一次进入本页那一刻的旧值。
  // 改为把角色同步 + 数据拉取整体挪到 onShow（每次页面可见都强制重新走一遍
  // initRoleAndStore()），与 profile.ts initMinePage() 的"强制优先读取生效角色"
  // 保持同一套刷新时机口径；onShow 在首次打开时本就会紧跟 onLoad 触发一次，
  // 不需要在 onLoad 里再重复调用一遍
  async onShow() {
    await this.initRoleAndStore();
    this.fetchProfile();
    this.fetchHealthDashboard();
  },

  onUnload() {
    if (this._navGuard) {
      this._navGuard.teardown();
      this._navGuard = null;
    }
  },

  // 🐛 根因修复：见 store-management.ts 同处修复记录——自己手写的
  // calculateNavBarHeight() + 内联 padding-top 在全局 box-sizing:border-box
  // 兜底生效后会把固定高度的导航栏挤爆，标题/返回键被压进刘海区域。改用
  // <navigation-bar> 共享组件，这里只接住组件上报的真实高度
  onNavLayout(e: { detail: { totalHeight: number } }) {
    this.setData({ contentTop: e.detail.totalHeight + 8 });
  },

  async initRoleAndStore() {
    let roleInfo = AuthService.getCachedRoleInfo();
    if (!roleInfo) {
      const result = await AuthService.fetchUserRole();
      roleInfo = result.roleInfo || null;
    }

    const store = getSelectedStore();
    const storeId = (roleInfo && roleInfo.storeId) || store.storeId || '';
    const storeName = (roleInfo && roleInfo.storeName) || store.storeName || '';

    // 🛡️ 强制优先读取切换后的生效角色：本页此前只认 AuthService.getCachedRoleInfo()
    // 下发的服务端真实角色，完全没读过 store-picker 切身份时写入的 current_user_role
    // 本地缓存——与 profile.ts initMinePage() 的优先级口径不一致，导致"切到家长
    // 身份后个人中心正确刷新，门店档案页却还是不能编辑"。这里补齐同一套优先级：
    // storage 一旦有值就无条件作为生效角色，不再理会服务端角色
    // 🐛 性能修复：改用异步 wx.getStorage 而非 wx.getStorageSync——本页从
    // profile.ts 跳转过来时曾报过 safeNavigateTo 2.5s 诊断警告（当前页 JS
    // 主线程被同步代码占满导致 navigateTo 原生回调迟迟排不上号），onShow 里
    // 这类同步 storage 读取即使单次不算重，也是缩小"跳转后到骨架屏可交互"
    // 这段同步执行栈的一环，能异步化的都异步化
    const storageRole = await getStorageAsync('current_user_role');
    const effectiveRole = storageRole ? String(storageRole).toLowerCase() : ((roleInfo && roleInfo.role) || '');

    // 🏛️ 严格白名单：只有 store_manager / store_patriarch / super_admin 这三种生效
    // 角色允许为 true，store_family（家人）/volunteer（义工）/finance（财务）一律
    // 强制 false。这是本页 canManage 唯一的判定点——fetchProfile() 不再用服务端
    // canEdit 覆盖这里算出的值（canEdit 只反映调用者的真实服务端角色，不认本地
    // 预览覆盖，见该函数内注释），避免真实 super_admin 账号在本地预览"家人"视角时，
    // 请求一回来又把按钮重新点亮。权限向下继承：大家长天然拥有店长的全套门店档案
    // 管理权限，与云函数 manageStoreProfile 的 resolveWriteTarget 写权限口径对齐——
    // 真正的写操作授权仍然完全由服务端独立校验，这里只决定按钮是否渲染
    const canManage = effectiveRole === 'store_manager' || effectiveRole === 'store_patriarch' || effectiveRole === 'super_admin';
    const canSetAdminKey = effectiveRole === 'store_patriarch' || effectiveRole === 'super_admin';

    this.setData({ currentStoreId: storeId, currentStoreName: storeName, canManage, canSetAdminKey });
    console.log('[verify] store-profile rendered, canManage:', canManage);
  },

  async fetchProfile() {
    if (!this.data.currentStoreId) {
      this.setData({ loading: false });
      wx.showToast({ title: '未找到所属门店，无法查看画像', icon: 'none' });
      return;
    }

    this.setData({ loading: true });
    try {
      const res: any = await callFunctionWithTimeout({
        name: 'manageStoreProfile',
        data: { action: 'get', storeId: this.data.currentStoreId }
      });

      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '加载门店画像失败', icon: 'none' });
        return;
      }

      const data = result.data || {};
      // 🛡️ 严格权限收紧：canManage 只能来自 initRoleAndStore() 里基于 effectiveRole
      // （优先读 store-picker 本地预览覆盖）算出的值，绝不能再被这里的服务端 canEdit
      // 覆盖——canEdit 只反映调用者的真实服务端角色，不知道客户端正在本地预览哪个
      // 角色。真实 super_admin 账号本就对任意门店 canEdit=true（服务端这条判断本身
      // 是对的，见 manageStoreProfile 云函数），但如果客户端正在本地预览"家人"身份，
      // 这里再用 canEdit 覆盖回 true，就会让"家人预览视角"下的按钮又冒出来，
      // 完全违背预览模拟的初衷。canManage 只允许 store_manager/store_patriarch/
      // super_admin 三种生效角色为 true，这一条判定口径只在 initRoleAndStore() 一处
      const update: any = {
        currentStoreName: data.storeName || this.data.currentStoreName,
        pendingProfileUpdate: data.pendingProfileUpdate || null,
        operatingStatus: data.operatingStatus || 'operating',
        operatingStatusLabel: OPERATING_STATUS_LABELS[data.operatingStatus] || '运营中',
        // 🛡️ setData 不接受 undefined 字段值（会报 "field ... is invalid" 警告）：
        // 门店尚未设置坐标时 data.latitude/longitude 就是 undefined，这里兜底为 null
        latitude: typeof data.latitude === 'number' ? data.latitude : null,
        longitude: typeof data.longitude === 'number' ? data.longitude : null,
        locationLabel: (typeof data.latitude === 'number' && typeof data.longitude === 'number') ? '已设置门店位置' : ''
      };
      PROFILE_FIELDS.forEach((f) => { update[f] = data[f] || 0; });
      TEXT_PROFILE_FIELDS.forEach((f) => { update[f] = data[f] || ''; });
      PHOTO_FIELDS.forEach((f) => { update[f] = sanitizePhotoUrls(data[f]); });
      const loadedOrgType = data.orgType || '';
      update.orgType = loadedOrgType;
      update.orgTypeLabel = ORG_TYPE_LABEL_MAP[loadedOrgType] || '';
      // 🍚 供餐餐次配置：云端未配置过（历史门店）时回退默认单午餐档，与
      // manageStoreProfile 云函数 get 分支的兜底口径一致
      const loadedSupportedMeals = data.mealConfig && Array.isArray(data.mealConfig.supportedMeals) && data.mealConfig.supportedMeals.length > 0
        ? data.mealConfig.supportedMeals
        : ['lunch'];
      update.supportedMeals = loadedSupportedMeals;
      update.adminKeySet = !!data.adminKeySet;
      update.adminKeyCurrentVal = data.adminKey || '';
      // 🏷️ 服务受众标签配置：从云端加载，无配置时退回当前 orgType 的默认值
      const stc = data.serviceTargetConfig || null;
      update.serviceTargetConfig = stc;
      // 🏮 品牌矩阵归属
      const loadedPlatformFamily = data.platformFamily || '';
      update.platformFamily = loadedPlatformFamily;
      update.platformFamilyLabel = PLATFORM_FAMILY_LABEL_MAP[loadedPlatformFamily] || '';
      update.platformFamilyPickerIndex = Math.max(0, PLATFORM_FAMILY_OPTIONS.findIndex(o => o.value === loadedPlatformFamily));
      this.setData(update);
      // 🛡️ canManage 不在这份 update 里——它自始至终只由 initRoleAndStore() 的
      // effectiveRole 判定决定，这里只是确认 fetchProfile() 没有意外动过它
      console.log('[verify] store-profile fetchProfile 完成, canManage 保持:', this.data.canManage, 'data.canEdit(服务端真实角色判定, 仅供参考不采用):', data.canEdit);
    } catch (err: any) {
      console.error('[fetchProfile] 加载门店画像异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 📊 门店动态健康看板：今日开餐 / 物资健康度 / 今日护持 / 今日服务，均来自
  // manageVolunteerSubmission statsSummary（与首页 index.ts fetchLatestMaterialStatus
  // 同一个数据源），不额外新增云函数
  async fetchHealthDashboard() {
    if (!this.data.currentStoreId) return;
    try {
      const res: any = await callFunctionWithTimeout({
        name: 'manageVolunteerSubmission',
        data: { action: 'statsSummary', storeId: this.data.currentStoreId }
      });
      const result = res.result;
      if (!result || !result.success || !result.data) return;

      const d = result.data;

      let todayMealStatusLabel = '待录入';
      let todayMealStatusClass = 'neutral';
      if (d.todayMealStatus === 'open') {
        todayMealStatusLabel = '正常供餐';
        todayMealStatusClass = 'good';
      } else if (d.todayMealStatus === 'closed') {
        todayMealStatusLabel = '休餐';
        todayMealStatusClass = 'warn';
      }

      // 🌾 物资健康度：大米/食用油两项取"更紧急"的那一项做主展示，两项都告急/
      // 一般时合并成一句话，避免只挑其中一项漏报另一项的风险
      const riceStatus = d.latestRiceStatus || 'normal';
      const oilStatus = d.latestOilStatus || 'sufficient';
      const riceRank = STOCK_STATUS_RANK[riceStatus] ?? 1;
      const oilRank = STOCK_STATUS_RANK[oilStatus] ?? 0;
      const worstRank = Math.max(riceRank, oilRank);
      let materialHealthLabel = '🍚 物资充裕';
      let materialHealthClass = 'good';
      if (worstRank > 0) {
        const riceWorst = riceRank === worstRank;
        const oilWorst = oilRank === worstRank;
        const names = [riceWorst ? '大米' : '', oilWorst ? '食用油' : ''].filter(Boolean).join('/');
        const emoji = worstRank === 2 ? '🚨' : '⚠️';
        materialHealthLabel = `${emoji} ${names}${STOCK_STATUS_LABEL[worstRank === 2 ? 'urgent' : 'normal']}`;
        materialHealthClass = worstRank === 2 ? 'danger' : 'warn';
      }

      this.setData({
        todayMealStatusLabel,
        todayMealStatusClass,
        materialHealthLabel,
        materialHealthClass,
        todayVolunteerCount: d.todayVolunteerCount || 0,
        todayDiningCount: (d.mealTotals && d.mealTotals.totalCount) || 0
      });
    } catch (err) {
      console.warn('[fetchHealthDashboard] 查询门店动态健康看板数据失败:', err);
    }
  },

  // 🎨 档案信息卡片整行可点：与卡片标题栏的"✏️ 修改"按钮效果一致，只是把可点
  // 触发面从一个小按钮扩大到整行。权限判断放在处理函数内部而不是 WXML 里按
  // canManage 条件切换 bindtap 绑定的函数名——同一个 canManage 已经在按钮上
  // 校验过一次，这里是防御性兜底，不依赖 WXML 条件绑定语法
  onRowTapToEdit() {
    if (!this.data.canManage || this.data.editing) return;
    this.onEditProfile();
  },

  onEditProfile() {
    const editForm: any = {};
    PROFILE_FIELDS.forEach((f) => { editForm[f] = String((this.data as any)[f] || 0); });
    TEXT_PROFILE_FIELDS.forEach((f) => { editForm[f] = (this.data as any)[f] || ''; });
    editForm.platformFamily = this.data.platformFamily || '';
    // 🍚 供餐餐次配置：编辑时预填当前配置，slice() 避免编辑态直接引用展示态数组
    editForm.supportedMeals = (this.data.supportedMeals || ['lunch']).slice();
    // 🏷️ 服务受众标签配置：编辑时预填当前配置（若无则用 orgType 默认值）
    const stc = this.data.serviceTargetConfig;
    const defLabels = (ORG_TYPE_DEFAULT_TARGET_LABELS as any)[this.data.orgType] || DEFAULT_TARGET_LABELS;
    editForm.platformBrand = (stc && stc.platformBrand) || '';
    editForm.dineInLabel   = (stc && stc.targetLabels && stc.targetLabels.dineInLabel)   || defLabels.dineInLabel   || '';
    editForm.deliveryLabel = (stc && stc.targetLabels && stc.targetLabels.deliveryLabel) || defLabels.deliveryLabel || '';
    editForm.listenLabel   = (stc && stc.targetLabels && stc.targetLabels.listenLabel)   || defLabels.listenLabel   || '';
    editForm.takeoutLabel  = (stc && stc.targetLabels && stc.targetLabels.takeoutLabel)  || defLabels.takeoutLabel  || '';
    editForm.operatingStatus = this.data.operatingStatus || 'operating';
    editForm.latitude = this.data.latitude;
    editForm.longitude = this.data.longitude;
    editForm.locationLabel = this.data.locationLabel || '';
    // 🏅 门头照/民政备案复印件/食品安全承诺不在这份整页编辑表单里——它们有自己
    // 独立的"门店资质与实景公示"快捷弹窗（见 onOpenQualificationModal），避免
    // 同一批照片存在两条互相独立、可能互相覆盖的编辑路径
    editForm.storePhotos = [...this.data.storePhotos];
    this.setData({ editing: true, editForm });
  },

  onCancelEdit() {
    this.setData({ editing: false });
  },

  onEditInput(e: any) {
    const field = e.currentTarget.dataset.field as ProfileField | TextProfileField;
    const value = e.detail.value;
    this.setData({ [`editForm.${field}`]: value });
  },

  onSelectOperatingStatus(e: any) {
    this.setData({ 'editForm.operatingStatus': e.currentTarget.dataset.value });
  },

  // 🍚 供餐餐次 Chip 多选：早餐/午餐/晚餐可任意组合勾选，与首页打卡弹窗的
  // onToggleReservedMeal 同一套交互习惯。至少保留一个餐次——取消勾选会导致
  // 只剩 0 个餐次时直接吞掉这次点击并提示，不允许保存出"什么都不供"的门店配置
  onToggleEditSupportedMeal(e: any) {
    const meal = e.currentTarget.dataset.meal;
    if (!meal) return;
    const current = this.data.editForm.supportedMeals || [];
    if (current.includes(meal) && current.length <= 1) {
      wx.showToast({ title: '至少保留一个供餐餐次', icon: 'none' });
      return;
    }
    const next = current.includes(meal) ? current.filter((m: string) => m !== meal) : [...current, meal];
    this.setData({ 'editForm.supportedMeals': next });
  },

  onEditOpenDateChange(e: any) {
    this.setData({ 'editForm.openDate': e.detail.value });
  },

  stopPropagation() {},

  // 🏪 门店照片 / 门头照 / 民政备案复印件 / 食品安全承诺：四个分类共用同一套
  // chooseMedia + compressAndUploadImages 上传逻辑（与 store-picker.ts
  // onChooseNewStorePhoto 同一套模式），用 data-category 区分分类而不是各写一份
  // 几乎相同的代码。data-target 区分写到哪个表单对象——整页编辑态用 editForm，
  // "门店资质与实景公示"快捷弹窗用 qualificationForm，不传时按 editForm 兜底，
  // 兼容整页编辑态里原有的 storePhotos 上传格没有加 data-target 的写法
  async onChoosePhoto(e: any) {
    const category = e.currentTarget.dataset.category as PhotoField;
    const target = (e.currentTarget.dataset.target || 'editForm') as 'editForm' | 'qualificationForm';
    const max = PHOTO_FIELD_MAX[category] || MAX_STORE_PHOTOS;
    const current = (this.data[target] as any)[category] as string[];
    const remaining = max - current.length;
    if (remaining <= 0) {
      wx.showToast({ title: `最多上传 ${max} 张${PHOTO_FIELD_LABELS[category]}`, icon: 'none' });
      return;
    }

    try {
      // 🛡️ 选图前先确保隐私授权已解决，避免遮罩挡住授权弹窗（见
      // utils/privacyAuthHub.ts ensurePrivacyAuthorized）
      await ensurePrivacyAuthorized();
      const chooseRes = await wx.chooseMedia({
        count: remaining,
        mediaType: ['image'],
        sourceType: ['album', 'camera']
      });

      const paths = (chooseRes.tempFiles || []).map((f) => f.tempFilePath);
      if (paths.length === 0) return;

      const insertStart = current.length;
      this.setData({
        [`${target}.${category}`]: [...current, ...paths],
        storePhotoUploading: true
      });

      try {
        const uploaded = await compressAndUploadImages(CANVAS_ID, paths, `store_profile_photos/${category}/${this.data.currentStoreId}/${Date.now()}`);
        const finalPhotos = [...((this.data[target] as any)[category] as string[])];
        uploaded.forEach((u, i) => { finalPhotos[insertStart + i] = u.url; });
        this.setData({ [`${target}.${category}`]: finalPhotos });
      } catch (uploadErr) {
        const rolledBack = ((this.data[target] as any)[category] as string[]).filter((_: string, i: number) => i < insertStart || i >= insertStart + paths.length);
        this.setData({ [`${target}.${category}`]: rolledBack });
        throw uploadErr;
      }

      this.setData({ storePhotoUploading: false });
    } catch (err) {
      this.setData({ storePhotoUploading: false });
      console.error('[store-profile] onChoosePhoto 异常:', err);
      wx.showToast({ title: '图片处理失败，请重试', icon: 'none' });
    }
  },

  onDeletePhoto(e: any) {
    const category = e.currentTarget.dataset.category as PhotoField;
    const target = (e.currentTarget.dataset.target || 'editForm') as 'editForm' | 'qualificationForm';
    const index = e.currentTarget.dataset.index;
    const next = ((this.data[target] as any)[category] as string[]).filter((_: string, i: number) => i !== index);
    this.setData({ [`${target}.${category}`]: next });
  },

  // 🖼️ 门店资质与实景公示：展示态点击任一分类的照片时全屏预览，与该分类其余
  // 照片一起支持左右滑动查看
  onPreviewProfilePhoto(e: any) {
    const url = e.currentTarget.dataset.url;
    const urls = e.currentTarget.dataset.urls;
    if (!url) return;
    wx.previewImage({ current: url, urls: Array.isArray(urls) && urls.length > 0 ? urls : [url] });
  },

  // 🐛 图片 500 报错兜底：URL 格式过滤（isValidPhotoUrl）拦不住"路径长得正常但
  // 云端文件已被删除/权限失效"这类场景，这里作为最后一道防线——binderror 触发后
  // 把该 URL 记进 imageFailedMap，对应 <image> 的 wx:if 让位给"加载失败"占位块，
  // 不再让控制台反复抛同一张图的网络错误
  onImageLoadError(e: any) {
    const url = e.currentTarget.dataset.url;
    console.warn('[store-profile] 图片加载失败:', url, e.detail);
    if (!url) return;
    this.setData({ [`imageFailedMap.${url}`]: true });
  },

  // 点击"加载失败"占位块重试：摘掉失败标记，wx:if/wx:else 会把 <image> 节点
  // 整个卸载重挂，强制小程序重新发起一次网络请求
  onRetryImage(e: any) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    const next = { ...this.data.imageFailedMap };
    delete next[url];
    this.setData({ imageFailedMap: next });
  },

  // 📞 一键拨打门店联系电话
  onCallPhone() {
    if (!this.data.contactPhone) {
      wx.showToast({ title: '门店尚未填写联系电话', icon: 'none' });
      return;
    }
    wx.makePhoneCall({ phoneNumber: this.data.contactPhone }).catch((err) => {
      console.warn('[store-profile] onCallPhone 拨打失败/取消:', err);
    });
  },

  // 📍 一键导航：唤起微信内置地图，需要门店已设置过经纬度（编辑态"设置门店位置"）
  onOpenNavigation() {
    if (typeof this.data.latitude !== 'number' || typeof this.data.longitude !== 'number') {
      wx.showToast({ title: '门店尚未设置具体位置，无法导航', icon: 'none' });
      return;
    }
    wx.openLocation({
      latitude: this.data.latitude,
      longitude: this.data.longitude,
      name: this.data.currentStoreName || '门店位置',
      address: this.data.address || ''
    }).catch((err) => {
      console.warn('[store-profile] onOpenNavigation 打开地图失败:', err);
    });
  },

  // 📍 编辑态设置门店位置：与 store-management 建店表单共用同一条
  // app.json "scope.userLocation" 权限声明
  async onChooseLocation() {
    try {
      const res: any = await wx.chooseLocation({});
      this.setData({
        'editForm.latitude': res.latitude,
        'editForm.longitude': res.longitude,
        'editForm.locationLabel': res.name || res.address || `${res.latitude}, ${res.longitude}`
      });
      if (!this.data.editForm.address && res.address) {
        this.setData({ 'editForm.address': res.address });
      }
    } catch (err) {
      console.warn('[store-profile] 选择门店位置失败/取消:', err);
    }
  },

  async onSaveProfile() {
    if (this.data.saving) return;
    this.setData({ saving: true });

    try {
      const payload: any = { action: 'update', storeId: this.data.currentStoreId };
      PROFILE_FIELDS.forEach((f) => { payload[f] = parseInt(this.data.editForm[f], 10) || 0; });
      TEXT_PROFILE_FIELDS.forEach((f) => { payload[f] = this.data.editForm[f] || ''; });
      // 🏢 平台类型：已改为进入首页时的工作空间选择一次性确定，本页只读展示，
      // 不再随整页编辑表单一并提交，避免覆盖首页选定的真实值
      // 🏷️ 服务受众标签配置：将 editForm 中的 4 个标签字段打包成 serviceTargetConfig 提交
      const ef = this.data.editForm as any;
      payload.serviceTargetConfig = {
        platformBrand: ef.platformBrand || '',
        targetLabels: {
          dineInLabel: ef.dineInLabel || '',
          deliveryLabel: ef.deliveryLabel || '',
          listenLabel: ef.listenLabel || '',
          takeoutLabel: ef.takeoutLabel || ''
        }
      };
      payload.operatingStatus = this.data.editForm.operatingStatus;
      // 🍚 供餐餐次配置：服务端会做白名单校验 + 空数组兜底默认单午餐档
      payload.supportedMeals = this.data.editForm.supportedMeals || ['lunch'];
      // 🏅 只提交 storePhotos——门头照/民政备案复印件/食品安全承诺走各自独立的
      // "门店资质与实景公示"弹窗（onSaveQualification），不在这份整页提交里，
      // 避免把 payload 里不存在的字段用 undefined 覆盖回本地展示态（见下方两处
      // pendingProfileUpdate/update 同理只回显 storePhotos）
      payload.storePhotos = this.data.editForm.storePhotos || [];
      if (typeof this.data.editForm.latitude === 'number' && typeof this.data.editForm.longitude === 'number') {
        payload.latitude = this.data.editForm.latitude;
        payload.longitude = this.data.editForm.longitude;
      }

      const res: any = await callFunctionWithTimeout({ name: 'manageStoreProfile', data: payload });
      const result = res.result;

      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '保存失败', icon: 'none' });
        return;
      }

      if (result.pending) {
        // 🏛️ 家长风控锁：本店已绑定家长/督导，未直接生效，转为待确认——
        // 展示态保持不变，只把提交内容记进 pendingProfileUpdate 供提示条展示
        const pendingProfileUpdate: any = { requestedAt: Date.now() };
        PROFILE_FIELDS.forEach((f) => { pendingProfileUpdate[f] = payload[f]; });
        TEXT_PROFILE_FIELDS.forEach((f) => { pendingProfileUpdate[f] = payload[f]; });
        pendingProfileUpdate.storePhotos = payload.storePhotos;
        pendingProfileUpdate.supportedMeals = payload.supportedMeals;
        this.setData({ editing: false, pendingProfileUpdate });
        wx.showModal({ title: '已提交审批', content: result.message || '已提交家长/超管审批，确认后生效', showCancel: false });
        return;
      }

      const update: any = {
        editing: false,
        pendingProfileUpdate: null,
        operatingStatus: payload.operatingStatus,
        operatingStatusLabel: OPERATING_STATUS_LABELS[payload.operatingStatus] || '运营中'
      };
      PROFILE_FIELDS.forEach((f) => { update[f] = payload[f]; });
      TEXT_PROFILE_FIELDS.forEach((f) => { update[f] = payload[f]; });
      update.serviceTargetConfig = payload.serviceTargetConfig || null;
      update.storePhotos = payload.storePhotos;
      update.supportedMeals = payload.supportedMeals;
      if (payload.latitude !== undefined) {
        update.latitude = payload.latitude;
        update.longitude = payload.longitude;
        update.locationLabel = '已设置门店位置';
      }
      this.setData(update);
      wx.showToast({ title: '门店档案已更新', icon: 'success' });
    } catch (err: any) {
      console.error('[onSaveProfile] 保存门店画像异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  // ============ 👥 门店人员与服务人群画像 · 快捷修改弹窗 ============

  onOpenProfileCountModal() {
    const profileCountForm: any = {};
    PROFILE_FIELDS.forEach((f) => { profileCountForm[f] = String((this.data as any)[f] || 0); });
    this.setData({ showProfileCountModal: true, profileCountForm });
  },

  onCloseProfileCountModal() {
    if (this.data.profileCountSaving) return;
    this.setData({ showProfileCountModal: false });
  },

  onProfileCountInput(e: any) {
    const field = e.currentTarget.dataset.field as ProfileField;
    this.setData({ [`profileCountForm.${field}`]: e.detail.value });
  },

  async onSaveProfileCount() {
    if (this.data.profileCountSaving) return;
    this.setData({ profileCountSaving: true });
    wx.showLoading({ title: '正在保存...', mask: true });

    try {
      const payload: any = { action: 'update', storeId: this.data.currentStoreId };
      PROFILE_FIELDS.forEach((f) => { payload[f] = parseInt(this.data.profileCountForm[f], 10) || 0; });

      const res: any = await callFunctionWithTimeout({ name: 'manageStoreProfile', data: payload });
      const result = res.result;

      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '保存失败', icon: 'none' });
        return;
      }

      if (result.pending) {
        // 🏛️ 家长风控锁：与整页保存 onSaveProfile 同一套挂起逻辑——本店已绑定
        // 家长/督导时不会直接生效，展示态数字保持不变，只更新待审批提示条
        const pendingProfileUpdate: any = { ...this.data.pendingProfileUpdate, requestedAt: Date.now() };
        PROFILE_FIELDS.forEach((f) => { pendingProfileUpdate[f] = payload[f]; });
        this.setData({ showProfileCountModal: false, pendingProfileUpdate });
        wx.showModal({ title: '已提交审批', content: result.message || '已提交家长/超管审批，确认后生效', showCancel: false });
        return;
      }

      const update: any = { showProfileCountModal: false };
      PROFILE_FIELDS.forEach((f) => { update[f] = payload[f]; });
      this.setData(update);
      wx.showToast({ title: '更新成功', icon: 'success' });
    } catch (err: any) {
      console.error('[onSaveProfileCount] 保存人员画像异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ profileCountSaving: false });
    }
  },

  // ============ 🏅 门店资质与实景公示 · 快捷修改弹窗 ============

  // 点击标题栏"✏️ 修改"按钮或某个分类的"暂未上传"占位区域都会先经过这里做
  // 一次权限校验——"暂未上传"占位在展示态对所有角色可见（含义工/家人只读
  // 浏览），不能只靠按钮的 wx:if 隐藏拦人，必须在打开弹窗前显式拦一次
  onOpenQualificationModal() {
    if (!this.data.canManage) {
      wx.showToast({ title: '仅店长/家长/超管可编辑门店资质公示', icon: 'none' });
      return;
    }
    this.setData({
      showQualificationModal: true,
      qualificationForm: {
        storefrontPhotos: [...this.data.storefrontPhotos],
        civilAffairsPhotos: [...this.data.civilAffairsPhotos],
        foodSafetyPledgePhotos: [...this.data.foodSafetyPledgePhotos]
      }
    });
  },

  onCloseQualificationModal() {
    if (this.data.qualificationSaving) return;
    this.setData({ showQualificationModal: false });
  },

  async onSaveQualification() {
    if (this.data.qualificationSaving) return;
    this.setData({ qualificationSaving: true });
    wx.showLoading({ title: '正在保存...', mask: true });

    try {
      // 🐛 只提交这 3 个照片字段——manageStoreProfile 云函数的 update 分支已经
      // 修复为"只在传了这个字段时才写入"，不会像修复前那样把没传的 7 项人数
      // 指标当作 0 静默清零，这份局部提交是安全的
      const payload: any = {
        action: 'update',
        storeId: this.data.currentStoreId,
        storefrontPhotos: this.data.qualificationForm.storefrontPhotos,
        civilAffairsPhotos: this.data.qualificationForm.civilAffairsPhotos,
        foodSafetyPledgePhotos: this.data.qualificationForm.foodSafetyPledgePhotos
      };

      const res: any = await callFunctionWithTimeout({ name: 'manageStoreProfile', data: payload });
      const result = res.result;

      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '保存失败', icon: 'none' });
        return;
      }

      if (result.pending) {
        // 🏛️ 家长风控锁：与 onSaveProfile/onSaveProfileCount 同一套挂起逻辑——
        // 本店已绑定家长/督导时不会直接生效，展示态照片保持不变，只更新待审批提示条
        const pendingProfileUpdate: any = { ...this.data.pendingProfileUpdate, requestedAt: Date.now() };
        pendingProfileUpdate.storefrontPhotos = payload.storefrontPhotos;
        pendingProfileUpdate.civilAffairsPhotos = payload.civilAffairsPhotos;
        pendingProfileUpdate.foodSafetyPledgePhotos = payload.foodSafetyPledgePhotos;
        this.setData({ showQualificationModal: false, pendingProfileUpdate });
        wx.showModal({ title: '已提交审批', content: result.message || '已提交家长/超管审批，确认后生效', showCancel: false });
        return;
      }

      this.setData({
        showQualificationModal: false,
        storefrontPhotos: payload.storefrontPhotos,
        civilAffairsPhotos: payload.civilAffairsPhotos,
        foodSafetyPledgePhotos: payload.foodSafetyPledgePhotos
      });
      wx.showToast({ title: '门店资质公示已更新', icon: 'success' });
    } catch (err: any) {
      console.error('[onSaveQualification] 保存门店资质公示异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ qualificationSaving: false });
    }
  },

  // ============ 🔐 管理员密钥设置弹窗 ============

  onOpenAdminKeyModal() {
    if (!this.data.canSetAdminKey) {
      wx.showToast({ title: '仅大家长/超管可设置管理员密钥', icon: 'none' });
      return;
    }
    // 预填当前值（大家长/超管通过 get 拿到原文，店长看不到）供修改时参考
    this.setData({ showAdminKeyModal: true, adminKeyInput: this.data.adminKeyCurrentVal });
  },

  onCloseAdminKeyModal() {
    if (this.data.adminKeySaving) return;
    this.setData({ showAdminKeyModal: false, adminKeyInput: '' });
  },

  onAdminKeyInputChange(e: any) {
    this.setData({ adminKeyInput: e.detail.value });
  },

  async onSaveAdminKey() {
    if (this.data.adminKeySaving) return;
    const newKey = (this.data.adminKeyInput || '').trim();
    this.setData({ adminKeySaving: true });
    wx.showLoading({ title: '保存中...', mask: true });
    try {
      const res: any = await callFunctionWithTimeout({
        name: 'manageStoreProfile',
        data: { action: 'update', storeId: this.data.currentStoreId, adminKey: newKey }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '保存失败', icon: 'none' });
        return;
      }
      this.setData({
        showAdminKeyModal: false,
        adminKeyInput: '',
        adminKeySet: newKey.length > 0,
        adminKeyCurrentVal: newKey
      });
      wx.showToast({ title: newKey ? '密钥已更新' : '密钥已清除', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ adminKeySaving: false });
    }
  },

});
