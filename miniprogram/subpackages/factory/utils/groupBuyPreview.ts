// 🏛️（护城河二）拼团阶梯预览：与 cloudfunctions/liveFactoryCore/lib/groupBuyTier.js
// 同一份命中规则，前端展示层共用（storefront.ts 下单页 + discover.ts 发现页
// 都要用同一套算法），只做"预览"用途，不是最终成交价的权威来源——真正生效的
// 价格由 createProductionOrder → liveFactoryCore.updateGroupBuyProgress 在下单
// 那一刻原子算出。抽成共享 util 而不是两个页面各写一份：前端 TS 之间没有
// 云函数那种"独立部署无法共享模块"的硬约束，重复维护同一份定价逻辑只会增加
// 日后改动漏改一处的风险，与本仓库云函数侧被迫复制的情况不是一回事。
export interface GroupBuyTier {
  minQuantity: number;
  unitPriceOverride: number;
}

export function resolveTierPreview(tiers: GroupBuyTier[], projectedTotal: number, basePriceCents: number) {
  const sorted = (tiers || []).slice().sort((a, b) => a.minQuantity - b.minQuantity);
  let applied: GroupBuyTier | null = null;
  for (const t of sorted) {
    if (projectedTotal >= t.minQuantity) applied = t;
    else break;
  }
  const nextTier = sorted.find((t) => t.minQuantity > projectedTotal) || null;
  return {
    unitPrice: applied ? applied.unitPriceOverride : basePriceCents,
    appliedTierLevel: applied ? applied.minQuantity : 0,
    nextTier
  };
}

export interface TierRow {
  minQuantity: number;
  priceYuan: string;
  isCurrent: boolean;
  isReached: boolean;
}

// 阶梯梯度展示行：按 minQuantity 升序，标记"当前命中档"（isCurrent）与
// "已解锁但不是当前最高档"（isReached，用于打勾灰显），供 storefront.ts 画
// 一条横向阶梯条用
export function buildTierRows(tiers: GroupBuyTier[], projectedTotal: number): TierRow[] {
  const sorted = (tiers || []).slice().sort((a, b) => a.minQuantity - b.minQuantity);
  let currentIndex = -1;
  sorted.forEach((t, i) => {
    if (projectedTotal >= t.minQuantity) currentIndex = i;
  });
  return sorted.map((t, i) => ({
    minQuantity: t.minQuantity,
    priceYuan: (t.unitPriceOverride / 100).toFixed(2),
    isCurrent: i === currentIndex,
    isReached: i < currentIndex
  }));
}

// 🌸（方向 B 发现页专用）给一个"再拼 N 件解锁 ¥X"这类一句话文案，discover.ts
// 的卡片只需要一行摘要，不需要 storefront.ts 那种完整阶梯条
export function buildNextTierHint(tiers: GroupBuyTier[], committedQuantity: number): string {
  const { nextTier } = resolveTierPreview(tiers, committedQuantity, 0);
  if (!nextTier) return '已解锁最低价';
  return `再拼 ${nextTier.minQuantity - committedQuantity} 件解锁 ¥${(nextTier.unitPriceOverride / 100).toFixed(2)}`;
}
