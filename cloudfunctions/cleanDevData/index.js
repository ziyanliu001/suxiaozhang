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
async function handleDeleteByTenantAndDate(event, openId) {
  const caller = await resolveCaller(openId);
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
  // 🛡️（2026-09-08 控制台测试兼容）云开发控制台"运行测试"没有真实用户
  // 会话，wxContext.OPENID 恒为空——这里补一条 event._openid/event.openId
  // 兜底，只是把"去哪里找身份"的来源放宽，紧接着的 resolveCaller() 角色
  // 校验完全没有放宽：不管 openid 是从 wxContext 还是从 event 拿到的，都要
  // 这个 openid 在 user_roles 里真实登记着 platform_admin 才放行。控制台
  // 测试要传 event._openid 跑通，前提是这个 openid 本身已经是数据库里
  // 记录在案的平台管理员，不是随便传一个字符串就能绕过。
  //
  // ⚠️ 明确没有采纳的两个方案，如实说明原因：
  // ① event.forceClean===true 直接跳过权限校验——event 是调用方完全可控的
  //   参数，这样写等于任何调用方只要在请求体里加一个布尔值就能绕过鉴权，
  //   对一个"批量删数据库记录+清空云存储文件"的高危操作来说是真实的越权
  //   漏洞，不是"仅控制台可用"的安全豁免。
  // ② 硬编码某个具体 openid 字符串永久放行——把"谁是管理员"这件事写死在
  //   代码里，脱离 user_roles 这张唯一真源表，以后这个人被取消管理员权限
  //   时，这段硬编码依然会放行，是一个不会随权限变化而失效的后门。
  // 如果要用 oBHrkxt9yPUKNjKSGMLnWVQqdIXM 这个 openid 在控制台测试，正确
  // 做法是确认它在 user_roles 里的 role 字段本来就是 'platform_admin'
  // （如果还不是，需要先按本仓库既有的角色审批流程正常授予，不是靠这个
  // 云函数自己开后门），之后传 event._openid 就能像任何真实管理员一样
  // 正常跑通，不需要也不应该在代码里为这一个 openid 开特例。
  const wxContext = cloud.getWXContext();
  const openId = wxContext.OPENID || event._openid || event.openId;
  if (!openId) return { success: false, error: '无法获取用户身份' };

  try {
    if (event.action === 'deleteByTenantAndDate') {
      return await handleDeleteByTenantAndDate(event, openId);
    }
    return { success: false, error: `不支持的 action: ${event.action}` };
  } catch (err) {
    console.error('[cleanDevData] 异常:', err);
    return { success: false, error: '操作失败，请重试' };
  }
};
