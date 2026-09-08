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
  productId: string;
  tenantId: string;
  productName: string;
  workshopName: string;
  quantity: number;
  payAmountYuan: string;
  orderStatus: string;
  statusLabel: string;
  createdAtLabel: string;
  failReason: string;
  batchDate: string;
  estimatedShippingDate: string;
  expressCompany: string;
  trackingNumber: string;
  appliedTierLevel: number;
  charityContribution: CharityContribution | null;
  // 展示用派生字段
  statusClass?: string;
  expanded?: boolean;
  tabBucket?: TabValue;
}

const CHARITY_PLEDGE_STATUS_LABEL: Record<string, string> = {
  pledged: '已转捐，待公益厨房核销',
  redeemed: '已核销'
};

type TabValue = 'all' | 'pending_shipment' | 'shipped' | 'exception';

const TAB_OPTIONS: { value: TabValue; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'pending_shipment', label: '待发货' },
  { value: 'shipped', label: '已发货' },
  { value: 'exception', label: '异常/失败' }
];

// 🆕（Tab 分组）真实 orderStatus 枚举（pending_payment/paid/in_production/
// shipped/refunded/failed）与用户要的四个 Tab 不是一一对应，需要自己定义
// 映射：pending_payment（待支付）归进"待发货"这个广义"还没收到货"大类；
// refunded（已退款）与 failed 一起归进"异常/失败"——从买家视角看两者都是
// "这笔订单没有正常走完"的结果
function computeTabBucket(orderStatus: string): TabValue {
  if (orderStatus === 'shipped') return 'shipped';
  if (orderStatus === 'failed' || orderStatus === 'refunded') return 'exception';
  return 'pending_shipment';
}

Page({
  data: {
    contentTop: 0,
    loading: true,
    loadError: '',
    orders: [] as MyOrder[],
    activeTab: 'all' as TabValue,
    tabOptions: TAB_OPTIONS,
    visibleCount: 0
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
          tabBucket: computeTabBucket(o.orderStatus),
          charityContribution: o.charityContribution ? {
            ...o.charityContribution,
            pledgeStatusLabel: CHARITY_PLEDGE_STATUS_LABEL[o.charityContribution.pledgeStatus] || o.charityContribution.pledgeStatus
          } : null
        }));
        this.setData({ orders, visibleCount: this.countVisible(orders, this.data.activeTab) });
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
  },

  countVisible(orders: MyOrder[], tab: TabValue): number {
    if (tab === 'all') return orders.length;
    return orders.filter((o) => o.tabBucket === tab).length;
  },

  // 🆕 Tab 切换：纯本地过滤，orders 已经一次性拉回（getMyProductionOrders
  // 单次最多 100 条），不为每个 Tab 单独发云调用——与
  // nationalDashboardService.ts 的 onSwitchMatrixFilter 同一种"一键快筛"模式
  onSwitchTab(e: any) {
    const tab = e.currentTarget.dataset.tab as TabValue;
    if (!tab || tab === this.data.activeTab) return;
    this.setData({ activeTab: tab, visibleCount: this.countVisible(this.data.orders, tab) });
  },

  // 🆕 物流单号快捷复制——与 platform-admin.ts 的 onCopyActivationCode 同一
  // 套写法。catchtap 绑定，避免冒泡触发外层 onToggleExpand 收起展开区
  onCopyTrackingNumber(e: any) {
    const trackingNumber = e.currentTarget.dataset.tracking;
    if (!trackingNumber) return;
    wx.setClipboardData({
      data: trackingNumber,
      success: () => wx.showToast({ title: '已复制物流单号', icon: 'success' })
    });
  },

  // 🆕「重新下单」：不新建一个"一键重试"的服务端接口——价格/产能/拼团状态
  // 都可能已经变化，真正安全的重试是带着 tenantId/productId 跳回商品页，
  // 走一遍正常下单流程，复用 storefront.ts 已有的 onLoad(options) 定位商品
  onRetryOrder(e: any) {
    const tenantId = e.currentTarget.dataset.tenantid;
    const productId = e.currentTarget.dataset.productid;
    if (!tenantId || !productId) {
      wx.showToast({ title: '商品信息缺失，无法重新下单', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/subpackages/factory/pages/storefront/storefront?tenantId=${encodeURIComponent(tenantId)}&productId=${encodeURIComponent(productId)}`
    });
  }
});
