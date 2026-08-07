// 云函数：getVolunteerHonorStats
//
// 「志愿者爱心荣誉卡」的数据来源：只统计"本人亲手提交过的账目"，不编造/估算数据。
//
// report_logs 是前端直接调用 db.collection('report_logs').add()（见 dataService.ts）
// 写入的，微信云开发会自动给每条记录打上创建者的真实 _openid，且不可被客户端伪造——
// 本函数据此按 _openid 查询，天然就是"该志愿者亲手提交的报告"，比任何前端估算都可靠。
//
// 服务天数（serviceDays）不在本函数里算：那是义工到岗打卡的本地统计（my_checkin_days），
// 与"提交账目"是两件不同的事，由调用页面（journey.ts）自己从本地存储读取即可，
// 不需要为此新增服务端查询。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// -502005: 集合不存在（volunteer_duty_logs 尚未写入任何打卡记录时会触发）
// 与 manageNotice/submitFeedback 同一套自愈口径：降级为空数据，不让 -502005 穿透到前端
function isCollectionNotExistError(err) {
  return !!err && (
    err.errCode === -502005 ||
    /database collection not exists/i.test(String(err.errMsg || err.message || ''))
  );
}

async function handlePersonalStats(OPENID) {
  let reportCount = 0;
  let diningCount = 0;
  let skip = 0;
  const batchLimit = 100;

  while (true) {
    const batch = await db.collection('report_logs')
      .where({ _openid: OPENID, isVoid: _.neq(true) })
      .field({ diningCount: true, diners: true })
      .skip(skip)
      .limit(batchLimit)
      .get();

    if (!batch.data || batch.data.length === 0) break;

    batch.data.forEach((item) => {
      reportCount++;
      diningCount += parseInt(item.diningCount || item.diners || 0, 10);
    });

    if (batch.data.length < batchLimit) break;
    skip += batchLimit;
    if (skip >= 2000) break; // 防御性上限，避免极端账号无限翻页
  }

  return { success: true, reportCount, diningCount };
}

// 🌟 全国纵览（journey.ts「暖心历程」页专属，仅 super_admin 可调用）：聚合调用者
// 所属机构（tenantId）范围内、全部门店的义工工时数据 + 报表供餐数据。
// 🛡️ 权限与隔离：与本项目其余"总览级"查询同一套口径——严格收敛在 caller.tenantId
// 内，绝不跨机构；非 super_admin 或账号缺失 tenantId 一律拒绝，不静默降级返回空数据
// （避免"看起来查到了 0"与"其实没权限"混淆）。
// 数据来源：volunteer_duty_logs（工时/义工数/打卡天数，与 manageVolunteerCheckIn
// 的 leaderboard 同一张表，这里不限 storeId，覆盖机构内全部门店）+ report_logs
// （供餐人次/报表数/活跃门店数，与本函数个人版同一张表，这里不限 _openid）
async function handleNetworkSummary(OPENID) {
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  const caller = (roleRes.data && roleRes.data[0]) || null;
  if (!caller || caller.role !== 'super_admin') {
    return { success: false, error: '无权限：仅超级管理员可查看全国纵览数据' };
  }
  if (!caller.tenantId) {
    return { success: false, error: '您的管理员账号缺少所属机构（tenantId）信息，无法查看全国纵览' };
  }
  const tenantId = caller.tenantId;
  const batchLimit = 100;
  const BATCH_CAP = 5000; // 与 manageVolunteerCheckIn 的 leaderboard 同一防御性上限

  const volunteerOpenids = new Set();
  const volunteerDays = new Set();
  let totalHours = 0;
  let skip = 0;
  // 🛡️ volunteer_duty_logs 在没有任何云端打卡记录时不存在，-502005 降级为空集合
  let dutyLogsAvailable = true;
  while (dutyLogsAvailable) {
    let batch;
    try {
      batch = await db.collection('volunteer_duty_logs')
        .where({ tenantId, status: 'active' })
        .field({ _openid: true, hours: true, dateString: true })
        .skip(skip)
        .limit(batchLimit)
        .get();
    } catch (err) {
      if (isCollectionNotExistError(err)) { dutyLogsAvailable = false; break; }
      throw err;
    }
    if (!batch.data || batch.data.length === 0) break;
    batch.data.forEach((item) => {
      volunteerOpenids.add(item._openid);
      volunteerDays.add(`${item._openid}_${item.dateString}`);
      totalHours += parseFloat(item.hours) || 0;
    });
    if (batch.data.length < batchLimit) break;
    skip += batchLimit;
    if (skip >= BATCH_CAP) break;
  }

  let reportCount = 0;
  let diningCount = 0;
  const activeStoreIds = new Set();
  skip = 0;
  while (true) {
    let batch;
    try {
      batch = await db.collection('report_logs')
        .where({ tenantId, isVoid: _.neq(true) })
        .field({ diningCount: true, diners: true, storeId: true })
        .skip(skip)
        .limit(batchLimit)
        .get();
    } catch (err) {
      if (isCollectionNotExistError(err)) break;
      throw err;
    }
    if (!batch.data || batch.data.length === 0) break;
    batch.data.forEach((item) => {
      reportCount++;
      diningCount += parseInt(item.diningCount || item.diners || 0, 10);
      if (item.storeId) activeStoreIds.add(item.storeId);
    });
    if (batch.data.length < batchLimit) break;
    skip += batchLimit;
    if (skip >= BATCH_CAP) break;
  }

  return {
    success: true,
    totalVolunteers: volunteerOpenids.size,
    totalServiceDays: volunteerDays.size,
    totalServiceHours: parseFloat(totalHours.toFixed(1)),
    totalReportCount: reportCount,
    totalDiningCount: diningCount,
    totalActiveStores: activeStoreIds.size
  };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { success: false, error: '无法获取用户身份' };
  }

  const action = (event && event.action) || 'personal';

  try {
    if (action === 'networkSummary') {
      return await handleNetworkSummary(OPENID);
    }
    return await handlePersonalStats(OPENID);
  } catch (err) {
    console.error('[getVolunteerHonorStats] 异常:', err);
    return { success: false, error: err.message || '荣誉数据查询失败' };
  }
};
