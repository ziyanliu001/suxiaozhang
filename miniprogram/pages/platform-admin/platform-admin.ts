import { AuthService } from '../../utils/authService';
import { createNavGuard, NavGuardInstance } from '../../utils/navGuard';

const PLAN_LABELS: Record<string, string> = {
  basic: '基础版',
  pro: '专业版',
  enterprise: '旗舰版'
};

Page({
  _navGuard: null as NavGuardInstance | null,

  data: {
    navTop: 0,
    contentTop: 0,
    checkedAccess: false,
    isPlatformAdmin: false,
    loading: false,
    overview: null as any,
    tenants: [] as any[],
    planLabels: PLAN_LABELS,

    showCreateForm: false,
    createForm: { name: '', contactName: '', contactPhone: '' },

    showRenewForm: false,
    renewForm: {
      tenantId: '',
      tenantName: '',
      planType: 'basic',
      serviceStartDate: '',
      serviceExpireDate: '',
      storeLimit: '',
      reason: ''
    },

    // 🌸 授权码生成/分发：微信支付商户号配好之前的过渡收入手段——平台管理员
    // 自己铸造一批一次性授权码，卖/发给机构，机构在个人页「开通/续费专业版
    // 套餐」弹窗里自助兑换（见 activateTenantSubscription 云函数 generate/
    // redeem 两个动作）。本页只做"铸造 + 台账查看"，不做兑换（兑换是机构侧
    // 自己的操作，且只允许兑换给自己所属机构，平台管理员没有所属机构）
    showGenerateCodesForm: false,
    generateCodesForm: { planType: 'pro', durationDays: '365', quantity: '1' },
    generatingCodes: false,
    // 🌟 刚生成的这一批：单独存一份，生成成功后置顶展示 + 一键复制，不用去
    // 下面的台账列表里翻找刚铸造出来的这几个码
    lastGeneratedCodes: [] as Array<{ code: string; planType: string; durationDays: number }>,
    activationCodesLoading: false,
    activationCodesFilter: 'UNUSED' as 'UNUSED' | 'USED' | 'all',
    activationCodes: [] as Array<{
      code: string;
      planType: string;
      durationDays: number;
      status: string;
      createdAt: string;
      redeemedAt: string;
      redeemedByTenantName: string;
    }>
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

  async checkAccess() {
    let cached = AuthService.getCachedRoleInfo();
    if (!cached) {
      const result = await AuthService.fetchUserRole();
      cached = result.roleInfo || null;
    }
    const isPlatformAdmin = !!(cached && cached.role === 'platform_admin');
    this.setData({ checkedAccess: true, isPlatformAdmin });

    if (isPlatformAdmin) {
      this.loadOverview();
      this.loadTenants();
      this.loadActivationCodes();
    }
  },

  async loadOverview() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getPlatformOverview' });
      const result = res.result as any;
      if (result && result.success) {
        this.setData({ overview: result });
      } else {
        wx.showToast({ title: (result && result.error) || '概览加载失败', icon: 'none' });
      }
    } catch (err) {
      console.error('[platform-admin] loadOverview 异常:', err);
      wx.showToast({ title: '概览加载异常', icon: 'none' });
    }
  },

  // 🐛 防抖锁：复用既有的 loading 字段做 in-flight guard——此前无任何拦截，
  // 创建机构/开通续费/暂停恢复服务成功后都会各自触发一次 loadTenants()，手快
  // 连续操作或网络慢时会并发打出多个重复的机构列表请求，返回顺序还可能互相
  // 覆盖。已有一轮在途时直接跳过本轮，等它自己 finally 解锁
  async loadTenants() {
    if (this.data.loading) {
      console.log('[platform-admin][loadTenants] 已有请求在途，跳过本次重复调用');
      return;
    }
    this.setData({ loading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageTenantSubscription',
        data: { action: 'listTenants' }
      });
      const result = res.result as any;
      if (result && result.success) {
        // 🌟 7 天内到期标记：与 getPlatformOverview 大盘"7 天内到期机构"预警
        // 同一口径，供列表里每张机构卡片自己的到期 Tag 显示橙色警告
        const EXPIRING_SOON_MS = 7 * 24 * 3600 * 1000;
        const tenants = (result.tenants || []).map((t: any) => {
          const sub = t.subscription;
          const expireTime = (sub && sub.serviceExpireDate) ? new Date(sub.serviceExpireDate).getTime() : NaN;
          const isExpiringSoon = !Number.isNaN(expireTime) && (expireTime - Date.now()) > 0 && (expireTime - Date.now()) <= EXPIRING_SOON_MS;
          return { ...t, isExpiringSoon };
        });
        this.setData({ tenants });
      } else {
        // 🛡️ -502005 等数据库层报错：manageTenantSubscription 云函数内部已经对
        // tenant_subscriptions 做了自愈降级（见该云函数 safeGetLatestSubscription），
        // 这里的 result.error 已经是友好文案（如"系统配置维护中，请联系技术支持"），
        // 不会是裸的数据库报错。这里只提示，不清空 this.data.tenants——一次网络
        // 抖动不该把已经成功加载过、正展示给用户的列表突然清空成空状态
        wx.showToast({ title: (result && result.error) || '机构列表加载失败', icon: 'none' });
      }
    } catch (err) {
      console.error('[platform-admin] loadTenants 异常:', err);
      wx.showToast({ title: '机构列表加载异常', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // ─────────────────────────────────────────────────────────────────────
  // 🌸 授权码生成/分发：过渡收入手段，见 data 声明处注释
  // ─────────────────────────────────────────────────────────────────────

  onToggleGenerateCodesForm() {
    this.setData({
      showGenerateCodesForm: !this.data.showGenerateCodesForm,
      // 每次重新展开表单都清空上一批"刚生成"的结果，避免误以为这批还在等着复制
      lastGeneratedCodes: []
    });
  },

  onSelectCodePlan(e: any) {
    this.setData({ 'generateCodesForm.planType': e.currentTarget.dataset.plan });
  },

  onGenerateCodesFormInput(e: any) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`generateCodesForm.${field}`]: e.detail.value });
  },

  // 🐛 防抖锁：与 loadTenants 同一套 in-flight guard，避免手快连点铸造出双倍数量的码
  async onSubmitGenerateCodes() {
    if (this.data.generatingCodes) return;
    const { planType, durationDays, quantity } = this.data.generateCodesForm;
    const durationDaysNum = parseInt(durationDays, 10);
    const quantityNum = parseInt(quantity, 10);
    if (!durationDaysNum || durationDaysNum <= 0) {
      wx.showToast({ title: '请填写有效的有效期天数', icon: 'none' });
      return;
    }
    if (!quantityNum || quantityNum <= 0) {
      wx.showToast({ title: '请填写有效的生成数量', icon: 'none' });
      return;
    }
    if (quantityNum > 50) {
      wx.showToast({ title: '单次最多生成 50 张，请分批生成', icon: 'none' });
      return;
    }

    this.setData({ generatingCodes: true });
    wx.showLoading({ title: '铸造中...', mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'activateTenantSubscription',
        data: { action: 'generate', planType, durationDays: durationDaysNum, quantity: quantityNum }
      });
      wx.hideLoading();
      const result = res.result as any;
      if (result && result.success) {
        wx.showToast({ title: `已生成 ${result.codes.length} 张授权码`, icon: 'success' });
        this.setData({ lastGeneratedCodes: result.codes, showGenerateCodesForm: false });
        this.loadActivationCodes();
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
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '已复制授权码', icon: 'success' })
    });
  },

  // 🌟 一键复制整批：卖/发一批码给同一家机构联系人时，不用一张张点复制再一张张粘贴
  onCopyAllGeneratedCodes() {
    const codes = this.data.lastGeneratedCodes;
    if (!codes || codes.length === 0) return;
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
    this.loadActivationCodes();
  },

  async loadActivationCodes() {
    if (this.data.activationCodesLoading) return;
    this.setData({ activationCodesLoading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'activateTenantSubscription',
        data: { action: 'list', status: this.data.activationCodesFilter }
      });
      const result = res.result as any;
      if (result && result.success) {
        this.setData({ activationCodes: result.codes || [] });
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

  onToggleCreateForm() {
    this.setData({ showCreateForm: !this.data.showCreateForm });
  },

  onCreateFormInput(e: any) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`createForm.${field}`]: e.detail.value });
  },

  async onSubmitCreateTenant() {
    const { name, contactName, contactPhone } = this.data.createForm;
    if (!name || !name.trim()) {
      wx.showToast({ title: '请填写机构名称', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '创建中...', mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageTenantSubscription',
        data: { action: 'createTenant', name, contactName, contactPhone }
      });
      wx.hideLoading();
      const result = res.result as any;
      if (result && result.success) {
        wx.showToast({ title: '机构创建成功', icon: 'success' });
        this.setData({
          showCreateForm: false,
          createForm: { name: '', contactName: '', contactPhone: '' }
        });
        this.loadTenants();
        this.loadOverview();
      } else {
        wx.showModal({ title: '创建失败', content: (result && result.error) || '未知错误', showCancel: false });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[platform-admin] createTenant 异常:', err);
      wx.showModal({ title: '调用失败', content: '请确认 manageTenantSubscription 云函数已部署', showCancel: false });
    }
  },

  onOpenRenewForm(e: any) {
    const { tenantid, tenantname } = e.currentTarget.dataset;
    const todayStr = new Date().toISOString().slice(0, 10);
    const nextYear = new Date();
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    this.setData({
      showRenewForm: true,
      renewForm: {
        tenantId: tenantid,
        tenantName: tenantname,
        planType: 'basic',
        serviceStartDate: todayStr,
        serviceExpireDate: nextYear.toISOString().slice(0, 10),
        storeLimit: '5',
        reason: ''
      }
    });
  },

  onCloseRenewForm() {
    this.setData({ showRenewForm: false });
  },

  onRenewFormInput(e: any) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`renewForm.${field}`]: e.detail.value });
  },

  onSelectPlan(e: any) {
    const plan = e.currentTarget.dataset.plan;
    this.setData({ 'renewForm.planType': plan });
  },

  async onSubmitRenew() {
    const { tenantId, planType, serviceStartDate, serviceExpireDate, storeLimit, reason } = this.data.renewForm;
    if (!reason || !reason.trim()) {
      wx.showToast({ title: '请填写开通/续费原因', icon: 'none' });
      return;
    }
    if (!serviceStartDate || !serviceExpireDate) {
      wx.showToast({ title: '请填写服务起止日期', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '提交中...', mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageTenantSubscription',
        data: {
          action: 'createOrRenewSubscription',
          tenantId,
          planType,
          serviceStartDate,
          serviceExpireDate,
          cloudQuota: { storeLimit: parseInt(storeLimit, 10) || 5 },
          reason
        }
      });
      wx.hideLoading();
      const result = res.result as any;
      if (result && result.success) {
        wx.showToast({ title: '订阅已更新', icon: 'success' });
        this.setData({ showRenewForm: false });
        this.loadTenants();
        this.loadOverview();
      } else {
        wx.showModal({ title: '操作失败', content: (result && result.error) || '未知错误', showCancel: false });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[platform-admin] renew 异常:', err);
      wx.showModal({ title: '调用失败', content: '请确认 manageTenantSubscription 云函数已部署', showCancel: false });
    }
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
          const cbRes = await wx.cloud.callFunction({
            name: 'manageTenantSubscription',
            data: { action: 'updateTenantStatus', tenantId: tenantid, status: nextStatus, reason }
          });
          wx.hideLoading();
          const result = cbRes.result as any;
          if (result && result.success) {
            wx.showToast({ title: `已${actionLabel}`, icon: 'success' });
            this.loadTenants();
          } else {
            wx.showModal({ title: '操作失败', content: (result && result.error) || '未知错误', showCancel: false });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[platform-admin] updateTenantStatus 异常:', err);
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
