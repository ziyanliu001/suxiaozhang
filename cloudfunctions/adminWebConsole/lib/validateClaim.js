// 紧急逃生舱（Web 管理中台通道）：入参校验、user_roles 写入文档、高危审计
// 日志文档的纯构造逻辑。不做 db I/O、不依赖 wx-server-sdk，便于单测。
//
// ⚠️ 本文件是 cloudfunctions/emergencyClaimSuperAdmin/lib/validateClaim.js
// 的独立镜像（第三处 super_admin 授予路径：微信内密钥自助接管 / 本地 CLI
// 直连数据库 / 本 Web 管理中台，三者共用同一套 user_roles 字段口径与
// audit_logs 记录格式，只是各自的调用入口不同），保持逻辑同步，改一处记得
// 检查另外两处是否也需要同步改动。本仓库云函数间无共享模块机制，这是
// 既定约束下的既定写法（参见 manageDailyMenu/getPatriarchDashboard 等四处
// resolveCaller.js 镜像的先例）。
'use strict';

const MAX_NAME_LENGTH = 50;
const MAX_PHONE_LENGTH = 20;
const MAX_NOTE_LENGTH = 200;

/**
 * 真实姓名校验：与 processRoleAudit submitRoleApply 同一条口径（非空即可，
 * 不强行套用姓名格式正则——真实姓名的合法字符集因民族/生僻字/姓名长度差异
 * 极大，本仓库历来不对这个字段做格式校验，只做非空 + 长度上限防御）。
 * @param {any} realName
 * @returns {{valid: true, value: string} | {valid: false, error: string}}
 */
function validateRealName(realName) {
  const trimmed = String(realName || '').trim();
  if (!trimmed) return { valid: false, error: '请提供接管人真实姓名' };
  return { valid: true, value: trimmed.slice(0, MAX_NAME_LENGTH) };
}

/**
 * 手机号校验：同上，与本仓库既有的"非空即可"口径一致，不引入新的格式正则
 * （国际号码/座机等历来不在本仓库校验范围内）。
 * @param {any} phone
 * @returns {{valid: true, value: string} | {valid: false, error: string}}
 */
function validatePhone(phone) {
  const trimmed = String(phone || '').trim();
  if (!trimmed) return { valid: false, error: '请提供接管人手机号，供后续核实身份使用' };
  return { valid: true, value: trimmed.slice(0, MAX_PHONE_LENGTH) };
}

/**
 * 构造写入 user_roles 的字段补丁——与 cloudfunctions/setupSuperAdmin 生成
 * super_admin 记录的字段口径完全一致（storeId 恒为空、storeName 固定展示
 * 值、role/status 恒定），保证经由两条不同路径（人工控制台自举 vs 本次
 * 应急密钥自助接管）产生的 super_admin 记录形状不会出现两套不一致的口径。
 * 🕐 不含任何 db.serverDate() 时间戳字段——与 dailyTenantSnapshotCron/
 * lib/buildDailySnapshot.js 同一个约定：本函数保持纯粹、不产生时间副作用，
 * 调用方（index.js）在真正写入前自行补上 emergencyClaimedAt/applyTime/
 * approveTime 这几个时间戳字段。
 * @param {object} params
 * @param {string} params.openid
 * @param {string} params.realName
 * @param {string} params.phone
 * @param {string} params.tenantId
 * @param {object|null} params.existingDoc 该 openid 已有的 user_roles 文档，没有则传 null
 * @returns {{isUpdate: boolean, docId: string|null, patch: object}}
 */
function buildUserRoleDoc({ openid, realName, phone, tenantId, existingDoc }) {
  const patch = {
    role: 'super_admin',
    status: 'approved',
    storeId: '',
    storeName: '全国总览',
    tenantId: tenantId || '',
    realName,
    phone
  };

  if (existingDoc) {
    return { isUpdate: true, docId: existingDoc._id, patch };
  }
  return {
    isUpdate: false,
    docId: null,
    patch: {
      ...patch,
      _openid: openid,
      requestedRole: 'super_admin'
    }
  };
}

/**
 * 构造写入 audit_logs 的高危事件记录——成功/失败两种场景共用同一个构造器，
 * 绝不把明文密钥（无论对错）写进日志的任何字段，只记录"是否匹配"这个布尔
 * 结果，避免审计日志本身成为密钥泄露的另一个渠道。
 * @param {object} params
 * @param {string} params.openid
 * @param {boolean} params.success
 * @param {string} [params.realName]
 * @param {string} [params.phone]
 * @param {string} [params.tenantId]
 * @param {boolean} [params.isUpdate]
 * @param {string} [params.failReason] 仅失败时填写，且必须是脱敏后的原因
 *   （如"密钥不匹配"/"已被锁定"），绝不包含调用方传入的原始 secret 值
 * @param {string} [params.channel] 走的是哪一条应急接管通道——
 *   'wechat_secret'（本函数，微信内密钥自助接管，默认值）/
 *   'cli_script'（scripts/ops/grant-super-admin.js，本地直连数据库）/
 *   'web_console'（cloudfunctions/adminWebConsole，独立 Web 管理中台）。
 *   三条通道共用同一套 buildAuditLogEntry，靠这个字段在 audit_logs 里
 *   区分事后追溯时"到底是哪一道防线被触发了"，见 CLAUDE.md 第 11 节。
 * 同样不含 db.serverDate()，operate_time 由调用方补上。
 * @returns {object}
 */
function buildAuditLogEntry({ openid, success, realName, phone, tenantId, isUpdate, failReason, channel }) {
  const entry = {
    action: 'EMERGENCY_SUPER_ADMIN_CLAIM',
    channel: channel || 'wechat_secret',
    operator_id: openid,
    success: !!success
  };
  if (success) {
    entry.granted_real_name = realName || '';
    entry.granted_phone = phone || '';
    entry.granted_tenant_id = tenantId || '';
    entry.write_mode = isUpdate ? 'updated_existing_record' : 'created_new_record';
  } else {
    entry.fail_reason = String(failReason || '未知原因').slice(0, MAX_NOTE_LENGTH);
  }
  return entry;
}

module.exports = {
  validateRealName,
  validatePhone,
  buildUserRoleDoc,
  buildAuditLogEntry
};
