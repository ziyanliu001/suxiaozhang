// 页面：排单与发货管理 —— 素食直播产销协同 Module B/C 的制作方/管理员端入口
//
// 🚪 入口方式：本页目前没有接入工作空间列表/切换 UI（那是 Module A 的独立
// 工作，未在本轮范围内），通过 wx.navigateTo 传入 tenantId 查询参数打开，
// 例如：wx.navigateTo({ url: '/pages/production-fulfillment/production-fulfillment?tenantId=' + tenantId })。
//
// 数据来源：直接复用 getProductionBoard 云函数——它已经做了 tenantId 归属
// 校验（仅 space_owner/space_admin/producer 可查看），返回的 orders 字段就是
// 待发货订单明细（Step 3 之前只返回聚合后的 tasks/materials，本轮追加了
// 逐单明细，不重复查库）。
import { getTodayIsoString } from '../../utils/dateUtils';

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

Page({
  data: {
    navTop: 0,
    contentTop: 0,

    tenantId: '',
    loading: true,
    loadError: '',
    orders: [] as FulfillmentOrder[],

    markingId: '' // 正在标记发货的订单 id，用于禁用对应按钮防止重复点击
  },

  onLoad(options: Record<string, string>) {
    this.calculateNavBarHeight();

    const tenantId = (options && options.tenantId) || '';
    if (!tenantId) {
      wx.showToast({ title: '缺少工作空间参数', icon: 'none' });
      setTimeout(() => wx.navigateBack({ delta: 1 }), 1200);
      return;
    }
    this.setData({ tenantId });
    this.loadOrders();
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
    wx.navigateTo({ url: '/pages/settlement-summary/settlement-summary?tenantId=' + this.data.tenantId });
  },

  async loadOrders(done?: () => void) {
    this.setData({ loading: true, loadError: '' });

    const startDate = getTodayIsoString();
    const endDate = addDaysIso(startDate, RANGE_DAYS);

    try {
      const res = await wx.cloud.callFunction({
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

  onTapMarkShipped(e: any) {
    const orderId = e.currentTarget.dataset.id;
    if (!orderId || this.data.markingId) return;

    wx.showModal({
      title: '确认标记发货？',
      content: '标记后将视为该订单已完成制作/发货，符合条件时会触发自动分账，此操作不可撤销。',
      confirmText: '确认发货',
      confirmColor: '#8C1D18',
      success: (res) => {
        if (res.confirm) this.markShipped(orderId);
      }
    });
  },

  async markShipped(orderId: string) {
    this.setData({ markingId: orderId });
    wx.showLoading({ title: '正在标记发货...', mask: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'completeProductionOrder',
        data: { tenantId: this.data.tenantId, orderId }
      });
      const result = res.result as any;
      wx.hideLoading();

      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '标记发货失败，请重试', icon: 'none' });
        return;
      }

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
      console.error('[production-fulfillment] markShipped 异常:', err);
      wx.showToast({ title: '标记发货失败，请重试', icon: 'none' });
    } finally {
      this.setData({ markingId: '' });
    }
  }
});
