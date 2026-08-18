// 极简 HTTPS JSON 请求封装：仓库里没有 axios/node-fetch 依赖，APIv3 调用量也不大，
// 用 Node 内置 https 模块自己包一层 Promise 就够了，不为此引入新依赖。
const https = require('https');

function requestJson({ method, hostname, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const req = https.request(
      {
        method,
        hostname,
        path,
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (err) {
            // 部分成功响应（如关单 204）body 为空，非 JSON 属正常情况，不当作错误
          }
          resolve({ statusCode: res.statusCode, headers: res.headers, raw, data: parsed });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

module.exports = { requestJson };
