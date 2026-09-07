import { callFunctionWithTimeout } from '../../../../utils/withTimeout';
// 页面：商品管理 —— 素食直播产销协同 Module B，space_owner/space_admin 端
// 商品（SKU）新建/编辑/上下架，直接调用既有的 manageProduct 云函数（create/
// update/remove/restore/list），本页不改动任何后端逻辑，只是给它接一个前端。
//
// 🚪 入口方式：通过 wx.navigateTo 传入 tenantId 查询参数打开
// （production-fulfillment 页顶部"商品管理"入口已接好，仅 canManageProducts
// 为 true 时才显示该入口——manageProduct.create/update 本身也会再校验一次
// space_owner/space_admin 身份，本页面没有权限判断纯粹是体验层，不是唯一防线）。
const NAME_MAX_LEN = 60; // 与 manageProduct/lib/validateProduct.js 的 NAME_MAX_LEN 保持一致
const DESCRIPTION_MAX_LEN = 500; // 与 DESCRIPTION_MAX_LEN 保持一致

interface ProductItem {
  _id: string;
  name: string;
  price: number; // 分
  dailyCapacityLimit: number;
  leadTimeDays: number;
  producerOpenId: string;
  description: string;
  status: string;
  // 展示用派生字段
  priceYuan?: string;
  statusLabel?: string;
}

interface ProductForm {
  name: string;
  priceYuan: string;
  dailyCapacityLimit: string;
  leadTimeDays: string;
  producerOpenId: string;
  description: string;
}

const EMPTY_FORM: ProductForm = {
  name: '', priceYuan: '', dailyCapacityLimit: '', leadTimeDays: '0', producerOpenId: '', description: ''
};

// 🏛️（《素食产销工坊升级与生态护城河演进计划书》里程碑 M0）支付模式与分账
// 费率此前没有任何前端配置入口，只能去数据库控制台手改。这里把它接在商品
// 管理页——本页已经是 space_owner/space_admin 语境下管理工坊核心资产的地方，
// 不新建一个专门的"工坊设置"页面（当前唯一使用场景就是这一处配置，不值得
// 单独开一整套路由/app.json 注册）
interface SettlementConfigForm {
  paymentMode: 'none' | 'direct_wechat';
  producerRatePercent: string; // 展示层用百分数字符串（如 "75"），提交时才换算成 0~1 小数
  promoterRatePercent: string;
}

const EMPTY_SETTLEMENT_CONFIG_FORM: SettlementConfigForm = {
  paymentMode: 'none', producerRatePercent: '75', promoterRatePercent: '20'
};

// 🏛️（护城河二 M3）拼团批次管理——固定 3 档阶梯价输入（后端 validateGroupBuyBatch
// 最多支持 5 档，但商品管理页只暴露 3 档：绝大多数拼团场景 3 档阶梯已经够用，
// 一次性做一个"动态增删档位"的表单交互成本明显高于收益，不做这个提前投入；
// 真有商家需要 4~5 档，届时再加字段/表单行，不提前设计一个没人用的灵活度
interface GroupBuyBatchItem {
  _id: string;
  batchDate: string;
  committedQuantity: number;
  status: string;
  deadlineAt: string;
  tierThresholds: Array<{ minQuantity: number; unitPriceOverride: number }>;
  // 展示用派生字段
  statusLabel?: string;
  deadlineStr?: string;
  tiersLabel?: string;
}

interface GroupBuyForm {
  batchDate: string;
  deadlineDate: string;
  deadlineTime: string;
  tier1Qty: string;
  tier1PriceYuan: string;
  tier2Qty: string;
  tier2PriceYuan: string;
  tier3Qty: string;
  tier3PriceYuan: string;
}

const EMPTY_GROUP_BUY_FORM: GroupBuyForm = {
  batchDate: '', deadlineDate: '', deadlineTime: '20:00',
  tier1Qty: '', tier1PriceYuan: '', tier2Qty: '', tier2PriceYuan: '', tier3Qty: '', tier3PriceYuan: ''
};

const GROUP_BUY_STATUS_LABEL: Record<string, string> = {
  collecting: '进行中', locked: '已锁定（产能已满）', closed: '已关闭'
};

Page({
  data: {
    contentTop: 0,

    tenantId: '',
    loading: true,
    loadError: '',
    products: [] as ProductItem[],

    showForm: false,
    formMode: 'create' as 'create' | 'edit',
    editingProductId: '',
    form: { ...EMPTY_FORM },
    submitting: false,

    togglingId: '',

    // 🏛️ 支付与分账设置（M0）
    showSettlementConfigForm: false,
    settlementConfigLoading: false,
    settlementConfigSubmitting: false,
    settlementConfigForm: { ...EMPTY_SETTLEMENT_CONFIG_FORM },
    // 平台留存比例是展示派生值（100% - 制作方 - 推广员），每次用户改动费率
    // 输入框都会重新计算，不需要用户自己心算
    platformRatePercentDisplay: '5',

    // 🏛️（护城河二 M3）拼团批次设置
    showGroupBuyModal: false,
    groupBuyProductId: '',
    groupBuyProductName: '',
    groupBuyProductPriceYuan: '',
    groupBuyBatchesLoading: false,
    groupBuyBatches: [] as GroupBuyBatchItem[],
    groupBuyForm: { ...EMPTY_GROUP_BUY_FORM },
    groupBuySubmitting: false
  },

  onLoad(options: Record<string, string>) {
    const tenantId = (options && options.tenantId) || '';
    if (!tenantId) {
      wx.showToast({ title: '缺少工作空间参数', icon: 'none' });
      setTimeout(() => wx.navigateBack({ delta: 1 }), 1200);
      return;
    }
    this.setData({ tenantId });
    this.loadProducts();
  },

  // 🐛 根因修复：见 store-management.ts 同处修复记录，改用 <navigation-bar>
  // 共享组件
  onNavLayout(e: { detail: { totalHeight: number } }) {
    this.setData({ contentTop: e.detail.totalHeight + 8 });
  },

  onPullDownRefresh() {
    this.loadProducts(() => wx.stopPullDownRefresh());
  },

  async loadProducts(done?: () => void) {
    this.setData({ loading: true, loadError: '' });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageProduct',
        data: { action: 'list', tenantId: this.data.tenantId, status: 'all' }
      });
      const result = res.result as any;
      if (result && result.success) {
        const products: ProductItem[] = (result.products || []).map((p: ProductItem) => ({
          ...p,
          priceYuan: ((p.price || 0) / 100).toFixed(2),
          statusLabel: p.status === 'active' ? '在架' : '已下架'
        }));
        this.setData({ products, loadError: '' });
      } else {
        this.setData({ products: [], loadError: (result && result.error) || '加载失败' });
      }
    } catch (err) {
      console.error('[product-management] loadProducts 异常:', err);
      this.setData({ products: [], loadError: '加载异常，请重试' });
    } finally {
      this.setData({ loading: false });
      if (typeof done === 'function') done();
    }
  },

  onTapCreate() {
    this.setData({ showForm: true, showSettlementConfigForm: false, formMode: 'create', editingProductId: '', form: { ...EMPTY_FORM } });
  },

  onTapEdit(e: any) {
    const id = e.currentTarget.dataset.id;
    const product = this.data.products.find((p) => p._id === id);
    if (!product) return;
    this.setData({
      showForm: true,
      showSettlementConfigForm: false,
      formMode: 'edit',
      editingProductId: id,
      form: {
        name: product.name,
        priceYuan: product.priceYuan || '',
        dailyCapacityLimit: String(product.dailyCapacityLimit),
        leadTimeDays: String(product.leadTimeDays),
        producerOpenId: product.producerOpenId || '',
        description: product.description || ''
      }
    });
  },

  onCancelForm() {
    this.setData({ showForm: false });
  },

  onFormFieldInput(e: any) {
    const field = e.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  async onSubmitForm() {
    if (this.data.submitting) return;
    const form = this.data.form;

    const name = (form.name || '').trim();
    const description = (form.description || '').trim();
    const priceYuan = parseFloat(form.priceYuan);
    const dailyCapacityLimit = parseInt(form.dailyCapacityLimit, 10);
    const leadTimeDays = parseInt(form.leadTimeDays || '0', 10);

    // 基础校验：与服务端 validateProduct.js 的规则同口径提前拦一遍，避免
    // 用户填完等一圈网络往返才被服务端拒绝——服务端校验仍然是唯一防线，
    // 这里只是提升体验，不代表信任客户端
    if (!name) {
      wx.showToast({ title: '请填写商品名称', icon: 'none' });
      return;
    }
    if (name.length > NAME_MAX_LEN) {
      wx.showToast({ title: `商品名称不能超过 ${NAME_MAX_LEN} 个字符`, icon: 'none' });
      return;
    }
    if (!(priceYuan > 0)) {
      wx.showToast({ title: '请填写正确的价格', icon: 'none' });
      return;
    }
    if (!(dailyCapacityLimit > 0) || !Number.isInteger(dailyCapacityLimit)) {
      wx.showToast({ title: '单日产能须为正整数', icon: 'none' });
      return;
    }
    if (!Number.isInteger(leadTimeDays) || leadTimeDays < 0) {
      wx.showToast({ title: '前置天数须为非负整数', icon: 'none' });
      return;
    }
    if (description.length > DESCRIPTION_MAX_LEN) {
      wx.showToast({ title: `商品简介不能超过 ${DESCRIPTION_MAX_LEN} 个字符`, icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '保存中...', mask: true });

    const payload: Record<string, unknown> = {
      tenantId: this.data.tenantId,
      name,
      price: Math.round(priceYuan * 100),
      dailyCapacityLimit,
      leadTimeDays,
      producerOpenId: (form.producerOpenId || '').trim(),
      description
    };
    if (this.data.formMode === 'edit') payload.productId = this.data.editingProductId;

    try {
      const res = await callFunctionWithTimeout({
        name: 'manageProduct',
        data: { action: this.data.formMode === 'edit' ? 'update' : 'create', ...payload }
      });
      const result = res.result as any;
      wx.hideLoading();

      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '保存失败，请重试', icon: 'none' });
        return;
      }
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ showForm: false });
      this.loadProducts();
    } catch (err) {
      wx.hideLoading();
      console.error('[product-management] onSubmitForm 异常:', err);
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  // switch 组件的 bindchange 已经带上了用户"想要切到"的目标值（e.detail.value），
  // 但实际状态仍然只认服务端确认后的 products[].status——用户在确认弹窗里点
  // "取消"时，switch 的 checked 绑定的是 item.status === 'active'，数据没变，
  // 下一次渲染 switch 会自己弹回原状态，不需要额外手动复位
  onSwitchStatus(e: any) {
    const id = e.currentTarget.dataset.id;
    const product = this.data.products.find((p) => p._id === id);
    if (!product || this.data.togglingId) return;

    const goingActive = !!e.detail.value;
    wx.showModal({
      title: goingActive ? '确认上架？' : '确认下架？',
      content: goingActive ? '上架后买家可在预售日历中看到并下单该商品。' : '下架后买家将无法继续下单该商品，已有订单不受影响。',
      confirmColor: '#8C1D18',
      success: (res) => {
        if (res.confirm) this.toggleStatus(id, goingActive);
      }
    });
  },

  async toggleStatus(productId: string, goingActive: boolean) {
    this.setData({ togglingId: productId });
    wx.showLoading({ title: '处理中...', mask: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageProduct',
        data: { action: goingActive ? 'restore' : 'remove', tenantId: this.data.tenantId, productId }
      });
      const result = res.result as any;
      wx.hideLoading();
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '操作失败，请重试', icon: 'none' });
        return;
      }
      this.loadProducts();
    } catch (err) {
      wx.hideLoading();
      console.error('[product-management] toggleStatus 异常:', err);
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    } finally {
      this.setData({ togglingId: '' });
    }
  },

  // ============ 支付与分账设置（M0） ============

  async onOpenSettlementConfig() {
    this.setData({ showSettlementConfigForm: true, showForm: false, settlementConfigLoading: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageTenantSettlementConfig',
        data: { action: 'get', tenantId: this.data.tenantId }
      });
      const result = res.result as any;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '加载失败，请重试', icon: 'none' });
        this.setData({ showSettlementConfigForm: false });
        return;
      }
      const producerRatePercent = String(Math.round((result.producerRate || 0) * 100));
      const promoterRatePercent = String(Math.round((result.promoterRate || 0) * 100));
      this.setData({
        settlementConfigForm: {
          paymentMode: result.paymentMode === 'direct_wechat' ? 'direct_wechat' : 'none',
          producerRatePercent,
          promoterRatePercent
        }
      });
      this.updatePlatformRateDisplay(producerRatePercent, promoterRatePercent);
    } catch (err) {
      console.error('[product-management] onOpenSettlementConfig 异常:', err);
      wx.showToast({ title: '加载异常，请重试', icon: 'none' });
      this.setData({ showSettlementConfigForm: false });
    } finally {
      this.setData({ settlementConfigLoading: false });
    }
  },

  onCancelSettlementConfig() {
    this.setData({ showSettlementConfigForm: false });
  },

  onSelectPaymentMode(e: any) {
    const mode = e.currentTarget.dataset.mode;
    if (mode !== 'none' && mode !== 'direct_wechat') return;
    this.setData({ 'settlementConfigForm.paymentMode': mode });
  },

  onSettlementConfigFieldInput(e: any) {
    const field = e.currentTarget.dataset.field;
    if (!field) return;
    const value = e.detail.value;
    this.setData({ [`settlementConfigForm.${field}`]: value });
    const form = this.data.settlementConfigForm;
    const producerRatePercent = field === 'producerRatePercent' ? value : form.producerRatePercent;
    const promoterRatePercent = field === 'promoterRatePercent' ? value : form.promoterRatePercent;
    this.updatePlatformRateDisplay(producerRatePercent, promoterRatePercent);
  },

  // 纯展示层派生计算，不做任何校验兜底——真正的合法性校验在 onSubmitSettlementConfig
  // 与服务端 validateSettlementConfig.js 里，这里只是让用户填的时候心里有数
  updatePlatformRateDisplay(producerRatePercent: string, promoterRatePercent: string) {
    const producer = parseFloat(producerRatePercent) || 0;
    const promoter = parseFloat(promoterRatePercent) || 0;
    const platform = Math.round((100 - producer - promoter) * 100) / 100;
    this.setData({ platformRatePercentDisplay: String(platform) });
  },

  async onSubmitSettlementConfig() {
    if (this.data.settlementConfigSubmitting) return;
    const form = this.data.settlementConfigForm;
    const producerRate = parseFloat(form.producerRatePercent) / 100;
    const promoterRate = parseFloat(form.promoterRatePercent) / 100;

    // 基础校验：与服务端 validateSettlementConfig.js 同口径提前拦一遍，避免
    // 用户填完等一圈网络往返才被服务端拒绝——服务端校验仍然是唯一防线
    if (!Number.isFinite(producerRate) || producerRate < 0 || producerRate > 1) {
      wx.showToast({ title: '制作方分成比例须为 0~100 的数字', icon: 'none' });
      return;
    }
    if (!Number.isFinite(promoterRate) || promoterRate < 0 || promoterRate > 1) {
      wx.showToast({ title: '推广员分成比例须为 0~100 的数字', icon: 'none' });
      return;
    }
    if (producerRate + promoterRate > 1) {
      wx.showToast({ title: '制作方 + 推广员比例之和不能超过 100%', icon: 'none' });
      return;
    }

    this.setData({ settlementConfigSubmitting: true });
    wx.showLoading({ title: '保存中...', mask: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageTenantSettlementConfig',
        data: { action: 'update', tenantId: this.data.tenantId, paymentMode: form.paymentMode, producerRate, promoterRate }
      });
      const result = res.result as any;
      wx.hideLoading();
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '保存失败，请重试', icon: 'none' });
        return;
      }
      // 🌟 切到 direct_wechat 时服务端会带一句真实前置条件提醒，用 showModal
      // 而不是 showToast——这句话信息量较大（提醒去微信支付商户平台开通分账
      // 权限），Toast 停留时间太短看不完
      if (result.warning) {
        wx.showModal({ title: '提示', content: result.warning, showCancel: false, confirmText: '知道了' });
      } else {
        wx.showToast({ title: '已保存', icon: 'success' });
      }
      this.setData({ showSettlementConfigForm: false });
    } catch (err) {
      wx.hideLoading();
      console.error('[product-management] onSubmitSettlementConfig 异常:', err);
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    } finally {
      this.setData({ settlementConfigSubmitting: false });
    }
  },

  // ============ 护城河二 M3：拼团批次管理 ============

  stopPropagation() {},

  onOpenGroupBuyModal(e: any) {
    const id = e.currentTarget.dataset.id;
    const product = this.data.products.find((p) => p._id === id);
    if (!product) return;
    this.setData({
      showGroupBuyModal: true,
      showForm: false,
      showSettlementConfigForm: false,
      groupBuyProductId: id,
      groupBuyProductName: product.name,
      groupBuyProductPriceYuan: product.priceYuan || '',
      groupBuyForm: { ...EMPTY_GROUP_BUY_FORM }
    });
    this.loadGroupBuyBatches();
  },

  onCloseGroupBuyModal() {
    this.setData({ showGroupBuyModal: false });
  },

  async loadGroupBuyBatches() {
    this.setData({ groupBuyBatchesLoading: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageGroupBuyBatch',
        data: { action: 'list', tenantId: this.data.tenantId, productId: this.data.groupBuyProductId }
      });
      const result = res.result as any;
      if (result && result.success) {
        const batches: GroupBuyBatchItem[] = (result.batches || []).map((b: GroupBuyBatchItem) => ({
          ...b,
          statusLabel: GROUP_BUY_STATUS_LABEL[b.status] || b.status,
          deadlineStr: b.deadlineAt ? new Date(b.deadlineAt).toLocaleString('zh-CN', { hour12: false }) : '',
          tiersLabel: (b.tierThresholds || [])
            .slice().sort((x, y) => x.minQuantity - y.minQuantity)
            .map((t) => `满${t.minQuantity}件¥${(t.unitPriceOverride / 100).toFixed(2)}`)
            .join(' / ')
        }));
        this.setData({ groupBuyBatches: batches });
      } else {
        wx.showToast({ title: (result && result.error) || '加载失败', icon: 'none' });
      }
    } catch (err) {
      console.error('[product-management] loadGroupBuyBatches 异常:', err);
      wx.showToast({ title: '加载异常，请重试', icon: 'none' });
    } finally {
      this.setData({ groupBuyBatchesLoading: false });
    }
  },

  onGroupBuyFormFieldInput(e: any) {
    const field = e.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [`groupBuyForm.${field}`]: e.detail.value });
  },

  onGroupBuyDateChange(e: any) {
    this.setData({ 'groupBuyForm.batchDate': e.detail.value });
  },

  onGroupBuyDeadlineDateChange(e: any) {
    this.setData({ 'groupBuyForm.deadlineDate': e.detail.value });
  },

  onGroupBuyDeadlineTimeChange(e: any) {
    this.setData({ 'groupBuyForm.deadlineTime': e.detail.value });
  },

  // 基础校验：与服务端 validateGroupBuyBatch.js 同口径提前拦一遍，服务端仍是
  // 唯一防线。空的档位行（数量/单价任一为空）视为"这一档不填"，直接跳过，
  // 不强制用户填满 3 档
  buildTierThresholdsFromForm(): Array<{ minQuantity: number; unitPriceOverride: number }> | null {
    const form = this.data.groupBuyForm;
    const rows = [
      [form.tier1Qty, form.tier1PriceYuan],
      [form.tier2Qty, form.tier2PriceYuan],
      [form.tier3Qty, form.tier3PriceYuan]
    ];
    const tiers: Array<{ minQuantity: number; unitPriceOverride: number }> = [];
    for (const [qtyStr, priceStr] of rows) {
      if (!qtyStr && !priceStr) continue; // 整行都没填，跳过
      const minQuantity = parseInt(qtyStr, 10);
      const unitPriceOverride = Math.round(parseFloat(priceStr) * 100);
      if (!(minQuantity > 0) || !(unitPriceOverride > 0)) return null; // 半填状态视为非法
      tiers.push({ minQuantity, unitPriceOverride });
    }
    return tiers;
  },

  async onSubmitGroupBuyBatch() {
    if (this.data.groupBuySubmitting) return;
    const form = this.data.groupBuyForm;
    if (!form.batchDate) {
      wx.showToast({ title: '请选择批次日期', icon: 'none' });
      return;
    }
    if (!form.deadlineDate) {
      wx.showToast({ title: '请选择拼团截止日期', icon: 'none' });
      return;
    }
    const tierThresholds = this.buildTierThresholdsFromForm();
    if (!tierThresholds || tierThresholds.length === 0) {
      wx.showToast({ title: '请至少完整填写一档阶梯价（数量+单价）', icon: 'none' });
      return;
    }
    const deadlineAt = `${form.deadlineDate}T${form.deadlineTime || '20:00'}:00`;
    if (new Date(deadlineAt).getTime() <= Date.now()) {
      wx.showToast({ title: '截止时间必须晚于当前时间', icon: 'none' });
      return;
    }

    this.setData({ groupBuySubmitting: true });
    wx.showLoading({ title: '提交中...', mask: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageGroupBuyBatch',
        data: {
          action: 'create',
          tenantId: this.data.tenantId,
          productId: this.data.groupBuyProductId,
          batchDate: form.batchDate,
          tierThresholds,
          deadlineAt
        }
      });
      const result = res.result as any;
      wx.hideLoading();
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '创建失败，请重试', icon: 'none' });
        return;
      }
      wx.showToast({ title: '拼团批次已创建', icon: 'success' });
      this.setData({ groupBuyForm: { ...EMPTY_GROUP_BUY_FORM } });
      this.loadGroupBuyBatches();
    } catch (err) {
      wx.hideLoading();
      console.error('[product-management] onSubmitGroupBuyBatch 异常:', err);
      wx.showToast({ title: '创建失败，请重试', icon: 'none' });
    } finally {
      this.setData({ groupBuySubmitting: false });
    }
  },

  async onCloseGroupBuyBatch(e: any) {
    const batchDate = e.currentTarget.dataset.date;
    if (!batchDate) return;
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '关闭拼团批次',
        content: `确认关闭 ${batchDate} 这场拼团？关闭后不再接受新的拼团加入，已下单的订单不受影响。`,
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      });
    });
    if (!confirmed) return;

    wx.showLoading({ title: '处理中...', mask: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageGroupBuyBatch',
        data: { action: 'close', tenantId: this.data.tenantId, productId: this.data.groupBuyProductId, batchDate }
      });
      const result = res.result as any;
      wx.hideLoading();
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '操作失败，请重试', icon: 'none' });
        return;
      }
      wx.showToast({ title: '已关闭', icon: 'success' });
      this.loadGroupBuyBatches();
    } catch (err) {
      wx.hideLoading();
      console.error('[product-management] onCloseGroupBuyBatch 异常:', err);
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    }
  }
});
