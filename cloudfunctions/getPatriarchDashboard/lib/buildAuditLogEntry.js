'use strict';

// 🛡️（2026-09-11 巡检漫游审计日志·方向3）纯逻辑：把一次"resolveCaller 确实
//把调用者身份替换成了某条 authorizedTenants 漫游授权"的调用上下文，整理成
// 一条可直接 db.collection('tenant_authorization_audit_logs').add() 的审计
// 日志文档。不做 db I/O、不依赖 wx-server-sdk，配套单测同目录
// buildAuditLogEntry.test.js。
//
// 🛡️ 与 resolveCaller.js 的职责边界：resolveEffectiveCaller() 只负责"这次
// 调用该不该、能不能漫游成某个身份"这个判断，本文件只负责"如果确实漫游
// 了，该记一条什么样的审计日志"，两者互不依赖对方内部实现，改动一处不
// 需要连带改另一处。
//
// ⚠️ 与 getPatriarchDashboard/lib/、manageReportApproval/lib/ 下的同名文件
// 是三处独立维护的镜像（cloudfunctions/ 下每个云函数是独立部署单元，互相
// 不能跨目录 require），与本仓库 MERIT_TAGS/buildPurchasePlan 已有的
// "两处独立维护同一份逻辑"是同一种既有约束的第三个实例。三份文件的函数
// 行为必须保持一致，改动一处记得同步另外两处。

/**
 * 判断这次调用是否真的发生了"漫游身份消费"——即最终生效的身份与调用者
 * 本来的身份不是同一份数据（原样返回 own 时不算漫游）。三处 resolveCaller
 * 实现都遵循"不漫游时原样返回 own 对象、漫游时才 {...own, tenantId, role,
 * storeId} 构造新对象"的约定，这里用字段比对而不是引用比对——引用比对
 * 在跨函数场景下不够稳妥（调用方可能在传入前自己也 spread 过一次）。
 */
function isRoamingConsumed(own, effectiveCaller) {
  if (!own || !effectiveCaller) return false;
  return (
    own.tenantId !== effectiveCaller.tenantId ||
    own.role !== effectiveCaller.role ||
    own.storeId !== effectiveCaller.storeId
  );
}

/**
 * @param {object} params
 * @param {string} params.operatorOpenId 实际发起调用的 openid（platform_admin 自己）
 * @param {object} params.own 调用者本来的身份（resolveCaller 反查出的 user_roles 文档）
 * @param {object} params.effectiveCaller 漫游判定后最终生效的身份
 * @param {string} params.targetStoreId 本次请求的目标门店
 * @param {string} [params.targetStoreName] 目标门店的真实名称——⚠️ 必须由调用方
 *   显式传入（如另外查一次 stores.storeName），不能从 effectiveCaller.storeName
 *   读取：三处 resolveCaller 实现在漫游时都只替换 tenantId/role/storeId 三个
 *   字段，storeName 会原样保留调用者自己的本来名称（platform_admin 账号通常是
 *   "全国总览"这类占位名），直接拿来当"目标门店名称"会是一条彻头彻尾误导人的
 *   审计记录——曾经真的这样写过，实测出现过"targetStoreName:'全国总览'"这种
 *   看起来像是漫游去查了全国总览、实际却是查了一家具体门店的假象，这里改成
 *   必须显式传入，不提供就诚实留空，不能编造一个错误值
 * @param {string} params.cloudFunctionName 发生在哪个云函数（便于跨多个消费点聚合审计）
 * @param {string} [params.action] 该云函数内部的具体 action（如 'get'/'update'/'getMeritStats'）
 * @returns {object|null} 可直接写入 tenant_authorization_audit_logs 的文档字段（不含
 *   createTime——那是调用方用 db.serverDate() 补的基础设施字段，不归本函数管）；
 *   不构成有效漫游、或必填参数缺失时返回 null，调用方据此跳过写库
 */
function buildAuditLogEntry({ operatorOpenId, own, effectiveCaller, targetStoreId, targetStoreName, cloudFunctionName, action }) {
  if (!operatorOpenId || !targetStoreId || !cloudFunctionName) return null;
  if (!isRoamingConsumed(own, effectiveCaller)) return null;

  return {
    operatorOpenId,
    targetStoreId,
    targetStoreName: targetStoreName || '',
    targetTenantId: effectiveCaller.tenantId || '',
    roamedAsRole: effectiveCaller.role || '',
    homeRole: (own && own.role) || '',
    homeTenantId: (own && own.tenantId) || '',
    cloudFunctionName,
    action: action || ''
  };
}

module.exports = { buildAuditLogEntry, isRoamingConsumed };
