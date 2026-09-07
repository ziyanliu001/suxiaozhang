// 纯逻辑：护城河三 4.5 节"防作弊资金防线"——导出前主动复核
// producerAmount + promoterAmount + platformFee === payAmount 这条恒等式。
// 这条恒等式在 liveFactoryCore/lib/settlement.js 的 computeSettlementSplit
// 里已经是代码级保证（platformFee 是余数定义出来的），正常记录 100% 会通过；
// 这里只是"关键操作前主动复核"的低成本加固，不重新实现分账算法本身。
'use strict';

function checkInvariant(row) {
  if (!row) return false;
  const producer = row.producerAmount || 0;
  const promoter = row.promoterAmount || 0;
  const platform = row.platformFee || 0;
  const pay = row.payAmount || 0;
  return producer + promoter + platform === pay;
}

module.exports = { checkInvariant };
