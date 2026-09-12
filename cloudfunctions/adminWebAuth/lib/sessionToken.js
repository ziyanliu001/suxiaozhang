// Web 管理中台会话令牌：生成与有效性判定。纯逻辑（除 crypto 内置模块外
// 不依赖任何第三方包/wx-server-sdk）。
'use strict';

const crypto = require('crypto');

// 会话有效期：8 小时——覆盖一个正常工作时段的操作窗口，又不会长到"一次
// 登录、令牌永久有效"这种更高风险的敞口
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

/**
 * 生成一个不可预测的随机会话令牌（32 字节，十六进制）。
 * @returns {string}
 */
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 构造写入 platform_web_sessions 的会话文档——用令牌本身作为 _id，天然
 * 支持 O(1) 按令牌查找，不需要额外索引。
 * @param {string} token
 * @param {string} username
 * @param {number} now
 * @returns {{_id: string, username: string, createdAtMs: number, expiresAt: string}}
 */
function buildSessionDoc(token, username, now) {
  return {
    _id: token,
    username,
    createdAtMs: now,
    expiresAt: new Date(now + SESSION_DURATION_MS).toISOString()
  };
}

/**
 * 判定一条会话记录当前是否仍然有效（存在且未过期）。
 * @param {{expiresAt?: string}|null} sessionDoc
 * @param {number} now
 * @returns {{valid: true, username: string} | {valid: false, error: string}}
 */
function isSessionValid(sessionDoc, now) {
  if (!sessionDoc) return { valid: false, error: '未登录或会话已失效，请重新登录' };
  const expiresAtMs = new Date(sessionDoc.expiresAt).getTime();
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= now) {
    return { valid: false, error: '登录已过期，请重新登录' };
  }
  return { valid: true, username: sessionDoc.username };
}

module.exports = { SESSION_DURATION_MS, generateSessionToken, buildSessionDoc, isSessionValid };
