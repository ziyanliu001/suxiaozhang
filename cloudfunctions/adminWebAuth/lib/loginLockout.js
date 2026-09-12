// Web 管理中台登录失败锁定：与 cloudfunctions/emergencyClaimSuperAdmin/lib/
// secretGuard.js 的 evaluateLockout/computeNextAttemptRecord 是同一份逻辑的
// 独立拷贝（本仓库云函数间无共享模块机制的既定约束），锁定维度从 openid
// 换成 username——Web 管理中台没有微信身份，只有登录用户名。
'use strict';

const crypto = require('crypto');

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000;

/**
 * @param {{failCount?: number, lockedUntil?: string|null}|null} record
 * @param {number} now
 * @returns {{allowed: true} | {allowed: false, error: string, lockedUntil: string}}
 */
function evaluateLockout(record, now) {
  if (record && record.lockedUntil) {
    const lockedUntilMs = new Date(record.lockedUntil).getTime();
    if (!Number.isNaN(lockedUntilMs) && lockedUntilMs > now) {
      const remainingMinutes = Math.ceil((lockedUntilMs - now) / 60000);
      return {
        allowed: false,
        error: `登录失败次数过多，账号已被临时锁定，请约 ${remainingMinutes} 分钟后重试`,
        lockedUntil: record.lockedUntil
      };
    }
  }
  return { allowed: true };
}

/**
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
 * 由用户名生成确定性的尝试记录文档 ID。
 * @param {string} username
 * @returns {string}
 */
function buildLoginAttemptDocId(username) {
  const hash = crypto.createHash('md5').update(String(username || '').toLowerCase()).digest('hex');
  return `admin_web_login_attempt_${hash}`;
}

module.exports = {
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_DURATION_MS,
  evaluateLockout,
  computeNextAttemptRecord,
  buildLoginAttemptDocId
};
