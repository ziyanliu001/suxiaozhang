// 微信支付 APIv3 签名 / 验签 / 加解密工具集，全部基于 Node 内置 crypto，
// 不引入第三方加密库——APIv3 的 RSA-SHA256 与 AES-256-GCM 都是 crypto 原生支持算法。
const crypto = require('crypto');

function randomNonceStr() {
  return crypto.randomBytes(16).toString('hex');
}

// APIv3 请求签名：用商户 API 私钥对 "方法\nURL\n时间戳\n随机串\nBody\n" 做 RSA-SHA256 签名，
// 拼成 Authorization 头。参见微信支付官方文档《认证类型说明》。
function buildAuthorizationHeader({ method, urlPath, body, mchId, mchSerialNo, mchPrivateKey }) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = randomNonceStr();
  const bodyStr = body ? JSON.stringify(body) : '';
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${bodyStr}\n`;
  const signature = crypto.createSign('RSA-SHA256').update(message, 'utf8').sign(mchPrivateKey, 'base64');
  const authorization = [
    `mchid="${mchId}"`,
    `nonce_str="${nonceStr}"`,
    `timestamp="${timestamp}"`,
    `serial_no="${mchSerialNo}"`,
    `signature="${signature}"`
  ].join(',');
  return `WECHATPAY2-SHA256-RSA2048 ${authorization}`;
}

// 小程序端 wx.requestPayment 拉起支付所需的 paySign：对
// "appId\ntimeStamp\nnonceStr\npackage\n" 做同一套 RSA-SHA256 签名（用的仍是
// 商户私钥，不是 APIv3 请求签名的复用——消息体不同，是两次独立签名）。
function buildPaySign({ appId, timeStamp, nonceStr, pkg, mchPrivateKey }) {
  const message = `${appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`;
  return crypto.createSign('RSA-SHA256').update(message, 'utf8').sign(mchPrivateKey, 'base64');
}

function buildRequestPaymentParams({ appId, prepayId, mchPrivateKey }) {
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = randomNonceStr();
  const pkg = `prepay_id=${prepayId}`;
  const paySign = buildPaySign({ appId, timeStamp, nonceStr, pkg, mchPrivateKey });
  return { timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign };
}

// 回调通知验签：微信支付服务器在 HTTP 头里带 Wechatpay-Timestamp/Wechatpay-Nonce/
// Wechatpay-Signature，用平台证书公钥验证 "时间戳\n随机串\n原始 Body\n" 的签名，
// 防止回调被伪造/篡改。platformPublicKeyPem 来自 certCache（按 Wechatpay-Serial 匹配）。
function verifyNotifySignature({ timestamp, nonce, rawBody, signature, platformPublicKeyPem }) {
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  try {
    return crypto.createVerify('RSA-SHA256').update(message, 'utf8').verify(platformPublicKeyPem, signature, 'base64');
  } catch (err) {
    console.error('[cryptoUtil] 验签异常（视为验签失败）:', err);
    return false;
  }
}

// AES-256-GCM 解密回调通知 resource 字段。ciphertext 末尾 16 字节是 GCM 认证标签，
// 需要单独截出来 setAuthTag，否则 decipher.final() 会因认证失败直接抛异常。
function decryptResource({ ciphertext, associatedData, nonce, apiV3Key }) {
  const buf = Buffer.from(ciphertext, 'base64');
  const authTagLength = 16;
  const authTag = buf.slice(buf.length - authTagLength);
  const data = buf.slice(0, buf.length - authTagLength);

  // key/iv 必须显式转成 Buffer（utf8）——直接传字符串在较新 Node 版本上会被
  // 当成 hex/被拒绝，微信支付官方 Node SDK 同样是这么处理的
  const keyBuf = Buffer.from(apiV3Key, 'utf8');
  const ivBuf = Buffer.from(nonce, 'utf8');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, ivBuf);
  decipher.setAuthTag(authTag);
  if (associatedData) decipher.setAAD(Buffer.from(associatedData, 'utf8'));

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

module.exports = {
  randomNonceStr,
  buildAuthorizationHeader,
  buildPaySign,
  buildRequestPaymentParams,
  verifyNotifySignature,
  decryptResource
};
