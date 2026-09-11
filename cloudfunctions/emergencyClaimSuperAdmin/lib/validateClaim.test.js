'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRealName, validatePhone, buildUserRoleDoc, buildAuditLogEntry } = require('./validateClaim');

// ==================== validateRealName ====================

test('validateRealName：正常姓名通过校验并去除首尾空白', () => {
  const res = validateRealName('  张三  ');
  assert.equal(res.valid, true);
  assert.equal(res.value, '张三');
});

test('validateRealName：空/纯空白/undefined 一律拒绝', () => {
  assert.equal(validateRealName('').valid, false);
  assert.equal(validateRealName('   ').valid, false);
  assert.equal(validateRealName(undefined).valid, false);
});

test('validateRealName：超长姓名截断到上限长度，不拒绝', () => {
  const longName = '张'.repeat(100);
  const res = validateRealName(longName);
  assert.equal(res.valid, true);
  assert.equal(res.value.length, 50);
});

// ==================== validatePhone ====================

test('validatePhone：正常手机号通过校验', () => {
  const res = validatePhone(' 13800001111 ');
  assert.equal(res.valid, true);
  assert.equal(res.value, '13800001111');
});

test('validatePhone：空/纯空白/undefined 一律拒绝', () => {
  assert.equal(validatePhone('').valid, false);
  assert.equal(validatePhone('   ').valid, false);
  assert.equal(validatePhone(undefined).valid, false);
});

// ==================== buildUserRoleDoc ====================

test('buildUserRoleDoc：不存在既有记录时构造新增文档，含 _openid/requestedRole', () => {
  const result = buildUserRoleDoc({
    openid: 'openid_1', realName: '张三', phone: '13800001111', tenantId: 'tenant_1', existingDoc: null
  });
  assert.equal(result.isUpdate, false);
  assert.equal(result.docId, null);
  assert.equal(result.patch._openid, 'openid_1');
  assert.equal(result.patch.requestedRole, 'super_admin');
  assert.equal(result.patch.role, 'super_admin');
  assert.equal(result.patch.status, 'approved');
  assert.equal(result.patch.storeId, '');
  assert.equal(result.patch.storeName, '全国总览');
  assert.equal(result.patch.tenantId, 'tenant_1');
  assert.equal(result.patch.realName, '张三');
  assert.equal(result.patch.phone, '13800001111');
});

test('buildUserRoleDoc：存在既有记录时构造更新补丁，携带原文档 _id，不含 _openid/requestedRole', () => {
  const existingDoc = { _id: 'doc_123', role: 'volunteer', storeId: 'store_9' };
  const result = buildUserRoleDoc({
    openid: 'openid_1', realName: '李四', phone: '13900002222', tenantId: 'tenant_2', existingDoc
  });
  assert.equal(result.isUpdate, true);
  assert.equal(result.docId, 'doc_123');
  assert.equal(result.patch.role, 'super_admin');
  assert.equal(result.patch.storeId, '');
  assert.equal(result.patch._openid, undefined);
  assert.equal(result.patch.requestedRole, undefined);
});

test('buildUserRoleDoc：tenantId 缺失时兜底为空字符串，不写入 undefined', () => {
  const result = buildUserRoleDoc({ openid: 'o', realName: 'n', phone: 'p', tenantId: undefined, existingDoc: null });
  assert.equal(result.patch.tenantId, '');
});

test('buildUserRoleDoc：不包含任何 db.serverDate() 时间戳字段（由调用方补上）', () => {
  const result = buildUserRoleDoc({ openid: 'o', realName: 'n', phone: 'p', tenantId: 't', existingDoc: null });
  assert.equal('emergencyClaimedAt' in result.patch, false);
  assert.equal('applyTime' in result.patch, false);
  assert.equal('approveTime' in result.patch, false);
});

// ==================== buildAuditLogEntry ====================

test('buildAuditLogEntry：成功场景记录接管人信息，不含 fail_reason', () => {
  const entry = buildAuditLogEntry({
    openid: 'openid_1', success: true, realName: '张三', phone: '13800001111', tenantId: 'tenant_1', isUpdate: false
  });
  assert.equal(entry.action, 'EMERGENCY_SUPER_ADMIN_CLAIM');
  assert.equal(entry.operator_id, 'openid_1');
  assert.equal(entry.success, true);
  assert.equal(entry.granted_real_name, '张三');
  assert.equal(entry.granted_phone, '13800001111');
  assert.equal(entry.granted_tenant_id, 'tenant_1');
  assert.equal(entry.write_mode, 'created_new_record');
  assert.equal('fail_reason' in entry, false);
});

test('buildAuditLogEntry：isUpdate 为 true 时 write_mode 标记为更新既有记录', () => {
  const entry = buildAuditLogEntry({ openid: 'o', success: true, isUpdate: true });
  assert.equal(entry.write_mode, 'updated_existing_record');
});

test('buildAuditLogEntry：失败场景只记录脱敏后的原因，不含接管人字段', () => {
  const entry = buildAuditLogEntry({ openid: 'openid_1', success: false, failReason: '密钥不匹配' });
  assert.equal(entry.success, false);
  assert.equal(entry.fail_reason, '密钥不匹配');
  assert.equal('granted_real_name' in entry, false);
  assert.equal('granted_phone' in entry, false);
});

test('buildAuditLogEntry：绝不会把调用方传入的原始 secret 字段写进日志（构造函数参数里本就没有 secret 这个入口）', () => {
  const entry = buildAuditLogEntry({ openid: 'o', success: false, failReason: '密钥不匹配', secret: 'leaked-if-bug' });
  assert.equal(JSON.stringify(entry).includes('leaked-if-bug'), false);
});

test('buildAuditLogEntry：failReason 缺失时兜底为"未知原因"，超长时截断', () => {
  const entry1 = buildAuditLogEntry({ openid: 'o', success: false });
  assert.equal(entry1.fail_reason, '未知原因');
  const entry2 = buildAuditLogEntry({ openid: 'o', success: false, failReason: 'x'.repeat(500) });
  assert.equal(entry2.fail_reason.length, 200);
});

test('buildAuditLogEntry：不含 operate_time 时间戳字段（由调用方补上）', () => {
  const entry = buildAuditLogEntry({ openid: 'o', success: true });
  assert.equal('operate_time' in entry, false);
});
