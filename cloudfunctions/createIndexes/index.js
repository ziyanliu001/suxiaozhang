// 云函数：createIndexes
//
// ⚠️ 2026-08 修复：本函数原先假设 `db.collection(name).createIndex(spec)` 是
// 一个可用的服务端 API，实测在 wx-server-sdk 下调用会直接报错
// "db.collection(...).createIndex is not a function"——这不是这次改造引入的
// 回归，是 wx-server-sdk 服务端 SDK 本身从未提供 collection 级别的索引管理
// 方法（客户端 SDK `wx.cloud.database()` 同样没有）。微信云开发的索引管理
// 只有两条真正可用的路径，都不是"云函数里调一个方法"：
//
//   路径 A（推荐，标准做法）：云开发控制台手动创建
//     微信开发者工具 → 云开发 → 数据库 → 选中目标集合 → 「索引管理」Tab →
//     「新建索引」，按下方 exports.main 返回结果里的 indexGuide 清单逐条填写
//     （索引名 / 字段名 / 排序方向 / 是否唯一）。这是官方文档明确支持、长期
//     稳定的方式，不依赖任何未公开或易变的接口。
//
//   路径 B（进阶，未在本函数中实现）：微信云开发 HTTP API
//     文档中存在管理端接口 `POST https://api.weixin.qq.com/tcb/updateIndex`
//     （需要小程序 access_token，通过 appid+secret 换取），可用于脚本化批量
//     建索引。⚠️ 本次未接入：其请求体字段细节依赖当时最新官方文档，且
//     access_token 的获取/缓存需要额外的凭证管理，贸然写一份没有真实环境
//     验证过的实现风险比价值大（与本仓库 wxPayCore 分账相关注释里"未经真实
//     商户号验证"是同一个谨慎原则）。如需要把索引创建纳入自动化部署流程，
//     建议后续单独排期，用真实环境跑通这条 HTTP API 后再落地。
//
// 本函数现在只做两件"确定安全、确定有效"的事：
//   1. 确保下方涉及的所有集合都存在（db.createCollection 是 wx-server-sdk
//      真实支持的方法，本仓库 wxPayCore/orderService.js 等处已在用同一模式）。
//   2. 把需要的索引整理成人类可读清单返回，供照着在控制台手动创建——不再
//      假装能自动建完。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function isCollectionExistsError(err) {
  const msg = ((err && (err.message || err.errMsg)) || '').toLowerCase();
  return msg.includes('already exist') || msg.includes('database collection exist');
}

async function ensureCollectionExists(name) {
  try {
    await db.createCollection(name);
    return { collection: name, status: 'created' };
  } catch (err) {
    if (isCollectionExistsError(err)) {
      return { collection: name, status: 'already_exists' };
    }
    return { collection: name, status: 'failed', error: err.message || err.errMsg };
  }
}

function describeKeys(keys) {
  return keys
    .map((k) => {
      const [field, direction] = Object.entries(k)[0];
      return `${field}(${direction === -1 ? '降序' : '升序'})`;
    })
    .join(' + ');
}

exports.main = async (event, context) => {
  // 索引规划的唯一真源：collection 名 + 索引 spec（name/keys/unique）。
  // 只用来 (a) 推导需要确保存在的集合列表 (b) 生成控制台手动建索引的清单，
  // 不再被传给任何 createIndex 调用。
  const tasks = [
    // ─── stores ────────────────────────────────────────────────────────
    ['stores', { name: 'storeName_asc',  keys: [{ storeName: 1 }],  unique: false }],
    ['stores', { name: 'tenantId',       keys: [{ tenantId: 1 }],   unique: false }],

    // ─── daily_reports ─────────────────────────────────────────────────
    ['daily_reports', { name: 'storeId_date',  keys: [{ storeId: 1 }, { reportDate: 1 }],  unique: false }],
    ['daily_reports', { name: 'reportDate_asc', keys: [{ reportDate: 1 }],                  unique: false }],

    // ─── report_logs ───────────────────────────────────────────────────
    ['report_logs', { name: 'shopName_date',                   keys: [{ shopName: 1 }, { dateString: 1 }],                  unique: false }],
    ['report_logs', { name: 'tenantId_date',                   keys: [{ tenantId: 1 }, { dateString: 1 }],                  unique: false }],
    ['report_logs', { name: 'auditedBy_asc',                   keys: [{ auditedBy: 1 }],                                    unique: false }],
    ['report_logs', { name: 'tenantId_auditedBy',              keys: [{ tenantId: 1 }, { auditedBy: 1 }],                   unique: false }],
    // 🔑 pages/index/index.ts fetchFinanceLedgerStatus 的"账本锁定状态"查询：
    // {tenantId, storeId, auditedBy: _.exists(true)}.count()
    ['report_logs', { name: 'tenantId_storeId_auditedBy',      keys: [{ tenantId: 1 }, { storeId: 1 }, { auditedBy: 1 }],   unique: false }],
    // 🐛 索引方向补充：fetchFinanceLedgerStatus 实际的查询构造是
    // `const baseWhere = { storeId }; if (tenantId) baseWhere.tenantId = tenantId;`——
    // storeId 才是这两条并发 count() 查询（baseWhere 本身 / baseWhere + auditedBy
    // exists）字段顺序上真正领头的主控字段，数据库控制台的索引推荐正是按这个顺序
    // 报的缺失索引。上面 tenantId_storeId_auditedBy/tenantId_auditedBy 领头字段是
    // tenantId，服务的是"先按机构、再按门店"这类不同查询路径的索引前缀匹配，
    // 不能互相替代同一个查询计划——同一组字段、不同领头顺序需要各自建一条复合索引
    ['report_logs', { name: 'storeId_tenantId_auditedBy',      keys: [{ storeId: 1 }, { tenantId: 1 }, { auditedBy: 1 }],   unique: false }],
    ['report_logs', { name: 'storeId_tenantId',                keys: [{ storeId: 1 }, { tenantId: 1 }],                     unique: false }],
    // 🔑 profile.ts fetchMeritStats 的提交人统计：{tenantId, storeId, _openid}.count()
    ['report_logs', { name: 'tenantId_storeId_openid',         keys: [{ tenantId: 1 }, { storeId: 1 }, { _openid: 1 }],    unique: false }],
    ['report_logs', { name: 'tenantId_storeId_dateString',     keys: [{ tenantId: 1 }, { storeId: 1 }, { dateString: 1 }], unique: false }],
    ['report_logs', { name: 'tenantId_approvalStatus_dateString', keys: [{ tenantId: 1 }, { approvalStatus: 1 }, { dateString: 1 }], unique: false }],
    // 🔑 getPatriarchDashboard 的两条真实查询：都只按 storeId 起头（不带 tenantId
    // 前缀），tenantId_storeId_dateString 用不上——tenantId 作为复合索引首列时，
    // 只有查询同时带 tenantId 精确匹配才能命中该索引前缀，这两条查询压根没传
    // tenantId，需要各自专属、以 storeId 起头的索引
    ['report_logs', { name: 'storeId_dateString',               keys: [{ storeId: 1 }, { dateString: 1 }],   unique: false }],
    ['report_logs', { name: 'storeId_voidPending',               keys: [{ storeId: 1 }, { voidPending: 1 }],  unique: false }],

    // ─── user_roles ────────────────────────────────────────────────────
    ['user_roles', { name: 'openid',                      keys: [{ _openid: 1 }],                                               unique: false }],
    ['user_roles', { name: 'tenantId',                    keys: [{ tenantId: 1 }],                                              unique: false }],
    ['user_roles', { name: 'tenantId_status_applyTime',   keys: [{ tenantId: 1 }, { status: 1 }, { applyTime: -1 }],           unique: false }],
    ['user_roles', { name: 'storeId_status_applyTime',    keys: [{ storeId: 1 }, { status: 1 }, { applyTime: -1 }],            unique: false }],
    ['user_roles', { name: 'storeId_status_approveTime',  keys: [{ storeId: 1 }, { status: 1 }, { approveTime: -1 }],         unique: false }],
    ['user_roles', { name: 'storeName_status_approveTime',keys: [{ storeName: 1 }, { status: 1 }, { approveTime: -1 }],       unique: false }],
    ['user_roles', { name: 'storeName_status_applyTime',  keys: [{ storeName: 1 }, { status: 1 }, { applyTime: -1 }],         unique: false }],

    // ─── store_sponsor ─────────────────────────────────────────────────
    ['store_sponsor', { name: 'storeId', keys: [{ storeId: 1 }], unique: false }],

    // ─── tenant_subscriptions ──────────────────────────────────────────
    ['tenant_subscriptions', { name: 'tenantId',              keys: [{ tenantId: 1 }],                            unique: false }],
    ['tenant_subscriptions', { name: 'tenantId_lastRenewedAt',keys: [{ tenantId: 1 }, { lastRenewedAt: -1 }],    unique: false }],

    // ─── daily_menus / activity_logs / expense_item_templates ──────────
    ['daily_menus',             { name: 'store_date',      keys: [{ storeId: 1 }, { dateString: -1 }],  unique: false }],
    ['activity_logs',           { name: 'store_eventTime', keys: [{ storeId: 1 }, { eventTime: -1 }],   unique: false }],
    ['expense_item_templates',  { name: 'store_category',  keys: [{ storeId: 1 }, { category: 1 }],     unique: false }],

    // ─── notices / notice_templates ────────────────────────────────────
    ['notices',           { name: 'tenant_store',        keys: [{ tenantId: 1 }, { storeId: 1 }],                    unique: false }],
    ['notice_templates',  { name: 'tenant_store_system', keys: [{ tenantId: 1 }, { storeId: 1 }, { isSystem: 1 }],  unique: false }],

    // ─── store_milestones ──────────────────────────────────────────────
    ['store_milestones', { name: 'store_eventDate', keys: [{ storeId: 1 }, { eventDate: -1 }], unique: false }],

    // ─── volunteer_duty_logs ───────────────────────────────────────────
    ['volunteer_duty_logs', { name: 'tenantId_storeId_openid_dateString',  keys: [{ tenantId: 1 }, { storeId: 1 }, { _openid: 1 }, { dateString: 1 }, { status: 1 }], unique: false }],
    ['volunteer_duty_logs', { name: 'tenantId_storeId_status_dateString',  keys: [{ tenantId: 1 }, { storeId: 1 }, { status: 1 }, { dateString: 1 }],                 unique: false }],

    // ─── store_invite_codes / tenant_activation_codes ──────────────────
    ['store_invite_codes',       { name: 'codeNormalized_unique', keys: [{ codeNormalized: 1 }], unique: true }],
    ['tenant_activation_codes',  { name: 'codeNormalized_unique', keys: [{ codeNormalized: 1 }], unique: true }],

    // ─── feedback_submissions ──────────────────────────────────────────
    ['feedback_submissions', { name: 'storeId_status_createTime', keys: [{ storeId: 1 }, { status: 1 }, { createTime: -1 }], unique: false }],

    // ─── 直播产销协同（live_factory）：Step 1 方案新增，纯追加，不影响以上任何条目 ──
    // tenant_members 是与 user_roles 物理隔离的独立集合（见 createProductionSpace/
    // index.js 头部注释），查询形状一致：openid+tenantId 查角色、tenantId 列表页
    ['tenant_members',                 { name: 'openid_tenantId_status',     keys: [{ _openid: 1 }, { tenantId: 1 }, { status: 1 }],         unique: false }],
    ['tenant_members',                 { name: 'tenantId',                   keys: [{ tenantId: 1 }],                                         unique: false }],
    // 🔑 live_factory 侧多处按业务字段 tenantId 查 tenants（createProductionOrder/
    // completeProductionOrder/markSettlementsSettled/getMyProductionSpaces），
    // 而不是按 _id——tenants 文档的 _id 是自动生成的，tenantId 只是业务字段
    // （见 createProductionSpace 的 add() 写法），这条索引专供这类查询。
    // ⚠️ 不设 unique：DEFAULT_TENANT_ID 那条雨花总览机构记录（createStore.js
    // ensureNationalTenant 用 .doc(id).set() 创建）压根没写 tenantId 字段，
    // 强行加 unique 很可能因为多条记录都"缺失该字段"而在控制台创建时报错
    ['tenants',                        { name: 'tenantId',                   keys: [{ tenantId: 1 }],                                         unique: false }],
    ['products',                       { name: 'tenantId_status',            keys: [{ tenantId: 1 }, { status: 1 }],                          unique: false }],
    // 🔑 getSettlementSummary 制作方视角的查询：{tenantId, producerOpenId}
    ['products',                       { name: 'tenantId_producerOpenId',    keys: [{ tenantId: 1 }, { producerOpenId: 1 }],                  unique: false }],
    ['production_orders',              { name: 'tenantId_batchDate_status',  keys: [{ tenantId: 1 }, { batchDate: 1 }, { orderStatus: 1 }],  unique: false }],
    ['production_orders',              { name: 'buyerOpenId_tenantId',       keys: [{ buyerOpenId: 1 }, { tenantId: 1 }],                     unique: false }],
    ['production_capacity_counters',   { name: 'tenantId_productId_batchDate_unique', keys: [{ tenantId: 1 }, { productId: 1 }, { batchDate: 1 }], unique: true }],
    ['order_settlements',              { name: 'tenantId_orderId',           keys: [{ tenantId: 1 }, { orderId: 1 }],                         unique: false }],
    ['order_settlements',              { name: 'tenantId_settlementStatus',  keys: [{ tenantId: 1 }, { settlementStatus: 1 }],                unique: false }],
    ['workspace_invite_codes',         { name: 'codeNormalized_unique',      keys: [{ codeNormalized: 1 }],                                   unique: true }],
    ['customer_checkins',              { name: 'tenantId_buyerOpenId_unique',keys: [{ tenantId: 1 }, { buyerOpenId: 1 }],                     unique: true }],

    // ─── wxPayCore 分账/退款账本（补齐 Step 4 遗留缺口时新增）──────────────
    ['refund_orders',                  { name: 'outRefundNo_unique',         keys: [{ outRefundNo: 1 }],                                      unique: true }],
    ['refund_orders',                  { name: 'outTradeNo_status',          keys: [{ outTradeNo: 1 }, { status: 1 }],                        unique: false }],
    ['profit_sharing_orders',          { name: 'outOrderNo_unique',          keys: [{ outOrderNo: 1 }],                                       unique: true }],
    ['profit_sharing_orders',          { name: 'outTradeNo_status',          keys: [{ outTradeNo: 1 }, { status: 1 }],                        unique: false }],
  ];

  // 1. 确保所有涉及的集合存在（真实支持的 API，与索引管理无关，先做完不受影响）
  const collections = [...new Set(tasks.map(([col]) => col))];
  const collectionResults = await Promise.all(collections.map(ensureCollectionExists));
  const collectionFailures = collectionResults.filter((r) => r.status === 'failed');

  // 2. 生成控制台手动建索引清单：按集合分组，每条给出索引名/字段/排序/唯一性
  const indexGuide = collections.map((collection) => ({
    collection,
    indexes: tasks
      .filter(([col]) => col === collection)
      .map(([, spec]) => ({
        indexName: spec.name,
        fields: describeKeys(spec.keys),
        unique: spec.unique
      }))
  }));

  return {
    success: collectionFailures.length === 0,
    message:
      'wx-server-sdk 不支持在云函数里自动创建索引（db.collection().createIndex 不是有效方法），' +
      '已改为只确保集合存在；索引请照 indexGuide 清单在「云开发控制台 → 数据库 → 对应集合 → 索引管理 → 新建索引」中手动创建。',
    collections: collectionResults,
    collectionFailures,
    indexGuide
  };
};
