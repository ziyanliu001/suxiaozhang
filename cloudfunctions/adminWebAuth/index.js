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
// - init_first_admin：{username, password} → 仅当 platform_web_admins 集合
//   为空时可用，免密直接创建第一个账号（见下方 handleInitFirstAdmin 头部
//   注释）。
//
// 🔧 部署要求：首个 Web 管理员账密有两条创建路径——① 本地执行
// scripts/ops/init-web-admin.js（需要配置 CLOUDBASE_ENV_ID/
// TENCENTCLOUD_SECRETID/SECRETKEY 直连数据库）；② 在微信开发者工具的云函数
// 云端测试面板直接调用本函数的 init_first_admin 动作（不需要本地配置任何
// 腾讯云 API 密钥，门槛更低，适合快速自举/本地开发联调场景）。两条路径
// 产生的账号记录完全等价，选哪条纯粹是"是否方便配置 API 密钥"的权衡。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const { generateSalt, hashPassword, verifyPassword } = require('./lib/passwordHash');
const { evaluateLockout, computeNextAttemptRecord, buildLoginAttemptDocId } = require('./lib/loginLockout');
const { generateSessionToken, buildSessionDoc, isSessionValid } = require('./lib/sessionToken');
const { validateBootstrapInput, buildAdminDocId } = require('./lib/bootstrapAdmin');
const { normalizeGatewayEvent } = require('./lib/normalizeGatewayEvent');

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

// 🛡️（2026-09-13）唯一一次不需要"已经有账号登录"就能创建账号的入口，
// 与 cloudfunctions/setupSuperAdmin 的 hasAnyPlatformAdmin() 自举豁免同一条
// 思路：只在 platform_web_admins 集合**当前完全为空**时放行——这是全局
// 状态判定，不是按 username 判定"这个用户名之前存在过没有"，一旦系统里
// 已经存在任意一条管理员记录（哪怕只有一条、哪怕是别的用户名），这条自举
// 豁免立刻永久失效，往后只能走 login 或 scripts/ops/init-web-admin.js 重置，
// 不会退化成一个可以随时反复调用的"创建管理员"后门。
async function handleInitFirstAdmin(event) {
  const check = validateBootstrapInput(event.username, event.password);
  if (!check.valid) return { success: false, error: check.error };
  const username = check.username;
  const password = String(event.password || '');

  const existingAnyRes = await db.collection(ADMINS_COLLECTION).limit(1).get().catch((err) => {
    if (!isCollectionNotExistError(err)) throw err;
    return { data: [] };
  });
  if (existingAnyRes.data && existingAnyRes.data.length > 0) {
    console.error('[adminWebAuth] 🚨 init_first_admin 被拒绝：系统中已存在管理员账号，自举豁免已失效');
    return {
      success: false,
      error: '系统中已存在管理员账号，禁止通过该入口创建。如需新增/重置账号，请联系已有管理员登录后台处理，或使用 scripts/ops/init-web-admin.js 直连数据库重置'
    };
  }

  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);
  const docId = buildAdminDocId(username);
  const doc = { _id: docId, username, passwordHash, passwordSalt: salt, disabled: false, createdAt: db.serverDate(), lastLoginAt: null };

  try {
    await db.collection(ADMINS_COLLECTION).add({ data: doc });
  } catch (err) {
    if (isCollectionNotExistError(err)) {
      await ensureCollection(ADMINS_COLLECTION);
      await db.collection(ADMINS_COLLECTION).add({ data: doc });
    } else {
      // 🛡️ 确定性 _id 撞主键唯一性约束：极小概率的并发竞态（两个近乎同时
      // 的自举请求都读到"集合为空"），回查一次确定性 ID 确认是否是被
      // 另一次调用抢先创建，按幂等处理，不再重复报错
      const raceRes = await db.collection(ADMINS_COLLECTION).doc(docId).get().catch(() => null);
      if (raceRes && raceRes.data) {
        return { success: false, error: '该用户名已被抢先注册（检测到并发的另一次自举请求），请重新确认账号状态' };
      }
      throw err;
    }
  }

  await writeAuditLog({ action: 'ADMIN_WEB_INIT_FIRST_ADMIN', operator_id: username, success: true });
  console.error('[adminWebAuth] 🚨 已通过 init_first_admin 创建首个 Web 管理员账号:', username, '—— 请立即核实这是否为授权操作');

  return { success: true, message: '已创建首个 Web 管理员账号，请立即登录测试' };
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

exports.main = async (rawEvent) => {
  const event = normalizeGatewayEvent(rawEvent);
  try {
    switch (event.action) {
      case 'login':
        return await handleLogin(event);
      case 'init_first_admin':
        return await handleInitFirstAdmin(event);
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
