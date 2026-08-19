// 页面：产销工坊买家下单页 —— 素食直播产销协同 Module D，商城/带货落地页
//
// 🚪 入口方式：wx.navigateTo/分享链接携带 tenantId + productId（必填），
// 可选携带 promoterOpenId（买家通过推广员分享的链接进入时由链接本身带入，
// 见 onShareAppMessage 的构造逻辑）。
//
// 🛡️ 推广佣金归属的最终校验点不在这里，在 createProductionOrder 服务端
// （反查 tenant_members 确认 promoterOpenId 真的是本租户已批准的 promoter，
// 无效则静默丢弃）——本页只负责"尽量把正确的 promoterOpenId 带上"，不代表
// 传了就一定生效，也不需要在这里重复校验。
import { payForOrder } from '../../utils/wxPayCore';

interface CalendarEntry {
  batchDate: string;
  remaining: number;
  soldOut: boolean;
}

interface OtherProduct {
  _id: string;
  name: string;
  price: number;
  priceYuan?: string;
}

Page({
  data: {
    navTop: 0,
    contentTop: 0,

    tenantId: '',
    productId: '',
    // 🎯 当前浏览会话关联的推广人 openid：可能来自进入本页时链接携带的
    // incomingPromoterOpenId，也可能是浏览者本人（若其本人就是本租户已批准
    // 的 promoter，见 resolveMyPromoterIdentity）——下单与转发分享都用这一个值
    effectivePromoterOpenId: '',

    loading: true,
    loadError: '',

    product: null as { name: string; priceYuan: string; dailyCapacityLimit: number; leadTimeDays: number; description: string } | null,
    calendar: [] as CalendarEntry[],
    quantity: 1,

    otherProducts: [] as OtherProduct[],

    placing: false
  },

  onLoad(options: Record<string, string>) {
    this.calculateNavBarHeight();

    const tenantId = (options && options.tenantId) || '';
    const productId = (options && options.productId) || '';
    const incomingPromoterOpenId = (options && options.promoterOpenId) || '';
    if (!tenantId || !productId) {
      wx.showToast({ title: '商品链接无效', icon: 'none' });
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 1200);
      return;
    }

    this.setData({ tenantId, productId, effectivePromoterOpenId: incomingPromoterOpenId });
    this.loadAll();
    this.resolveMyPromoterIdentity();

    // 右上角 "..." 菜单默认只带"转发给朋友"，"分享到朋友圈"要显式开启才会
    // 出现——两者都配了 onShareAppMessage/onShareTimeline 之后还需要这一步，
    // 缺了这行只会看到转发选项、看不到朋友圈选项
    wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage', 'shareTimeline'] });
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

  goBack() {
    wx.navigateBack({
      delta: 1,
      fail: () => wx.switchTab({ url: '/pages/index/index' })
    });
  },

  onPullDownRefresh() {
    this.loadAll(() => wx.stopPullDownRefresh());
  },

  // 若浏览者本人就是本租户已批准的 promoter，转发分享/下单时优先归到自己
  // 名下（覆盖掉可能存在的 incomingPromoterOpenId——自己就是推广人时，没有
  // 理由把佣金让给别人的分享链接）
  async resolveMyPromoterIdentity() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getMyTenantRole', data: { tenantId: this.data.tenantId } });
      const result = res.result as any;
      if (result && result.success && result.role === 'promoter' && result.openid) {
        this.setData({ effectivePromoterOpenId: result.openid });
      }
    } catch (err) {
      console.warn('[storefront] resolveMyPromoterIdentity 失败:', err);
    }
  },

  async loadAll(done?: () => void) {
    this.setData({ loading: true, loadError: '' });
    try {
      const [productRes, calendarRes] = await Promise.all([
        wx.cloud.callFunction({ name: 'manageProduct', data: { action: 'get', productId: this.data.productId } }),
        wx.cloud.callFunction({
          name: 'getPresaleCalendar',
          data: { tenantId: this.data.tenantId, productId: this.data.productId, rangeDays: 14 }
        })
      ]);

      const productResult = productRes.result as any;
      if (!productResult || !productResult.success || productResult.product.tenantId !== this.data.tenantId || productResult.product.status !== 'active') {
        this.setData({ loadError: '商品不存在或已下架', loading: false });
        if (typeof done === 'function') done();
        return;
      }
      const p = productResult.product;
      this.setData({
        product: {
          name: p.name,
          priceYuan: ((p.price || 0) / 100).toFixed(2),
          dailyCapacityLimit: p.dailyCapacityLimit,
          leadTimeDays: p.leadTimeDays,
          description: p.description || ''
        }
      });

      const calendarResult = calendarRes.result as any;
      if (calendarResult && calendarResult.success) {
        this.setData({ calendar: calendarResult.calendar || [] });
      }

      this.loadOtherProducts();
    } catch (err) {
      console.error('[storefront] loadAll 异常:', err);
      this.setData({ loadError: '加载异常，请重试' });
    } finally {
      this.setData({ loading: false });
      if (typeof done === 'function') done();
    }
  },

  async loadOtherProducts() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageProduct',
        data: { action: 'list', tenantId: this.data.tenantId, status: 'active' }
      });
      const result = res.result as any;
      if (result && result.success) {
        const otherProducts: OtherProduct[] = (result.products || [])
          .filter((p: OtherProduct) => p._id !== this.data.productId)
          .map((p: OtherProduct) => ({ ...p, priceYuan: ((p.price || 0) / 100).toFixed(2) }));
        this.setData({ otherProducts });
      }
    } catch (err) {
      console.warn('[storefront] loadOtherProducts 失败:', err);
    }
  },

  onTapOtherProduct(e: any) {
    const productId = e.currentTarget.dataset.id;
    if (!productId) return;
    wx.redirectTo({
      url: `/pages/storefront/storefront?tenantId=${this.data.tenantId}&productId=${productId}&promoterOpenId=${this.data.effectivePromoterOpenId}`
    });
  },

  onDecreaseQty() {
    if (this.data.quantity > 1) this.setData({ quantity: this.data.quantity - 1 });
  },

  onIncreaseQty() {
    const max = (this.data.product && this.data.product.dailyCapacityLimit) || 999;
    if (this.data.quantity < max) this.setData({ quantity: this.data.quantity + 1 });
  },

  // 🐛 没有直接用 createOrderAndPay 这个一站式封装：它内部下单成功后只往外
  // 抛 PayOutcome（{ok, cancelled, message}），createProductionOrder 返回的
  // batchDate/estimatedShippingDate 会被吞掉——买家支付成功后"指引查看预计
  // 发货时间"这个要求就没法满足了。改成自己调用 createProductionOrder 拿到
  // 完整下单结果，再把结果交给同一个 utils/wxPayCore.ts 导出的 payForOrder()
  // 走支付这一步（Mock/真实支付切换逻辑完全复用，不重新实现一遍），只是把
  // "下单"和"付款"两步拆开自己编排，而不是用那个把两步焊死在一起的封装。
  async onTapOrder() {
    if (this.data.placing || !this.data.product) return;
    this.setData({ placing: true });
    wx.showLoading({ title: '正在生成订单...', mask: true });

    let orderResult: any;
    try {
      const res = await wx.cloud.callFunction({
        name: 'createProductionOrder',
        data: {
          tenantId: this.data.tenantId,
          productId: this.data.productId,
          quantity: this.data.quantity,
          promoterOpenId: this.data.effectivePromoterOpenId
        }
      });
      orderResult = res.result;
    } catch (err) {
      wx.hideLoading();
      this.setData({ placing: false });
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      return;
    }
    wx.hideLoading();

    if (!orderResult || !orderResult.success) {
      this.setData({ placing: false });
      wx.showToast({ title: (orderResult && orderResult.error) || '生成订单失败，请重试', icon: 'none' });
      return;
    }

    const outcome = await payForOrder(orderResult);
    this.setData({ placing: false });

    if (outcome.ok) {
      this.showOrderSuccessModal(orderResult.batchDate, orderResult.estimatedShippingDate);
      this.loadAll(); // 刷新预售日历余量
    } else if (!outcome.cancelled) {
      wx.showToast({ title: outcome.message, icon: 'none' });
    }
  },

  showOrderSuccessModal(batchDate: string, estimatedShippingDate: string) {
    wx.showModal({
      title: '下单成功',
      content: `已按现有产能排入 ${batchDate} 批次制作，预计 ${estimatedShippingDate} 发货，请留意收货信息。`,
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#8C1D18'
    });
  },

  // 🔗 转发分享：始终携带 effectivePromoterOpenId（自己是推广员时是自己的
  // openid，若是从别人分享链接进来的普通买家转发则原样透传——推广链继续
  // 归到最初的推广员名下，是常见的裂变分享惯例，不重新指向自己）
  onShareAppMessage() {
    const { tenantId, productId, effectivePromoterOpenId, product } = this.data;
    return {
      title: product ? `${product.name} · 产销工坊直供` : '产销工坊直供好物',
      path: `/pages/storefront/storefront?tenantId=${tenantId}&productId=${productId}&promoterOpenId=${effectivePromoterOpenId}`
    };
  },

  // 朋友圈分享：与 onShareAppMessage 同一套推广人归属逻辑，但朋友圈分享的
  // API 形状不一样——只接受 query 字符串（自动拼接在当前页面路径后面），
  // 不支持传完整 path，所以这里不能直接复用 onShareAppMessage 的返回值
  onShareTimeline() {
    const { tenantId, productId, effectivePromoterOpenId, product } = this.data;
    return {
      title: product ? `${product.name} · 产销工坊直供` : '产销工坊直供好物',
      query: `tenantId=${tenantId}&productId=${productId}&promoterOpenId=${effectivePromoterOpenId}`
    };
  }
});
