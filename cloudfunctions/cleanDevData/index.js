// 云函数：cleanDevData
// 平台管理员专用运维工具：按 tenantId + reportDate 精准批量删除测试/脏
// 日报数据（report_logs），并同步清理这些日报里引用的云存储照片文件。
//
// 🛡️ 权限：仅 platform_admin 可调用，与本仓库其余"数据管理/清理"类高危
// 工具（activateTenantSubscription/manageTenantSubscription）同一条鉴权
// 口径。不对外暴露前端调用入口——这是运维工具，平台管理员通过云开发控制台
// "云函数测试"面板直接传参调用，不需要为此单独做一个前端表单页面。
//
// 🎯 精确匹配单日，不做日期范围批量删除：范围删除误删真实数据的风险更高，
// 与"清理某一天的测试数据"这个具体场景对齐即可，如需批量清理需要另开
// 专项方案（如加二次确认+预览命中条数）。
//
// 🖼️ 照片清理口径：report_logs 唯一的图片字段是 receiptImages（纯字符串
// 数组，存的是 wx.cloud.uploadFile 返回的 fileID，见 utils/dataService.ts
// saveReport() 头部注释——report_logs 唯一写入入口），没有其他图片字段需要
// 一并处理。先删数据库文档、再删云存储文件，避免"文件删了但文档还在、
// 前端渲染出裂图"这种中间态比"文档删了但文件还占空间"更糟。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const REPORT_LOGS_COLLECTION = 'report_logs';

function isCollectionNotExistError(err) {
  return !!err && (err.errCode === -502005 || /database collection not exists/i.test(String(err.errMsg || err.message || '')));
}

async function resolveCaller(openid) {
  if (!openid) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: openid }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

// 🗑️ 按 tenantId + reportDate 精确匹配删除日报 + 同步清理云存储照片
async function handleDeleteByTenantAndDate(event, OPENID) {
  const caller = await resolveCaller(OPENID);
  if (!caller || caller.role !== 'platform_admin') {
    return { success: false, error: '无权限：仅平台管理员可清理数据' };
  }

  const tenantId = String(event.tenantId || '').trim();
  const reportDate = String(event.reportDate || '').trim();
  if (!tenantId || !reportDate) {
    return { success: false, error: '参数缺失: tenantId/reportDate' };
  }

  let rows = [];
  try {
    const res = await db.collection(REPORT_LOGS_COLLECTION)
      .where({ tenantId, reportDate })
      .field({ _id: true, receiptImages: true })
      .get();
    rows = res.data || [];
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    return { success: true, deletedReportCount: 0, deletedFileCount: 0 };
  }

  if (rows.length === 0) {
    return { success: true, deletedReportCount: 0, deletedFileCount: 0 };
  }

  const reportIds = rows.map((r) => r._id);
  const fileIds = [];
  rows.forEach((r) => {
    (r.receiptImages || []).forEach((fileId) => {
      if (fileId) fileIds.push(fileId);
    });
  });

  await db.collection(REPORT_LOGS_COLLECTION).where({ _id: _.in(reportIds) }).remove();

  let deletedFileCount = 0;
  if (fileIds.length > 0) {
    // 🛡️ 云存储单次 deleteFile 最多 50 个 fileID，分批处理；单批失败不影响
    // 其余批次（如某个 fileID 早已被手动删过），累计成功计数，不中断整体流程
    const BATCH_SIZE = 50;
    for (let i = 0; i < fileIds.length; i += BATCH_SIZE) {
      const batch = fileIds.slice(i, i + BATCH_SIZE);
      try {
        const deleteRes = await cloud.deleteFile({ fileList: batch });
        const results = (deleteRes && deleteRes.fileList) || [];
        deletedFileCount += results.filter((r) => r.status === 0).length;
      } catch (err) {
        console.error('[cleanDevData] deleteFile 批次异常:', err);
      }
    }
  }

  return {
    success: true,
    deletedReportCount: reportIds.length,
    deletedFileCount
  };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  try {
    if (event.action === 'deleteByTenantAndDate') {
      return await handleDeleteByTenantAndDate(event, OPENID);
    }
    return { success: false, error: `不支持的 action: ${event.action}` };
  } catch (err) {
    console.error('[cleanDevData] 异常:', err);
    return { success: false, error: '操作失败，请重试' };
  }
};
