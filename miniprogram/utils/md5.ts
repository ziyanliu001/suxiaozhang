/**
 * 纯 JS 实现的 MD5（RFC 1321），不依赖任何 npm 包——小程序端未启用 npm 构建，
 * 无法直接引入 crypto-js 之类的第三方库，只能自实现。
 *
 * 仅用于本地"同一张图片是否重复上传"的去重比对场景，不用于任何安全/加密用途。
 */

function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function leftRotate(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

const K = new Int32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
]);

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

function toHex(n: number): string {
  // n 按小端序输出为 4 个字节的十六进制，与 RFC 1321 的输出字节序一致
  let hex = '';
  for (let i = 0; i < 4; i++) {
    const byte = (n >>> (i * 8)) & 0xff;
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** 对任意二进制数据计算 MD5，返回 32 位小写十六进制字符串 */
export function md5(data: ArrayBuffer | Uint8Array): string {
  const message = toUint8Array(data);
  const originalLength = message.length;

  // 1. 填充：补 0x80，再补 0x00 直到长度 ≡ 56 (mod 64)，最后补 8 字节原始比特长度（小端）
  const bitLenLow = (originalLength * 8) >>> 0;
  const bitLenHigh = Math.floor((originalLength * 8) / 0x100000000) >>> 0;

  let paddedLength = originalLength + 1;
  while (paddedLength % 64 !== 56) paddedLength++;
  paddedLength += 8;

  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[originalLength] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLenLow, true);
  view.setUint32(paddedLength - 4, bitLenHigh, true);

  // 2. 初始化链接变量
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const chunkCount = paddedLength / 64;
  for (let chunk = 0; chunk < chunkCount; chunk++) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      M[i] = view.getUint32(chunk * 64 + i * 4, true);
    }

    let A = a0, B = b0, C = c0, D = d0;

    for (let i = 0; i < 64; i++) {
      let F = 0;
      let g = 0;

      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }

      F = (F + A + K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + leftRotate(F, S[i])) | 0;
    }

    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  return toHex(a0 >>> 0) + toHex(b0 >>> 0) + toHex(c0 >>> 0) + toHex(d0 >>> 0);
}
