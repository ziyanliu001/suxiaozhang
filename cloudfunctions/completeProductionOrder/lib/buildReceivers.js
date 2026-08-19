// 纯逻辑：把一条分账快照（order_settlements）翻译成 wxPayCore.requestProfitSharing
// 需要的 receivers 数组。不做 db I/O，便于单测；也不依赖 wx-server-sdk。
//
// 🛡️ 只分账"有明确接收人"的部分，不猜：
//   - producerAmount 只有在商品配置了 producerOpenId 时才生成接收方——没配置
//     就是没配置，不会替商家瞎猜"应该分给谁"（历史教训：见 orgType/tenantId
//     不做推断的同一条原则）。
//   - promoterAmount 只有在订单本身带 promoterOpenId 时才生成接收方，这个字段
//     本来就是下单时买家/系统写死的，不存在"猜"的问题。
// 两者任一缺失时，对应份额保留在 settlementStatus:'unsettled'，走人工/受托
// 结算路径（markSettlementsSettled），不会被这个函数悄悄吞掉或瞎分。
'use strict';

function buildProfitSharingReceivers({ settlement, order, product }) {
  const receivers = [];

  if (settlement && settlement.producerAmount > 0 && product && product.producerOpenId) {
    receivers.push({
      type: 'PERSONAL_OPENID',
      account: product.producerOpenId,
      amount: settlement.producerAmount,
      description: '制作方分成'
    });
  }

  if (settlement && settlement.promoterAmount > 0 && order && order.promoterOpenId) {
    receivers.push({
      type: 'PERSONAL_OPENID',
      account: order.promoterOpenId,
      amount: settlement.promoterAmount,
      description: '推广分成'
    });
  }

  return receivers;
}

module.exports = { buildProfitSharingReceivers };
