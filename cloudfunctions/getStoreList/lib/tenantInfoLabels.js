'use strict';

// 纯逻辑：门店列表附加展示用的机构名/套餐标签格式化，不做任何 db I/O，
// 便于单测（本仓库 wxPayCore/getSettlementSummary 等云函数已有的既定写法，
// index.js 通过 require('./lib/xxx') 引入，不在两处各写一份）。
//
// 🏛️ 套餐标签口径与 cloudfunctions/checkTenantPermission/index.js 的
// buildPlanName()/PLAN_CODE_MAP 保持同一份对外展示别名（各云函数独立部署，
// 无共享模块机制，只能人工同步这几处拷贝），这里只取三档简称，不含门店数——
// 门店选择器分组头是轻量展示场景，不需要 checkTenantPermission 那份完整的
// "专业版 (10店)"长文案

// tenants 文档 -> 展示用机构名。本仓库 tenants 集合存在两条历史创建路径，
// 机构名字段分别叫 name / tenantName（见 checkTenantPermission/index.js 同一处
// 兜底注释），这里两个字段都兜底，任一为空都不报错
function resolveTenantDisplayName(tenantDoc) {
  if (!tenantDoc) return '';
  return tenantDoc.name || tenantDoc.tenantName || '';
}

// planType -> 简短展示标签。未知/缺失 planType 一律按 basic（免费版）处理，
// 不抛错——门店选择器分组头是纯展示场景，宁可显示"基础免费版"也不要因为
// 一条脏数据整个查询失败
function buildPlanLabel(planType) {
  if (planType === 'pro') return '专业版';
  if (planType === 'enterprise') return '旗舰版';
  return '基础免费版';
}

module.exports = { resolveTenantDisplayName, buildPlanLabel };
