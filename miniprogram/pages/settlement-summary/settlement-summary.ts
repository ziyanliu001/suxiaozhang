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

interface DetailRow {
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

Page({
  data: {
    navTop: 0,
    contentTop: 0,

    tenantId: '',
    loading: true,
    loadError: '',

    unsettled: { count: 0, producerAmountYuan: '0.00', promoterAmountYuan: '0.00' },
    settled: { count: 0, producerAmountYuan: '0.00', promoterAmountYuan: '0.00' },
    voided: { count: 0, producerAmountYuan: '0.00', promoterAmountYuan: '0.00' },

    details: [] as DetailRow[]
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
    this.loadSummary();
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
    wx.navigateBack({ delta: 1 });
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

  async loadSummary(done?: () => void) {
    this.setData({ loading: true, loadError: '' });

    try {
      const res = await wx.cloud.callFunction({
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
        this.setData({
          unsettled: this.formatBucket(result.summary.unsettled),
          settled: this.formatBucket(result.summary.settled),
          voided: this.formatBucket(result.summary.voided),
          details,
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
  }
});
