// 产销工坊订单状态展示口径：与 production_orders.orderStatus 真实枚举一一
// 对应（见 completeProductionOrder/lib/orderStatusMachine.js、
// processProductionRefund/index.js）——不是 KB 文档早期草案里
// PENDING/PRODUCING/PACKED/FULFILLED 那套理想化状态机。抽成共享 util 供
// production-fulfillment.ts（商家侧履约看板）与 my-orders.ts（买家侧订单
// 列表）共用同一份文案/配色 token，不各自维护一份容易走样的映射表。
//
// ORDER_STATUS_CLASS 是 WXSS class 后缀 token，不是完整 class 名——两个页面
// WXSS 各自拼接自己的前缀（production-fulfillment 是 .pf-xxx-{{class}}，
// my-orders 是 .mo-xxx-{{class}}），WXML/WXSS 本身仍是页面各自维护
// （本仓库样式文件是 isolated/页面级作用域的既有惯例，不是这里新引入的）。
export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending_payment: '待支付',
  paid: '已付款 · 待生产',
  in_production: '生产中',
  shipped: '已发货',
  refunded: '已退款',
  failed: '下单失败'
};

export const ORDER_STATUS_CLASS: Record<string, string> = {
  pending_payment: 'pending_payment',
  paid: 'pending',
  in_production: 'producing',
  shipped: 'shipped',
  refunded: 'refunded',
  failed: 'failed'
};
