import { AuthService } from '../../../../utils/authService';
import { createNavGuard, NavGuardInstance } from '../../../../utils/navGuard';
import { callFunctionWithTimeout } from '../../../../utils/withTimeout';

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

// 🌟 套餐档位切换联动：basic 固定为「1 家门店 + 永久有效」，不再需要选服务
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
    navTop: 0,
    contentTop: 0,
    checkedAccess: false,
    // 🐛 根因修复：checkAccess() 此前一旦抛异常（网络异常/云函数未部署等），
    // checkedAccess 永远停留在 false，页面卡死在"校验身份中..."。现在无论成功
    // 失败都会落地到 true，失败时改用这个字段展示可重试的错误态，不再无限转圈
    accessError: '',
    isPlatformAdmin: false,
    // 🗂️ 顶层 Tab 分流：授权码管理 / 机构管理，取代此前所有模块纵向堆叠在
    // 单屏里的混乱体验
    activeTab: 'codes' as 'codes' | 'tenants',
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
    generateCodesForm: { codeType: 'package', planType: 'pro', durationDays: '365', quantity: '1', extraStores: '1' },
    // 🆕 前端基础校验：输入框失焦/提交时填充，非空即代表校验不通过，wxml 据此
    // 显示红色错误提示，不用等点了提交按钮才用 Toast 告知
    generateCodesErrors: { durationDays: '', quantity: '', extraStores: '' },
    generatingCodes: false,
    // 🌟 刚生成的这一批：单独存一份，生成成功后置顶展示 + 一键复制，不用去
    // 下面的台账列表里翻找刚铸造出来的这几个码
    lastGeneratedCodes: [] as Array<{ code: string; codeType?: string; planType?: string; durationDays?: number; extraStores?: number }>,
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
    activationCodes: [] as Array<{
      _id: string;
      code: string;
      planType: string;
      durationDays: number;
      status: string;
      createdAt: string;
      redeemedAt: string;
      redeemedByTenantName: string;
      revokedAt: string;
      revokeReason: string;
      createdAtLabel: string;
      redeemedAtLabel: string;
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
    renewSubmitting: false
  },

  onLoad() {
    this.calculateNavBarHeight();
    this.checkAccess();

    this._navGuard = createNavGuard({
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

  // 🌟 原生下拉刷新：两个 Tab 各自的数据源都重新拉一遍（概览 KPI 是两个 Tab
  // 共用的顶部卡片，必须刷；列表只刷当前激活的那个 Tab，切回另一个 Tab 时
  // onSwitchTab 自身也会做一次"数据是否已加载过"的兜底刷新，不会展示脏数据）
  async onPullDownRefresh() {
    this.setData({ pageRefreshing: true });
    try {
      const tasks: Promise<any>[] = [this.loadOverview()];
      if (this.data.activeTab === 'codes') {
        tasks.push(this.loadActivationCodes(true));
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

  // 🐛 根因修复：此前任何一步抛异常（fetchUserRole 网络失败、云函数未部署等）
  // 都会让 checkedAccess 永远停在 false，页面卡在"校验身份中..."出不来。
  // 现在用 try/catch 兜底，失败也会把 checkedAccess 置为 true 并落一条
  // accessError 友好文案 + 重试按钮，不会无限转圈
  async checkAccess() {
    try {
      let cached = AuthService.getCachedRoleInfo();
      if (!cached) {
        const result = await AuthService.fetchUserRole();
        cached = result.roleInfo || null;
      }
      const isPlatformAdmin = !!(cached && cached.role === 'platform_admin');
      this.setData({ checkedAccess: true, isPlatformAdmin, accessError: '' });

      if (isPlatformAdmin) {
        this.loadOverview();
        this.loadTenants();
        this.loadActivationCodes();
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
    }
    if (tab === 'tenants' && this.data.tenants.length === 0 && !this.data.tenantsLoading) {
      this.loadTenants();
    }
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
        data: { action: 'listTenants', skip: 0 }
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
        data: { action: 'listTenants', skip: this.data.tenantsSkip }
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

      return {
        ...t,
        isExpiringSoon,
        isActivePaidPlan,
        storeLimit,
        storeQuotaPercent,
        isStoreQuotaFull: storeCount >= storeLimit
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

    const { codeType, planType, durationDays, quantity, extraStores } = this.data.generateCodesForm;
    this.setData({ generatingCodes: true });
    wx.showLoading({ title: '铸造中...', mask: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'activateTenantSubscription',
        data: codeType === 'add_on'
          ? { action: 'generate', codeType: 'add_on', extraStores: parseInt(extraStores, 10), quantity: parseInt(quantity, 10) }
          : { action: 'generate', codeType: 'package', planType, durationDays: parseInt(durationDays, 10), quantity: parseInt(quantity, 10) }
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
          generateCodesForm: { codeType: 'package', planType: 'pro', durationDays: '365', quantity: '1', extraStores: '1' }
        });
        this.loadActivationCodes(true);
        this.loadOverview();
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

  onCopyActivationCode(e: any) {
    const code = e.currentTarget.dataset.code;
    if (!code) return;
    safeVibrate();
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '已复制授权码', icon: 'success' })
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
        data: { action: 'list', status: this.data.activationCodesFilter, skip: 0 }
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
        data: { action: 'list', status: this.data.activationCodesFilter, skip: this.data.activationCodesSkip }
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
      tenantStoresTenantName: tenantname
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
            await this.afterTenantStoreMutation();
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

  // 🚪 加入机构：与 onRemoveStoreFromTenant 对称，把一家孤儿门店（或需要改挂
  // 归属的门店）关联到指定机构——对接 manageTenantSubscription 的
  // assignStoreToTenant action（platform_admin 专属，服务端会做目标机构配额
  // CAS 校验，配额已满时返回 STORE_LIMIT_REACHED，这里直接把 error 文案吐司
  // 出来，不需要额外分支处理）。v1 用 wx.showModal 的可编辑输入框收目标机构 ID，
  // 暂不做搜索选择器，保持轻量
  onAssignStoreToTenant(e: any) {
    const { storeid, storename } = e.currentTarget.dataset;
    if (!storeid || this.data.storeActionInFlightId) return;

    wx.showModal({
      title: `将「${storename}」加入机构`,
      editable: true,
      placeholderText: '请输入目标机构 ID（见机构卡片"机构 ID"）',
      confirmText: '确认加入',
      success: async (res) => {
        if (!res.confirm) return;
        const targetTenantId = (res.content || '').trim();
        if (!targetTenantId) {
          wx.showToast({ title: '请输入目标机构 ID', icon: 'none' });
          return;
        }
        this.setData({ storeActionInFlightId: storeid });
        wx.showLoading({ title: '处理中...', mask: true });
        try {
          const cloudRes = await callFunctionWithTimeout({
            name: 'manageTenantSubscription',
            data: { action: 'assignStoreToTenant', storeId: storeid, targetTenantId }
          });
          const result = cloudRes.result as any;
          wx.hideLoading();
          if (result && result.success) {
            wx.showToast({ title: '已加入机构', icon: 'success' });
            safeVibrate();
            await this.afterTenantStoreMutation();
          } else {
            wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none', duration: 2500 });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[platform-admin] onAssignStoreToTenant 异常:', err);
          wx.showModal({ title: '调用失败', content: '请确认 manageTenantSubscription 云函数已部署', showCancel: false });
        } finally {
          this.setData({ storeActionInFlightId: '' });
        }
      }
    });
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
