// 纯逻辑：校验拼团批次的阶梯价配置与截止时间。不做 db I/O，便于单测；也不
// 依赖 wx-server-sdk。
//
// 🏛️ 业务规则（如实写死，不是猜的）：
//   - 阶梯档位 1~5 档，minQuantity 必须是 >=1 的正整数，且互不相同——排序后
//     检查严格递增，允许调用方传入乱序数组。
//   - unitPriceOverride 必须是 >0 的整数（分为单位，与订单 payAmount 同一
//     口径），且必须 < basePriceCents——阶梯价存在的意义就是"量大从优"，
//     不允许配置一个比原价还贵或相等的"阶梯"，那不是阶梯是圈套。
//   - 按 minQuantity 升序排列后，unitPriceOverride 必须单调不增——买得越多
//     单价只能越低或持平，不能出现"买 50 件反而比买 30 件贵"的倒挂配置。
//   - deadlineAt 必须是合法且晚于 now 的时间。
'use strict';

const MAX_TIERS = 5;

function validateGroupBuyBatch({ tierThresholds, deadlineAt, basePriceCents }, now = new Date()) {
  if (!Array.isArray(tierThresholds) || tierThresholds.length === 0) {
    return { valid: false, error: '至少需要配置一档阶梯价' };
  }
  if (tierThresholds.length > MAX_TIERS) {
    return { valid: false, error: `阶梯档位最多 ${MAX_TIERS} 档` };
  }
  if (!(Number.isFinite(basePriceCents) && basePriceCents > 0)) {
    return { valid: false, error: '商品原价非法' };
  }

  for (const tier of tierThresholds) {
    if (!tier || !Number.isInteger(tier.minQuantity) || tier.minQuantity < 1) {
      return { valid: false, error: '每档 minQuantity 必须是不小于 1 的整数' };
    }
    if (!Number.isInteger(tier.unitPriceOverride) || tier.unitPriceOverride <= 0) {
      return { valid: false, error: '每档 unitPriceOverride 必须是大于 0 的整数（分）' };
    }
    if (tier.unitPriceOverride >= basePriceCents) {
      return { valid: false, error: '阶梯价必须低于商品原价，否则失去"量大从优"的意义' };
    }
  }

  const sorted = tierThresholds.slice().sort((a, b) => a.minQuantity - b.minQuantity);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].minQuantity === sorted[i - 1].minQuantity) {
      return { valid: false, error: '阶梯档位的 minQuantity 不能重复' };
    }
    if (sorted[i].unitPriceOverride > sorted[i - 1].unitPriceOverride) {
      return { valid: false, error: '阶梯价必须随 minQuantity 递增而单调不增（买得越多单价只能越低）' };
    }
  }

  const deadline = deadlineAt ? new Date(deadlineAt) : null;
  if (!deadline || isNaN(deadline.getTime())) {
    return { valid: false, error: '截止时间格式不正确' };
  }
  if (deadline.getTime() <= now.getTime()) {
    return { valid: false, error: '截止时间必须晚于当前时间' };
  }

  return { valid: true, sortedTierThresholds: sorted, deadline };
}

module.exports = { validateGroupBuyBatch, MAX_TIERS };
