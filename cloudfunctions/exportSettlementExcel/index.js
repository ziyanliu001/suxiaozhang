// 云函数：exportSettlementExcel — 护城河三 M2：对账明细导出（Excel）。
//
// 结构参考仓库既有 exportAccountExcel 的路由分发 + lib 建表模式，但作用对象
// 是 order_settlements（工坊分账快照），与 report_logs（雨花公益记账流水）
// 数据模型完全不同，本仓库云函数间无共享模块（各自独立部署），不跨函数复用
// 任何代码。
//
// 权限口径与 getSettlementSummary 完全一致：space_owner/space_admin 看全
// 租户，producer 只看自己名下商品产生的分成明细——导出的是同一份数据，权限
// 不应该比"能看"更宽松。
//
// 🌟「先核对、再确认、后导出」：previewOnly 模式下只查询/归并/复核，不触碰
// ExcelJS 工作簿构建与云存储上传，与 exportAccountExcel 同一套安全闭环。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { buildDetailRows } = require('./lib/bucketSettlements');
const { checkInvariant } = require('./lib/checkInvariant');
const { buildSettlementWorkbook } = require('./lib/buildSettlementWorkbook');
const { fetchAllInBatches } = require('./lib/batchQuery');

// 🛡️（2026-09-16 内存与性能加固）config.json 已新增 timeout: 20（秒，此前
// 本函数完全没有 config.json，会静默走平台默认的 3 秒）——FUNCTION_TIMEOUT_MS
// 必须和它保持一致，两处一起改。SAFETY_MARGIN_MS 留给"停止拉取数据之后建表
// +上传"这几步的余量
const FUNCTION_TIMEOUT_MS = 20000;
const SAFETY_MARGIN_MS = 5000;

function yuan(fen) {
  return ((fen || 0) / 100).toFixed(2);
}

// 🚨 查 tenant_members 而不是 user_roles：见 createProductionSpace/index.js
// 头部注释——live_factory 成员记录绝不能混进雨花公益专区依赖的 user_roles。
async function verifyTenantAccess(openid, tenantId, requiredRoles) {
  const res = await db.collection('tenant_members')
    .where({ _openid: openid, tenantId, status: 'approved' })
    .get();
  return (res.data || []).find((r) => requiredRoles.includes(r.role)) || null;
}

function withinDateRange(row, startDate, endDate) {
  if (!startDate && !endDate) return true;
  if (!row.createdAt) return false;
  const d = new Date(row.createdAt);
  if (isNaN(d.getTime())) return false;
  const dateStr = d.toISOString().slice(0, 10);
  if (startDate && dateStr < startDate) return false;
  if (endDate && dateStr > endDate) return false;
  return true;
}

exports.main = async (event) => {
  const deadline = Date.now() + FUNCTION_TIMEOUT_MS - SAFETY_MARGIN_MS;
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, errMsg: '无法获取用户身份' };

  const tenantId = String(event.tenantId || '');
  if (!tenantId) return { success: false, errMsg: '参数缺失: tenantId' };

  const startDate = event.startDate || '';
  const endDate = event.endDate || '';
  const previewOnly = !!event.previewOnly;

  try {
    const caller = await verifyTenantAccess(OPENID, tenantId, ['space_owner', 'space_admin', 'producer']);
    if (!caller) return { success: false, errMsg: '无权限：仅空间负责人/管理员/制作方可导出对账明细' };

    let productIdFilter = null;
    if (caller.role === 'producer') {
      const productsRes = await db.collection('products').where({ tenantId, producerOpenId: OPENID }).get();
      productIdFilter = (productsRes.data || []).map((p) => p._id);
      if (productIdFilter.length === 0) return { success: false, errMsg: '暂无可导出的分成记录' };
    }

    // 🐛 根因修复（静默数据丢失）：微信云开发数据库单次 .get() 硬性上限是
    // 1000 条，此前这里直接 .limit(2000).get() 单次查询——租户订单/分账记录
    // 超过 1000 条时，超出部分被数据库静默截断，导出的对账表格里凭空少了
    // 数据，没有任何报错提示。改用 fetchAllInBatches 分批拉取，见
    // lib/batchFetchPlan.js 头部注释；分批拉取依赖稳定排序，统一按 _id 升序
    // （production_orders/order_settlements 均未维护面向导出场景的时间索引，
    // _id 是唯一确定存在、天然唯一的排序字段）
    const ordersWhere = productIdFilter ? { tenantId, productId: _.in(productIdFilter) } : { tenantId };
    const ordersResult = await fetchAllInBatches(
      db.collection('production_orders').where(ordersWhere).orderBy('_id', 'asc'),
      { maxTotal: 2000, deadline }
    );
    const orders = ordersResult.records;
    if (orders.length === 0) return { success: false, errMsg: '暂无可导出的分成记录' };
    const orderIds = orders.map((o) => o._id);

    const settlementsResult = await fetchAllInBatches(
      db.collection('order_settlements').where({ tenantId, orderId: _.in(orderIds) }).orderBy('_id', 'asc'),
      { maxTotal: 2000, deadline }
    );
    const docs = settlementsResult.records;

    // 🛡️ 执行超时阻断：任一阶段分批拉取已经耗尽安全时间预算时，不再继续往下
    // 走归并/建表这些同样需要时间的步骤，明确告知用户原因，而不是任由云函数
    // 在超时边缘被平台强制杀死、前端只收到一个无意义的网络错误
    if (ordersResult.hitDeadline || settlementsResult.hitDeadline) {
      return {
        success: false,
        errMsg: `数据量过大（已拉取 ${orders.length} 笔订单/${docs.length} 条结算记录仍未拉完），请缩短日期范围后重试`
      };
    }

    let rows = buildDetailRows(docs)
      .filter((r) => withinDateRange(r, startDate, endDate))
      .sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      })
      .map((r) => ({ ...r, invariantOk: checkInvariant(r) }));

    if (rows.length === 0) return { success: false, errMsg: '该周期内无对账记录可导出' };

    const anomalyCount = rows.filter((r) => !r.invariantOk).length;

    if (previewOnly) {
      const summary = rows.reduce((acc, r) => {
        acc.payAmount += r.payAmount || 0;
        acc.producerAmount += r.producerAmount || 0;
        acc.promoterAmount += r.promoterAmount || 0;
        acc.platformFee += r.platformFee || 0;
        return acc;
      }, { payAmount: 0, producerAmount: 0, promoterAmount: 0, platformFee: 0 });

      return {
        success: true,
        previewOnly: true,
        recordCount: rows.length,
        anomalyCount,
        records: rows.slice(0, 200).map((r) => ({
          orderId: r.orderId,
          settlementStatus: r.settlementStatus,
          payAmountYuan: yuan(r.payAmount),
          producerAmountYuan: yuan(r.producerAmount),
          promoterAmountYuan: yuan(r.promoterAmount),
          platformFeeYuan: yuan(r.platformFee),
          invariantOk: r.invariantOk
        })),
        summary: {
          recordCount: rows.length,
          anomalyCount,
          payAmountYuan: yuan(summary.payAmount),
          producerAmountYuan: yuan(summary.producerAmount),
          promoterAmountYuan: yuan(summary.promoterAmount),
          platformFeeYuan: yuan(summary.platformFee)
        }
      };
    }

    return await buildSettlementWorkbook(cloud, { tenantId, rows, startDate, endDate });
  } catch (err) {
    console.error('💥 [exportSettlementExcel] 失败:', err);
    return { success: false, errMsg: err.message || '导出失败' };
  }
};
