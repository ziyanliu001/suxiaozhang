// 云函数：adminWebAuth —— 独立于微信生态的 Web 管理中台认证服务（第四道
// 应急防线的一部分，见 CLAUDE.md 第 11 节"Web 管理中台"）。
//
// 🛡️ 定位：`web-admin/` 静态网页通过用户名 + 密码登录，与整个小程序/微信
// 生态完全解耦——不依赖 cloud.getWXContext() 的 OPENID（浏览器发起的
// cloud.callFunction() 调用本来就不会携带任何微信身份），只认这里签发的
// 会话令牌。即使唯一的超级管理员微信账号被封禁，只要这里的账密还在，
// 运营方依然能通过普通浏览器登录管理中台，是与 emergencyClaimSuperAdmin
// （第二道防线，微信内密钥自助接管）、scripts/ops/grant-super-admin.js
// （第三道防线，本地 CLI 直连数据库）互补、完全独立的第四道防线——三者
// 中任意一个仍然可用，运营方就不会被彻底锁死。
//
// action:
// - login：{username, password} → 校验通过后签发 8 小时有效期的会话令牌
// - logout：{token} → 立即失效该令牌
//
// 🔧 部署要求：首个 Web 管理员账密不通过本函数创建（登录前提是"已经有一个
// 账号"，鸡生蛋问题）——用 scripts/ops/init-web-admin.js 直连数据库写入。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const { verifyPassword } = require('./lib/passwordHash');
const { evaluateLockout, computeNextAttemptRecord, buildLoginAttemptDocId } = require('./lib/loginLockout');
const { generateSessionToken, buildSessionDoc, isSessionValid } = require('./lib/sessionToken');

const ADMINS_COLLECTION = 'platform_web_admins';
const SESSIONS_COLLECTION = 'platform_web_sessions';
const ATTEMPTS_COLLECTION = 'platform_web_login_attempts';
const AUDIT_COLLECTION = 'audit_logs';

function isCollectionNotExistError(err) {
  return !!err && (
    err.errCode === -502005 ||
    /database collection not exists/i.test(String(err.errMsg || err.message || ''))
  );
}

async function ensureCollection(name) {
  await db.createCollection(name).catch(() => {});
}

async function writeAuditLog(entry) {
  const doc = { ...entry, operate_time: db.serverDate() };
  try {
    await db.collection(AUDIT_COLLECTION).add({ data: doc });
  } catch (err) {
    if (!isCollectionNotExistError(err)) {
      console.error('[adminWebAuth] 🚨 审计日志写入失败（需人工核对）:', err);
      return;
    }
    await ensureCollection(AUDIT_COLLECTION);
    await db.collection(AUDIT_COLLECTION).add({ data: doc }).catch(() => {});
  }
}

async function handleLogin(event) {
  const username = String(event.username || '').trim();
  const password = String(event.password || '');
  if (!username || !password) {
    return { success: false, error: '请输入用户名和密码' };
  }

  const now = Date.now();
  const attemptDocId = buildLoginAttemptDocId(username);
  const attemptRes = await db.collection(ATTEMPTS_COLLECTION).doc(attemptDocId).get().catch(() => null);
  const attemptRecord = attemptRes && attemptRes.data;

  const lockCheck = evaluateLockout(attemptRecord, now);
  if (!lockCheck.allowed) {
    console.error('[adminWebAuth] 🚨 账号已被锁定，拒绝本次登录:', username, lockCheck.error);
    return { success: false, error: lockCheck.error };
  }

  async function recordAttempt(success) {
    const nextRecord = computeNextAttemptRecord(attemptRecord, success, now);
    try {
      await db.collection(ATTEMPTS_COLLECTION).doc(attemptDocId).set({ data: nextRecord });
    } catch (err) {
      if (!isCollectionNotExistError(err)) {
        console.error('[adminWebAuth] 登录尝试记录写入失败:', err);
        return;
      }
      await ensureCollection(ATTEMPTS_COLLECTION);
      await db.collection(ATTEMPTS_COLLECTION).doc(attemptDocId).set({ data: nextRecord }).catch(() => {});
    }
  }

  const adminRes = await db.collection(ADMINS_COLLECTION).where({ username }).limit(1).get().catch((err) => {
    if (!isCollectionNotExistError(err)) throw err;
    return { data: [] };
  });
  const admin = (adminRes.data && adminRes.data[0]) || null;

  // 🛡️ 账号不存在与密码错误返回同一句提示、走同一套失败记录逻辑——不向
  // 调用方泄露"用户名是否存在"这个信息，也不因为账号不存在就跳过密码哈希
  // 计算（跳过会让"账号不存在"这条路径的响应耗时明显短于"账号存在但密码
  // 错误"，反而暴露了账号是否存在的侧信道）
  const passwordOk = admin && !admin.disabled
    ? await verifyPassword(password, admin.passwordSalt, admin.passwordHash)
    : await verifyPassword(password, 'placeholder-salt-for-timing-consistency', '');

  if (!admin || admin.disabled || !passwordOk) {
    await recordAttempt(false);
    await writeAuditLog({
      action: 'ADMIN_WEB_LOGIN',
      operator_id: username,
      success: false,
      fail_reason: !admin ? '账号不存在' : (admin.disabled ? '账号已禁用' : '密码错误')
    });
    console.error('[adminWebAuth] 🚨 登录失败:', username);
    return { success: false, error: '用户名或密码不正确' };
  }

  const token = generateSessionToken();
  const sessionDoc = buildSessionDoc(token, username, now);
  try {
    await db.collection(SESSIONS_COLLECTION).add({ data: sessionDoc });
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    await ensureCollection(SESSIONS_COLLECTION);
    await db.collection(SESSIONS_COLLECTION).add({ data: sessionDoc });
  }

  await recordAttempt(true);
  await db.collection(ADMINS_COLLECTION).doc(admin._id).update({ data: { lastLoginAt: db.serverDate() } }).catch(() => {});
  await writeAuditLog({ action: 'ADMIN_WEB_LOGIN', operator_id: username, success: true });

  return { success: true, token, expiresAt: sessionDoc.expiresAt };
}

async function handleLogout(event) {
  const token = String(event.token || '');
  if (!token) return { success: true };
  await db.collection(SESSIONS_COLLECTION).doc(token).remove().catch(() => {});
  return { success: true };
}

// 供本函数与 adminWebConsole 共用的会话校验语义参考——adminWebConsole 是
// 独立部署的云函数，无法 require 本文件（本仓库云函数间无共享模块机制），
// 已在其自己的 lib/ 目录下维护同一份 isSessionValid 判定逻辑的独立拷贝
async function handleVerifySession(event) {
  const token = String(event.token || '');
  if (!token) return { success: false, error: '缺少会话令牌' };
  const sessionRes = await db.collection(SESSIONS_COLLECTION).doc(token).get().catch(() => null);
  const result = isSessionValid(sessionRes && sessionRes.data, Date.now());
  if (!result.valid) return { success: false, error: result.error };
  return { success: true, username: result.username };
}

exports.main = async (event) => {
  try {
    switch (event.action) {
      case 'login':
        return await handleLogin(event);
      case 'logout':
        return await handleLogout(event);
      case 'verifySession':
        return await handleVerifySession(event);
      default:
        return { success: false, error: '未知操作' };
    }
  } catch (err) {
    console.error('[adminWebAuth] 未捕获异常:', event.action, err);
    return { success: false, error: err.message || '服务异常，请重试' };
  }
};
