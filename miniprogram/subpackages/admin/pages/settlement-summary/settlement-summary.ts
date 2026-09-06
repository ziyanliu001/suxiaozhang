import { callFunctionWithTimeout } from '../../../../utils/withTimeout';
// 页面：对账明细 —— 素食直播产销协同「简易对账看板」
//
// 🚪 入口方式：与 production-fulfillment 同款，通过 wx.navigateTo 传入
// tenantId 查询参数打开；production-fulfillment 页顶部有一个"对账明细 →"
// 入口直接带 tenantId 跳转过来。
//
// 数据来源：getSettlementSummary 云函数——space_owner/space_admin 看全租户，
// producer 只看自己名下商品产生的订单分成（云函数侧已做角色区分，本页不用
// 关心当前角色是谁，拿到什么就展示什么）。
const STATUS_LABEL: Record<string, string> = {
  unsettled: '待结算',
  settled: '已结算',
  settled_then_reversed: '已结算(后续退款冲销)',
  refunded: '已撤销(未产生实际支付)'
};

function yuan(fen: number): string {
  return ((fen || 0) / 100).toFixed(2);
}

interface SettlementBucket {
  count: number;
  payAmount: number;
  producerAmount: number;
  promoterAmount: number;
  platformFee: number;
}

interface OpsStats {
  orderCount: number;
  totalQuantity: number;
  producerAmount: number;
  promoterAmount: number;
  platformFee: number;
}

interface DetailRow {
  settlementId: string;
  orderId: string;
  payAmount: number;
  producerAmount: number;
  promoterAmount: number;
  platformFee: number;
  settlementStatus: string;
  createdAt: string | null;
  settledAt?: string | null;
  reversedAt?: string | null;
  // 展示用派生字段
  statusLabel?: string;
  producerAmountYuan?: string;
  promoterAmountYuan?: string;
}

// 🏛️（护城河一 M1）转捐目标门店——manageCharityContribution.listTargetStores
// 返回的原始字段
interface TargetStore {
  storeId: string;
  storeName: string;
  orgType: string;
  city: string;
  province: string;
}

Page({
  data: {
    contentTop: 0,

    tenantId: '',
    loading: true,
    loadError: '',

    unsettled: { count: 0, producerAmountYuan: '0.00', promoterAmountYuan: '0.00' },
    settled: { count: 0, producerAmountYuan: '0.00', promoterAmountYuan: '0.00' },
    voided: { count: 0, producerAmountYuan: '0.00', promoterAmountYuan: '0.00' },

    // 📊 运营简报：opsStats 是服务端一次性算好的 7 天/30 天两份数据，切换
    // 区间只是换一份已经在本地的数据展示，不需要重新请求云函数
    opsRangeDays: 7 as 7 | 30,
    opsStatsRaw: { last7: null as OpsStats | null, last30: null as OpsStats | null },
    opsDisplay: {
      orderCount: 0, totalQuantity: 0,
      producerAmountYuan: '0.00', promoterAmountYuan: '0.00', platformFeeYuan: '0.00'
    },

    details: [] as DetailRow[],

    // 🏛️（护城河一 M1）以产养善：累计转捐额度 + 转捐弹窗状态
    charityPledgedTotalYuan: '0.00',
    showPledgeModal: false,
    pledgeTargetOrderId: '',
    pledgeSettlementId: '',
    pledgeMaxAmount: 0, // 分，等于该笔结算的 producerAmount，前端校验上限用
    pledgeMaxAmountYuan: '0.00', // 仅供弹窗展示，不参与校验（校验用上面的分）
    pledgeAmountYuan: '',
    pledgeSubmitting: false,
    pledgeStoresLoading: false,
    pledgeStoresAll: [] as TargetStore[],
    pledgeStoresFiltered: [] as TargetStore[],
    pledgeKeyword: '',
    pledgeSelectedStoreId: '',
    pledgeSelectedStoreName: ''
  },

  onLoad(options: Record<string, string>) {
    const tenantId = (options && options.tenantId) || '';
    if (!tenantId) {
      wx.showToast({ title: '缺少工作空间参数', icon: 'none' });
      setTimeout(() => wx.navigateBack({ delta: 1 }), 1200);
      return;
    }
    this.setData({ tenantId });
    this.loadSummary();
  },

  // 🐛 根因修复：见 store-management.ts 同处修复记录，改用 <navigation-bar>
  // 共享组件
  onNavLayout(e: { detail: { totalHeight: number } }) {
    this.setData({ contentTop: e.detail.totalHeight + 8 });
  },

  onPullDownRefresh() {
    this.loadSummary(() => wx.stopPullDownRefresh());
  },

  formatBucket(bucket: SettlementBucket) {
    return {
      count: bucket.count,
      producerAmountYuan: yuan(bucket.producerAmount),
      promoterAmountYuan: yuan(bucket.promoterAmount)
    };
  },

  formatOpsStats(stats: OpsStats | null) {
    const s = stats || { orderCount: 0, totalQuantity: 0, producerAmount: 0, promoterAmount: 0, platformFee: 0 };
    return {
      orderCount: s.orderCount,
      totalQuantity: s.totalQuantity,
      producerAmountYuan: yuan(s.producerAmount),
      promoterAmountYuan: yuan(s.promoterAmount),
      platformFeeYuan: yuan(s.platformFee)
    };
  },

  onSelectOpsRange(e: any) {
    const days = Number(e.currentTarget.dataset.days);
    if (days !== 7 && days !== 30) return;
    this.setData({
      opsRangeDays: days,
      opsDisplay: this.formatOpsStats(days === 7 ? this.data.opsStatsRaw.last7 : this.data.opsStatsRaw.last30)
    });
  },

  async loadSummary(done?: () => void) {
    this.setData({ loading: true, loadError: '' });

    try {
      const res = await callFunctionWithTimeout({
        name: 'getSettlementSummary',
        data: { tenantId: this.data.tenantId }
      });
      const result = res.result as any;

      if (result && result.success) {
        const details: DetailRow[] = (result.details || []).map((d: DetailRow) => ({
          ...d,
          statusLabel: STATUS_LABEL[d.settlementStatus] || d.settlementStatus,
          producerAmountYuan: yuan(d.producerAmount),
          promoterAmountYuan: yuan(d.promoterAmount)
        }));
        const opsStatsRaw = result.opsStats || { last7: null, last30: null };
        this.setData({
          unsettled: this.formatBucket(result.summary.unsettled),
          settled: this.formatBucket(result.summary.settled),
          voided: this.formatBucket(result.summary.voided),
          details,
          opsStatsRaw,
          opsDisplay: this.formatOpsStats(this.data.opsRangeDays === 7 ? opsStatsRaw.last7 : opsStatsRaw.last30),
          charityPledgedTotalYuan: yuan(result.charityPledgedTotal || 0),
          loadError: ''
        });
      } else {
        this.setData({ loadError: (result && result.error) || '加载失败' });
      }
    } catch (err) {
      console.error('[settlement-summary] loadSummary 异常:', err);
      this.setData({ loadError: '加载异常，请重试' });
    } finally {
      this.setData({ loading: false });
      // 🐛 同 production-fulfillment.ts 的修复：重试按钮 bindtap="loadSummary"
      // 会把 tap 事件对象当 done 传进来，必须判类型而不是只判真值
      if (typeof done === 'function') done();
    }
  },

  // ============ 护城河一 M1：转捐给公益厨房 ============

  stopPropagation() {},

  async onOpenPledgeModal(e: any) {
    const orderId = e.currentTarget.dataset.orderId;
    const row = this.data.details.find((d) => d.orderId === orderId);
    if (!row) return;

    this.setData({
      showPledgeModal: true,
      pledgeTargetOrderId: row.orderId,
      pledgeSettlementId: row.settlementId,
      pledgeMaxAmount: row.producerAmount,
      pledgeMaxAmountYuan: yuan(row.producerAmount),
      // 默认全额转捐，用户可以改小——不能改大，见 onPledgeAmountInput 的上限拦截
      pledgeAmountYuan: yuan(row.producerAmount),
      pledgeKeyword: '',
      pledgeSelectedStoreId: '',
      pledgeSelectedStoreName: '',
      pledgeStoresAll: [],
      pledgeStoresFiltered: []
    });
    this.loadTargetStores();
  },

  onClosePledgeModal() {
    if (this.data.pledgeSubmitting) return;
    this.setData({ showPledgeModal: false });
  },

  async loadTargetStores() {
    this.setData({ pledgeStoresLoading: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageCharityContribution',
        data: { action: 'listTargetStores', tenantId: this.data.tenantId }
      });
      const result = res.result as any;
      if (result && result.success) {
        const stores: TargetStore[] = result.stores || [];
        this.setData({ pledgeStoresAll: stores, pledgeStoresFiltered: stores });
      } else {
        wx.showToast({ title: (result && result.error) || '门店列表加载失败', icon: 'none' });
      }
    } catch (err) {
      console.error('[settlement-summary] loadTargetStores 异常:', err);
      wx.showToast({ title: '门店列表加载异常', icon: 'none' });
    } finally {
      this.setData({ pledgeStoresLoading: false });
    }
  },

  onPledgeKeywordInput(e: any) {
    const keyword = String(e.detail.value || '').trim();
    const all = this.data.pledgeStoresAll;
    const filtered = keyword ? all.filter((s) => s.storeName.indexOf(keyword) !== -1) : all;
    this.setData({ pledgeKeyword: keyword, pledgeStoresFiltered: filtered });
  },

  onSelectTargetStore(e: any) {
    const storeId = e.currentTarget.dataset.storeId;
    const store = this.data.pledgeStoresFiltered.find((s) => s.storeId === storeId);
    if (!store) return;
    this.setData({ pledgeSelectedStoreId: store.storeId, pledgeSelectedStoreName: store.storeName });
  },

  onPledgeAmountInput(e: any) {
    this.setData({ pledgeAmountYuan: e.detail.value });
  },

  async onSubmitPledge() {
    if (this.data.pledgeSubmitting) return;
    if (!this.data.pledgeSelectedStoreId) {
      wx.showToast({ title: '请先选择要捐赠的公益厨房', icon: 'none' });
      return;
    }
    const amountYuan = parseFloat(this.data.pledgeAmountYuan);
    if (!(amountYuan > 0)) {
      wx.showToast({ title: '请填写正确的转捐金额', icon: 'none' });
      return;
    }
    const amount = Math.round(amountYuan * 100);
    if (amount > this.data.pledgeMaxAmount) {
      wx.showToast({ title: '转捐金额不能超过该笔订单制作方分成金额', icon: 'none' });
      return;
    }

    this.setData({ pledgeSubmitting: true });
    wx.showLoading({ title: '提交中...', mask: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageCharityContribution',
        data: {
          action: 'pledge',
          tenantId: this.data.tenantId,
          settlementId: this.data.pledgeSettlementId,
          amount,
          targetStoreId: this.data.pledgeSelectedStoreId
        }
      });
      const result = res.result as any;
      wx.hideLoading();
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '提交失败，请重试', icon: 'none' });
        return;
      }
      wx.showToast({ title: '已转捐，感谢您的善心', icon: 'success' });
      this.setData({ showPledgeModal: false });
      this.loadSummary();
    } catch (err) {
      wx.hideLoading();
      console.error('[settlement-summary] onSubmitPledge 异常:', err);
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
    } finally {
      this.setData({ pledgeSubmitting: false });
    }
  }
});
