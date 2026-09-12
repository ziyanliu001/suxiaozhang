// 云函数：adminWebConsole —— 独立于微信生态的 Web 管理中台业务动作（第四道
// 应急防线，见 CLAUDE.md 第 11 节）。与 cloudfunctions/adminWebAuth（登录/
// 会话）分开部署——认证与业务动作职责分离，与本仓库 wxPayCore/liveFactoryCore
// 这类"基础设施层"和 createSubscriptionOrder/createProductionOrder 这类
// "业务编排层"分离的既有惯例一致。
//
// 🛡️ 每个 action 第一步都是校验 event.sessionToken（查 platform_web_sessions
// 集合），本函数与 adminWebAuth 各自独立部署，无法互相 require 对方的 lib/
// （本仓库云函数间无共享模块机制），已在自己的 lib/verifySession.js 维护
// 同一份判定逻辑的独立镜像。
//
// action:
// - generateActivationCode：铸造 SaaS 授权码。本函数自己不实现铸造逻辑，
//   而是携带 ADMIN_CONSOLE_INTERNAL_TOKEN 转发给 activateTenantSubscription
//   的 generate 动作（与 wxPayCore/liveFactoryCore 同一套"内部调用令牌"
//   fail-closed 模式）——避免重新实现一遍已经在生产环境验证过的铸造逻辑，
//   也避免两处代码后续各自演化出不一致的字段口径。
// - grantEmergencySuperAdmin：应急超管换绑，与 emergencyClaimSuperAdmin
//   共用同一套 user_roles/audit_logs 字段口径（各自独立维护一份镜像，见
//   lib/validateClaim.js 头部注释），区别是本函数接受调用方显式指定的
//   targetOpenid（Web 管理中台没有微信身份上下文，不能像 emergencyClaimSuperAdmin
//   那样"给当前调用者自己"授权，只能是"运营方在网页上为某个已知的 openid
//   授权"）。
// - getSystemOverview：全网门店与快照生成概览，只读，风险最低。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { isSessionValid } = require('./lib/verifySession');
const { validateRealName, validatePhone, buildUserRoleDoc, buildAuditLogEntry } = require('./lib/validateClaim');
const { buildSystemOverview } = require('./lib/buildSystemOverview');
const { normalizeGatewayEvent } = require('./lib/normalizeGatewayEvent');

const SESSIONS_COLLECTION = 'platform_web_sessions';
const AUDIT_COLLECTION = 'audit_logs';

function isCollectionNotExistError(err) {
  return !!err && (
    err.errCode === -502005 ||
    /database collection not exists/i.test(String(err.errMsg || err.message || ''))
  );
}

async function requireValidSession(event) {
  const token = String(event.sessionToken || '');
  if (!token) return { valid: false, error: '缺少会话令牌，请重新登录' };
  const sessionRes = await db.collection(SESSIONS_COLLECTION).doc(token).get().catch(() => null);
  return isSessionValid(sessionRes && sessionRes.data, Date.now());
}

async function writeAuditLog(entry) {
  const doc = { ...entry, operate_time: db.serverDate() };
  try {
    await db.collection(AUDIT_COLLECTION).add({ data: doc });
  } catch (err) {
    if (!isCollectionNotExistError(err)) {
      console.error('[adminWebConsole] 🚨 审计日志写入失败（需人工核对）:', err);
      return;
    }
    await db.createCollection(AUDIT_COLLECTION).catch(() => {});
    await db.collection(AUDIT_COLLECTION).add({ data: doc }).catch(() => {});
  }
}

// ── action: generateActivationCode ─────────────────────────────────────────
async function handleGenerateActivationCode(event, session) {
  const internalToken = process.env.ADMIN_CONSOLE_INTERNAL_TOKEN || '';
  if (!internalToken) {
    console.error('[adminWebConsole] 🚨 ADMIN_CONSOLE_INTERNAL_TOKEN 未配置，拒绝铸造授权码（fail-closed）');
    return { success: false, error: '铸造通道未启用，请联系技术负责人在云开发控制台配置 ADMIN_CONSOLE_INTERNAL_TOKEN' };
  }

  const res = await cloud.callFunction({
    name: 'activateTenantSubscription',
    data: {
      action: 'generate',
      internalToken,
      codeType: event.codeType,
      quantity: event.quantity,
      planType: event.planType,
      durationDays: event.durationDays,
      extraStores: event.extraStores,
      targetStoreId: event.targetStoreId,
      note: event.note
    }
  }).catch((err) => ({ result: { success: false, error: String(err.errMsg || err.message || '铸造服务异常') } }));

  const result = res.result || {};
  await writeAuditLog({
    action: 'ADMIN_WEB_GENERATE_ACTIVATION_CODE',
    operator_id: session.username,
    success: !!result.success,
    fail_reason: result.success ? undefined : String(result.error || '未知原因').slice(0, 200),
    generated_count: result.success ? (result.codes || []).length : 0
  });

  return result;
}

// ── action: grantEmergencySuperAdmin ────────────────────────────────────────
async function resolveTenantId(requestedTenantId) {
  if (requestedTenantId) {
    const byIdRes = await db.collection('tenants').doc(requestedTenantId).get().catch(() => null);
    if (byIdRes && byIdRes.data) return { resolved: true, tenantId: requestedTenantId };
    const byFieldRes = await db.collection('tenants').where({ tenantId: requestedTenantId }).limit(1).get().catch(() => ({ data: [] }));
    if (byFieldRes.data && byFieldRes.data.length > 0) return { resolved: true, tenantId: requestedTenantId };
    return { resolved: false, error: '指定的 tenantId 不存在，请核实后重试' };
  }
  const allRes = await db.collection('tenants').limit(2).get().catch(() => ({ data: [] }));
  const tenants = allRes.data || [];
  if (tenants.length === 1) return { resolved: true, tenantId: tenants[0].tenantId || tenants[0]._id };
  if (tenants.length === 0) return { resolved: true, tenantId: '' };
  return { resolved: false, error: '系统中存在多家机构，请显式指定要接管的 tenantId（不猜测，避免关联到错误机构）' };
}

async function handleGrantEmergencySuperAdmin(event, session) {
  const targetOpenid = String(event.targetOpenid || '').trim();
  if (!targetOpenid) {
    return { success: false, error: '请提供要授权的目标微信 openid（可让对方先打开一次小程序，从后台 users/user_roles 集合里查到）' };
  }

  const nameCheck = validateRealName(event.realName);
  if (!nameCheck.valid) return { success: false, error: nameCheck.error };
  const phoneCheck = validatePhone(event.phone);
  if (!phoneCheck.valid) return { success: false, error: phoneCheck.error };

  const tenantResolution = await resolveTenantId(event.tenantId ? String(event.tenantId).trim() : '');
  if (!tenantResolution.resolved) {
    return { success: false, error: tenantResolution.error };
  }

  const existingRes = await db.collection('user_roles').where({ _openid: targetOpenid }).limit(1).get().catch(() => ({ data: [] }));
  const existingDoc = (existingRes.data && existingRes.data[0]) || null;

  const { isUpdate, docId, patch } = buildUserRoleDoc({
    openid: targetOpenid,
    realName: nameCheck.value,
    phone: phoneCheck.value,
    tenantId: tenantResolution.tenantId,
    existingDoc
  });

  if (isUpdate) {
    await db.collection('user_roles').doc(docId).update({ data: { ...patch, emergencyClaimedAt: db.serverDate() } });
  } else {
    await db.collection('user_roles').add({
      data: { ...patch, emergencyClaimedAt: db.serverDate(), applyTime: db.serverDate(), approveTime: db.serverDate() }
    });
  }

  await writeAuditLog(buildAuditLogEntry({
    openid: session.username, // Web 管理中台没有目标账号以外的微信身份，operator_id 记运营方登录用户名
    success: true,
    realName: nameCheck.value,
    phone: phoneCheck.value,
    tenantId: tenantResolution.tenantId,
    isUpdate,
    channel: 'web_console'
  }));

  console.error(
    '[adminWebConsole] 🚨🚨🚨 Web 管理中台已执行应急超管换绑——operator:', session.username,
    'targetOpenid:', targetOpenid, 'realName:', nameCheck.value, 'tenantId:', tenantResolution.tenantId,
    '—— 请立即核实这是否为授权操作'
  );

  return {
    success: true,
    message: '已成功为目标账号授予超级管理员权限',
    action: isUpdate ? 'updated' : 'created',
    tenantId: tenantResolution.tenantId
  };
}

// ── action: getSystemOverview ───────────────────────────────────────────────
function computeYesterdayDateString() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function handleGetSystemOverview() {
  const [storesRes, tenantsRes] = await Promise.all([
    db.collection('stores').where({ status: _.neq('inactive') }).count().catch(() => ({ total: 0 })),
    db.collection('tenants').count().catch(() => ({ total: 0 }))
  ]);

  const yesterday = computeYesterdayDateString();
  const snapshotRes = await db.collection('daily_tenant_snapshots')
    .where({ dateString: yesterday })
    .count()
    .catch((err) => {
      if (!isCollectionNotExistError(err)) console.warn('[adminWebConsole] 查询昨日快照数量失败:', err);
      return { total: 0 };
    });

  return {
    success: true,
    data: buildSystemOverview({
      totalActiveStores: storesRes.total || 0,
      totalTenants: tenantsRes.total || 0,
      snapshotsGeneratedYesterday: snapshotRes.total || 0,
      snapshotDateChecked: yesterday
    })
  };
}

exports.main = async (rawEvent) => {
  const event = normalizeGatewayEvent(rawEvent);
  try {
    const session = await requireValidSession(event);
    if (!session.valid) {
      return { success: false, error: session.error };
    }

    switch (event.action) {
      case 'generateActivationCode':
        return await handleGenerateActivationCode(event, session);
      case 'grantEmergencySuperAdmin':
        return await handleGrantEmergencySuperAdmin(event, session);
      case 'getSystemOverview':
        return await handleGetSystemOverview();
      default:
        return { success: false, error: '未知操作' };
    }
  } catch (err) {
    console.error('[adminWebConsole] 未捕获异常:', event.action, err);
    return { success: false, error: err.message || '服务异常，请重试' };
  }
};
