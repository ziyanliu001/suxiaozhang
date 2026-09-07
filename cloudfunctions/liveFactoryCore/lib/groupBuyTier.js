// 纯逻辑：护城河二「拼团阶梯排产」——根据当前批次已认购总件数，算出命中的
// 阶梯单价。不做 db I/O，便于单测；也不依赖 wx-server-sdk。
//
// 🏛️ 命中规则：tierThresholds 按 minQuantity 升序排列，取"累计认购量 >=
// minQuantity"里 minQuantity 最大的那一档；一档都没达到时用商品原价
// basePriceCents，appliedTierLevel 用 0 表示"未命中任何阶梯"（与真实阶梯
// 的 minQuantity 恒 >=1 天然区分，不会撞值）。
'use strict';

function resolveTierPrice(tierThresholds, totalQuantity, basePriceCents) {
  const sorted = (Array.isArray(tierThresholds) ? tierThresholds : [])
    .filter((t) => t && Number.isFinite(t.minQuantity) && Number.isFinite(t.unitPriceOverride))
    .slice()
    .sort((a, b) => a.minQuantity - b.minQuantity);

  let applied = null;
  for (const tier of sorted) {
    if (totalQuantity >= tier.minQuantity) applied = tier;
    else break;
  }

  return {
    unitPrice: applied ? applied.unitPriceOverride : basePriceCents,
    appliedTierLevel: applied ? applied.minQuantity : 0
  };
}

module.exports = { resolveTierPrice };
