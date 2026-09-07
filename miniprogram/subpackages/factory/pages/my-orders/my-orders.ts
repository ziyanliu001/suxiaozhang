// 页面：我的工坊订单 —— 方向 B 买家自查入口
//
// 🚪 入口方式：pages/profile/profile.ts 的"🛒 我的工坊订单"卡片（有数据才
// 露出，与该页已有的"🌾 产销工坊反哺"卡片同一种克制展示原则）navigateTo 到
// 本页，不需要任何查询参数——getMyProductionOrders 以调用者 OPENID 为唯一
// 过滤维度，买家在所有工坊下过的订单都在这一份列表里。
//
// 交互：列表卡片可展开/收起（wx:if 切换，不跳详情页——买家订单量级小，不值得
// 为此新增第二个页面），展开后显示物流信息 + 「善行反哺凭据」小卡。
import { callFunctionWithTimeout } from '../../../../utils/withTimeout';
import { ORDER_STATUS_CLASS } from '../../utils/orderStatusLabels';

interface CharityContribution {
  amountYuan: string;
  pledgeStatus: string;
  targetStoreName: string;
  // 展示用派生字段
  pledgeStatusLabel?: string;
}

interface MyOrder {
  orderId: string;
  productName: string;
  workshopName: string;
  quantity: number;
  payAmountYuan: string;
  orderStatus: string;
  statusLabel: string;
  batchDate: string;
  estimatedShippingDate: string;
  expressCompany: string;
  trackingNumber: string;
  appliedTierLevel: number;
  charityContribution: CharityContribution | null;
  // 展示用派生字段
  statusClass?: string;
  expanded?: boolean;
}

const CHARITY_PLEDGE_STATUS_LABEL: Record<string, string> = {
  pledged: '已转捐，待公益厨房核销',
  redeemed: '已核销'
};

Page({
  data: {
    contentTop: 0,
    loading: true,
    loadError: '',
    orders: [] as MyOrder[]
  },

  onLoad() {
    this.loadOrders();
  },

  onNavLayout(e: { detail: { totalHeight: number } }) {
    this.setData({ contentTop: e.detail.totalHeight + 8 });
  },

  onPullDownRefresh() {
    this.loadOrders(() => wx.stopPullDownRefresh());
  },

  async loadOrders(done?: () => void) {
    this.setData({ loading: true, loadError: '' });
    try {
      const res = await callFunctionWithTimeout({ name: 'getMyProductionOrders', data: {} });
      const result = res.result as any;
      if (result && result.success) {
        const orders: MyOrder[] = (result.orders || []).map((o: MyOrder) => ({
          ...o,
          statusClass: ORDER_STATUS_CLASS[o.orderStatus] || '',
          expanded: false,
          charityContribution: o.charityContribution ? {
            ...o.charityContribution,
            pledgeStatusLabel: CHARITY_PLEDGE_STATUS_LABEL[o.charityContribution.pledgeStatus] || o.charityContribution.pledgeStatus
          } : null
        }));
        this.setData({ orders });
      } else {
        this.setData({ loadError: (result && result.error) || '加载失败' });
      }
    } catch (err) {
      console.error('[my-orders] loadOrders 异常:', err);
      this.setData({ loadError: '加载异常，请重试' });
    } finally {
      this.setData({ loading: false });
      if (typeof done === 'function') done();
    }
  },

  // 🐛 用 data-index 精确 path 更新 orders[index].expanded，不做
  // this.setData({ orders }) 全量数组替换——见 CLAUDE.md「setData 铁律」
  onToggleExpand(e: any) {
    const index = e.currentTarget.dataset.index;
    if (index === undefined) return;
    const nowExpanded = !this.data.orders[index].expanded;
    this.setData({ [`orders[${index}].expanded`]: nowExpanded });
  }
});
