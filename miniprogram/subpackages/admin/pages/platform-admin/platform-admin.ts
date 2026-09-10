import { AuthService } from '../../../../utils/authService';
import { createNavGuard, NavGuardInstance } from '../../../../utils/navGuard';
import { callFunctionWithTimeout } from '../../../../utils/withTimeout';
import { safeNavigateTo } from '../../../../utils/navHelper';

const PLAN_LABELS: Record<string, string> = {
  basic: '基础版',
  pro: '专业版',
  enterprise: '旗舰版'
};

const CODE_STATUS_LABELS: Record<string, string> = {
  UNUSED: '未使用',
  USED: '已核销',
  REVOKED: '已作废'
};

// 🔍（2026-09-10 巡检免输 ID）grantTenantAuthorization 的 GRANTABLE_ROLES 白名单
// 展示文案，用于"当前生效中的巡检"列表把 role 原始值渲成人类可读文案
const INSPECT_ROLE_LABELS: Record<string, string> = {
  store_patriarch: '大家长',
  store_manager: '店长',
  finance: '财务',
  volunteer: '义工'
};

// 🌟 与云函数 PAGE_SIZE 保持一致（activateTenantSubscription/manageTenantSubscription
// 的 listTenants 都是 20），仅用于客户端判断"这一页拿到的条数是否等于整页"这类
// 展示逻辑，不参与任何鉴权/查询条件
const PAGE_SIZE = 20;

// 🌸 到期预警窗口：与 getPlatformOverview「7 天内到期」大盘同一口径，机构卡片
// 自己的橙色到期 Tag 复用这个阈值
const EXPIRING_SOON_MS = 7 * 24 * 3600 * 1000;

// 🆓 基础版是面向基础机构的免费版，固定单门店配额，没有"到期续费"这个概念——
// 但 manageTenantSubscription 云函数的 createOrRenewSubscription 分支仍然把
// serviceExpireDate 当必填参数硬校验（见该云函数 event 解构后的非空判断），
// 这里用一个足够遥远的哨兵日期代表"永久有效"，避免为了这一个免费档位单独
// 改动服务端契约；到期日期本身在基础版弹窗上是隐藏/置灰的，用户完全无感知
const PERMANENT_EXPIRE_DATE = '2099-12-31';

// 🏛️ 「方案一：按机构维度统一授权与门店配额管理」——三档套餐的门店配额，
// 与 checkTenantPermission/createStore/activateTenantSubscription/
// manageTenantSubscription 四个云函数里完全同一份 PLAN_STORE_LIMITS 拷贝保持
// 一致（本仓库一贯做法：各云函数独立部署，没有跨函数共享模块机制）。basic
// 由 manageTenantSubscription.createOrRenewSubscription 服务端强制收敛，
// 不信任本地这份值；pro/enterprise 是"缺省建议值"，平台管理员仍可在弹窗里
// 手动调高（如购买扩容包），服务端未收到显式 storeLimit 时才回落到这里
const PLAN_STORE_LIMIT_DEFAULTS: Record<string, string> = {
  basic: '2',
  pro: '10',
  enterprise: '30'
};

// 🌟 套餐档位切换联动：basic 固定为「2 家门店 + 永久有效」，不再需要选服务
// 到期日期；pro/enterprise 恢复成"以开始日期为基准往后一年"的到期日建议值 +
// 该档位的默认门店配额，两者都还可以在弹窗里手动改
function getPlanQuotaDefaults(planType: string, serviceStartDate: string): { storeLimit: string; serviceExpireDate: string } {
  if (planType === 'basic') {
    return { storeLimit: PLAN_STORE_LIMIT_DEFAULTS.basic, serviceExpireDate: PERMANENT_EXPIRE_DATE };
  }
  const start = serviceStartDate ? new Date(serviceStartDate) : new Date();
  const nextYear = new Date(start);
  nextYear.setFullYear(nextYear.getFullYear() + 1);
  return {
    storeLimit: PLAN_STORE_LIMIT_DEFAULTS[planType] || PLAN_STORE_LIMIT_DEFAULTS.pro,
    serviceExpireDate: nextYear.toISOString().slice(0, 10)
  };
}

// 🆕（2026-09-10 一键复制格式化文本）复制内容包含授权码本身 + 套餐/扩容
// 类型 + 一句兑换说明，粘贴给机构联系人时不用再自己手打说明文字。
// PLAN_LABELS 与「刚生成授权码」/「授权码台账」两处展示同一套文案口径，
// 两个调用点（pa-generated-row/pa-code-card）传入的 item 形状略有差异
// （前者来自 generate 云调用结果，没有 status/_id；后者来自 list 台账），
// 但都具备这里需要的 code/codeType/planType/durationDays/extraStores 字段
function buildActivationCodeCopyText(item: any): string {
  const typeLine = item.codeType === 'add_on'
    ? `类型：扩容门店包（+${item.extraStores || 0} 家门店）`
    : `类型：${PLAN_LABELS[item.planType] || item.planType}（${item.durationDays || 0} 天）`;
  return [
    `授权码：${item.code}`,
    typeLine,
    '使用说明：小程序【个人中心】→【开通/续费套餐】页面输入此授权码即可自助兑换，兑换后立即生效，请勿转发给无关人员。'
  ].join('\n');
}

function safeVibrate() {
  // 🛡️ 部分机型/开发者工具不支持震动反馈，wx.vibrateShort 会抛错——纯"锦上添花"
  // 的触觉反馈，失败静默吞掉即可，绝不能因为它把复制成功的主流程打断
  try {
    wx.vibrateShort({ type: 'light' });
  } catch (e) {
    /* ignore */
  }
}

Page({
  _navGuard: null as NavGuardInstance | null,

  data: {
    contentTop: 0,
    checkedAccess: false,
    // 🐛 根因修复：checkAccess() 此前一旦抛异常（网络异常/云函数未部署等），
    // checkedAccess 永远停留在 false，页面卡死在"校验身份中..."。现在无论成功
    // 失败都会落地到 true，失败时改用这个字段展示可重试的错误态，不再无限转圈
    accessError: '',
    isPlatformAdmin: false,
    // 🗂️ 顶层 Tab 分流：授权码管理 / 机构管理 / 平台巡检，取代此前所有模块纵向
    // 堆叠在单屏里的混乱体验
    activeTab: 'codes' as 'codes' | 'tenants' | 'inspect',
    planLabels: PLAN_LABELS,
    codeStatusLabels: CODE_STATUS_LABELS,

    overview: null as any,
    // 🐛 初始值就是 true（不是 false）：pa-content 一旦可见就意味着 checkAccess()
    // 马上会同步调用 loadOverview()，默认 false 会让 KPI 卡片在第一帧短暂
    // 显示"0"而不是骨架屏——语义上"0"应该只代表"确认过、真的是 0"。
    // 🛡️ 这个初始值技巧在这里是安全的，因为 loadOverview() 本身没有"防重入锁"
    // （不检查 this.data.overviewLoading 就直接往下走）——activationCodesLoading/
    // tenantsLoading 不能照搬同一个技巧，见它们各自声明处的教训
    overviewLoading: true,
    // 🌟 下拉刷新态：onPullDownRefresh 触发时置位，两个 Tab 各自的列表 + 概览
    // 一起刷新完才收起（wx.stopPullDownRefresh）
    pageRefreshing: false,

    // ─────────────────────────────────────────────────────────────────
    // 🔑 授权码管理 Tab
    // ─────────────────────────────────────────────────────────────────
    showGenerateCodesSheet: false,
    // 🏢 codeType：'package'（常规套餐码，走 planType/durationDays）/ 'add_on'
    // （扩容门店包码，走 extraStores）——与 activateTenantSubscription 云函数
    // generate action 的 codeType 分支一一对应
    // 🆕 note：铸造用途备注（如"卖给XX机构"），非必填，纯留痕，不参与校验
    // 🎯（2026-09-10 双轨兼容：定向空间专用码）targetStoreId 选填，留空即
    // 铸造原有的"通用兑换码"语义；填了则整批码只能被这一家门店/空间核销
    // （见 activateTenantSubscription 云函数 handleGenerate/handleRedeem）
    generateCodesForm: { codeType: 'package', planType: 'pro', durationDays: '365', quantity: '1', extraStores: '1', note: '', targetStoreId: '' },
    // 🆕 前端基础校验：输入框失焦/提交时填充，非空即代表校验不通过，wxml 据此
    // 显示红色错误提示，不用等点了提交按钮才用 Toast 告知
    generateCodesErrors: { durationDays: '', quantity: '', extraStores: '' },
    generatingCodes: false,
    // 🆕（可视化制卡台账）顶部库存看板：专业版/旗舰版未核销余量 + 已核销总数
    codeStats: { unusedPro: 0, unusedEnterprise: 0, usedTotal: 0 },
    codeStatsLoading: false,
    // 🌟 刚生成的这一批：单独存一份，生成成功后置顶展示 + 一键复制，不用去
    // 下面的台账列表里翻找刚铸造出来的这几个码
    lastGeneratedCodes: [] as Array<{ code: string; codeType?: string; planType?: string; durationDays?: number; extraStores?: number; note?: string }>,
    // 🐛 根因修复：这里此前也照搬 overviewLoading 的"初始值设 true 防闪烁"套路，
    // 但 loadActivationCodes() 自己开头有一道 `if (this.data.activationCodesLoading)
    // return` 的防重入锁——loadOverview() 没有这道锁，套用同一个技巧是安全的，
    // 这里却直接把"防重入锁"锁死在"已加载"状态：checkAccess() 里第一次调用
    // loadActivationCodes() 时，这道锁看到的就是这个初始 true，直接原地返回，
    // 云函数请求根本没发出去，且函数在锁检查处提前 return，永远走不到 finally
    // 去把它重置为 false——授权码列表因此永久卡在骨架屏，控制台狂刷"已有请求
    // 在途，跳过本次重复调用"。这个字段的语义是"当前是否有请求在途"，初始值
    // 必须是 false（真的没有请求在途）
    activationCodesLoading: false,
    activationCodesLoadingMore: false,
    activationCodesFilter: 'UNUSED' as 'UNUSED' | 'USED' | 'REVOKED' | 'all',
    // 🆕（可视化制卡台账）按套餐类型筛选，与 activationCodesFilter（状态）是
    // 两个独立维度，可以同时生效
    activationCodesPlanFilter: 'all' as 'all' | 'pro' | 'enterprise',
    activationCodes: [] as Array<{
      _id: string;
      code: string;
      planType: string;
      durationDays: number;
      note: string;
      status: string;
      createdAt: string;
      redeemedAt: string;
      tenantId: string;
      tenantName: string;
      // 📍（2026-09-10 双轨兼容：空间核销落地追踪）见 activateTenantSubscription
      // 云函数 handleList 同名字段注释
      usedByOpenId: string;
      usedStoreId: string;
      usedStoreName: string;
      usedAt: string;
      // 🎯 定向空间专用码：铸造时可选绑定，只在 UNUSED 时对展示有意义
      targetStoreId: string;
      targetStoreName: string;
      revokedAt: string;
      revokeReason: string;
      createdAtLabel: string;
      redeemedAtLabel: string;
      usedAtLabel: string;
      revokedAtLabel: string;
    }>,
    // 📄 分页游标：下一页从这个 skip 开始拉，hasMore=false 时列表尾部不再展示
    // "加载更多"，触底也不会再发请求
    activationCodesSkip: 0,
    activationCodesHasMore: false,
    // 🗑️ 作废激活码防抖锁：值为正在作废中的 codeId，空字符串表示当前无操作在途
    revokingCodeId: '',

    // ─────────────────────────────────────────────────────────────────
    // 🏢 机构管理 Tab
    // ─────────────────────────────────────────────────────────────────
    showCreateTenantSheet: false,
    createForm: { name: '', contactName: '', contactPhone: '' },
    createFormErrors: { name: '' },
    creatingTenant: false,

    tenants: [] as any[],
    // 🐛 根因修复：同 activationCodesLoading 处注释——loadTenants() 自己开头
    // 也有一道 `if (this.data.tenantsLoading) return` 的防重入锁，初始值不能
    // 是 true，否则 checkAccess() 里第一次调用就被自己的锁原地挡回去，机构
    // 列表永久卡在骨架屏
    tenantsLoading: false,
    tenantsLoadingMore: false,
    tenantsSkip: 0,
    tenantsHasMore: false,
    // 🔒 终止订阅防抖锁：值为正在处理中的 tenantId，空字符串表示当前无操作在途
    terminatingTenantId: '',

    // 🆕 机构搜索：走服务端 keyword 过滤（不是本地过滤已加载的这一页）——
    // 机构总数会分页，搜索必须能搜到还没翻到的那些机构
    tenantSearchKeyword: '',
    // 🆕 状态筛选：走本地快筛（与授权码台账的套餐类型筛选同一种权衡，机构
    // 数量级不大，不为筛选单独发云调用），基于 decorateTenants() 算出的
    // displayStatus 派生字段
    tenantStatusFilter: 'all' as 'all' | 'active' | 'inactive',

    // 🏪 机构下挂门店抽屉：点击机构卡片"查看门店"时唤起，见 onOpenTenantStores——
    // 这是"机构列表看不到测试1"这类问题的排查入口：门店本身不会在机构列表里
    // 单独占一行（门店是挂在 tenantId 下的子资源），要看某个具体门店在不在，
    // 得点进它所属机构这里来看
    showTenantStoresSheet: false,
    tenantStoresLoading: false,
    tenantStoresTenantId: '',
    tenantStoresTenantName: '',
    tenantStores: [] as any[],
    // 🔒 门店行内操作防抖锁：值为正在处理中的 storeId，空字符串表示当前无操作在途
    storeActionInFlightId: '',

    showRenewSheet: false,
    renewForm: {
      tenantId: '',
      tenantName: '',
      planType: 'basic',
      serviceStartDate: '',
      serviceExpireDate: '',
      storeLimit: '',
      reason: ''
    },
    renewFormErrors: { serviceStartDate: '', serviceExpireDate: '', reason: '' },
    renewSubmitting: false,

    // ─────────────────────────────────────────────────────────────────
    // 🔍（2026-09-09 平台巡检自助授权，2026-09-10 改为两级选择器）平台巡检
    // Tab——platform_admin 本人默认"不碰业务数据"（见 getStoreList 云函数
    // 头部注释），需要临时排障某一家具体门店时，走"选机构 → 选门店 → 授权"
    // 两级选择器（复用 manageTenantSubscription 的 listTenants/getTenantDetail，
    // 不新增云函数），取代此前要求去云开发控制台复制门店 _id 的做法，授权成功
    // 后直接跳转 store-profile.ts 编辑。这不是新开一条"超管万能穿透"通道——
    // 店铺范围必须逐一显式列出，角色白名单与 grantTenantAuthorization 云函数
    // 完全一致（不含 super_admin/platform_admin 本身），每次授权都在
    // authorizedTenants 数组里留痕（grantedBy/grantedAt），这份痕迹本身就是
    // 审计记录
    // ─────────────────────────────────────────────────────────────────
    inspectStage: 'tenant' as 'tenant' | 'store',
    inspectTenantKeyword: '',
    inspectTenantsLoading: false,
    inspectTenantResults: [] as any[],
    inspectSelectedTenantId: '',
    inspectSelectedTenantName: '',
    inspectStoresLoading: false,
    inspectStores: [] as any[],
    inspectSelectedStoreId: '',
    inspectSelectedStoreName: '',
    inspectRole: 'store_patriarch' as 'store_patriarch' | 'store_manager' | 'finance' | 'volunteer',
    inspectRoleOptions: [
      { value: 'store_patriarch', label: '大家长（完整档案编辑 + 管理员密钥）' },
      { value: 'store_manager', label: '店长（档案编辑，不含管理员密钥）' },
      { value: 'finance', label: '财务（只读查看，不可编辑）' },
      { value: 'volunteer', label: '义工（只读查看，不可编辑）' }
    ],
    inspectSubmitting: false,
    inspectError: '',
    // 🆕（2026-09-10 一键回收临时凭证）当前生效中的临时巡检：只读展示
    // platform_admin 自己账号 authorizedTenants 数组（grantTenantAuthorization
    // 的 list action），配一键撤销，避免该数组无限膨胀
    activeGrants: [] as any[],
    activeGrantsLoading: false,
    revokingGrantTenantId: ''
  },

  onLoad() {
    // 🩺（排查白屏用）确认 onLoad 是否真的被调用——如果模拟器控制台看不到
    // 这条日志，说明问题出在 onLoad 之前（编译模式指向的路径/WXML 编译失败/
    // 模块 require 阶段异常），不是本方法内部逻辑的问题，不用再往下排查
    // this.checkAccess()/navGuard 这些具体实现
    console.log('[platform-admin] onLoad 开始执行');
    this.checkAccess();

    this._navGuard = createNavGuard({
      homePath: '/pages/index/index',
      alertMessage: '即将退出雨花爱心餐报助手，是否返回首页继续使用？'
    });
    this._navGuard.setupOnLoad();
    console.log('[platform-admin] onLoad 执行完毕（navGuard 已初始化）');
  },

  onUnload() {
    if (this._navGuard) {
      this._navGuard.teardown();
      this._navGuard = null;
    }
  },

  // 🌟 原生下拉刷新：两个 Tab 各自的数据源都重新拉一遍（概览 KPI 是两个 Tab
  // 共用的顶部卡片，必须刷；列表只刷当前激活的那个 Tab，切回另一个 Tab 时
  // onSwitchTab 自身也会做一次"数据是否已加载过"的兜底刷新，不会展示脏数据）
  async onPullDownRefresh() {
    this.setData({ pageRefreshing: true });
    try {
      const tasks: Promise<any>[] = [this.loadOverview()];
      if (this.data.activeTab === 'codes') {
        tasks.push(this.loadActivationCodes(true));
        tasks.push(this.loadCodeStats());
      } else {
        tasks.push(this.loadTenants(true));
      }
      await Promise.all(tasks);
    } finally {
      this.setData({ pageRefreshing: false });
      wx.stopPullDownRefresh();
    }
  },

  // 🌟 触底加载更多：只对当前激活的 Tab 生效，避免在后台 Tab 里悄悄发请求
  onReachBottom() {
    if (this.data.activeTab === 'codes') {
      this.loadMoreActivationCodes();
    } else {
      this.loadMoreTenants();
    }
  },

  // 🐛 根因修复：见 store-management.ts 同处修复记录，改用 <navigation-bar>
  // 共享组件
  // 🩺（排查白屏用）navigation-bar 组件 attached() 里的 _layout() 算完自身
  // 高度后会 triggerEvent('layout', ...) 上报到这里——这条日志能出现，说明
  // 自定义导航栏组件本身已经正常渲染/挂载完成，胶囊高度计算没有卡死；如果
  // onLoad 的日志出现了但这条没出现，说明问题出在 WXML 里
  // <navigation-bar> 这个组件本身没有正常渲染，而不是页面 JS 逻辑的问题
  onNavLayout(e: { detail: { totalHeight: number } }) {
    console.log('[platform-admin] onNavLayout 收到导航栏布局上报:', e.detail);
    this.setData({ contentTop: e.detail.totalHeight + 8 });
  },

  // 🐛 根因修复：此前任何一步抛异常（fetchUserRole 网络失败、云函数未部署等）
  // 都会让 checkedAccess 永远停在 false，页面卡在"校验身份中..."出不来。
  // 现在用 try/catch 兜底，失败也会把 checkedAccess 置为 true 并落一条
  // accessError 友好文案 + 重试按钮，不会无限转圈
  async checkAccess() {
    console.log('[platform-admin] checkAccess 开始');
    try {
      let cached = AuthService.getCachedRoleInfo();
      if (!cached) {
        console.log('[platform-admin] 无缓存角色信息，发起 fetchUserRole');
        const result = await AuthService.fetchUserRole();
        cached = result.roleInfo || null;
      }
      const isPlatformAdmin = !!(cached && cached.role === 'platform_admin');
      console.log('[platform-admin] checkAccess 角色判定结果:', cached && cached.role, 'isPlatformAdmin=', isPlatformAdmin);
      this.setData({ checkedAccess: true, isPlatformAdmin, accessError: '' });

      if (isPlatformAdmin) {
        this.loadOverview();
        this.loadTenants();
        this.loadActivationCodes();
        this.loadCodeStats();
        this.loadActiveGrants();
      }
    } catch (err) {
      console.error('[platform-admin] checkAccess 异常:', err);
      this.setData({
        checkedAccess: true,
        isPlatformAdmin: false,
        accessError: '身份校验失败，请检查网络后重试'
      });
    }
  },

  onRetryCheckAccess() {
    this.setData({ checkedAccess: false, accessError: '' });
    this.checkAccess();
  },

  onSwitchTab(e: any) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.activeTab) return;
    this.setData({ activeTab: tab });
    // 🌟 切到某个 Tab 时，若它自己的列表此前还从未加载成功过（例如首次
    // checkAccess 时那次请求失败了），这里补一次兜底加载，不需要用户手动下拉刷新
    if (tab === 'codes' && this.data.activationCodes.length === 0 && !this.data.activationCodesLoading) {
      this.loadActivationCodes();
      this.loadCodeStats();
    }
    if (tab === 'tenants' && this.data.tenants.length === 0 && !this.data.tenantsLoading) {
      this.loadTenants();
    }
    if (tab === 'inspect' && this.data.inspectTenantResults.length === 0 && !this.data.inspectTenantsLoading) {
      this.loadInspectTenants();
    }
  },

  onSelectInspectRole(e: any) {
    this.setData({ inspectRole: e.currentTarget.dataset.value });
  },

  onInspectTenantKeywordInput(e: any) {
    this.setData({ inspectTenantKeyword: e.detail.value });
  },

  onInspectTenantSearchConfirm() {
    this.loadInspectTenants();
  },

  // 🔍（2026-09-10 巡检免输 ID）第一级：机构搜索选择——复用
  // manageTenantSubscription 的 listTenants（与"机构管理" Tab 同一个
  // action），独立一份 keyword/结果状态，不与机构管理 Tab 的分页/筛选状态
  // 互相干扰。留空关键词直接展示最近创建的一页机构，不强制先输入才能看到列表
  async loadInspectTenants() {
    if (this.data.inspectTenantsLoading) return;
    this.setData({ inspectTenantsLoading: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageTenantSubscription',
        data: { action: 'listTenants', skip: 0, keyword: this.data.inspectTenantKeyword }
      });
      const result = res.result as any;
      if (result && result.success) {
        this.setData({ inspectTenantResults: result.tenants || [] });
      } else {
        wx.showToast({ title: (result && result.error) || '机构列表加载失败', icon: 'none' });
      }
    } catch (err) {
      console.error('[platform-admin] loadInspectTenants 异常:', err);
      wx.showToast({ title: '机构列表加载异常', icon: 'none' });
    } finally {
      this.setData({ inspectTenantsLoading: false });
    }
  },

  // 🔍 选中机构后进入第二级门店选择，复用 getTenantDetail 的 storeList——
  // 与"机构管理" Tab 的"查看门店"抽屉同一个云调用，这里不新增查询逻辑
  async onInspectSelectTenant(e: any) {
    const { tenantid, tenantname } = e.currentTarget.dataset;
    if (!tenantid) return;
    this.setData({
      inspectStage: 'store',
      inspectSelectedTenantId: tenantid,
      inspectSelectedTenantName: tenantname,
      inspectSelectedStoreId: '',
      inspectSelectedStoreName: '',
      inspectError: ''
    });
    await this.loadInspectStores(tenantid);
  },

  async loadInspectStores(tenantId: string) {
    this.setData({ inspectStoresLoading: true, inspectStores: [] });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageTenantSubscription',
        data: { action: 'getTenantDetail', tenantId }
      });
      const result = res.result as any;
      if (result && result.success) {
        this.setData({ inspectStores: result.storeList || [] });
      } else {
        wx.showToast({ title: (result && result.error) || '门店列表加载失败', icon: 'none' });
      }
    } catch (err) {
      console.error('[platform-admin] loadInspectStores 异常:', err);
      wx.showToast({ title: '门店列表加载异常', icon: 'none' });
    } finally {
      this.setData({ inspectStoresLoading: false });
    }
  },

  onInspectSelectStore(e: any) {
    const { storeid, storename } = e.currentTarget.dataset;
    this.setData({ inspectSelectedStoreId: storeid, inspectSelectedStoreName: storename, inspectError: '' });
  },

  // ⬅️ 返回机构选择：不清空已加载的 inspectTenantResults，避免回退后又要
  // 重新搜/翻一遍
  onInspectBackToTenant() {
    this.setData({
      inspectStage: 'tenant',
      inspectSelectedStoreId: '',
      inspectSelectedStoreName: '',
      inspectError: ''
    });
  },

  // 🔍（2026-09-09 平台巡检自助授权，2026-09-10 改为选择器驱动，2026-09-10
  // 修复"未获取到当前账号身份"拦截）给自己的账号授权一家具体门店，成功后
  // 直接跳转 store-profile.ts——grantTenantAuthorization 的 grant action
  // 本身会做全部真正的安全校验（role 白名单/stores 非空/目标文档必须已
  // 存在），这里不重复校验逻辑。
  // 🐛 根因修复：此前这里要求先拿到 AuthService.getOpenid()（一个只在
  // ensureLogin() 调用过 login 云函数后才会写入的本地缓存，与 checkAccess()
  // 判定 platform_admin 身份走的是完全独立的 checkUserRole 链路）才允许提交，
  // 缓存没命中时——即便服务端早已确认当前账号就是 platform_admin——也会被
  // 这层纯客户端的空值拦截挡住，提示"未获取到当前账号身份"。本巡检 Tab 的
  // 三个调用（grant/list/revoke）都只是"操作自己账号"，不需要客户端知道
  // 自己的 openid：grantTenantAuthorization 云函数已改为不传 targetOpenId
  // 时默认取调用者自己（cloud.getWXContext() 反查，100% 可靠、无法伪造），
  // 这里直接不传，不再依赖任何本地缓存
  async onSubmitInspectGrant() {
    if (this.data.inspectSubmitting) return;
    const storeId = this.data.inspectSelectedStoreId;
    if (!storeId) {
      this.setData({ inspectError: '请先选择要巡检的门店' });
      return;
    }

    this.setData({ inspectSubmitting: true, inspectError: '' });
    try {
      const res: any = await callFunctionWithTimeout({
        name: 'grantTenantAuthorization',
        data: { action: 'grant', stores: [storeId], role: this.data.inspectRole }
      });
      const result = res && res.result;
      if (!result || !result.success) {
        this.setData({ inspectError: (result && result.error) || '授权失败，请重试' });
        return;
      }
      // 🛡️ 授权只追加进 authorizedTenants 数组，不改动任何本地缓存的角色/
      // 门店字段——下次调用 checkUserRole/AuthService.fetchUserRole() 时
      // 才会带上这条新授权，这里强制刷新一次缓存，确保紧接着跳转的
      // store-profile.ts 初次渲染就能读到，不用等一次自然刷新
      await AuthService.fetchUserRole();
      this.loadActiveGrants();
      // 🆕（2026-09-10 一键穿透直达）授权成功后 600ms 内自动跳转门店档案，
      // 平台管理员不需要再手动去找入口。跳转仍走 safeNavigateTo（而非直接
      // wx.navigateTo）——它是本仓库 200+ 调用点共用的防抖/页面栈深度兜底
      // 封装（见 utils/navHelper.ts），手快连点两次这里不会因为重复触发
      // navigateTo 而报错或叠出两级门店档案页，替换成裸 wx.navigateTo 会
      // 丢掉这层保护，收益为零、风险不为零，因此保留
      wx.showToast({ title: '巡检授权成功', icon: 'success', duration: 1500 });
      setTimeout(() => {
        safeNavigateTo({ url: `/subpackages/admin/pages/store-profile/store-profile?storeId=${storeId}` });
      }, 600);
    } catch (err) {
      console.error('[onSubmitInspectGrant] 授权异常:', err);
      this.setData({ inspectError: '网络异常，请重试' });
    } finally {
      this.setData({ inspectSubmitting: false });
    }
  },

  // 🗑️（2026-09-10 一键回收临时凭证，2026-09-10 修复"未获取到当前账号身份"
  // 拦截）只读查看 platform_admin 自己账号的 authorizedTenants 数组
  // （grantTenantAuthorization 的 list action，不传 targetOpenId 时默认取
  // 调用者自己——见 onSubmitInspectGrant 同一处根因修复注释），配一键撤销，
  // 避免该数组随巡检次数增多无限膨胀
  async loadActiveGrants() {
    if (this.data.activeGrantsLoading) return;
    this.setData({ activeGrantsLoading: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'grantTenantAuthorization',
        data: { action: 'list' }
      });
      const result = res.result as any;
      if (result && result.success) {
        const grants = (result.authorizedTenants || []).map((g: any) => ({
          ...g,
          roleLabel: INSPECT_ROLE_LABELS[g.role] || g.role,
          grantedAtLabel: this.formatDateLabel(g.grantedAt)
        }));
        this.setData({ activeGrants: grants });
      }
    } catch (err) {
      console.error('[platform-admin] loadActiveGrants 异常:', err);
    } finally {
      this.setData({ activeGrantsLoading: false });
    }
  },

  onRevokeActiveGrant(e: any) {
    const { tenantid } = e.currentTarget.dataset;
    if (!tenantid || this.data.revokingGrantTenantId) return;

    wx.showModal({
      title: '确认撤销该巡检授权？',
      content: '撤销后立即失去这家机构对应门店的临时访问权限，可随时重新授权。',
      confirmText: '确认撤销',
      confirmColor: '#E03131',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ revokingGrantTenantId: tenantid });
        wx.showLoading({ title: '处理中...', mask: true });
        try {
          const cloudRes = await callFunctionWithTimeout({
            name: 'grantTenantAuthorization',
            data: { action: 'revoke', tenantId: tenantid }
          });
          const result = cloudRes.result as any;
          wx.hideLoading();
          if (result && result.success) {
            wx.showToast({ title: '已撤销', icon: 'success' });
            safeVibrate();
            await AuthService.fetchUserRole();
            this.loadActiveGrants();
          } else {
            wx.showToast({ title: (result && result.error) || '撤销失败', icon: 'none' });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[platform-admin] onRevokeActiveGrant 异常:', err);
          wx.showModal({ title: '调用失败', content: '请确认 grantTenantAuthorization 云函数已部署', showCancel: false });
        } finally {
          this.setData({ revokingGrantTenantId: '' });
        }
      }
    });
  },

  async loadOverview() {
    this.setData({ overviewLoading: true });
    try {
      const res = await callFunctionWithTimeout({ name: 'getPlatformOverview' });
      const result = res.result as any;
      if (result && result.success) {
        this.setData({ overview: result });
      } else {
        wx.showToast({ title: (result && result.error) || '概览加载失败', icon: 'none' });
      }
    } catch (err) {
      console.error('[platform-admin] loadOverview 异常:', err);
      wx.showToast({ title: '概览加载异常', icon: 'none' });
    } finally {
      this.setData({ overviewLoading: false });
    }
  },

  // 🐛 防抖锁：创建机构/开通续费/暂停恢复服务成功后都会各自触发一次
  // loadTenants(true)（重置分页），手快连续操作或网络慢时会并发打出多个重复
  // 请求，返回顺序还可能互相覆盖。已有一轮在途时直接跳过本轮，等它自己
  // finally 解锁；reset=true 时强制清空已有分页状态重新拉第一页（下拉刷新/
  // 新建成功后的场景），reset=false 时是"加载更多"的增量追加
  async loadTenants(reset: boolean = true) {
    if (this.data.tenantsLoading) {
      console.log('[platform-admin][loadTenants] 已有请求在途，跳过本次重复调用');
      return;
    }
    this.setData({ tenantsLoading: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageTenantSubscription',
        data: { action: 'listTenants', skip: 0, keyword: this.data.tenantSearchKeyword }
      });
      const result = res.result as any;
      if (result && result.success) {
        const tenants = this.decorateTenants(result.tenants || []);
        this.setData({
          tenants,
          tenantsSkip: result.nextSkip || tenants.length,
          tenantsHasMore: !!result.hasMore
        });
      } else {
        // 🛡️ -502005 等数据库层报错：manageTenantSubscription 云函数内部已经对
        // tenant_subscriptions 做了自愈降级，result.error 已经是友好文案。这里
        // 只提示，不清空 this.data.tenants——一次网络抖动不该把已经成功加载过、
        // 正展示给用户的列表突然清空成空状态
        wx.showToast({ title: (result && result.error) || '机构列表加载失败', icon: 'none' });
      }
    } catch (err) {
      console.error('[platform-admin] loadTenants 异常:', err);
      wx.showToast({ title: '机构列表加载异常', icon: 'none' });
    } finally {
      this.setData({ tenantsLoading: false });
    }
  },

  async loadMoreTenants() {
    if (this.data.tenantsLoading || this.data.tenantsLoadingMore || !this.data.tenantsHasMore) return;
    this.setData({ tenantsLoadingMore: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageTenantSubscription',
        data: { action: 'listTenants', skip: this.data.tenantsSkip, keyword: this.data.tenantSearchKeyword }
      });
      const result = res.result as any;
      if (result && result.success) {
        const more = this.decorateTenants(result.tenants || []);
        this.setData({
          tenants: this.data.tenants.concat(more),
          tenantsSkip: result.nextSkip || (this.data.tenantsSkip + more.length),
          tenantsHasMore: !!result.hasMore
        });
      } else {
        wx.showToast({ title: (result && result.error) || '加载更多失败', icon: 'none' });
      }
    } catch (err) {
      console.error('[platform-admin] loadMoreTenants 异常:', err);
      wx.showToast({ title: '加载更多异常', icon: 'none' });
    } finally {
      this.setData({ tenantsLoadingMore: false });
    }
  },

  // 🌟 7 天内到期标记：与 getPlatformOverview 大盘"7 天内到期机构"预警同一
  // 口径，供列表里每张机构卡片自己的到期 Tag 显示橙色警告
  decorateTenants(tenants: any[]) {
    return tenants.map((t: any) => {
      const sub = t.subscription;
      const expireTime = (sub && sub.serviceExpireDate) ? new Date(sub.serviceExpireDate).getTime() : NaN;
      const isExpiringSoon = !Number.isNaN(expireTime) && (expireTime - Date.now()) > 0 && (expireTime - Date.now()) <= EXPIRING_SOON_MS;
      // 🛑 是否存在可终止的生效付费订阅：basic（免费版）或已到期都不需要
      // 展示"终止订阅"按钮——与 terminateTenantSubscription 云函数里
      // "已是免费版或已到期，无需终止"的校验口径保持一致，前端提前收起
      // 这个入口，避免点了却直接被服务端拒绝
      const isExpired = !Number.isNaN(expireTime) && expireTime < Date.now();
      const isActivePaidPlan = !!sub && sub.planType !== 'basic' && !isExpired;

      // 🏪 门店容量进度：到期/从未开通订阅一律按 basic 档配额计算——与
      // checkTenantPermission/createStore 服务端实际生效的降级口径保持一致，
      // 卡片上看到的配额数字才不会和真正建店时校验的上限对不上
      const effectivePlanType = (sub && !isExpired) ? (sub.planType || 'basic') : 'basic';
      const storeLimit = (sub && !isExpired && sub.cloudQuota && sub.cloudQuota.storeLimit)
        || Number(PLAN_STORE_LIMIT_DEFAULTS[effectivePlanType] || PLAN_STORE_LIMIT_DEFAULTS.basic);
      const storeCount = t.storeCount || 0;
      const storeQuotaPercent = storeLimit > 0 ? Math.min(100, Math.round((storeCount / storeLimit) * 100)) : 100;

      // 🐛 根因修复（状态徽章矛盾）：t.status 是 tenants 文档自己的
      // active/suspended 字段（机构记录本身有没有被管理员停用），与是否
      // 开通过付费套餐（sub 是否存在）是两个完全独立的维度——从未开通订阅
      // 的机构 t.status 依然是 'active'，此前 WXML 直接展示这个原始字段，
      // 卡片上因此显示绿色"active"，让人误以为它有生效中的套餐。这里按
      // "机构被停用 > 从未开通订阅 > 套餐已到期 > 生效中"优先级算出一个
      // 展示专用的状态，与 t.status 本身（仍用于暂停/恢复的业务判断）分开
      let displayStatus: 'suspended' | 'none' | 'expired' | 'active';
      let displayStatusLabel: string;
      if (t.status === 'suspended') {
        displayStatus = 'suspended';
        displayStatusLabel = '已暂停';
      } else if (!sub) {
        displayStatus = 'none';
        displayStatusLabel = '未开通';
      } else if (isExpired) {
        displayStatus = 'expired';
        displayStatusLabel = '已到期';
      } else {
        displayStatus = 'active';
        displayStatusLabel = '生效中';
      }

      return {
        ...t,
        isExpiringSoon,
        isActivePaidPlan,
        storeLimit,
        storeQuotaPercent,
        isStoreQuotaFull: storeCount >= storeLimit,
        displayStatus,
        displayStatusLabel
      };
    });
  },

  // ─────────────────────────────────────────────────────────────────────
  // 🌸 授权码生成/分发：微信支付商户号配好之前的过渡收入手段——平台管理员
  // 自己铸造一批一次性授权码，卖/发给机构，机构在个人页「开通/续费专业版
  // 套餐」弹窗里自助兑换（见 activateTenantSubscription 云函数 generate/
  // redeem 两个动作）。本页只做"铸造 + 台账查看"，不做兑换（兑换是机构侧
  // 自己的操作，且只允许兑换给自己所属机构，平台管理员没有所属机构）
  // ─────────────────────────────────────────────────────────────────────

  onOpenGenerateCodesSheet() {
    this.setData({
      showGenerateCodesSheet: true,
      // 每次重新打开表单都清空上一批"刚生成"的结果与残留校验错误，不用把
      // 上一批复制完的码继续顶在最上面
      lastGeneratedCodes: [],
      generateCodesErrors: { durationDays: '', quantity: '' }
    });
  },

  onCloseGenerateCodesSheet() {
    if (this.data.generatingCodes) return;
    this.setData({ showGenerateCodesSheet: false });
  },

  onSelectCodePlan(e: any) {
    this.setData({ 'generateCodesForm.planType': e.currentTarget.dataset.plan });
  },

  // 🏢 codeType 切换：常规套餐码 / 扩容门店包码，两种码在 wxml 里各自展示
  // 不同的表单字段（见 generateCodesForm 声明处注释）
  onSelectCodeType(e: any) {
    this.setData({
      'generateCodesForm.codeType': e.currentTarget.dataset.type,
      generateCodesErrors: { durationDays: '', quantity: '', extraStores: '' }
    });
  },

  onGenerateCodesFormInput(e: any) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [`generateCodesForm.${field}`]: e.detail.value,
      [`generateCodesErrors.${field}`]: ''
    });
  },

  // 🆕 前端基础校验：返回 true 表示通过。失败时把具体错误文案落进
  // generateCodesErrors，由 wxml 在对应输入框下方展示红字，不再是提交后才
  // 弹一个笼统的 Toast
  validateGenerateCodesForm(): boolean {
    const { codeType, durationDays, quantity, extraStores } = this.data.generateCodesForm;
    const quantityNum = parseInt(quantity, 10);
    const errors = { durationDays: '', quantity: '', extraStores: '' };
    let ok = true;

    if (codeType === 'add_on') {
      const extraStoresNum = parseInt(extraStores, 10);
      if (!extraStoresNum || extraStoresNum <= 0) {
        errors.extraStores = '请填写有效的扩容门店数';
        ok = false;
      } else if (extraStoresNum > 20) {
        errors.extraStores = '单张码最多扩容 20 家门店';
        ok = false;
      }
    } else {
      const durationDaysNum = parseInt(durationDays, 10);
      if (!durationDaysNum || durationDaysNum <= 0) {
        errors.durationDays = '请填写有效的有效期天数';
        ok = false;
      } else if (durationDaysNum > 3650) {
        // 🐛 根因修复（2102 年到期日溢出）：与云函数 activateTenantSubscription
        // 的 MAX_DURATION_DAYS 同一口径——多打/少删一个 0（365 误输成 3650/36500）
        // 会铸造出携带巨额有效期天数的激活码，兑换后到期日会被"正确地"顺延到
        // 离谱的未来年份。10 年封顶在这里先拦一道，不必等云函数兜底才发现填错
        errors.durationDays = '有效期天数最多 3650 天（10 年），请检查是否多输了 0';
        ok = false;
      }
    }
    if (!quantityNum || quantityNum <= 0) {
      errors.quantity = '请填写有效的生成数量';
      ok = false;
    } else if (quantityNum > 50) {
      errors.quantity = '单次最多生成 50 张，请分批生成';
      ok = false;
    }

    this.setData({ generateCodesErrors: errors });
    return ok;
  },

  // 🐛 防抖锁：避免手快连点铸造出双倍数量的码
  async onSubmitGenerateCodes() {
    if (this.data.generatingCodes) return;
    if (!this.validateGenerateCodesForm()) return;

    const { codeType, planType, durationDays, quantity, extraStores, note, targetStoreId } = this.data.generateCodesForm;
    const trimmedTargetStoreId = (targetStoreId || '').trim();
    this.setData({ generatingCodes: true });
    wx.showLoading({ title: '铸造中...', mask: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'activateTenantSubscription',
        data: codeType === 'add_on'
          ? { action: 'generate', codeType: 'add_on', extraStores: parseInt(extraStores, 10), quantity: parseInt(quantity, 10), targetStoreId: trimmedTargetStoreId }
          : { action: 'generate', codeType: 'package', planType, durationDays: parseInt(durationDays, 10), quantity: parseInt(quantity, 10), note, targetStoreId: trimmedTargetStoreId }
      });
      wx.hideLoading();
      const result = res.result as any;
      if (result && result.success) {
        wx.showToast({ title: `已生成 ${result.codes.length} 张授权码`, icon: 'success' });
        safeVibrate();
        this.setData({
          lastGeneratedCodes: result.codes,
          showGenerateCodesSheet: false,
          // 🌟 成功后清空表单残留，下次打开是干净的默认值，不会看到上一批填的数量
          generateCodesForm: { codeType: 'package', planType: 'pro', durationDays: '365', quantity: '1', extraStores: '1', note: '', targetStoreId: '' }
        });
        this.loadActivationCodes(true);
        this.loadOverview();
        this.loadCodeStats();
      } else {
        wx.showModal({ title: '生成失败', content: (result && result.error) || '未知错误', showCancel: false });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[platform-admin] generate 授权码异常:', err);
      wx.showModal({ title: '调用失败', content: '请确认 activateTenantSubscription 云函数已部署', showCancel: false });
    } finally {
      this.setData({ generatingCodes: false });
    }
  },

  // 🆕（2026-09-10）卡片整体仍可点击复制（hover-class 已提示可点击），旁边
  // 另有一个明确的「📋 复制」小按钮（catchtap，不会冒泡到卡片重复触发）—
  // 两处都传入完整 item 对象（wxml data-item="{{item}}"），复制的是格式化
  // 文本（授权码 + 类型 + 兑换说明），不是裸码，方便直接转发给机构联系人
  onCopyActivationCode(e: any) {
    const item = e.currentTarget.dataset.item;
    if (!item || !item.code) return;
    safeVibrate();
    wx.setClipboardData({
      data: buildActivationCodeCopyText(item),
      success: () => wx.showToast({ title: '授权码已复制', icon: 'success' })
    });
  },

  // 🌟 一键复制整批：卖/发一批码给同一家机构联系人时，不用一张张点复制再一张张粘贴
  onCopyAllGeneratedCodes() {
    const codes = this.data.lastGeneratedCodes;
    if (!codes || codes.length === 0) return;
    safeVibrate();
    const text = codes.map((c) => c.code).join('\n');
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: `已复制 ${codes.length} 张授权码`, icon: 'success' })
    });
  },

  onSwitchActivationCodesFilter(e: any) {
    const filter = e.currentTarget.dataset.filter;
    if (filter === this.data.activationCodesFilter) return;
    this.setData({ activationCodesFilter: filter });
    this.loadActivationCodes(true);
  },

  // 🆕（可视化制卡台账）套餐类型筛选——与上面的状态筛选是两个独立维度，
  // 写法完全同款
  onSwitchActivationCodesPlanFilter(e: any) {
    const filter = e.currentTarget.dataset.filter;
    if (filter === this.data.activationCodesPlanFilter) return;
    this.setData({ activationCodesPlanFilter: filter });
    this.loadActivationCodes(true);
  },

  // 📊（可视化制卡台账）库存看板：不影响 activationCodesLoading 那把锁——
  // 统计卡片和列表是两次独立云调用，互不阻塞
  async loadCodeStats() {
    if (this.data.codeStatsLoading) return;
    this.setData({ codeStatsLoading: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'activateTenantSubscription',
        data: { action: 'getStats' }
      });
      const result = res.result as any;
      if (result && result.success) {
        this.setData({ codeStats: result.stats });
      }
    } catch (err) {
      console.error('[platform-admin] loadCodeStats 异常:', err);
    } finally {
      this.setData({ codeStatsLoading: false });
    }
  },

  // 🕐 台账时间展示：createdAt/redeemedAt 是云函数透传的 Date 对象序列化
  // 结果（ISO 字符串），这里统一裁成 "YYYY-MM-DD HH:mm" 供列表直接展示，
  // 不在 wxml 里写日期裁剪表达式
  formatDateLabel(raw: string): string {
    if (!raw) return '';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  decorateActivationCodes(codes: any[]) {
    return codes.map((c: any) => ({
      ...c,
      createdAtLabel: this.formatDateLabel(c.createdAt),
      redeemedAtLabel: this.formatDateLabel(c.redeemedAt),
      // 📍（2026-09-10 双轨兼容）usedAtLabel 优先；历史上（本次改造前）核销的
      // 码没有 usedAt，wxml 按 usedAtLabel || redeemedAtLabel 兜底
      usedAtLabel: this.formatDateLabel(c.usedAt),
      revokedAtLabel: this.formatDateLabel(c.revokedAt)
    }));
  },

  // 🗑️ 作废激活码：仅对台账里 status === 'UNUSED' 的码展示这个按钮（wxml 侧
  // 已用 wx:if 收敛），这里再兜底拦一次，防止极端时序下（如两个管理员标签页
  // 同时操作同一批码）对已核销/已作废的码重复发起请求。作废原因走原生弹窗
  // editable 输入框，与本页 onToggleTenantStatus 停用/恢复机构服务同一套
  // "留痕审计"交互习惯保持一致
  onRevokeActivationCode(e: any) {
    const { codeid, code, status } = e.currentTarget.dataset;
    if (!codeid || status !== 'UNUSED') return;
    if (this.data.revokingCodeId) return;

    wx.showModal({
      title: `确认作废激活码 ${code}？`,
      content: '作废后该码将无法再被兑换，此操作不可撤销',
      editable: true,
      placeholderText: '请填写作废原因',
      confirmText: '确认作废',
      confirmColor: '#E03131',
      success: async (res) => {
        if (!res.confirm) return;
        const reason = (res.content || '').trim();
        if (!reason) {
          wx.showToast({ title: '请填写作废原因', icon: 'none' });
          return;
        }
        this.setData({ revokingCodeId: codeid });
        wx.showLoading({ title: '处理中...', mask: true });
        try {
          const cloudRes = await callFunctionWithTimeout({
            name: 'activateTenantSubscription',
            data: { action: 'revoke', codeId: codeid, reason }
          });
          const result = cloudRes.result as any;
          wx.hideLoading();
          if (result && result.success) {
            wx.showToast({ title: '已作废', icon: 'success' });
            safeVibrate();
            this.loadActivationCodes(true);
          } else {
            wx.showToast({ title: (result && result.error) || '作废失败', icon: 'none' });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[platform-admin] onRevokeActivationCode 异常:', err);
          wx.showModal({ title: '调用失败', content: '请确认 activateTenantSubscription 云函数已部署', showCancel: false });
        } finally {
          this.setData({ revokingCodeId: '' });
        }
      }
    });
  },

  // reset=true：筛选切换/下拉刷新/生成成功后——清空分页状态重新拉第一页
  // reset=false：不会被直接调用（增量走 loadMoreActivationCodes），保留参数
  // 只是让调用方语义显式
  async loadActivationCodes(reset: boolean = true) {
    if (this.data.activationCodesLoading) return;
    this.setData({ activationCodesLoading: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'activateTenantSubscription',
        data: { action: 'list', status: this.data.activationCodesFilter, planType: this.data.activationCodesPlanFilter, skip: 0 }
      });
      const result = res.result as any;
      if (result && result.success) {
        const codes = this.decorateActivationCodes(result.codes || []);
        this.setData({
          activationCodes: codes,
          activationCodesSkip: result.nextSkip || codes.length,
          activationCodesHasMore: !!result.hasMore
        });
      } else {
        wx.showToast({ title: (result && result.error) || '授权码台账加载失败', icon: 'none' });
      }
    } catch (err) {
      console.error('[platform-admin] loadActivationCodes 异常:', err);
      wx.showToast({ title: '授权码台账加载异常', icon: 'none' });
    } finally {
      this.setData({ activationCodesLoading: false });
    }
  },

  async loadMoreActivationCodes() {
    if (this.data.activationCodesLoading || this.data.activationCodesLoadingMore || !this.data.activationCodesHasMore) return;
    this.setData({ activationCodesLoadingMore: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'activateTenantSubscription',
        data: { action: 'list', status: this.data.activationCodesFilter, planType: this.data.activationCodesPlanFilter, skip: this.data.activationCodesSkip }
      });
      const result = res.result as any;
      if (result && result.success) {
        const more = this.decorateActivationCodes(result.codes || []);
        this.setData({
          activationCodes: this.data.activationCodes.concat(more),
          activationCodesSkip: result.nextSkip || (this.data.activationCodesSkip + more.length),
          activationCodesHasMore: !!result.hasMore
        });
      } else {
        wx.showToast({ title: (result && result.error) || '加载更多失败', icon: 'none' });
      }
    } catch (err) {
      console.error('[platform-admin] loadMoreActivationCodes 异常:', err);
      wx.showToast({ title: '加载更多异常', icon: 'none' });
    } finally {
      this.setData({ activationCodesLoadingMore: false });
    }
  },

  // ─────────────────────────────────────────────────────────────────────
  // 🏢 机构管理 Tab
  // ─────────────────────────────────────────────────────────────────────

  onOpenCreateTenantSheet() {
    this.setData({
      showCreateTenantSheet: true,
      createFormErrors: { name: '' }
    });
  },

  onCloseCreateTenantSheet() {
    if (this.data.creatingTenant) return;
    this.setData({ showCreateTenantSheet: false });
  },

  onCreateFormInput(e: any) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [`createForm.${field}`]: e.detail.value,
      [`createFormErrors.${field}`]: ''
    });
  },

  async onSubmitCreateTenant() {
    if (this.data.creatingTenant) return;
    const { name, contactName, contactPhone } = this.data.createForm;
    if (!name || !name.trim()) {
      this.setData({ createFormErrors: { name: '请填写机构名称' } });
      return;
    }

    this.setData({ creatingTenant: true });
    wx.showLoading({ title: '创建中...', mask: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageTenantSubscription',
        data: { action: 'createTenant', name, contactName, contactPhone }
      });
      wx.hideLoading();
      const result = res.result as any;
      if (result && result.success) {
        wx.showToast({ title: '机构创建成功', icon: 'success' });
        this.setData({
          showCreateTenantSheet: false,
          createForm: { name: '', contactName: '', contactPhone: '' },
          createFormErrors: { name: '' }
        });
        this.loadTenants(true);
        this.loadOverview();
      } else {
        wx.showModal({ title: '创建失败', content: (result && result.error) || '未知错误', showCancel: false });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[platform-admin] createTenant 异常:', err);
      wx.showModal({ title: '调用失败', content: '请确认 manageTenantSubscription 云函数已部署', showCancel: false });
    } finally {
      this.setData({ creatingTenant: false });
    }
  },

  onOpenRenewForm(e: any) {
    const { tenantid, tenantname } = e.currentTarget.dataset;
    const todayStr = new Date().toISOString().slice(0, 10);
    // 🌟 默认档位是基础版（免费版）：与业务规则一致——机构默认就是基础版，
    // 需要平台管理员主动升级才会进入专业版/旗舰版这条"多门店 + 到期续费"路径
    const planType = 'basic';
    const defaults = getPlanQuotaDefaults(planType, todayStr);
    this.setData({
      showRenewSheet: true,
      renewForm: {
        tenantId: tenantid,
        tenantName: tenantname,
        planType,
        serviceStartDate: todayStr,
        serviceExpireDate: defaults.serviceExpireDate,
        storeLimit: defaults.storeLimit,
        reason: ''
      },
      renewFormErrors: { serviceStartDate: '', serviceExpireDate: '', reason: '' }
    });
  },

  onCloseRenewForm() {
    if (this.data.renewSubmitting) return;
    this.setData({ showRenewSheet: false });
  },

  onRenewFormInput(e: any) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [`renewForm.${field}`]: e.detail.value,
      [`renewFormErrors.${field}`]: ''
    });
  },

  onSelectPlan(e: any) {
    const plan = e.currentTarget.dataset.plan;
    if (plan === this.data.renewForm.planType) return;
    // 🌟 档位联动：基础版自动锁定为单门店 + 永久有效，切到专业版/旗舰版时
    // 恢复"可编辑的到期日期 + 该档位默认门店配额"，与 WXML 里日期输入框/门店
    // 配额输入框按 planType 切换只读态是同一套判断依据（renewForm.planType）
    const defaults = getPlanQuotaDefaults(plan, this.data.renewForm.serviceStartDate);
    this.setData({
      'renewForm.planType': plan,
      'renewForm.storeLimit': defaults.storeLimit,
      'renewForm.serviceExpireDate': defaults.serviceExpireDate,
      'renewFormErrors.serviceExpireDate': ''
    });
  },

  validateRenewForm(): boolean {
    const { serviceStartDate, serviceExpireDate, reason } = this.data.renewForm;
    const errors = { serviceStartDate: '', serviceExpireDate: '', reason: '' };
    let ok = true;

    if (!serviceStartDate) {
      errors.serviceStartDate = '请选择服务开始日期';
      ok = false;
    }
    if (!serviceExpireDate) {
      errors.serviceExpireDate = '请选择服务到期日期';
      ok = false;
    } else if (serviceStartDate && serviceExpireDate < serviceStartDate) {
      errors.serviceExpireDate = '到期日期不能早于开始日期';
      ok = false;
    }
    if (!reason || !reason.trim()) {
      errors.reason = '请填写开通/续费原因（留痕审计）';
      ok = false;
    }

    this.setData({ renewFormErrors: errors });
    return ok;
  },

  async onSubmitRenew() {
    if (this.data.renewSubmitting) return;
    if (!this.validateRenewForm()) return;

    const { tenantId, planType, serviceStartDate, serviceExpireDate, storeLimit, reason } = this.data.renewForm;
    this.setData({ renewSubmitting: true });
    wx.showLoading({ title: '提交中...', mask: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageTenantSubscription',
        data: {
          action: 'createOrRenewSubscription',
          tenantId,
          planType,
          serviceStartDate,
          serviceExpireDate,
          cloudQuota: { storeLimit: parseInt(storeLimit, 10) || Number(PLAN_STORE_LIMIT_DEFAULTS[planType] || PLAN_STORE_LIMIT_DEFAULTS.pro) },
          reason
        }
      });
      wx.hideLoading();
      const result = res.result as any;
      if (result && result.success) {
        wx.showToast({ title: '订阅已更新', icon: 'success' });
        this.setData({ showRenewSheet: false });
        this.loadTenants(true);
        this.loadOverview();
      } else {
        wx.showModal({ title: '操作失败', content: (result && result.error) || '未知错误', showCancel: false });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[platform-admin] renew 异常:', err);
      wx.showModal({ title: '调用失败', content: '请确认 manageTenantSubscription 云函数已部署', showCancel: false });
    } finally {
      this.setData({ renewSubmitting: false });
    }
  },

  // 🏪 机构下挂门店抽屉：点击机构卡片"查看门店"唤起，调用 getTenantDetail
  // 拿到 storeList（门店名称/状态/城市/创建时间）——这是"机构列表看不到某个
  // 门店"这类问题的排查入口，门店本身不会在机构列表里单独占一行
  async onOpenTenantStores(e: any) {
    const { tenantid, tenantname } = e.currentTarget.dataset;
    this.setData({
      showTenantStoresSheet: true,
      tenantStoresTenantId: tenantid,
      // 🐛 根因修复（2026-09-10 控制台警告）：wxml 侧已经在 data-tenantname
      // 兜底了"未命名机构"，这里再兜底一层——防止未来有别的调用点（如果有）
      // 忘了在 wxml 侧兜底，setData 收到 undefined 会报
      // "Setting data field 'tenantStoresTenantName' to undefined is invalid"
      tenantStoresTenantName: tenantname || '未命名机构'
    });
    await this.loadTenantStores(tenantid);
  },

  // 抽出来供"移出机构/停用门店"操作成功后刷新同一个抽屉用，避免重复维护
  // 一份几乎一样的请求+decorate逻辑
  async loadTenantStores(tenantId: string) {
    this.setData({ tenantStoresLoading: true, tenantStores: [] });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageTenantSubscription',
        data: { action: 'getTenantDetail', tenantId }
      });
      const result = res.result as any;
      if (result && result.success) {
        this.setData({
          tenantStores: (result.storeList || []).map((s: any) => ({
            ...s,
            createdAtLabel: this.formatDateLabel(s.createdAt)
          }))
        });
      } else {
        wx.showToast({ title: (result && result.error) || '门店列表加载失败', icon: 'none' });
      }
    } catch (err) {
      console.error('[platform-admin] loadTenantStores 异常:', err);
      wx.showToast({ title: '门店列表加载异常', icon: 'none' });
    } finally {
      this.setData({ tenantStoresLoading: false });
    }
  },

  onCloseTenantStores() {
    this.setData({ showTenantStoresSheet: false });
  },

  // 🚪 移出机构：清空该门店的 tenantId，使其脱离当前机构（变为待关联的孤儿
  // 门店，需要另外走一次关联才能重新挂到某个机构下）。这是纯平台管理员操作，
  // 与门店自己所属机构的 super_admin 无关，所以没有走 updateStoreStatus/
  // updateStoreName 那套"调用者必须是本机构 super_admin"的鉴权模型，而是
  // 新增 manageTenantSubscription 的 removeStoreFromTenant action（platform_admin
  // 专属，可跨机构操作任意门店）
  onRemoveStoreFromTenant(e: any) {
    const { storeid, storename } = e.currentTarget.dataset;
    if (!storeid || this.data.storeActionInFlightId) return;

    wx.showModal({
      title: `确认将「${storename}」移出机构？`,
      content: '移出后该门店将失去机构归属（tenantId 清空），需要重新关联才能出现在任何机构的门店清单里，历史账目数据不受影响。',
      confirmText: '确认移出',
      confirmColor: '#E03131',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ storeActionInFlightId: storeid });
        wx.showLoading({ title: '处理中...', mask: true });
        try {
          const cloudRes = await callFunctionWithTimeout({
            name: 'manageTenantSubscription',
            data: { action: 'removeStoreFromTenant', storeId: storeid }
          });
          const result = cloudRes.result as any;
          wx.hideLoading();
          if (result && result.success) {
            wx.showToast({ title: '已移出机构', icon: 'success' });
            safeVibrate();
            // 🆕（2026-09-10 按钮状态互斥收尾）不再整份重新拉取门店列表——
            // 那样会因为这一行不再匹配 tenantId 查询条件而直接从列表消失，
            // 管理员想"移出 A 机构、马上加入 B 机构"就得先关抽屉、重新在
            // 机构列表里找回这家门店。这里改为就地把这一行的 tenantId 清空，
            // 行内按钮立刻切换成"加入机构"，可以无缝接着操作；机构卡片上的
            // storeCount 数字仍需要一次真实数据刷新，走 loadTenants(true)
            // 后台完成，不阻塞这次操作的视觉反馈
            const updatedStores = this.data.tenantStores.map((s: any) =>
              s._id === storeid ? { ...s, tenantId: '' } : s
            );
            this.setData({ tenantStores: updatedStores });
            this.loadTenants(true);
          } else {
            wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[platform-admin] onRemoveStoreFromTenant 异常:', err);
          wx.showModal({ title: '调用失败', content: '请确认 manageTenantSubscription 云函数已部署', showCancel: false });
        } finally {
          this.setData({ storeActionInFlightId: '' });
        }
      }
    });
  },

  // 🚪（2026-09-10 废除手动输入机构ID，改为点选）与 onRemoveStoreFromTenant
  // 对称，把一家孤儿门店（tenantId 已清空，通常就是刚在本抽屉里"移出机构"
  // 的那一行）关联到指定机构——对接 manageTenantSubscription 的
  // assignStoreToTenant action（platform_admin 专属，服务端会做目标机构配额
  // CAS 校验，配额已满时返回 STORE_LIMIT_REACHED，这里直接把 error 文案吐司
  // 出来，不需要额外分支处理）。
  // 🐛 根因修复：v1 用 wx.showModal 的可编辑输入框收目标机构 ID，要求管理员
  // 去机构列表卡片上复制一长串 Mongo ObjectId 再粘贴回来，体验极差且容易
  // 抄错。改为 wx.showActionSheet 直接列机构名称点选——复用「机构管理」Tab
  // 已加载的 this.data.tenants（本抽屉本来就只能从这个 Tab 打开），不额外
  // 发云调用；只列出第一页已加载的机构，如果目标机构还没被搜/翻到，需要先
  // 在「机构管理」Tab 搜索栏搜出来再回来操作——这是当前的已知限制，不是 bug
  onAssignStoreToTenant(e: any) {
    const { storeid, storename } = e.currentTarget.dataset;
    if (!storeid || this.data.storeActionInFlightId) return;

    const candidates = (this.data.tenants || []).filter((t: any) => t._id !== this.data.tenantStoresTenantId);
    if (candidates.length === 0) {
      wx.showToast({ title: '暂无其他可选机构，请先在"机构管理"里加载/搜出目标机构', icon: 'none', duration: 2500 });
      return;
    }

    wx.showActionSheet({
      itemList: candidates.map((t: any) => t.name || '未命名机构'),
      success: (res) => {
        const target = candidates[res.tapIndex];
        if (!target) return;
        this.confirmAssignStoreToTenant(storeid, storename, target._id, target.name || '未命名机构');
      }
    });
  },

  // 抽出来供 onAssignStoreToTenant 选中目标机构后调用，保持 wx.showActionSheet
  // 的 success 回调本身简短
  async confirmAssignStoreToTenant(storeId: string, storeName: string, targetTenantId: string, targetTenantName: string) {
    this.setData({ storeActionInFlightId: storeId });
    wx.showLoading({ title: '处理中...', mask: true });
    try {
      const cloudRes = await callFunctionWithTimeout({
        name: 'manageTenantSubscription',
        data: { action: 'assignStoreToTenant', storeId, targetTenantId }
      });
      const result = cloudRes.result as any;
      wx.hideLoading();
      if (result && result.success) {
        wx.showToast({ title: `已加入「${targetTenantName}」`, icon: 'success' });
        safeVibrate();
        // 已经加入了别的机构，不再属于本抽屉正在查看的这家，直接从列表移除
        this.setData({
          tenantStores: this.data.tenantStores.filter((s: any) => s._id !== storeId)
        });
        this.loadTenants(true);
      } else {
        wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none', duration: 2500 });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[platform-admin] confirmAssignStoreToTenant 异常:', err);
      wx.showModal({ title: '调用失败', content: '请确认 manageTenantSubscription 云函数已部署', showCancel: false });
    } finally {
      this.setData({ storeActionInFlightId: '' });
    }
  },

  // 🛑 停用/启用门店：与 store-management.ts 里超管本人操作走的是同一份业务
  // 语义（stores.status active/inactive，停用后禁止新增记账，见
  // utils/dataService.ts saveReport 的硬校验），但调用者是平台管理员而非该
  // 机构自己的 super_admin，同样走 manageTenantSubscription 新增的
  // setStoreStatus action（platform_admin 专属，跨机构生效）
  onSetStoreStatus(e: any) {
    const { storeid, storename, status } = e.currentTarget.dataset;
    if (!storeid || this.data.storeActionInFlightId) return;
    const targetStatus = status === 'inactive' ? 'active' : 'inactive';
    const actionLabel = targetStatus === 'inactive' ? '停用' : '启用';

    wx.showModal({
      title: `确认${actionLabel}「${storename}」？`,
      content: targetStatus === 'inactive'
        ? '停用后该门店将无法再提交新的记账数据，历史数据不受影响，可随时重新启用。'
        : '重新启用后该门店可继续正常提交记账数据。',
      confirmColor: targetStatus === 'inactive' ? '#E03131' : '#8C1D18',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ storeActionInFlightId: storeid });
        wx.showLoading({ title: '处理中...', mask: true });
        try {
          const cloudRes = await callFunctionWithTimeout({
            name: 'manageTenantSubscription',
            data: { action: 'setStoreStatus', storeId: storeid, status: targetStatus }
          });
          const result = cloudRes.result as any;
          wx.hideLoading();
          if (result && result.success) {
            wx.showToast({ title: targetStatus === 'inactive' ? '门店已停用' : '门店已重新启用', icon: 'success' });
            safeVibrate();
            await this.afterTenantStoreMutation();
          } else {
            wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[platform-admin] onSetStoreStatus 异常:', err);
          wx.showModal({ title: '调用失败', content: '请确认 manageTenantSubscription 云函数已部署', showCancel: false });
        } finally {
          this.setData({ storeActionInFlightId: '' });
        }
      }
    });
  },

  // 👪 解除家长/退出授权：清空该门店的家长绑定（stores.patriarch/
  // patriarchOpenId）并摘除对应用户的 STORE_PATRIARCH 身份，供家长失联/
  // 申请错误/机构要求更换家长等场景使用。与 onSetStoreStatus 同一套鉴权
  // 模型——platform_admin 专属，跨机构对任意门店生效
  onUnbindStorePatriarch(e: any) {
    const { storeid, storename, patriarch } = e.currentTarget.dataset;
    if (!storeid || this.data.storeActionInFlightId) return;

    wx.showModal({
      title: `确认解除「${storename}」的家长绑定？`,
      content: `当前家长：${patriarch || '未知'}。解除后该用户将立即失去家长身份（若还兼任其他身份则平滑降级，不受影响），此操作不可撤销。`,
      confirmText: '确认解除',
      confirmColor: '#E03131',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ storeActionInFlightId: storeid });
        wx.showLoading({ title: '处理中...', mask: true });
        try {
          const cloudRes = await callFunctionWithTimeout({
            name: 'manageTenantSubscription',
            data: { action: 'unbindStorePatriarch', storeId: storeid }
          });
          const result = cloudRes.result as any;
          wx.hideLoading();
          if (result && result.success) {
            wx.showToast({ title: '已解除家长绑定', icon: 'success' });
            safeVibrate();
            await this.afterTenantStoreMutation();
          } else {
            wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[platform-admin] onUnbindStorePatriarch 异常:', err);
          wx.showModal({ title: '调用失败', content: '请确认 manageTenantSubscription 云函数已部署', showCancel: false });
        } finally {
          this.setData({ storeActionInFlightId: '' });
        }
      }
    });
  },

  // 🔄 门店行内操作成功后的统一刷新：抽屉里的门店清单（当前机构可能已经不再
  // 包含刚移出的那家）+ 机构列表卡片上的 storeCount 数字，两处口径都来自
  // 服务端重新查询，不在前端本地估算/自减，避免 count 漂移
  async afterTenantStoreMutation() {
    const tasks: Promise<any>[] = [this.loadTenants(true)];
    if (this.data.tenantStoresTenantId) {
      tasks.push(this.loadTenantStores(this.data.tenantStoresTenantId));
    }
    await Promise.all(tasks);
  },

  onToggleTenantStatus(e: any) {
    const { tenantid, currentstatus } = e.currentTarget.dataset;
    const nextStatus = currentstatus === 'suspended' ? 'active' : 'suspended';
    const actionLabel = nextStatus === 'suspended' ? '暂停' : '恢复';

    wx.showModal({
      title: `确认${actionLabel}该机构服务？`,
      editable: true,
      placeholderText: `请填写${actionLabel}原因`,
      confirmText: '确认',
      success: async (res) => {
        if (!res.confirm) return;
        const reason = String(res.content || '').trim();
        if (!reason) {
          wx.showToast({ title: '请填写原因', icon: 'none' });
          return;
        }

        wx.showLoading({ title: '处理中...', mask: true });
        try {
          const cbRes = await callFunctionWithTimeout({
            name: 'manageTenantSubscription',
            data: { action: 'updateTenantStatus', tenantId: tenantid, status: nextStatus, reason }
          });
          wx.hideLoading();
          const result = cbRes.result as any;
          if (result && result.success) {
            wx.showToast({ title: `已${actionLabel}`, icon: 'success' });
            this.loadTenants(true);
          } else {
            wx.showModal({ title: '操作失败', content: (result && result.error) || '未知错误', showCancel: false });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[platform-admin] updateTenantStatus 异常:', err);
          wx.showModal({ title: '调用失败', content: '请确认 manageTenantSubscription 云函数已部署', showCancel: false });
        }
      }
    });
  },

  // 🆕（操作栏紧凑化，2026-09-10 扩充修改名称/彻底注销）"更多"入口——用
  // 微信原生 ActionSheet 收纳暂停/恢复服务、终止订阅、修改机构名称、彻底
  // 注销这几个低频/危险操作，不新建自定义弹窗组件。选中后直接调用对应的
  // on* 方法（构造一个只含 currentTarget.dataset 的最小事件对象——这几个
  // 方法本来就只读这个字段），各自已有的 wx.showModal 二次确认原样保留，
  // 这里不重复做一次确认。
  // ⚠️ wx.showActionSheet 的 itemColor 是整份作用于全部选项的单一颜色，
  // 原生 API 不支持逐项配色——"彻底注销"用文案前缀 ⚠️ 标出危险，真正的
  // "警示色"体现在 onDeleteTenant 二次确认弹窗的 confirmColor
  onOpenTenantMoreActions(e: any) {
    const item = e.currentTarget.dataset.item;
    if (!item) return;
    const itemList: string[] = [item.status === 'suspended' ? '恢复服务' : '暂停服务'];
    const actionTypes: Array<'toggleStatus' | 'terminate' | 'editName' | 'delete'> = ['toggleStatus'];
    if (item.isActivePaidPlan) {
      itemList.push('终止订阅');
      actionTypes.push('terminate');
    }
    itemList.push('修改机构名称');
    actionTypes.push('editName');
    itemList.push('⚠️ 彻底注销此机构');
    actionTypes.push('delete');

    wx.showActionSheet({
      itemList,
      itemColor: '#C62828',
      success: (res) => {
        const type = actionTypes[res.tapIndex];
        if (type === 'terminate') {
          this.onTerminateSubscription({
            currentTarget: { dataset: { tenantid: item._id, tenantname: item.name, plantype: item.subscription && item.subscription.planType } }
          });
        } else if (type === 'editName') {
          this.onEditTenantName({
            currentTarget: { dataset: { tenantid: item._id, tenantname: item.name } }
          });
        } else if (type === 'delete') {
          this.onDeleteTenant({
            currentTarget: { dataset: { tenantid: item._id, tenantname: item.name, storecount: item.storeCount || 0 } }
          });
        } else {
          this.onToggleTenantStatus({
            currentTarget: { dataset: { tenantid: item._id, currentstatus: item.status } }
          });
        }
      }
    });
  },

  // ✏️（2026-09-10 新增）修改机构名称——单字段更新，走新增的
  // manageTenantSubscription updateTenantName action。非空/未变化校验在
  // 前端先拦一道 UX 层面的空跑，服务端仍会自己再校验一遍非空，不信任客户端
  onEditTenantName(e: any) {
    const { tenantid, tenantname } = e.currentTarget.dataset;
    if (!tenantid) return;
    wx.showModal({
      title: '修改机构名称',
      content: tenantname || '',
      editable: true,
      placeholderText: '请输入新的机构名称',
      confirmText: '保存',
      success: async (res) => {
        if (!res.confirm) return;
        const newName = String(res.content || '').trim();
        if (!newName) {
          wx.showToast({ title: '机构名称不能为空', icon: 'none' });
          return;
        }
        if (newName === tenantname) return;
        wx.showLoading({ title: '保存中...', mask: true });
        try {
          const cloudRes = await callFunctionWithTimeout({
            name: 'manageTenantSubscription',
            data: { action: 'updateTenantName', tenantId: tenantid, name: newName }
          });
          const result = cloudRes.result as any;
          wx.hideLoading();
          if (result && result.success) {
            wx.showToast({ title: '机构名称已更新', icon: 'success' });
            safeVibrate();
            this.loadTenants(true);
          } else {
            wx.showToast({ title: (result && result.error) || '修改失败', icon: 'none' });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[platform-admin] onEditTenantName 异常:', err);
          wx.showModal({ title: '调用失败', content: '请确认 manageTenantSubscription 云函数已部署', showCancel: false });
        }
      }
    });
  },

  // 🗑️（2026-09-10 新增，危险操作）彻底注销空机构——前端只做两层拦截：
  // storeCount > 0 直接拒绝；storeCount === 0 才弹不可逆二次确认。服务端
  // deleteTenant action 会重新查一遍真实门店数 + 有没有生效付费套餐 + 有
  // 没有账号绑定这个 tenantId，不信任这里传入的 storecount（卡片上的
  // storeCount 是上一次 loadTenants 时的快照，可能已经过时）
  onDeleteTenant(e: any) {
    const { tenantid, tenantname, storecount } = e.currentTarget.dataset;
    if (!tenantid) return;

    if (Number(storecount) > 0) {
      wx.showModal({
        title: '禁止注销',
        content: '该机构下存在关联门店，请先解绑或迁移门店后再注销。',
        showCancel: false
      });
      return;
    }

    wx.showModal({
      title: '危险：彻底注销机构',
      content: `确定要注销「${tenantname}」吗？此操作不可逆，将物理清除该机构记录。`,
      confirmText: '确认注销',
      confirmColor: '#FA5151',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '注销中...', mask: true });
        try {
          const cloudRes = await callFunctionWithTimeout({
            name: 'manageTenantSubscription',
            data: { action: 'deleteTenant', tenantId: tenantid }
          });
          const result = cloudRes.result as any;
          wx.hideLoading();
          if (result && result.success) {
            wx.showToast({ title: '机构已注销', icon: 'success' });
            safeVibrate();
            // 🌟 直接从本地列表移除，不等一次 loadTenants(true) 往返——"从
            // 列表消失"本身就是最直观的反馈，省一次不必要的云调用
            this.setData({ tenants: this.data.tenants.filter((t: any) => t._id !== tenantid) });
            this.loadOverview();
          } else {
            wx.showModal({ title: '注销失败', content: (result && result.error) || '未知错误', showCancel: false });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[platform-admin] onDeleteTenant 异常:', err);
          wx.showModal({ title: '调用失败', content: '请确认 manageTenantSubscription 云函数已部署', showCancel: false });
        }
      }
    });
  },

  // 🆕 机构 ID 复制——与本页 onCopyActivationCode 同一套写法
  onCopyTenantId(e: any) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.setClipboardData({
      data: id,
      success: () => wx.showToast({ title: '已复制机构ID', icon: 'success' })
    });
  },

  // 🆕 机构搜索：仅同步本地输入值，实际发起查询在 onTenantSearchConfirm——
  // 不做输入即触发的防抖搜索，避免每敲一个字就打一次云函数请求
  onTenantSearchInput(e: any) {
    this.setData({ tenantSearchKeyword: e.detail.value });
  },

  onTenantSearchConfirm() {
    this.loadTenants(true);
  },

  // 🆕 状态筛选：纯本地 wx:if 快筛，不重新发云调用——与授权码台账的套餐
  // 类型筛选同一种权衡
  onSwitchTenantStatusFilter(e: any) {
    const value = e.currentTarget.dataset.value;
    if (!value || value === this.data.tenantStatusFilter) return;
    this.setData({ tenantStatusFilter: value });
  },

  // 🛑 终止订阅：误操作/退款/提前解约场景下，收回机构当前生效的付费套餐，
  // 立即降级为免费版。与 onToggleTenantStatus（暂停/恢复整个机构服务）是
  // 两个独立操作——这里只动套餐，不影响机构本身能不能正常使用免费版功能
  onTerminateSubscription(e: any) {
    const { tenantid, tenantname, plantype } = e.currentTarget.dataset;
    if (!tenantid || this.data.terminatingTenantId) return;
    const planLabel = PLAN_LABELS[plantype] || plantype;

    wx.showModal({
      title: '终止订阅',
      content: `确定要终止「${tenantname}」的${planLabel}权益吗？终止后该机构及下属门店将立即失去${planLabel}功能。`,
      confirmText: '确认终止',
      confirmColor: '#E03131',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ terminatingTenantId: tenantid });
        wx.showLoading({ title: '处理中...', mask: true });
        try {
          const cbRes = await callFunctionWithTimeout({
            name: 'manageTenantSubscription',
            data: { action: 'terminateTenantSubscription', tenantId: tenantid }
          });
          wx.hideLoading();
          const result = cbRes.result as any;
          if (result && result.success) {
            wx.showToast({ title: result.message || '订阅已成功终止', icon: 'success' });
            safeVibrate();
            this.loadTenants(true);
          } else {
            wx.showModal({ title: '操作失败', content: (result && result.error) || '未知错误', showCancel: false });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[platform-admin] onTerminateSubscription 异常:', err);
          wx.showModal({ title: '调用失败', content: '请确认 manageTenantSubscription 云函数已部署', showCancel: false });
        } finally {
          this.setData({ terminatingTenantId: '' });
        }
      }
    });
  },

  noop() {
    // 用于阻止弹窗内部点击事件冒泡触发遮罩层的关闭逻辑
  },

  // 🛡️ 全局返回逻辑排查修复：goHome() 是给分享直入场景的物理返回键设计的，不该
  // 挪用给自定义导航栏的"←"按钮——那会导致不管从哪个页面点进来都被强制跳回首页
  onGoBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
  }
});
