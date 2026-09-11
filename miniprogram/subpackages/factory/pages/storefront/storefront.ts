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
import { payForOrder } from '../../../../utils/wxPayCore';
import { requestShippingNoticeSubscription } from '../../../../utils/subscribeMessage';
import { callFunctionWithTimeout } from '../../../../utils/withTimeout';
import { GroupBuyTier, TierRow, resolveTierPreview, buildTierRows } from '../../utils/groupBuyPreview';

interface GroupBuyBatch {
  batchId: string;
  tierThresholds: GroupBuyTier[];
  committedQuantity: number;
  deadlineAt: string | null;
}

interface CalendarEntry {
  batchDate: string;
  remaining: number;
  soldOut: boolean;
  groupBuyBatch: GroupBuyBatch | null;
}

interface OtherProduct {
  _id: string;
  name: string;
  price: number;
  priceYuan?: string;
}

Page({
  data: {
    contentTop: 0,

    tenantId: '',
    productId: '',
    // 🎯 当前浏览会话关联的推广人 openid：可能来自进入本页时链接携带的
    // incomingPromoterOpenId，也可能是浏览者本人（若其本人就是本租户已批准
    // 的 promoter，见 resolveMyPromoterIdentity）——下单与转发分享都用这一个值
    effectivePromoterOpenId: '',

    loading: true,
    loadError: '',

    product: null as { name: string; priceYuan: string; priceCents: number; dailyCapacityLimit: number; leadTimeDays: number; description: string } | null,
    calendar: [] as CalendarEntry[],
    // 🎯 买家在预售日历上选中的具体批次日：留空 = 沿用原来的"自动找最早
    // 可用日"行为（向后兼容，选期是可选的轻量交互，不是强制流程）
    selectedBatchDate: '',
    quantity: 1,

    // 🏛️（2026-09-12 履约状态机双轨化）取货方式：下单时选定，透传给
    // createProductionOrder 落库为 production_orders.deliveryMethod，决定
    // 后续 completeProductionOrder 走"物流发货"还是"到店自提核销"哪条终态
    // 路径，见 completeProductionOrder/lib/orderStatusMachine.js 头部注释。
    // 默认 'logistics'，与升级前"只有物流发货一条路径"的行为保持一致
    deliveryMethod: 'logistics' as 'logistics' | 'self_pickup',

    // 🏛️（护城河二）拼团预览：selectedBatchDate 命中的批次信息 + 按当前
    // quantity 预估的成交价文案，随 onSelectBatchDate/onIncreaseQty/
    // onDecreaseQty 联动刷新。tierRows 是方向 B 新增的完整阶梯梯度展示
    // （当前档高亮 + 已解锁档打勾），此前只有 nextTierHint 一行摘要文案
    groupBuyPreview: null as {
      unitPriceYuan: string;
      appliedTierLevel: number;
      committedQuantity: number;
      nextTierHint: string;
      tierRows: TierRow[];
    } | null,

    // 🏛️（方向 B）今日产能进度：取当前选中日期（未选中时取最早可下单日）的
    // 产能占用比例，让买家直观看到"仅剩 N 份，手慢无"的紧迫感——数据源就是
    // calendar[].remaining/product.dailyCapacityLimit，纯前端计算，不新增
    // 云函数调用
    capacityProgress: null as {
      batchDate: string;
      remaining: number;
      percentLocked: number; // 0~100
      urgencyClass: string; // 'normal' | 'low' | 'full'，复用日历既有三档阈值
    } | null,

    otherProducts: [] as OtherProduct[],

    placing: false
  },

  onLoad(options: Record<string, string>) {
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

  // 🐛 根因修复：见 store-management.ts 同处修复记录，改用 <navigation-bar>
  // 共享组件
  onNavLayout(e: { detail: { totalHeight: number } }) {
    this.setData({ contentTop: e.detail.totalHeight + 8 });
  },

  onPullDownRefresh() {
    this.loadAll(() => wx.stopPullDownRefresh());
  },

  // 若浏览者本人就是本租户已批准的 promoter，转发分享/下单时优先归到自己
  // 名下（覆盖掉可能存在的 incomingPromoterOpenId——自己就是推广人时，没有
  // 理由把佣金让给别人的分享链接）
  async resolveMyPromoterIdentity() {
    try {
      const res = await callFunctionWithTimeout({ name: 'getMyTenantRole', data: { tenantId: this.data.tenantId } });
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
        callFunctionWithTimeout({ name: 'manageProduct', data: { action: 'get', productId: this.data.productId } }),
        callFunctionWithTimeout({
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
          priceCents: p.price || 0,
          dailyCapacityLimit: p.dailyCapacityLimit,
          leadTimeDays: p.leadTimeDays,
          description: p.description || ''
        }
      });

      const calendarResult = calendarRes.result as any;
      if (calendarResult && calendarResult.success) {
        this.setData({ calendar: calendarResult.calendar || [] });
        this.updateGroupBuyPreview();
        this.updateCapacityProgress();
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
      const res = await callFunctionWithTimeout({
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
      url: `/subpackages/factory/pages/storefront/storefront?tenantId=${this.data.tenantId}&productId=${productId}&promoterOpenId=${this.data.effectivePromoterOpenId}`
    });
  },

  // 轻量选期：点已选中的日期再点一次取消选择，点已约满的日期不响应
  // （wxml 上已约满的项没有绑定这个 handler，这里的 soldOut 判断是双重保险）
  onSelectBatchDate(e: any) {
    const date = e.currentTarget.dataset.date;
    if (!date) return;
    const entry = this.data.calendar.find((c) => c.batchDate === date);
    if (!entry || entry.soldOut) return;
    this.setData({ selectedBatchDate: this.data.selectedBatchDate === date ? '' : date });
    this.updateGroupBuyPreview();
    this.updateCapacityProgress();
  },

  onDecreaseQty() {
    if (this.data.quantity > 1) {
      this.setData({ quantity: this.data.quantity - 1 });
      this.updateGroupBuyPreview();
    }
  },

  onIncreaseQty() {
    const max = (this.data.product && this.data.product.dailyCapacityLimit) || 999;
    if (this.data.quantity < max) {
      this.setData({ quantity: this.data.quantity + 1 });
      this.updateGroupBuyPreview();
    }
  },

  // 🏛️（护城河二）纯展示层预估：selectedBatchDate 命中的批次若挂了拼团活动，
  // 按"当前已认购量 + 本次下单量"预估会落在哪一档——只是给买家一个大致
  // 参考，真正生效的价格在下单瞬间由服务端 CAS 原子算出（见
  // createProductionOrder 的 groupBuyBatchId 接线），两者理论上一致，但如果
  // 下单瞬间又有别的买家抢先推高了总量，实际成交价可能比这里预估的更优惠
  // （不会更差——阶梯只会随总量增加变得更便宜）
  updateGroupBuyPreview() {
    const entry = this.data.calendar.find((c) => c.batchDate === this.data.selectedBatchDate);
    const batch = entry && entry.groupBuyBatch;
    if (!batch || !this.data.product) {
      this.setData({ groupBuyPreview: null });
      return;
    }
    const projectedTotal = batch.committedQuantity + this.data.quantity;
    const { unitPrice, appliedTierLevel, nextTier } = resolveTierPreview(batch.tierThresholds, projectedTotal, this.data.product.priceCents);
    const nextTierHint = nextTier
      ? `再拼 ${nextTier.minQuantity - projectedTotal} 份可解锁 ¥${(nextTier.unitPriceOverride / 100).toFixed(2)}/份`
      : '已解锁最低价';
    this.setData({
      groupBuyPreview: {
        unitPriceYuan: (unitPrice / 100).toFixed(2),
        appliedTierLevel,
        committedQuantity: batch.committedQuantity,
        nextTierHint,
        tierRows: buildTierRows(batch.tierThresholds, projectedTotal)
      }
    });
  },

  // 🏛️（方向 B）今日产能进度：取当前选中日期，未选中时取预售日历最早的一天
  // （即"今日/最快可下单日"），把 remaining/dailyCapacityLimit 换算成一条
  // "已锁 N% · 仅剩 M 份"的紧迫感文案。三档阈值与日历卡片本身的
  // soldOut/remaining<=3 判断口径一致，不新造一套颜色规则
  updateCapacityProgress() {
    const product = this.data.product;
    if (!product || !this.data.calendar || this.data.calendar.length === 0) {
      this.setData({ capacityProgress: null });
      return;
    }
    const entry = this.data.calendar.find((c) => c.batchDate === this.data.selectedBatchDate) || this.data.calendar[0];
    if (!entry || !(product.dailyCapacityLimit > 0)) {
      this.setData({ capacityProgress: null });
      return;
    }
    const percentLocked = Math.round((1 - entry.remaining / product.dailyCapacityLimit) * 100);
    const urgencyClass = entry.soldOut ? 'full' : (entry.remaining <= 3 ? 'low' : 'normal');
    this.setData({
      capacityProgress: {
        batchDate: entry.batchDate,
        remaining: entry.remaining,
        percentLocked: Math.min(Math.max(percentLocked, 0), 100),
        urgencyClass
      }
    });
  },

  onSelectDeliveryMethod(e: any) {
    const method = e.currentTarget.dataset.method;
    if (method === 'logistics' || method === 'self_pickup') {
      this.setData({ deliveryMethod: method });
    }
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

    const selectedEntry = this.data.calendar.find((c) => c.batchDate === this.data.selectedBatchDate);
    const groupBuyBatchId = (selectedEntry && selectedEntry.groupBuyBatch && selectedEntry.groupBuyBatch.batchId) || '';

    let orderResult: any;
    try {
      const res = await callFunctionWithTimeout({
        name: 'createProductionOrder',
        data: {
          tenantId: this.data.tenantId,
          productId: this.data.productId,
          quantity: this.data.quantity,
          promoterOpenId: this.data.effectivePromoterOpenId,
          preferredDate: this.data.selectedBatchDate,
          groupBuyBatchId,
          deliveryMethod: this.data.deliveryMethod
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
      // 先唤起"订单发货通知"订阅授权（wx.requestSubscribeMessage 必须由用户
      // 手势直接触发的调用链里发起，紧跟在支付成功之后是最自然的时机），
      // 授权与否都会 resolve，不影响后面成功弹窗正常展示
      await requestShippingNoticeSubscription();
      this.showOrderSuccessModal(orderResult.batchDate, orderResult.estimatedShippingDate, orderResult.appliedTierLevel > 0 ? orderResult.unitPrice : 0);
      this.setData({ selectedBatchDate: '', groupBuyPreview: null }); // 下单完成，清空选期，避免下一笔订单误用旧选择
      this.loadAll(); // 刷新预售日历余量
    } else if (!outcome.cancelled) {
      wx.showToast({ title: outcome.message, icon: 'none' });
    }
  },

  showOrderSuccessModal(batchDate: string, estimatedShippingDate: string, groupBuyUnitPriceCents: number) {
    const tierNote = groupBuyUnitPriceCents > 0 ? `本次以拼团价 ¥${(groupBuyUnitPriceCents / 100).toFixed(2)}/份成交，` : '';
    wx.showModal({
      title: '下单成功',
      content: `${tierNote}已按现有产能排入 ${batchDate} 批次制作，预计 ${estimatedShippingDate} 发货，请留意收货信息。`,
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
      path: `/subpackages/factory/pages/storefront/storefront?tenantId=${tenantId}&productId=${productId}&promoterOpenId=${effectivePromoterOpenId}`
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
