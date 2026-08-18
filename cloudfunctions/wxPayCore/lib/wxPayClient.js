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

module.exports = { createUnifiedOrder, queryOrderByOutTradeNo, closeOrder, decryptNotify };
