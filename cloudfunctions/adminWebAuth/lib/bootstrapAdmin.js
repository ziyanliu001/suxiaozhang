// Web 管理中台首个账号自举（action: 'init_first_admin'）：入参校验与
// 确定性文档 ID 构造。纯逻辑，不做 db I/O，不依赖 wx-server-sdk。
//
// 🛡️ 设计背景：与 cloudfunctions/setupSuperAdmin 的 hasAnyPlatformAdmin()
// 自举豁免同一条思路——platform_web_admins 集合为空时（系统里还没有任何
// 一个 Web 管理员账号），允许免密直接创建第一个账号；一旦集合里已经存在
// 至少一条记录，这条自举豁免立刻永久失效（真正的"是否为空"判定与
// db.collection(...).limit(1).get() 这次 I/O 留在 index.js，本文件只负责
// 纯粹的输入校验与文档 ID 构造）。
'use strict';

const crypto = require('crypto');

const MIN_PASSWORD_LENGTH = 12;
const MAX_USERNAME_LENGTH = 50;

/**
 * @param {any} username
 * @param {any} password
 * @returns {{valid: true, username: string} | {valid: false, error: string}}
 */
function validateBootstrapInput(username, password) {
  const trimmedUsername = String(username || '').trim();
  if (!trimmedUsername) return { valid: false, error: '请提供用户名' };
  if (trimmedUsername.length > MAX_USERNAME_LENGTH) {
    return { valid: false, error: `用户名过长，请控制在 ${MAX_USERNAME_LENGTH} 字以内` };
  }
  const pwd = String(password || '');
  if (pwd.length < MIN_PASSWORD_LENGTH) {
    return { valid: false, error: `密码长度至少 ${MIN_PASSWORD_LENGTH} 位` };
  }
  return { valid: true, username: trimmedUsername };
}

/**
 * 由用户名派生确定性的 platform_web_admins 文档 _id——与本仓库
 * liveFactoryCore.buildSettlementDocId 同一套"确定性 _id + add() 主键
 * 唯一性天然防重复插入"手法：即使自举检查（集合是否为空）本身存在读写
 * 竞态窗口（两个近乎同时的自举请求都读到"集合为空"），数据库对 _id 的
 * 唯一性约束也只会让其中一次 add() 成功，另一次会失败——按"已被抢先注册"
 * 处理，不会对同一个用户名产生两条互相冲突的记录。
 * @param {string} username
 * @returns {string}
 */
function buildAdminDocId(username) {
  const hash = crypto.createHash('md5').update(String(username || '').toLowerCase()).digest('hex');
  return `web_admin_${hash}`;
}

module.exports = { MIN_PASSWORD_LENGTH, MAX_USERNAME_LENGTH, validateBootstrapInput, buildAdminDocId };
