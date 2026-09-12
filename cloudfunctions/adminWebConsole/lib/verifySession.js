// Web 管理中台会话有效性判定：与 cloudfunctions/adminWebAuth/lib/sessionToken.js
// 的 isSessionValid() 是同一份逻辑的独立镜像（本仓库云函数间无共享模块
// 机制的既定约束）。本函数只做"给定一条会话文档，判断当前是否仍然有效"
// 这一纯逻辑判断，真正查询 platform_web_sessions 集合的 db I/O 留在
// index.js（与 adminWebAuth 各自独立部署、各自负责自己的数据库访问）。
'use strict';

/**
 * @param {{username?: string, expiresAt?: string}|null} sessionDoc
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

module.exports = { isSessionValid };
