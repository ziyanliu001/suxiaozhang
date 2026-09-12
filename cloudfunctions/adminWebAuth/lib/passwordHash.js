// Web 管理中台密码哈希：纯逻辑（除了 crypto 这个 Node 内置模块，不依赖
// wx-server-sdk 或任何第三方包——CLAUDE.md"克制原则"不允许未经许可引入
// 第三方 npm 包如 bcrypt，Node 内置的 scrypt 是同等强度的密码哈希 KDF，
// 不需要额外依赖）。
'use strict';

const crypto = require('crypto');

const SALT_BYTES = 16;
const KEY_LENGTH = 64;
// scrypt 的 N（CPU/内存成本）参数：Node 官方文档推荐的默认值 16384（2^14），
// 在现代云函数运行环境下计算耗时约几十毫秒，登录场景完全可接受，同时足以
// 抵御大规模离线暴力破解（每猜一次都要付出这个计算成本）
const SCRYPT_COST = 16384;

/**
 * 生成随机盐值（十六进制字符串）。
 * @returns {string}
 */
function generateSalt() {
  return crypto.randomBytes(SALT_BYTES).toString('hex');
}

/**
 * 用 scrypt 对密码 + 盐值做哈希，返回十六进制字符串。
 * @param {string} password
 * @param {string} salt
 * @returns {Promise<string>}
 */
function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password || ''), String(salt || ''), KEY_LENGTH, { N: SCRYPT_COST }, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey.toString('hex'));
    });
  });
}

/**
 * 校验密码：重新按同一盐值哈希一遍，与存储的哈希值做常量时间比较。
 * @param {string} password 用户输入的原始密码
 * @param {string} salt 该账号存储的盐值
 * @param {string} expectedHash 该账号存储的哈希值
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, salt, expectedHash) {
  const actualHash = await hashPassword(password, salt);
  const a = Buffer.from(actualHash, 'hex');
  const b = Buffer.from(String(expectedHash || ''), 'hex');
  if (a.length !== b.length) {
    // 长度不同时仍参与一次真实比较，保持耗时特征一致，避免长度差异本身
    // 成为侧信道——与 cloudfunctions/emergencyClaimSuperAdmin/lib/secretGuard.js
    // secretsMatch() 同一处理原则
    crypto.timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

module.exports = { generateSalt, hashPassword, verifyPassword, SCRYPT_COST };
