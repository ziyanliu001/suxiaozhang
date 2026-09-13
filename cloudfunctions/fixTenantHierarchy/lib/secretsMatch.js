// 常量时间字符串比较：纯逻辑，不做 db I/O、不依赖 wx-server-sdk，便于单测。
// 与 cloudfunctions/emergencyClaimSuperAdmin/lib/secretGuard.js 的同名函数是
// 独立维护的镜像（云函数间无共享模块机制，见 CLAUDE.md）——那里连同失败锁定
// 一起用于"零权限、任何人都能调用"的应急接管通道；这里只搬 secretsMatch 本身：
// 本函数（fixTenantHierarchy）的密钥校验只在 OPENID 为空（云开发控制台"云端
// 测试"场景）时才会被触发，不会被公网小程序客户端直接摸到，暴力枚举的现实
// 风险比 emergencyClaimSuperAdmin 低得多，因此不需要再叠加一套失败锁定机制，
// 但常量时间比较这一条基本卫生仍然要做——避免响应耗时差异成为一个可利用的
// 侧信道。
'use strict';

const crypto = require('crypto');

/**
 * 常量时间字符串比较，防止通过响应耗时差异侧信道逐字节猜出密钥。
 * 长度不同时也不能提前短路返回（否则长度差异本身就是一种侧信道），用一个
 * 与调用方输入等长的零缓冲区参与一次真实比较，保持耗时特征一致。
 * @param {string} provided 调用方传入的密钥
 * @param {string} expected 环境变量里配置的真实密钥
 * @returns {boolean}
 */
function secretsMatch(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

module.exports = { secretsMatch };
