const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { clearReports, clearRequests, clearInvites } = event;
  const result = { reportsDeleted: 0, requestsDeleted: 0, invitesDeleted: 0 };

  try {
    if (clearReports) {
      const reportRes = await db.collection('daily_reports').where({
        _id: _.exists(true)
      }).remove();
      result.reportsDeleted = reportRes.stats ? reportRes.stats.removed : (reportRes.removed || 0);
    }

    if (clearReports) {
      const logRes = await db.collection('report_logs').where({
        _id: _.exists(true)
      }).remove();
      result.reportsDeleted += logRes.stats ? logRes.stats.removed : (logRes.removed || 0);
    }

    if (clearRequests) {
      const requestRes = await db.collection('role_requests').where({
        _id: _.exists(true)
      }).remove();
      result.requestsDeleted = requestRes.stats ? requestRes.stats.removed : (requestRes.removed || 0);
    }

    if (clearInvites) {
      const inviteRes = await db.collection('store_invites').where({
        _id: _.exists(true)
      }).remove();
      result.invitesDeleted = inviteRes.stats ? inviteRes.stats.removed : (inviteRes.removed || 0);
    }

    return {
      success: true,
      log: '测试数据清洗成功',
      data: result
    };

  } catch (err) {
    return {
      success: false,
      error: err.message || err
    };
  }
};