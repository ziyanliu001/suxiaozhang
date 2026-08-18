// 支付配置读取层：所有真实商户凭证只从环境变量读取，绝不硬编码在代码/仓库里。
// 在云开发控制台 → 云函数 wxPayCore → 环境变量 中配置：
//
//   PAYMENT_MOCK_MODE      'true' | 'false'（默认 'true'，过渡期未接入真实商户号前的安全默认值）
//   WXPAY_APPID            小程序 appid（同时用于 unifiedorder 请求体 appid 与 paySign 消息体）
//   WXPAY_MCHID            微信支付商户号
//   WXPAY_MCH_SERIAL_NO    商户 API 证书序列号（非 apiclient_key 的序列号，是证书的）
//   WXPAY_MCH_PRIVATE_KEY  商户 API 私钥 PEM 全文，换行符用 \n 转义存成单行环境变量
//   WXPAY_API_V3_KEY       APIv3 密钥（32 字节，用于回调 AES-256-GCM 解密）
//   WXPAY_NOTIFY_URL       本云函数 HTTP 触发的公网回调地址（控制台「HTTP 访问服务」绑定后可得）
//   WXPAY_INTERNAL_TOKEN   内部调用令牌（随机字符串即可）：createOrder/closeOrder 涉及
//                          金额，只信任携带此令牌的业务云函数调用，绝不接受客户端直传
//                          金额发起下单——业务云函数需在自己的环境变量里配置同一份值，
//                          调用 wxPayCore 时随 event.internalToken 一并传入（见 index.js
//                          requireInternalCaller）。Mock/真实两种模式共用同一份令牌校验。
//
// Mock 模式下以上真实凭证全部可留空——这是本模块存在的意义：机构主体认证与
// 微信支付商户号绑定完成前，业务方（如 createSubscriptionOrder 的下一代实现）
// 仍可以把完整下单 → 支付 → 回调 → 状态流转跑通，不必等真实资质到位。

function isMockMode() {
  // 显式写 'false' 才关闭 Mock；未配置/其他取值一律按 Mock 处理，避免真实密钥
  // 缺失时误把用户请求打到真实 APIv3 报出一堆签名错误
  return String(process.env.PAYMENT_MOCK_MODE || 'true').toLowerCase() !== 'false';
}

function getRealPayConfig() {
  const appId = process.env.WXPAY_APPID || '';
  const mchId = process.env.WXPAY_MCHID || '';
  const mchSerialNo = process.env.WXPAY_MCH_SERIAL_NO || '';
  // 环境变量只能存单行字符串，PEM 的换行符会被存成字面量 "\n"，这里还原成真实换行符，
  // 否则 crypto.createSign().sign(privateKey) 会直接报 "error:0909006C" 之类的解析错误
  const mchPrivateKey = String(process.env.WXPAY_MCH_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const apiV3Key = process.env.WXPAY_API_V3_KEY || '';
  const notifyUrl = process.env.WXPAY_NOTIFY_URL || '';

  const missing = Object.entries({ appId, mchId, mchSerialNo, mchPrivateKey, apiV3Key, notifyUrl })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    const err = new Error(`微信支付真实凭证未完整配置，缺少：${missing.join(', ')}`);
    err.code = 'WXPAY_CONFIG_INCOMPLETE';
    throw err;
  }

  return { appId, mchId, mchSerialNo, mchPrivateKey, apiV3Key, notifyUrl };
}

module.exports = { isMockMode, getRealPayConfig };
