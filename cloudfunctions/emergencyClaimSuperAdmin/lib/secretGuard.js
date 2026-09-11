// 紧急逃生舱（Break-Glass）密钥校验与失败锁定：纯逻辑，不做 db I/O，
// 不依赖 wx-server-sdk，便于单测（与本仓库其它 lib/ 拆分同一个理由）。
//
// 🛡️ 设计背景：本云函数是"唯一超级管理员微信账号被封/丢失"这种单点失效
// 场景下的最后手段，必须能在调用者**零权限、甚至从未有过任何 user_roles
// 记录**的前提下被调用——不能像其余管理类云函数那样要求"先是 super_admin/
// platform_admin 才能调用"，那样一旦唯一的超管账号失效，谁都没有资格调用
// 本函数来恢复权限，彻底锁死后台。这决定了本函数的唯一防线就是
// EMERGENCY_RECOVERY_SECRET 这个云端环境变量密钥本身，因此这里的两道加固
// （常量时间比较 + 失败锁定）比本仓库其余内部调用令牌校验（如
// wxPayCore.requireInternalCaller 的 `event.internalToken === expected`）
// 要重得多——那些令牌只在云函数之间传递，不会被公网客户端直接尝试；本函数
// 的 secret 参数是小程序客户端直接可控的输入，存在被暴力枚举的现实风险。
'use strict';

const crypto = require('crypto');

// 连续失败达到这个次数后触发锁定，锁定期内即使密钥正确也直接拒绝——
// 逼真正的操作者去检查密钥配置是否有误，而不是无限重试
const MAX_FAILED_ATTEMPTS = 5;
// 锁定时长：30 分钟。足够劝退自动化枚举脚本，又不至于让真正的操作者
// （手滑打错几次密钥）被锁死太久无法自救
const LOCKOUT_DURATION_MS = 30 * 60 * 1000;

/**
 * 常量时间字符串比较，防止通过响应耗时差异侧信道逐字节猜出密钥。
 * 长度不同时也不能提前短路返回（否则长度差异本身就是一种侧信道），
 * 用较长的一方作为比较基准长度、先各自转成等长 Buffer 再比较。
 * @param {string} provided 调用方传入的密钥
 * @param {string} expected 环境变量里配置的真实密钥
 * @returns {boolean}
 */
function secretsMatch(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length) {
    // 长度不同时用一个同长度的零缓冲区参与一次真实比较，保持耗时特征
    // 一致，而不是直接 return false（那本身就是长度侧信道）
    crypto.timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * 判断当前调用者是否已因连续失败被锁定。
 * @param {{failCount?: number, lockedUntil?: string|null}|null} record 该
 *   openid 在 emergency_claim_attempts 集合里的既有记录，从未失败过时为 null
 * @param {number} now 当前时间戳（毫秒），显式传入保持纯粹可测
 * @returns {{allowed: true} | {allowed: false, error: string, lockedUntil: string}}
 */
function evaluateLockout(record, now) {
  if (record && record.lockedUntil) {
    const lockedUntilMs = new Date(record.lockedUntil).getTime();
    if (!Number.isNaN(lockedUntilMs) && lockedUntilMs > now) {
      const remainingMinutes = Math.ceil((lockedUntilMs - now) / 60000);
      return {
        allowed: false,
        error: `尝试次数过多，账号已被临时锁定，请约 ${remainingMinutes} 分钟后重试，或联系技术负责人核实密钥配置`,
        lockedUntil: record.lockedUntil
      };
    }
  }
  return { allowed: true };
}

/**
 * 计算本次尝试（成功/失败）之后应该写回 emergency_claim_attempts 的新记录。
 * 成功时清零失败计数、解除锁定；失败时累加计数，达到上限时设置新的
 * 锁定截止时间（从"本次失败时刻"重新计时，而不是从第一次失败算起）。
 * @param {{failCount?: number}|null} record
 * @param {boolean} success
 * @param {number} now
 * @returns {{failCount: number, lastAttemptAt: string, lockedUntil: string|null}}
 */
function computeNextAttemptRecord(record, success, now) {
  if (success) {
    return { failCount: 0, lastAttemptAt: new Date(now).toISOString(), lockedUntil: null };
  }
  const failCount = ((record && record.failCount) || 0) + 1;
  const lockedUntil = failCount >= MAX_FAILED_ATTEMPTS
    ? new Date(now + LOCKOUT_DURATION_MS).toISOString()
    : ((record && record.lockedUntil) || null);
  return { failCount, lastAttemptAt: new Date(now).toISOString(), lockedUntil };
}

/**
 * 由 openid 生成确定性的尝试记录文档 ID——每个 openid 恒定一条记录，
 * 天然幂等（用 set() 覆写，不产生重复文档）。
 * @param {string} openid
 * @returns {string}
 */
function buildAttemptDocId(openid) {
  // openid 本身允许出现在 _id 里，但保险起见做一次 md5，避免个别历史
  // openid 格式里混入云数据库 _id 不允许的字符
  const hash = crypto.createHash('md5').update(String(openid || '')).digest('hex');
  return `emergency_claim_attempt_${hash}`;
}

module.exports = {
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_DURATION_MS,
  secretsMatch,
  evaluateLockout,
  computeNextAttemptRecord,
  buildAttemptDocId
};
