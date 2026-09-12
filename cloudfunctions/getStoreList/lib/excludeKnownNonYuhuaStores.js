'use strict';

// 纯逻辑：拆自 cloudfunctions/getStoreList/index.js，不依赖 wx-server-sdk，
// 便于单测（本仓库 wxPayCore/getSettlementSummary 等云函数已有的既定写法，
// index.js 通过 require('./lib/xxx') 引入，不在两处各写一份）。
//
// 🐛（2026-09-13 根因修复："嵩屿街道敬老中心"跨专区渗透）buildOrgTypeCondition
// 对雨花专区的"orgType 缺失/空字符串"兼容分支本意是不丢失还没打标签的真实
// 雨花斋历史门店，但这条宽松匹配同样会捞进任何其它专区、同样还没打标签的
// 门店——真实复现："嵩屿街道敬老中心"（社区长者食堂，orgType 理应是
// elderly_canteen，但 cloudfunctions/fixTenantHierarchy 那次数据迁移尚未
// 执行 apply，字段仍是缺失状态）被误判成"疑似雨花斋"，混进了
// handleDiscoverByOrgType 的跨机构发现结果——这条路径没有 tenantId 过滤，
// 是本仓库现存查询里对这类"orgType 缺失"脏数据暴露面最大的一条。
//
// "缺失即兼容雨花斋"这道判定本身没法收紧（收紧成严格相等会导致雨花专区
// 查询整个返回空列表，是更严重的问题），只能在结果集里显式排除已知与雨花斋
// 无关、仍在等待 fixTenantHierarchy 回填 orgType 的门店——与该迁移云函数
// 里记录的"待修正门店清单"保持同步：一旦某家店的 orgType 通过那次迁移正式
// 回填完成，它会被真实的 orgType 值挡在 buildOrgTypeCondition 的"缺失"分支
// 之外，不再需要出现在这份排除名单里，届时应删掉对应条目，不要让这份名单
// 无限增长下去。
const KNOWN_NON_YUHUA_PENDING_MIGRATION_KEYWORDS = ['嵩屿'];

/**
 * @param {string} orgType 本次查询请求的 orgType（只在等于 'yuhuazhai' 时才需要
 *   排除，其余专区的查询条件本来就不会误伤这些门店）
 * @param {Array<{storeName?: string}>} list 查询结果列表
 * @returns {Array} 过滤后的列表；orgType 不是 'yuhuazhai' 时原样返回
 */
function excludeKnownNonYuhuaStores(orgType, list) {
  if (orgType !== 'yuhuazhai') return list || [];
  return (list || []).filter((s) => {
    const name = (s && s.storeName) || '';
    return !KNOWN_NON_YUHUA_PENDING_MIGRATION_KEYWORDS.some((kw) => name.includes(kw));
  });
}

module.exports = { excludeKnownNonYuhuaStores, KNOWN_NON_YUHUA_PENDING_MIGRATION_KEYWORDS };
