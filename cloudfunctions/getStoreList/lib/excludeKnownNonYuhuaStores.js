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
//
// 🐛（2026-09-13 二次加固）真机复测反馈"嵩屿"仍然出现在雨花专区列表——
// 真实全称是"嵩屿街道敬老中心助餐点"，本身就包含"嵩屿"这个关键词，按理说
// 上面的名字匹配应该已经能拦下，如果真机上仍未生效，最大嫌疑是云函数改完
// 代码后还没有重新上传部署（微信云开发的云函数需要显式"上传并部署"，本地
// 改完 git 仓库代码不会自动生效到线上环境）——这一点无法在代码层面验证或
// 绕过，需要用户确认已经重新部署过 getStoreList。这里按用户明确要求叠加
// 第二个独立信号：只要 orgType 命中已知的非雨花斋分类（不依赖店名文本），
// 即使 storeName 关键词因为某种原因（如未来改名、不同分店用了不同措辞）
// 匹配不上，orgType 这条独立信号仍能兜底拦下——两个信号任一命中就排除，
// 不要求同时命中
const KNOWN_NON_YUHUA_PENDING_MIGRATION_KEYWORDS = ['嵩屿'];
const KNOWN_NON_YUHUA_ORG_TYPES = ['elderly_canteen', 'elderly_care'];

/**
 * @param {string} orgType 本次查询请求的 orgType（只在等于 'yuhuazhai' 时才需要
 *   排除，其余专区的查询条件本来就不会误伤这些门店）
 * @param {Array<{storeName?: string, orgType?: string}>} list 查询结果列表
 *   （必须是过滤前的原始文档，需要读到真实 orgType 字段，不能是已经映射成
 *   客户端展示字段的结果）
 * @returns {Array} 过滤后的列表；orgType 不是 'yuhuazhai' 时原样返回
 */
function excludeKnownNonYuhuaStores(orgType, list) {
  if (orgType !== 'yuhuazhai') return list || [];
  return (list || []).filter((s) => {
    if (!s) return true;
    const name = s.storeName || '';
    const matchesKeyword = KNOWN_NON_YUHUA_PENDING_MIGRATION_KEYWORDS.some((kw) => name.includes(kw));
    const matchesOrgType = KNOWN_NON_YUHUA_ORG_TYPES.includes(s.orgType);
    return !(matchesKeyword || matchesOrgType);
  });
}

module.exports = { excludeKnownNonYuhuaStores, KNOWN_NON_YUHUA_PENDING_MIGRATION_KEYWORDS, KNOWN_NON_YUHUA_ORG_TYPES };
