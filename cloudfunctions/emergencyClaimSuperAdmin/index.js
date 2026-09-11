// 云函数：emergencyClaimSuperAdmin —— 紧急逃生舱（Break-Glass）应急接管
//
// 🛡️ 定位：唯一超级管理员微信账号被封禁/丢失/失联时的最后手段。与本仓库
// 其余管理类云函数（setupSuperAdmin/processRoleAudit 等）根本不同的一点：
// 那些函数都要求"调用者已经是 super_admin/platform_admin"才能继续操作，
// 一旦唯一的超管账号失效，没有任何账号有资格调用它们来恢复权限，后台会
// 永久锁死。本函数因此故意不做任何"调用者当前角色"层面的前置校验，
// 唯一的防线是 EMERGENCY_RECOVERY_SECRET 这个只存在于云开发控制台环境
// 变量里的密钥——必须持有物理访问云开发控制台权限的人（通常就是账号本人
// 或其信任的技术负责人）才能配置/得知这个值，这是安全模型的信任根。
//
// 🔧 部署要求（务必在云开发控制台配置，缺失时本函数拒绝所有调用）：
//   - 环境变量 EMERGENCY_RECOVERY_SECRET：建议使用高强度随机字符串（≥32位，
//     含大小写字母/数字/符号），只告知极少数受信任的人，且与其它任何令牌
//     （WXPAY_INTERNAL_TOKEN 等）不复用。
//   - 上线后建议立即在云开发控制台"访问历史"里确认本函数从未被非预期调用，
//     并考虑上线一段时间验证无误后，把本函数的调用日志接入告警（如短信/
//     邮件通知机构负责人）——本次实现里 console.error 已经用 🚨 标记打了
//     最高优先级日志，云开发控制台的日志告警规则可以直接订阅这个关键字。
//
// 🛡️ 安全加固清单：
//   1. fail-closed：EMERGENCY_RECOVERY_SECRET 未配置时拒绝一切调用。
//   2. 密钥比对使用常量时间比较（lib/secretGuard.js secretsMatch），防止
//      通过响应耗时差异侧信道逐字节猜出密钥。
//   3. 失败锁定：同一 openid 连续失败达到上限后临时锁定一段时间，遏制
//      自动化枚举（见 lib/secretGuard.js 头部注释）。
//   4. 高危审计日志：无论成功/失败都写入 audit_logs（action:
//      'EMERGENCY_SUPER_ADMIN_CLAIM'），成功时额外记录接管人姓名/手机号/
//      归属机构，供事后人工核实这是否为授权操作；绝不记录密钥明文本身
//      （无论对错）。这条日志只由本函数写入，本仓库其余任何云函数都不会
//      更新/删除 audit_logs 里的记录，天然只增不改。
//   5. 多 super_admin 并行：写入的 user_roles 文档与 setupSuperAdmin/
//      processRoleAudit 生成的记录同一套 role='super_admin' 字段口径——
//      本仓库全局的 super_admin 判定永远是"按 openid 查 user_roles 单文档
//      的 role 字段"，不存在任何硬编码单 openid 白名单，本次接管产生的新
//      super_admin 记录与已有的（如果还能正常使用）super_admin 账号完全
//      并行生效，互不冲突、互不覆盖。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const {
  secretsMatch,
  evaluateLockout,
  computeNextAttemptRecord,
  buildAttemptDocId
} = require('./lib/secretGuard');
const { validateRealName, validatePhone, buildUserRoleDoc, buildAuditLogEntry } = require('./lib/validateClaim');

const ATTEMPTS_COLLECTION = 'emergency_claim_attempts';
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
      // 🚨 高危审计日志写入失败本身就是需要立刻被人工看到的异常——不吞掉，
      // 但也不能因为日志写失败就让整个接管流程回滚（这次调用如果密钥正确、
      // 数据合法，权限本身该给的还是要给，日志失败是可以后续人工补查的
      // 次要问题，不应该反过来卡死主流程）
      console.error('[emergencyClaimSuperAdmin] 🚨 审计日志写入失败（需人工核对是否有遗漏）:', err);
      return;
    }
    await ensureCollection(AUDIT_COLLECTION);
    await db.collection(AUDIT_COLLECTION).add({ data: doc }).catch((err2) => {
      console.error('[emergencyClaimSuperAdmin] 🚨 审计日志二次写入仍失败:', err2);
    });
  }
}

// 归属机构解析：显式传入 tenantId 时校验其存在（tenants 集合历史上存在
// `_id`/`tenantId` 业务字段两条创建路径，参见 docs/SCHEMA.md，这里两段式
// 查询兼容两种情况）；未传入时，仅当系统里恰好只有一家机构时才自动关联，
// 避免在多租户环境下把新超管错误地关联到一个无关机构——那本身就是一次
// 需要人工介入澄清的越权风险，宁可拒绝也不能瞎猜
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
  if (tenants.length === 1) {
    const only = tenants[0];
    return { resolved: true, tenantId: only.tenantId || only._id };
  }
  if (tenants.length === 0) {
    // 全新环境，尚无任何机构——允许先以空 tenantId 接管，后续通过正常的
    // 建店/建机构流程补全，不阻塞应急接管本身
    return { resolved: true, tenantId: '' };
  }
  return { resolved: false, error: '系统中存在多家机构，请显式指定要接管的 tenantId（不猜测，避免关联到错误机构）' };
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  const EXPECTED_SECRET = process.env.EMERGENCY_RECOVERY_SECRET || '';
  if (!EXPECTED_SECRET) {
    console.error('[emergencyClaimSuperAdmin] 🚨 EMERGENCY_RECOVERY_SECRET 未配置，本云函数拒绝所有调用（fail-closed）。请立即在云开发控制台为本云函数配置该环境变量。');
    return { success: false, error: '应急接管通道未启用，请联系技术负责人在云开发控制台配置 EMERGENCY_RECOVERY_SECRET' };
  }

  const now = Date.now();
  const attemptDocId = buildAttemptDocId(OPENID);
  const attemptRes = await db.collection(ATTEMPTS_COLLECTION).doc(attemptDocId).get().catch((err) => {
    if (!isCollectionNotExistError(err)) console.warn('[emergencyClaimSuperAdmin] 读取尝试记录失败（按无记录处理）:', err);
    return null;
  });
  const attemptRecord = attemptRes && attemptRes.data;

  const lockCheck = evaluateLockout(attemptRecord, now);
  if (!lockCheck.allowed) {
    console.error('[emergencyClaimSuperAdmin] 🚨 调用者已被锁定，拒绝本次请求:', OPENID, lockCheck.error);
    return { success: false, error: lockCheck.error };
  }

  async function recordAttempt(success) {
    const nextRecord = computeNextAttemptRecord(attemptRecord, success, now);
    try {
      await db.collection(ATTEMPTS_COLLECTION).doc(attemptDocId).set({ data: nextRecord });
    } catch (err) {
      if (!isCollectionNotExistError(err)) {
        console.error('[emergencyClaimSuperAdmin] 尝试记录写入失败（不影响本次结果判定，但锁定计数可能不准确）:', err);
        return;
      }
      await ensureCollection(ATTEMPTS_COLLECTION);
      await db.collection(ATTEMPTS_COLLECTION).doc(attemptDocId).set({ data: nextRecord }).catch(() => {});
    }
  }

  const providedSecret = String(event.secret || '');
  const matched = secretsMatch(providedSecret, EXPECTED_SECRET);
  if (!matched) {
    await recordAttempt(false);
    await writeAuditLog(buildAuditLogEntry({ openid: OPENID, success: false, failReason: '密钥不匹配' }));
    console.error('[emergencyClaimSuperAdmin] 🚨 密钥校验失败，调用者 openid:', OPENID);
    return { success: false, error: '密钥不正确' };
  }

  const nameCheck = validateRealName(event.realName);
  if (!nameCheck.valid) return { success: false, error: nameCheck.error };
  const phoneCheck = validatePhone(event.phone);
  if (!phoneCheck.valid) return { success: false, error: phoneCheck.error };

  const tenantResolution = await resolveTenantId(event.tenantId ? String(event.tenantId).trim() : '');
  if (!tenantResolution.resolved) {
    return { success: false, error: tenantResolution.error };
  }

  const existingRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get().catch(() => ({ data: [] }));
  const existingDoc = (existingRes.data && existingRes.data[0]) || null;

  const { isUpdate, docId, patch } = buildUserRoleDoc({
    openid: OPENID,
    realName: nameCheck.value,
    phone: phoneCheck.value,
    tenantId: tenantResolution.tenantId,
    existingDoc
  });

  // 🛡️ 单文档写入天然具备数据库原生原子性，不需要跨文档事务——本次操作
  // 只涉及 user_roles 这一个目标文档的整体覆盖式更新/插入
  if (isUpdate) {
    await db.collection('user_roles').doc(docId).update({
      data: { ...patch, emergencyClaimedAt: db.serverDate() }
    });
  } else {
    await db.collection('user_roles').add({
      data: { ...patch, emergencyClaimedAt: db.serverDate(), applyTime: db.serverDate(), approveTime: db.serverDate() }
    });
  }

  await recordAttempt(true);
  await writeAuditLog(buildAuditLogEntry({
    openid: OPENID,
    success: true,
    realName: nameCheck.value,
    phone: phoneCheck.value,
    tenantId: tenantResolution.tenantId,
    isUpdate
  }));

  console.error(
    '[emergencyClaimSuperAdmin] 🚨🚨🚨 应急接管已执行——openid:', OPENID,
    'realName:', nameCheck.value, 'phone:', phoneCheck.value, 'tenantId:', tenantResolution.tenantId,
    '—— 请立即核实这是否为授权操作，如非本人操作请立刻在云开发控制台轮换 EMERGENCY_RECOVERY_SECRET 并核查 user_roles/audit_logs'
  );

  return {
    success: true,
    message: '已成功接管超级管理员权限，请尽快通过常规流程核实账号安全并考虑轮换应急密钥',
    action: isUpdate ? 'updated' : 'created',
    tenantId: tenantResolution.tenantId
  };
};
