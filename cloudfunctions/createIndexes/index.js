const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 🛡️ 每条索引独立 try-catch：已存在的索引 createIndex 会 throw "index already exists"，
// 不能让单条失败中断后续所有索引的创建。succeeded/skipped/failed 三分类让调用方
// 能清楚看到本次执行哪些是新建的，哪些是已有索引跳过的，哪些是真正失败的。
async function ensureIndex(collection, spec) {
  try {
    await db.collection(collection).createIndex(spec);
    return { collection, index: spec.name, status: 'created' };
  } catch (err) {
    // 索引已存在时微信 SDK 抛出 "index already exists" 类消息，视为正常
    const alreadyExists =
      (err.message || '').toLowerCase().includes('already') ||
      (err.errMsg || '').toLowerCase().includes('already');
    return {
      collection,
      index: spec.name,
      status: alreadyExists ? 'skipped (already exists)' : 'failed',
      error: alreadyExists ? undefined : (err.message || err.errMsg)
    };
  }
}

exports.main = async (event, context) => {
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
    ['products',                       { name: 'tenantId_status',            keys: [{ tenantId: 1 }, { status: 1 }],                          unique: false }],
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

  const results = await Promise.all(tasks.map(([col, spec]) => ensureIndex(col, spec)));

  const created = results.filter(r => r.status === 'created').length;
  const skipped = results.filter(r => r.status.startsWith('skipped')).length;
  const failed  = results.filter(r => r.status === 'failed');

  return {
    success: failed.length === 0,
    summary: `新建 ${created} 条，已存在跳过 ${skipped} 条，失败 ${failed.length} 条`,
    results,
    failures: failed
  };
};
