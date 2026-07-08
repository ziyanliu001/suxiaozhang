const cloud = require('wx-server-sdk');

cloud.init({
  env: 'cloudbase-d8g7hg2bf851750ab'
});

const db = cloud.database();

exports.main = async (event, context) => {
  const { startDate, endDate, shopName, limit = 100, viewMode } = event;
  const { OPENID } = cloud.getWXContext();

  try {
    const userRes = await db.collection('users')
      .where({ _openid: OPENID })
      .limit(1)
      .get();
    const userRole = userRes.data && userRes.data.length > 0 ? userRes.data[0].role : 'user';

    let whereConditions = {};
    if (startDate && endDate) {
      whereConditions.dateString = db.command.gte(startDate).and(db.command.lte(endDate));
    } else if (startDate) {
      whereConditions.dateString = db.command.gte(startDate);
    } else if (endDate) {
      whereConditions.dateString = db.command.lte(endDate);
    }

    if (shopName) {
      whereConditions.shopName = shopName;
    }

    const shouldFilterByOpenid = (viewMode === 'personal') || (userRole !== 'admin' && viewMode !== 'all');
    if (shouldFilterByOpenid) {
      whereConditions._openid = OPENID;
    }

    let query = db.collection('report_logs');
    if (Object.keys(whereConditions).length > 0) {
      query = query.where(whereConditions);
    }

    const result = await query.orderBy('dateString', 'desc').limit(limit).get();

    return {
      success: true,
      data: result.data || [],
      role: userRole,
      total: (result.data || []).length
    };
  } catch (error) {
    console.error('getReports error:', error);
    return {
      success: false,
      error: error.message
    };
  }
};
