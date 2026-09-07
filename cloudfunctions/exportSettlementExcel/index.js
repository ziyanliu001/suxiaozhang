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

    const ordersWhere = productIdFilter ? { tenantId, productId: _.in(productIdFilter) } : { tenantId };
    const ordersRes = await db.collection('production_orders').where(ordersWhere).limit(2000).get();
    const orders = ordersRes.data || [];
    if (orders.length === 0) return { success: false, errMsg: '暂无可导出的分成记录' };
    const orderIds = orders.map((o) => o._id);

    const settlementsRes = await db.collection('order_settlements').where({ tenantId, orderId: _.in(orderIds) }).limit(2000).get();
    const docs = settlementsRes.data || [];

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
