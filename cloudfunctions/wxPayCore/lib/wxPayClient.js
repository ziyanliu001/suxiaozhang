// 真实微信支付 APIv3 客户端：JSAPI 统一下单 / 查询订单 / 关闭订单 / 回调解密验签。
// 只在 PAYMENT_MOCK_MODE=false 时被调用（见 index.js 的分流），因此这里不做
// Mock 兜底——真实凭证缺失时应该直接抛错，而不是静默降级。
const { requestJson } = require('./httpClient');
const { buildAuthorizationHeader, buildRequestPaymentParams, verifyNotifySignature, decryptResource } = require('./cryptoUtil');
const { getPlatformPublicKey } = require('./certCache');

const HOST = 'api.mch.weixin.qq.com';

async function callApiV3({ method, urlPath, body, realConfig }) {
  const { mchId, mchSerialNo, mchPrivateKey } = realConfig;
  const authorization = buildAuthorizationHeader({ method, urlPath, body, mchId, mchSerialNo, mchPrivateKey });
  const resp = await requestJson({
    method,
    hostname: HOST,
    path: urlPath,
    headers: { Authorization: authorization },
    body
  });
  return resp;
}

// 统一下单（JSAPI）：POST /v3/pay/transactions/jsapi
// 返回 prepay_id，并当场用商户私钥算好 wx.requestPayment 所需的 paySign，
// 一次调用把"下单"与"生成拉起参数"两步都做完，业务方拿到的就是能直接传给
// wx.requestPayment 的成品对象。
async function createUnifiedOrder({ outTradeNo, description, totalFee, openid, realConfig }) {
  const { appId, mchId, notifyUrl } = realConfig;
  const body = {
    appid: appId,
    mchid: mchId,
    description,
    out_trade_no: outTradeNo,
    notify_url: notifyUrl,
    amount: { total: totalFee, currency: 'CNY' },
    payer: { openid }
  };

  const resp = await callApiV3({ method: 'POST', urlPath: '/v3/pay/transactions/jsapi', body, realConfig });
  if (resp.statusCode !== 200 || !resp.data || !resp.data.prepay_id) {
    const err = new Error(`统一下单失败: HTTP ${resp.statusCode} ${resp.raw}`);
    err.code = 'WXPAY_UNIFIEDORDER_FAILED';
    throw err;
  }

  const prepayId = resp.data.prepay_id;
  const payment = buildRequestPaymentParams({ appId, prepayId, mchPrivateKey: realConfig.mchPrivateKey });
  return { prepayId, payment };
}

// 订单查询：GET /v3/pay/transactions/out-trade-no/{out_trade_no}
async function queryOrderByOutTradeNo({ outTradeNo, realConfig }) {
  const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(realConfig.mchId)}`;
  const resp = await callApiV3({ method: 'GET', urlPath, body: null, realConfig });
  if (resp.statusCode !== 200 || !resp.data) {
    const err = new Error(`订单查询失败: HTTP ${resp.statusCode} ${resp.raw}`);
    err.code = 'WXPAY_QUERY_FAILED';
    throw err;
  }
  return {
    tradeState: resp.data.trade_state, // SUCCESS/REFUND/NOTPAY/CLOSED/REVOKED/USERPAYING/PAYERROR
    transactionId: resp.data.transaction_id || ''
  };
}

// 主动关单：POST /v3/pay/transactions/out-trade-no/{out_trade_no}/close
// 成功响应 204 No Content，无 body。
async function closeOrder({ outTradeNo, realConfig }) {
  const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`;
  const body = { mchid: realConfig.mchId };
  const resp = await callApiV3({ method: 'POST', urlPath, body, realConfig });
  if (resp.statusCode !== 204 && resp.statusCode !== 200) {
    const err = new Error(`关闭订单失败: HTTP ${resp.statusCode} ${resp.raw}`);
    err.code = 'WXPAY_CLOSE_FAILED';
    throw err;
  }
  return true;
}

// 解析并验签、解密支付通知回调。headers 用小写 key（云开发 HTTP 触发透传的
// event.headers 就是小写），rawBody 必须是原始未解析的请求体字符串——验签用的
// 是原文，不是 JSON.parse 之后再 stringify 的版本（字段顺序/空白可能不一致，
// 那样会导致签名永远验不过）。
async function decryptNotify({ headers, rawBody, realConfig }) {
  const timestamp = headers['wechatpay-timestamp'];
  const nonce = headers['wechatpay-nonce'];
  const signature = headers['wechatpay-signature'];
  const serialNo = headers['wechatpay-serial'];

  if (!timestamp || !nonce || !signature || !serialNo) {
    const err = new Error('回调缺少必要的 Wechatpay-* 验签请求头');
    err.code = 'WXPAY_NOTIFY_HEADERS_MISSING';
    throw err;
  }

  const platformPublicKeyPem = await getPlatformPublicKey(serialNo, realConfig);
  if (!platformPublicKeyPem) {
    const err = new Error(`未找到序列号为 ${serialNo} 的微信支付平台证书`);
    err.code = 'WXPAY_CERT_NOT_FOUND';
    throw err;
  }

  const signatureValid = verifyNotifySignature({ timestamp, nonce, rawBody, signature, platformPublicKeyPem });
  if (!signatureValid) {
    const err = new Error('回调验签失败，拒绝处理（可能是伪造请求）');
    err.code = 'WXPAY_NOTIFY_SIGNATURE_INVALID';
    throw err;
  }

  const payload = JSON.parse(rawBody);
  if (payload.event_type !== 'TRANSACTION.SUCCESS' || !payload.resource) {
    // 非支付成功事件（如仅测试推送）：验签通过但不是我们关心的事件类型
    return { eventType: payload.event_type, decrypted: null };
  }

  const decrypted = decryptResource({
    ciphertext: payload.resource.ciphertext,
    associatedData: payload.resource.associated_data,
    nonce: payload.resource.nonce,
    apiV3Key: realConfig.apiV3Key
  });

  return { eventType: payload.event_type, decrypted };
}

// ── 退款：POST /v3/refund/domestic/refunds ──────────────────────────────
// transactionId 优先于 outTradeNo（微信支付文档建议优先传 transaction_id）。
async function createRefund({ outRefundNo, outTradeNo, transactionId, totalAmount, refundAmount, reason, realConfig }) {
  const body = {
    out_refund_no: outRefundNo,
    reason: (reason || '').slice(0, 80), // 微信支付对 reason 长度有限制
    amount: { refund: refundAmount, total: totalAmount, currency: 'CNY' }
  };
  if (realConfig.notifyUrl) body.notify_url = realConfig.notifyUrl;
  if (transactionId) body.transaction_id = transactionId; else body.out_trade_no = outTradeNo;

  const resp = await callApiV3({ method: 'POST', urlPath: '/v3/refund/domestic/refunds', body, realConfig });
  if (resp.statusCode !== 200 || !resp.data) {
    const err = new Error(`申请退款失败: HTTP ${resp.statusCode} ${resp.raw}`);
    err.code = 'WXPAY_REFUND_FAILED';
    throw err;
  }
  // status: SUCCESS / CLOSED / PROCESSING / ABNORMAL
  return { refundId: resp.data.refund_id || '', status: resp.data.status || 'PROCESSING' };
}

// 退款查询：GET /v3/refund/domestic/refunds/{out_refund_no}
async function queryRefund({ outRefundNo, realConfig }) {
  const urlPath = `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`;
  const resp = await callApiV3({ method: 'GET', urlPath, body: null, realConfig });
  if (resp.statusCode !== 200 || !resp.data) {
    const err = new Error(`查询退款失败: HTTP ${resp.statusCode} ${resp.raw}`);
    err.code = 'WXPAY_REFUND_QUERY_FAILED';
    throw err;
  }
  return { status: resp.data.status || 'PROCESSING', refundId: resp.data.refund_id || '' };
}

// ── 分账（Profit Sharing）──────────────────────────────────────────────────
// ⚠️ 分账接口在真实上线前需要商户先在微信支付商户平台手动开通"分账"权限，
// 本模块不做任何自动化前置——没开通权限时以下调用会直接被微信支付拒绝。
//
// ⚠️ 接收方姓名等敏感信息：微信支付官方文档要求 receivers/add 的 name 字段
// （若传入）需用微信支付平台证书公钥加密后再传输，本实现【未做该加密】，
// 仅在 account 类型不要求实名（如小额 PERSONAL_OPENID）时可以不传 name 安全
// 使用；接入真实商户号前务必对照当时最新的官方文档确认加密要求是否适用，
// 不要直接把这里的实现当作已验证过加密链路的成品。
async function addProfitSharingReceiver({ type, account, name, relationType, realConfig }) {
  const body = { appid: realConfig.appId, type, account, relation_type: relationType || 'PARTNER' };
  if (name) body.name = name;
  const resp = await callApiV3({ method: 'POST', urlPath: '/v3/profitsharing/receivers/add', body, realConfig });
  if (resp.statusCode !== 200 || !resp.data) {
    const err = new Error(`添加分账接收方失败: HTTP ${resp.statusCode} ${resp.raw}`);
    err.code = 'WXPAY_PROFITSHARING_RECEIVER_FAILED';
    throw err;
  }
  return resp.data;
}

// 请求分账：POST /v3/profitsharing/orders
// receivers: [{ type, account, amount, description }]，amount 单位分。
async function requestProfitSharing({ outOrderNo, transactionId, receivers, unfreezeUnsplit, realConfig }) {
  const body = {
    appid: realConfig.appId,
    transaction_id: transactionId,
    out_order_no: outOrderNo,
    receivers,
    unfreeze_unsplit: !!unfreezeUnsplit
  };
  const resp = await callApiV3({ method: 'POST', urlPath: '/v3/profitsharing/orders', body, realConfig });
  if (resp.statusCode !== 200 || !resp.data) {
    const err = new Error(`请求分账失败: HTTP ${resp.statusCode} ${resp.raw}`);
    err.code = 'WXPAY_PROFITSHARING_FAILED';
    throw err;
  }
  return { orderId: resp.data.order_id || '', status: resp.data.status || 'PROCESSING', receivers: resp.data.receivers || [] };
}

// 分账结果查询：GET /v3/profitsharing/orders/{out_order_no}?transaction_id=xxx
async function queryProfitSharing({ outOrderNo, transactionId, realConfig }) {
  const urlPath = `/v3/profitsharing/orders/${encodeURIComponent(outOrderNo)}?transaction_id=${encodeURIComponent(transactionId)}`;
  const resp = await callApiV3({ method: 'GET', urlPath, body: null, realConfig });
  if (resp.statusCode !== 200 || !resp.data) {
    const err = new Error(`查询分账结果失败: HTTP ${resp.statusCode} ${resp.raw}`);
    err.code = 'WXPAY_PROFITSHARING_QUERY_FAILED';
    throw err;
  }
  return { status: resp.data.status || 'PROCESSING', receivers: resp.data.receivers || [] };
}

// 分账完结（释放未分完的剩余冻结资金回商户余额）：POST /v3/profitsharing/finish-order
// 🛡️ 不调用这一步，已分账订单里没分完的部分会一直冻结在微信支付账户里不可用——
// requestProfitSharing 成功后应该总是紧跟一次 finishProfitSharing（unfreezeUnsplit
// 传 true 时部分场景可以省略，但显式调用更保险，不同版本 API 行为不完全一致）。
async function finishProfitSharing({ outOrderNo, transactionId, description, realConfig }) {
  const body = { transaction_id: transactionId, out_order_no: outOrderNo, description: (description || '分账完结').slice(0, 80) };
  const resp = await callApiV3({ method: 'POST', urlPath: '/v3/profitsharing/finish-order', body, realConfig });
  if (resp.statusCode !== 200 || !resp.data) {
    const err = new Error(`完结分账失败: HTTP ${resp.statusCode} ${resp.raw}`);
    err.code = 'WXPAY_PROFITSHARING_FINISH_FAILED';
    throw err;
  }
  return { orderId: resp.data.order_id || '', status: resp.data.status || 'PROCESSING' };
}

// ════════════════════════════════════════════════════════════════════════
// 📋 分账回退（Profit Sharing Return）—— 技术规范存档，暂不编码
// ════════════════════════════════════════════════════════════════════════
// 触发场景：processProductionRefund 已经标注过这个残余风险——如果一笔订单
// 在 completeProductionOrder 时已经完成自动分账（settlementStatus:'settled'，
// 钱已划给 producer/promoter），买家事后又要求退款，商户自己的"未分账余额"
// 很可能不够覆盖这笔退款，微信支付会拒绝或者需要先把已分出去的钱"回退"回来。
// 这就是分账回退接口要解决的问题：把之前分给某个接收方的钱，部分或全部
// 转回商户的可用余额，退款才有钱可退。
//
// 接口：POST /v3/profitsharing/return-orders
// 认证方式与本文件其它 APIv3 调用一致（复用 callApiV3 的 buildAuthorizationHeader）。
//
// 请求体字段：
//   order_id      string  原分账单号——微信支付分账后返回的 order_id（不是
//                         商户自己生成的 out_order_no），来自 requestProfitSharing
//                         成功响应里的 orderId，或 profit_sharing_orders 账本里
//                         对应记录的同名字段
//   out_return_no string  商户系统内部回退单号，需保证唯一，建议沿用本模块
//                         "业务前缀 + 时间戳 + 随机串"的既有生成方式（对照
//                         refundService.genOutRefundNo / profitSharingService.genOutOrderNo）
//   return_mchid   string  可选：仅当分账接收方类型是 MERCHANT_ID（分给另一个
//                         商户号）时需要，本模块目前的 receivers 只用
//                         PERSONAL_OPENID，通常不需要传
//   amount         number  回退金额（分），不能超过当初分给该接收方的金额
//   description    string  回退描述，会展示给分账接收方
//
// 响应体关键字段：
//   order_id / out_order_no / out_return_no / return_no（微信侧回退单号）
//   return_mchid / result（PROCESSING / SUCCESS / FAIL）/ fail_reason / create_time
//
// 查询：GET /v3/profitsharing/return-orders/{out_return_no}?out_order_no=xxx
//   用于轮询 PROCESSING 状态的回退结果，形状与 queryRefund/queryProfitSharing
//   完全同构。
//
// 如果要落地实现，建议的接线方式（供后续排期参考，不在本轮范围内）：
//   1. 新增 profit_sharing_return_orders 账本集合，字段设计对照
//      refundService.js / profitSharingService.js 的既有模式（out_return_no
//      唯一索引 + status 状态机 + createPendingXxx/markXxxStatus 一套函数）。
//   2. processProductionRefund 检测到 alreadyProfitShared 为 true 时，不能像
//      现在这样只是在响应里"提示一下"就直接调 wxPayCore.refund——正确顺序应
//      该是：先对该订单分账快照里每一个 receiver 各发起一次分账回退（本模块
//      当前的 receivers 最多两个：producer + promoter），全部回退成功后才
//      继续走现有的"退款优先"流程；任意一个回退失败/进入需要人工介入的状态，
//      就应该整个中止、明确提示"请先联系制作方/推广人确认分账回退，暂不能
//      自动退款"，而不是让平台自己垫付这笔钱。
//   3. wxPayCore 需要新增 action: 'returnProfitSharing'，鉴权方式与
//      refund/requestProfitSharing 同一套 requireInternalCaller 内部令牌校验。
//
// ⚠️ 未经真实商户号验证：以上字段名称/结构基于官方文档记忆整理，接真实
// 商户号落地前务必对照当时最新的《微信支付 APIv3 分账回退》文档逐字核对，
// 不要直接当作已验证过的成品去写实现。
module.exports = {
  createUnifiedOrder, queryOrderByOutTradeNo, closeOrder, decryptNotify,
  createRefund, queryRefund,
  addProfitSharingReceiver, requestProfitSharing, queryProfitSharing, finishProfitSharing
};
