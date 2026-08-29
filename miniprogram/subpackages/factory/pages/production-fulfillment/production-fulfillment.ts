// 页面：排单与发货管理 —— 素食直播产销协同 Module B/C 的制作方/管理员端入口
//
// 🚪 入口方式：wx.navigateTo 传入 tenantId 查询参数打开（profile.ts/index.ts
// 的入口都这么调用），例如
// '/subpackages/factory/pages/production-fulfillment/production-fulfillment?tenantId=' + tenantId；
// 未传 tenantId 时回退读取本地持久化的上次选中空间（见 CURRENT_TENANT_STORAGE_KEY），
// 两者都没有才提示"缺少工作空间参数"退出。
//
// 📦 本页与 product-management/storefront/workspace-join 一起位于独立分包
// subpackages/factory 下（root: "subpackages/factory"，见 app.json），不在
// 主包里——这四个页面搬进来之前主包编译体积超过了微信 2MB 主包限制。分包内
// 页面之间用绝对路径互相跳转（如本文件里跳去 product-management），分包页面
// 跳回主包页面（如 settlement-summary）同样用绝对路径，两种情况都不需要关心
// "对方是不是在同一个包"，微信原生支持跨包跳转。
// 🔀 多工坊切换：账号可能同时属于多个 live_factory 工作空间（自己的工坊 +
// 被别的工坊邀请当 producer）。顶部工坊切换器只在 mySpaces.length > 1 时
// 显示，切换后会重置所有当前工坊相关的页面状态（订单列表/角色/各类弹窗）
// 再用新 tenantId 重新加载，不会把上一个工坊的数据残留在页面上——见
// switchTenant()。
//
// 数据来源：直接复用 getProductionBoard 云函数——它已经做了 tenantId 归属
// 校验（仅 space_owner/space_admin/producer 可查看），返回的 orders 字段就是
// 待发货订单明细（Step 3 之前只返回聚合后的 tasks/materials，本轮追加了
// 逐单明细，不重复查库）。
import { getTodayIsoString } from '../../../../utils/dateUtils';
import { callFunctionWithTimeout } from '../../../../utils/withTimeout';

const CURRENT_TENANT_STORAGE_KEY = 'LIVE_FACTORY_CURRENT_TENANT_ID';

const RANGE_DAYS = 30; // 展示未来 30 天内的待发货订单，与其它列表页的合理默认区间一致

function addDaysIso(isoDateStr: string, days: number): string {
  const [y, m, d] = isoDateStr.split('-').map((n) => parseInt(n, 10));
  const date = new Date(y, m - 1, d + days);
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const ORDER_STATUS_LABEL: Record<string, string> = {
  paid: '已付款 · 待生产',
  in_production: '生产中'
};

interface FulfillmentOrder {
  _id: string;
  productId: string;
  productName: string;
  buyerOpenId: string;
  quantity: number;
  payAmount: number;
  batchDate: string;
  estimatedShippingDate: string;
  orderStatus: string;
  // 展示用派生字段
  statusLabel?: string;
  payAmountYuan?: string;
}

const INVITE_ROLE_LABEL: Record<string, string> = { producer: '制作方', promoter: '推广员' };

// 与 cloudfunctions/completeProductionOrder/lib/validateShipment.js 的
// EXPRESS_COMPANIES 保持一致——前端选项和后端白名单分别维护是这个仓库一贯
// 的做法（各云函数/页面独立部署，没有跨端共享常量的机制），改动任一边记得
// 同步另一边
const EXPRESS_COMPANY_OPTIONS = ['顺丰', '中通', '圆通', '韵达', '极兔', '邮政', '其他'];

Page({
  data: {
    navTop: 0,
    contentTop: 0,

    tenantId: '',
    loading: true,
    loadError: '',
    orders: [] as FulfillmentOrder[],

    markingId: '', // 正在标记发货的订单 id，用于禁用对应按钮防止重复点击

    // 📦 去发货/录入快递单号弹窗
    expressCompanyOptions: EXPRESS_COMPANY_OPTIONS,
    showShipModal: false,
    shipOrderId: '',
    shipExpressCompanyIndex: -1,
    shipTrackingNumber: '',
    shipSubmitting: false,

    // 🧺 商品管理/邀请成员只对 space_owner/space_admin 开放，producer 能看
    // 发货看板但不能改商品/发邀请——loadMySpaces() 通过 getMyProductionSpaces
    // 反查当前账号在本 tenantId 下的角色来决定
    canManageProducts: false,

    // 🔀 多工坊切换
    mySpaces: [] as Array<{ tenantId: string; tenantName: string; role: string }>,
    currentTenantName: '',
    showSwitcherModal: false,

    // 🤝 邀请成员弹窗状态
    showInviteModal: false,
    inviteRole: 'producer' as 'producer' | 'promoter',
    inviteGenerating: false,
    inviteResult: null as { code: string; roleLabel: string; qrFileID: string } | null
  },

  onLoad(options: Record<string, string>) {
    this.calculateNavBarHeight();

    const tenantId = (options && options.tenantId) || wx.getStorageSync(CURRENT_TENANT_STORAGE_KEY) || '';
    if (!tenantId) {
      wx.showToast({ title: '缺少工作空间参数', icon: 'none' });
      setTimeout(() => wx.navigateBack({ delta: 1 }), 1200);
      return;
    }
    this.setData({ tenantId });
    wx.setStorageSync(CURRENT_TENANT_STORAGE_KEY, tenantId);
    this.loadOrders();
    this.loadMySpaces();
  },

  // 复用 getMyProductionSpaces（已有云函数，不新增接口）拿到本账号归属的
  // 全部工坊列表——既用来判断当前工坊下的角色（决定商品管理/邀请成员两个
  // 管理入口是否显示），也用来驱动顶部的多工坊切换器（列表长度 >1 才显示）。
  // 失败时保守按"不可管理、不显示切换器"处理，不额外弹错误打扰用户。
  async loadMySpaces() {
    try {
      const res = await callFunctionWithTimeout({ name: 'getMyProductionSpaces', data: {} });
      const result = res.result as any;
      const spaces: Array<{ tenantId: string; tenantName: string; role: string }> = (result && result.success && result.spaces) || [];
      const mine = spaces.find((s) => s.tenantId === this.data.tenantId);
      this.setData({
        mySpaces: spaces,
        currentTenantName: mine ? mine.tenantName : '',
        canManageProducts: !!mine && (mine.role === 'space_owner' || mine.role === 'space_admin')
      });
    } catch (err) {
      console.warn('[production-fulfillment] loadMySpaces 失败:', err);
    }
  },

  onOpenSwitcherModal() {
    if (this.data.mySpaces.length <= 1) return; // 只有一个空间时没什么可切换的
    this.setData({ showSwitcherModal: true });
  },

  onCloseSwitcherModal() {
    this.setData({ showSwitcherModal: false });
  },

  onSelectSpace(e: any) {
    const tenantId = e.currentTarget.dataset.tenantid;
    if (!tenantId || tenantId === this.data.tenantId) {
      this.setData({ showSwitcherModal: false });
      return;
    }
    this.switchTenant(tenantId);
  },

  // 切换工坊：持久化新的 currentTenantId，重置所有"上一个工坊"相关的页面
  // 状态（订单列表/发货&邀请弹窗/角色标记），避免切换后短暂闪现旧工坊数据
  // 或者旧弹窗里残留的 orderId 指向根本不属于新工坊的订单，再用新 tenantId
  // 重新加载订单与角色——两次云函数调用天然按各自的 tenantId 参数隔离数据，
  // 不存在"忘了清空导致新旧数据混在一起"的风险
  switchTenant(tenantId: string) {
    wx.setStorageSync(CURRENT_TENANT_STORAGE_KEY, tenantId);
    this.setData({
      tenantId,
      showSwitcherModal: false,
      orders: [],
      loadError: '',
      markingId: '',
      showShipModal: false,
      shipOrderId: '',
      showInviteModal: false,
      inviteResult: null,
      canManageProducts: false,
      currentTenantName: ''
    });
    this.loadOrders();
    this.loadMySpaces();
  },

  noop() {
    // catchtap 占位：阻止邀请弹窗内容区的点击冒泡到遮罩层触发关闭
  },

  // 与 store-management.ts 同一套：按胶囊按钮实测位置换算导航栏高度
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

  goBack() {
    wx.navigateBack({ delta: 1 });
  },

  onPullDownRefresh() {
    this.loadOrders(() => wx.stopPullDownRefresh());
  },

  onGoToSettlementSummary() {
    wx.navigateTo({ url: '/subpackages/admin/pages/settlement-summary/settlement-summary?tenantId=' + this.data.tenantId });
  },

  onGoToProductManagement() {
    wx.navigateTo({ url: '/subpackages/factory/pages/product-management/product-management?tenantId=' + this.data.tenantId });
  },

  onOpenInviteModal() {
    this.setData({ showInviteModal: true, inviteRole: 'producer', inviteResult: null });
  },

  onCloseInviteModal() {
    this.setData({ showInviteModal: false });
  },

  onSelectInviteRole(e: any) {
    const role = e.currentTarget.dataset.role;
    if (role === 'producer' || role === 'promoter') this.setData({ inviteRole: role });
  },

  async onGenerateInvite() {
    if (this.data.inviteGenerating) return;
    this.setData({ inviteGenerating: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageWorkspaceInvite',
        data: { action: 'generate', tenantId: this.data.tenantId, role: this.data.inviteRole }
      });
      const result = res.result as any;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '生成邀请码失败', icon: 'none' });
        return;
      }
      this.setData({
        inviteResult: {
          code: result.code,
          roleLabel: result.roleLabel || INVITE_ROLE_LABEL[this.data.inviteRole],
          qrFileID: result.qrFileID || ''
        }
      });
    } catch (err) {
      console.error('[production-fulfillment] onGenerateInvite 异常:', err);
      wx.showToast({ title: '生成邀请码失败，请重试', icon: 'none' });
    } finally {
      this.setData({ inviteGenerating: false });
    }
  },

  async loadOrders(done?: () => void) {
    this.setData({ loading: true, loadError: '' });

    const startDate = getTodayIsoString();
    const endDate = addDaysIso(startDate, RANGE_DAYS);

    try {
      const res = await callFunctionWithTimeout({
        name: 'getProductionBoard',
        data: { tenantId: this.data.tenantId, startDate, endDate }
      });
      const result = res.result as any;

      if (result && result.success) {
        const orders: FulfillmentOrder[] = (result.orders || []).map((o: FulfillmentOrder) => ({
          ...o,
          statusLabel: ORDER_STATUS_LABEL[o.orderStatus] || o.orderStatus,
          payAmountYuan: (o.payAmount / 100).toFixed(2)
        }));
        this.setData({ orders, loadError: '' });
      } else {
        this.setData({ orders: [], loadError: (result && result.error) || '加载失败' });
      }
    } catch (err) {
      console.error('[production-fulfillment] loadOrders 异常:', err);
      this.setData({ orders: [], loadError: '加载异常，请重试' });
    } finally {
      this.setData({ loading: false });
      // 🐛 wxml 的重试按钮 bindtap="loadOrders" 直接把 loadOrders 当 tap 处理
      // 函数绑定，微信会把 tap 事件对象作为第一个参数传进来——此时 done 是
      // 一个 truthy 但不可调用的事件对象，done() 直接抛 "done is not a
      // function"。改用 typeof 判断，只有真的传了函数（onPullDownRefresh
      // 那种用法）才调用
      if (typeof done === 'function') done();
    }
  },

  // 点"标记发货"不再直接弹确认框，改为打开"去发货/录入单号"弹窗——快递公司
  // + 单号是这次改造新增的必填项，见 completeProductionOrder 的
  // lib/validateShipment.js（两者必须同时填写，服务端会再校验一遍，这里的
  // 前端校验只是省一趟网络往返）
  onTapMarkShipped(e: any) {
    const orderId = e.currentTarget.dataset.id;
    if (!orderId || this.data.markingId) return;
    this.setData({
      showShipModal: true,
      shipOrderId: orderId,
      shipExpressCompanyIndex: -1,
      shipTrackingNumber: ''
    });
  },

  onCloseShipModal() {
    if (this.data.shipSubmitting) return; // 提交中不允许关闭，避免用户以为取消了、实际请求仍在飞
    this.setData({ showShipModal: false });
  },

  onExpressCompanyChange(e: any) {
    this.setData({ shipExpressCompanyIndex: Number(e.detail.value) });
  },

  onTrackingNumberInput(e: any) {
    this.setData({ shipTrackingNumber: e.detail.value });
  },

  async onConfirmShip() {
    if (this.data.shipSubmitting || this.data.markingId) return;

    const orderId = this.data.shipOrderId;
    const expressCompany = this.data.expressCompanyOptions[this.data.shipExpressCompanyIndex] || '';
    const trackingNumber = (this.data.shipTrackingNumber || '').trim();
    if (!expressCompany) {
      wx.showToast({ title: '请选择快递公司', icon: 'none' });
      return;
    }
    if (!trackingNumber) {
      wx.showToast({ title: '请填写快递单号', icon: 'none' });
      return;
    }

    this.setData({ shipSubmitting: true, markingId: orderId });
    wx.showLoading({ title: '正在提交...', mask: true });

    try {
      const res = await callFunctionWithTimeout({
        name: 'completeProductionOrder',
        data: { tenantId: this.data.tenantId, orderId, expressCompany, trackingNumber }
      });
      const result = res.result as any;
      wx.hideLoading();

      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '标记发货失败，请重试', icon: 'none' });
        return;
      }

      this.setData({ showShipModal: false });

      const profitSharing = result.profitSharing || {};
      if (profitSharing.attempted && !profitSharing.success) {
        // 发货本身已成功，但自动分账失败——透出具体原因，不用一句笼统的"失败"糊弄过去
        wx.showModal({
          title: '已标记发货，但分账未成功',
          content: profitSharing.error || '分账失败，原因未知，请稍后在本页重试（重复标记发货是安全的）。',
          showCancel: false,
          confirmText: '知道了'
        });
      } else if (profitSharing.attempted && profitSharing.success) {
        wx.showToast({ title: '已发货，分账成功', icon: 'success' });
      } else {
        wx.showToast({ title: '已标记发货', icon: 'success' });
      }

      this.loadOrders();
    } catch (err) {
      wx.hideLoading();
      console.error('[production-fulfillment] onConfirmShip 异常:', err);
      wx.showToast({ title: '标记发货失败，请重试', icon: 'none' });
    } finally {
      this.setData({ shipSubmitting: false, markingId: '' });
    }
  }
});
