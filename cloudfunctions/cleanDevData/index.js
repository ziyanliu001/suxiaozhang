// 云函数：cleanDevData
// 平台管理员专用运维工具：按（tenantId 或 storeId）+ 目标日期批量删除
// 测试/脏数据，覆盖三张会带图片的业务表（report_logs 日报 / daily_menus
// 每日食谱 / activity_logs 门店日志——爱心墙"温情图册"的三个真实图片
// 来源，见 getPhotoArchive 头部注释），并同步清理这些记录引用的云存储
// 照片文件。
//
// action: 'scanByDate' —— 只读排查，不带身份限制、按日期扫描三张表，把
//   命中记录的 _id/tenantId/storeId/日期字段/图片字段完整打印+返回，用来
//   确认"这一天的数据到底在哪张表、tenantId/storeId 实际存的是什么值"。
//   建议先跑这个确认清楚，再用下面的 action 精确删。
// action: 'deleteByTenantAndDate' —— 真正执行删除，tenantId/storeId 至少
//   要提供一个（见该函数注释里"为什么不能完全不限定身份"的说明）。
//
// 🛡️ 权限：仅 platform_admin 可调用，与本仓库其余"数据管理/清理"类高危
// 工具（activateTenantSubscription/manageTenantSubscription）同一条鉴权
// 口径。不对外暴露前端调用入口——这是运维工具，平台管理员通过云开发控制台
// "云函数测试"面板直接传参调用，不需要为此单独做一个前端表单页面。
//
// 🎯 精确匹配单日（日期用前缀正则，兜住带时间后缀的历史脏数据），不做
// 日期范围批量删除：范围删除误删真实数据的风险更高，与"清理某一天的测试
// 数据"这个具体场景对齐即可，如需批量清理需要另开专项方案（如加二次
// 确认+预览命中条数）。
//
// 🖼️ 三张表各自的图片字段结构不同，核实自各自的云函数写入路径：
//   - report_logs.receiptImages：纯字符串数组，元素本身就是 fileID
//     （见 utils/dataService.ts saveReport() 头部注释——唯一写入入口）。
//   - daily_menus.images / activity_logs.images：`{url, thumbUrl, name?}[]`
//     对象数组——核实过 manageDailyMenu/manageActivityLog 两个写入云函数
//     对应的前端页面（daily-menu.ts/activity-log.ts），thumbUrl 恒等于
//     url（没有单独生成缩略图上传），url 本身就是云存储 fileID，只取
//     url 一份即可，不用把 thumbUrl 也当成另一个文件重复删一次。
//   - 三张表用的"日期"字段名不同（reportDate/dateString/eventTime），但
//     格式都是同一种 YYYY-MM-DD 字符串，可以直接复用同一个 event.reportDate
//     入参精确匹配三张表各自的日期字段，不需要让调用方分别传三个日期。
// 先删数据库文档、再删云存储文件，避免"文件删了但文档还在、前端渲染出
// 裂图"这种中间态比"文档删了但文件还占空间"更糟。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function isCollectionNotExistError(err) {
  return !!err && (err.errCode === -502005 || /database collection not exists/i.test(String(err.errMsg || err.message || '')));
}

// 🆕（排查"传了 storeId 依然 0 条"）转义关键词里的正则特殊字符——日期本身
// 是 YYYY-MM-DD 格式，"-"不是正则特殊字符不影响匹配，这里只是保持与
// manageTenantSubscription 的 escapeRegExp 同一套防御习惯
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 🆕 日期改用前缀正则匹配（^2026-07-21）而不是精确字符串相等——如果真实
// 存的日期带了时间后缀（如 "2026-07-21 08:30" 这类历史脏数据），精确匹配
// 会漏掉，前缀匹配能兜住这种情况。三张表各自的日期字段名（reportDate/
// dateString/eventTime）是从各自的写入云函数源码里核实过的真实字段名，
// 不是猜的，这里不额外去猜其他没有证据支持的字段名
function dateRegex(dateStr) {
  return db.RegExp({ regexp: `^${escapeRegExp(dateStr)}`, options: '' });
}

async function resolveCaller(openid) {
  if (!openid) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: openid }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

// 🗑️ 查询命中记录 + 收集其图片 fileID，不在这里做删除——三张表各自查完、
// 汇总出完整的待删 id/fileId 清单后，再统一批量删，避免"查一张删一张"中途
// 某一张表异常导致前面已经删掉、后面还没处理，数据处于不上不下的中间态。
// 同时把原始 rows 一并返回——调用方要在真正 remove() 之前把命中详情打印
// 出来供人工核对，不能删完了才后悔
async function collectMatchedRows(collectionName, whereClause, extractFileIds) {
  let rows = [];
  try {
    const res = await db.collection(collectionName).where(whereClause).limit(200).get();
    rows = res.data || [];
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    return { rows: [], ids: [], fileIds: [] };
  }
  const ids = rows.map((r) => r._id);
  const fileIds = [];
  rows.forEach((r) => {
    extractFileIds(r).forEach((fileId) => {
      if (fileId) fileIds.push(fileId);
    });
  });
  return { rows, ids, fileIds };
}

async function removeByIds(collectionName, ids) {
  if (ids.length === 0) return;
  await db.collection(collectionName).where({ _id: _.in(ids) }).remove();
}

// 🖼️ 云存储单次 deleteFile 最多 50 个 fileID，分批处理；单批失败不影响
// 其余批次（如某个 fileID 早已被手动删过），累计成功计数，不中断整体流程
async function deleteCloudFiles(fileIds) {
  let deletedFileCount = 0;
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
  return deletedFileCount;
}

// 🔍（只读排查，不删任何数据）不带 tenantId 限制、按日期前缀正则扫描三张表，
// 命中详情（_id/tenantId/storeId/日期字段值/图片字段）通过 console.log
// 完整打印，也原样放进返回体的 preview 里——用来确认"这一天的数据到底存在
// 哪张表、tenantId/storeId 实际存的是什么值"，确认清楚了再用
// deleteByTenantAndDate 精确删，不要没看过数据长什么样就直接删
async function handleScanByDate(event, openId) {
  const caller = await resolveCaller(openId);
  if (!caller || caller.role !== 'platform_admin') {
    return { success: false, error: '无权限：仅平台管理员可查看数据' };
  }

  const reportDate = String(event.reportDate || '').trim();
  if (!reportDate) {
    return { success: false, error: '参数缺失: reportDate' };
  }

  const scanOne = async (collectionName, dateField) => {
    try {
      const res = await db.collection(collectionName)
        .where({ [dateField]: dateRegex(reportDate) })
        .limit(50)
        .get();
      return res.data || [];
    } catch (err) {
      if (!isCollectionNotExistError(err)) throw err;
      return [];
    }
  };

  const [reportLogs, dailyMenus, activityLogs] = await Promise.all([
    scanOne('report_logs', 'reportDate'),
    scanOne('daily_menus', 'dateString'),
    scanOne('activity_logs', 'eventTime')
  ]);

  const preview = {
    report_logs: reportLogs.map((r) => ({ _id: r._id, tenantId: r.tenantId, storeId: r.storeId, reportDate: r.reportDate, receiptImages: r.receiptImages })),
    daily_menus: dailyMenus.map((r) => ({ _id: r._id, tenantId: r.tenantId, storeId: r.storeId, dateString: r.dateString, images: r.images })),
    activity_logs: activityLogs.map((r) => ({ _id: r._id, tenantId: r.tenantId, storeId: r.storeId, eventTime: r.eventTime, images: r.images }))
  };

  console.log('[cleanDevData] scanByDate 命中详情（不限 tenantId，各表最多 50 条）:', JSON.stringify(preview));

  return {
    success: true,
    counts: {
      report_logs: reportLogs.length,
      daily_menus: dailyMenus.length,
      activity_logs: activityLogs.length
    },
    preview
  };
}

// 🗑️ 按（tenantId 或 storeId，至少一项）+ 目标日期匹配，清理 report_logs/
// daily_menus/activity_logs 三张表的测试数据 + 同步清理引用的云存储照片。
//
// 🛡️（2026-09-08 收到"传了 storeId 依然 0 条"反馈后调整，如实说明取舍）
// 没有采纳"完全取消 tenantId/storeId 校验，只认角色+日期"这个方案——那会
// 把一个"清理某个机构某一天数据"的工具变成"清理全平台某一天所有机构数据"
// 的工具，对一个真删数据库记录+清空云存储文件的操作来说，误杀真实数据的
// 风险扩大到了整个平台，不是"仅测试环境可用"的安全豁免。改为两处有真实
// 依据的放宽：① identity 条件从"必须同时有 tenantId"放宽成"tenantId 或
// storeId 至少给一个就行"（不少测试数据是手工在控制台插入的，可能没有
// 正确挂 tenantId 但 storeId 是对的，这是更贴近真实原因的放宽，而不是
// 完全不限定身份）；② 日期改前缀正则而不是精确匹配，兜住"日期字段带时间
// 后缀"这种可能。调用前建议先用 action:'scanByDate' 看一眼真实命中的数据
// 长什么样，确认 tenantId/storeId 到底是什么值。
async function handleDeleteByTenantAndDate(event, openId) {
  const caller = await resolveCaller(openId);
  if (!caller || caller.role !== 'platform_admin') {
    return { success: false, error: '无权限：仅平台管理员可清理数据' };
  }

  const tenantId = String(event.tenantId || '').trim();
  const storeId = String(event.storeId || '').trim();
  const reportDate = String(event.reportDate || '').trim();
  if (!reportDate) {
    return { success: false, error: '参数缺失: reportDate' };
  }
  if (!tenantId && !storeId) {
    return { success: false, error: '参数缺失: tenantId 与 storeId 至少需要提供一个，避免误删其他机构的数据' };
  }

  const identityCondition = tenantId && storeId
    ? _.or([{ tenantId }, { storeId }])
    : tenantId
      ? { tenantId }
      : { storeId };
  const buildWhere = (dateField) => _.and([identityCondition, { [dateField]: dateRegex(reportDate) }]);

  const [reportLogs, dailyMenus, activityLogs] = await Promise.all([
    collectMatchedRows('report_logs', buildWhere('reportDate'), (r) => r.receiptImages || []),
    collectMatchedRows('daily_menus', buildWhere('dateString'), (r) => (r.images || []).map((img) => img && img.url)),
    collectMatchedRows('activity_logs', buildWhere('eventTime'), (r) => (r.images || []).map((img) => img && img.url))
  ]);

  // 🆕 真正 remove() 之前，先把命中的记录完整打印出来——删完了再想看已经
  // 来不及了，这是"删之前最后一次确认没删错"的机会
  console.log('[cleanDevData] deleteByTenantAndDate 即将删除的命中详情:', JSON.stringify({
    report_logs: reportLogs.rows.map((r) => ({ _id: r._id, tenantId: r.tenantId, storeId: r.storeId, reportDate: r.reportDate })),
    daily_menus: dailyMenus.rows.map((r) => ({ _id: r._id, tenantId: r.tenantId, storeId: r.storeId, dateString: r.dateString })),
    activity_logs: activityLogs.rows.map((r) => ({ _id: r._id, tenantId: r.tenantId, storeId: r.storeId, eventTime: r.eventTime }))
  }));

  await Promise.all([
    removeByIds('report_logs', reportLogs.ids),
    removeByIds('daily_menus', dailyMenus.ids),
    removeByIds('activity_logs', activityLogs.ids)
  ]);

  const allFileIds = [...reportLogs.fileIds, ...dailyMenus.fileIds, ...activityLogs.fileIds];
  const deletedFileCount = allFileIds.length > 0 ? await deleteCloudFiles(allFileIds) : 0;

  return {
    success: true,
    deletedReportCount: reportLogs.ids.length,
    deletedDailyMenuCount: dailyMenus.ids.length,
    deletedActivityLogCount: activityLogs.ids.length,
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
    if (event.action === 'scanByDate') {
      return await handleScanByDate(event, openId);
    }
    if (event.action === 'deleteByTenantAndDate') {
      return await handleDeleteByTenantAndDate(event, openId);
    }
    return { success: false, error: `不支持的 action: ${event.action}` };
  } catch (err) {
    console.error('[cleanDevData] 异常:', err);
    return { success: false, error: '操作失败，请重试' };
  }
};
