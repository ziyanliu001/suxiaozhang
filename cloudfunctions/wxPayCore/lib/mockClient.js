// Mock 支付客户端：与 wxPayClient.js 暴露完全相同的函数签名，index.js 按
// isMockMode() 二选一调用——业务方（orderService/前端）感知不到切换，这正是
// "无缝切换"的落点：只有 index.js 这一处 if/else 知道自己在跑哪条通道。
//
// 🛡️ 关键设计：Mock 模式下不会、也不能生成一份能通过真机 wx.requestPayment
// 校验的 paySign——真机会把 package/paySign 发给微信服务器验证，伪造的签名
// 只会得到 "支付验证失败" 的错误，不存在"骗过微信客户端"这回事。所以 Mock
// 订单返回的 payment 对象带有 mock:true 标记，前端据此走"模拟支付确认弹窗"
// 分支，完全不调用 wx.requestPayment（见 miniprogram/utils/wxPayCore.ts）。
const crypto = require('crypto');

function mockPrepayId(outTradeNo) {
  return `mock_prepay_${outTradeNo}`;
}

async function createUnifiedOrder({ outTradeNo }) {
  const prepayId = mockPrepayId(outTradeNo);
  const payment = {
    timeStamp: Math.floor(Date.now() / 1000).toString(),
    nonceStr: crypto.randomBytes(16).toString('hex'),
    package: `prepay_id=${prepayId}`,
    signType: 'RSA',
    paySign: 'MOCK_SIGNATURE_NOT_FOR_REAL_REQUESTPAYMENT',
    mock: true
  };
  return { prepayId, payment };
}

// Mock 模式的"查单"直接读本地订单状态（orderService 已经是唯一真源），
// 转换成与真实 APIv3 查单响应同构的 tradeState 枚举，方便调用方写统一分支。
async function queryOrderByOutTradeNo({ localOrder }) {
  const stateMap = { PENDING_PAY: 'NOTPAY', PAID: 'SUCCESS', CLOSED: 'CLOSED', REFUNDED: 'REFUND' };
  return {
    tradeState: stateMap[localOrder.status] || 'NOTPAY',
    transactionId: localOrder.transactionId || ''
  };
}

async function closeOrder() {
  return true; // Mock 模式没有真实网关可关，orderService 直接改本地状态即可
}

// Mock 退款：直接返回 SUCCESS——真实网关的 PROCESSING 中间态在 Mock 模式下没有
// 意义（没有真实资金流转需要等待），让业务方回调链路能同步跑通验证。
async function createRefund({ outRefundNo }) {
  return { refundId: `mock_refund_${outRefundNo}`, status: 'SUCCESS' };
}
async function queryRefund({ outRefundNo }) {
  return { status: 'SUCCESS', refundId: `mock_refund_${outRefundNo}` };
}

async function addProfitSharingReceiver({ type, account }) {
  return { type, account, mock: true };
}
async function requestProfitSharing({ outOrderNo, receivers }) {
  return {
    orderId: `mock_share_${outOrderNo}`,
    status: 'FINISHED',
    receivers: (receivers || []).map((r) => ({ ...r, result: 'SUCCESS' }))
  };
}
async function queryProfitSharing({ outOrderNo }) {
  return { status: 'FINISHED', receivers: [] };
}
async function finishProfitSharing({ outOrderNo }) {
  return { orderId: `mock_share_${outOrderNo}`, status: 'FINISHED' };
}

module.exports = {
  createUnifiedOrder, queryOrderByOutTradeNo, closeOrder,
  createRefund, queryRefund,
  addProfitSharingReceiver, requestProfitSharing, queryProfitSharing, finishProfitSharing
};
