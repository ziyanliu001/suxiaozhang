// 页面：工坊好物·爱心预售 —— 方向 B 跨租户商品发现页
//
// 🚪 入口方式：pages/index/index.ts 的 onSelectFactoryPlatform() 在
// getMyProductionSpaces 查出调用者不属于任何工坊（spaces.length===0）时
// navigateTo 到本页——此前这个分支直接送去 workspace-join（员工邀请码入口），
// 普通买家点进去除了退出无事可做，本页补上买家侧真正能用的入口。
//
// 数据来源：getFactoryProductFeed，跨租户查询 products（不带 tenantId
// 过滤，见该云函数头部注释），本页只做展示 + 跳转，不持有任何下单逻辑——
// 点击卡片直接 navigateTo storefront.ts，复用买家下单全部既有流程。
import { callFunctionWithTimeout } from '../../../../utils/withTimeout';
import { GroupBuyTier, resolveTierPreview, buildNextTierHint } from '../../utils/groupBuyPreview';

interface FeedGroupBuyBatch {
  tierThresholds: GroupBuyTier[];
  committedQuantity: number;
}

interface FeedProduct {
  productId: string;
  tenantId: string;
  workshopName: string;
  name: string;
  priceYuan: string;
  dailyCapacityLimit: number;
  cardEmoji: string;
  cardColor: string;
  groupBuyBatch: FeedGroupBuyBatch | null;
}

interface FeedCardView extends FeedProduct {
  hasGroupBuy: boolean;
  groupBuyPriceYuan: string;
  groupBuyProgress: number; // 0~100，相对最高档 minQuantity 的进度
  groupBuyHint: string;
}

function buildCardView(p: FeedProduct): FeedCardView {
  const batch = p.groupBuyBatch;
  if (!batch || !batch.tierThresholds || batch.tierThresholds.length === 0) {
    return { ...p, hasGroupBuy: false, groupBuyPriceYuan: '', groupBuyProgress: 0, groupBuyHint: '' };
  }
  const basePriceCents = Math.round(parseFloat(p.priceYuan) * 100);
  const { unitPrice } = resolveTierPreview(batch.tierThresholds, batch.committedQuantity, basePriceCents);
  const highestTier = batch.tierThresholds.reduce((max, t) => (t.minQuantity > max.minQuantity ? t : max), batch.tierThresholds[0]);
  const progress = highestTier.minQuantity > 0
    ? Math.min(Math.round((batch.committedQuantity / highestTier.minQuantity) * 100), 100)
    : 0;
  return {
    ...p,
    hasGroupBuy: true,
    groupBuyPriceYuan: (unitPrice / 100).toFixed(2),
    groupBuyProgress: progress,
    groupBuyHint: buildNextTierHint(batch.tierThresholds, batch.committedQuantity)
  };
}

Page({
  data: {
    contentTop: 0,
    loading: true,
    loadError: '',
    products: [] as FeedCardView[]
  },

  onLoad() {
    this.loadFeed();
  },

  onNavLayout(e: { detail: { totalHeight: number } }) {
    this.setData({ contentTop: e.detail.totalHeight + 8 });
  },

  onPullDownRefresh() {
    this.loadFeed(() => wx.stopPullDownRefresh());
  },

  async loadFeed(done?: () => void) {
    this.setData({ loading: true, loadError: '' });
    try {
      const res = await callFunctionWithTimeout({ name: 'getFactoryProductFeed', data: {} });
      const result = res.result as any;
      if (result && result.success) {
        const products: FeedCardView[] = (result.products || []).map((p: FeedProduct) => buildCardView(p));
        this.setData({ products });
      } else {
        this.setData({ loadError: (result && result.error) || '加载失败' });
      }
    } catch (err) {
      console.error('[discover] loadFeed 异常:', err);
      this.setData({ loadError: '加载异常，请重试' });
    } finally {
      this.setData({ loading: false });
      if (typeof done === 'function') done();
    }
  },

  onTapProduct(e: any) {
    const tenantId = e.currentTarget.dataset.tenantId;
    const productId = e.currentTarget.dataset.productId;
    if (!tenantId || !productId) return;
    wx.navigateTo({ url: `/subpackages/factory/pages/storefront/storefront?tenantId=${tenantId}&productId=${productId}` });
  },

  // 保留员工入职路径——本页只是把"普通买家的死胡同"改掉，不影响真正持有
  // 邀请码的员工继续走既有流程
  onGoToWorkspaceJoin() {
    wx.navigateTo({ url: '/subpackages/factory/pages/workspace-join/workspace-join' });
  }
});
