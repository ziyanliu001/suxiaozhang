// 微信支付平台证书缓存：回调通知验签需要平台公钥（不是商户自己的证书），
// 通过 GET /v3/certificates 拉取并用 APIv3 密钥解密后得到，按 serial_no 缓存到
// wx_pay_platform_certs 集合，避免每次回调都重新拉取证书接口。
//
// 🛡️ 引导信任：首次拉取证书列表时，我们还没有平台公钥去验证这个响应本身的签名——
// 这是所有微信支付官方 SDK 共同的"先有鸡还是先有蛋"处理方式：该请求本身用商户私钥
// 签名（证明请求方身份），响应体用 APIv3 密钥（仅商户与微信双方持有的共享密钥）
// AES-256-GCM 解密，解密成功即证明响应确实来自微信（伪造方拿不到 APIv3 密钥），
// 不需要再对这次引导请求本身做平台签名验证。
const cloud = require('wx-server-sdk');
const { requestJson } = require('./httpClient');
const { buildAuthorizationHeader, decryptResource } = require('./cryptoUtil');

const db = cloud.database();
const CERTS_COLLECTION = 'wx_pay_platform_certs';
const CERT_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时刷新一次，跟随微信证书轮换周期足够及时

function isCollectionNotExistError(err) {
  return !!err && (
    err.errCode === -502005 ||
    /database collection not exists/i.test(String(err.errMsg || err.message || ''))
  );
}

async function fetchAndCachePlatformCerts(realConfig) {
  const { mchId, mchSerialNo, mchPrivateKey, apiV3Key } = realConfig;
  const urlPath = '/v3/certificates';
  const authorization = buildAuthorizationHeader({
    method: 'GET',
    urlPath,
    body: null,
    mchId,
    mchSerialNo,
    mchPrivateKey
  });

  const resp = await requestJson({
    method: 'GET',
    hostname: 'api.mch.weixin.qq.com',
    path: urlPath,
    headers: { Authorization: authorization }
  });

  if (resp.statusCode !== 200 || !resp.data || !Array.isArray(resp.data.data)) {
    const err = new Error(`拉取微信支付平台证书失败: HTTP ${resp.statusCode} ${resp.raw}`);
    err.code = 'WXPAY_CERT_FETCH_FAILED';
    throw err;
  }

  const certs = resp.data.data.map((item) => {
    const encryptCert = item.encrypt_certificate;
    const publicKeyPem = decryptResource({
      ciphertext: encryptCert.ciphertext,
      associatedData: encryptCert.associated_data,
      nonce: encryptCert.nonce,
      apiV3Key
    });
    return {
      serialNo: item.serial_no,
      publicKeyPem, // decryptResource 返回的 payload 本身就是 PEM 文本（微信证书接口特例：resource 非 JSON 对象而是纯文本证书）
      expireTime: item.expire_time,
      fetchedAt: db.serverDate()
    };
  });

  await ensureCollection();
  await Promise.all(certs.map((cert) =>
    db.collection(CERTS_COLLECTION).where({ serialNo: cert.serialNo }).get().then((res) => {
      if (res.data && res.data.length > 0) {
        return db.collection(CERTS_COLLECTION).doc(res.data[0]._id).update({ data: cert });
      }
      return db.collection(CERTS_COLLECTION).add({ data: cert });
    })
  ));

  return certs;
}

async function ensureCollection() {
  try {
    await db.collection(CERTS_COLLECTION).limit(1).get();
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    await db.createCollection(CERTS_COLLECTION).catch(() => {});
  }
}

// 按回调头里的 Wechatpay-Serial 查找对应平台公钥；缓存缺失/过期时现拉一次。
async function getPlatformPublicKey(serialNo, realConfig) {
  await ensureCollection();
  const res = await db.collection(CERTS_COLLECTION).where({ serialNo }).limit(1).get().catch(() => ({ data: [] }));
  const cached = res.data && res.data[0];
  const isFresh = cached && cached.fetchedAt && (Date.now() - new Date(cached.fetchedAt).getTime() < CERT_TTL_MS);
  if (isFresh) return cached.publicKeyPem;

  const certs = await fetchAndCachePlatformCerts(realConfig);
  const matched = certs.find((c) => c.serialNo === serialNo);
  return matched ? matched.publicKeyPem : null;
}

module.exports = { getPlatformPublicKey, fetchAndCachePlatformCerts };
