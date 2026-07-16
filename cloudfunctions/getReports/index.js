const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event, context) => {
  const { startDate, endDate, shopName, storeId, mpAccount, limit = 100, viewMode } = event;
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

    // 🔑 多门店数据强隔离：storeId 非空且不是全国总览标识时加入查询条件
    if (storeId && storeId !== 'national_overview' && storeId !== 'ALL_STORES' && storeId !== 'all_stores') {
      whereConditions.storeId = storeId;
    }

    if (shopName) {
      whereConditions.shopName = shopName;
    }

    if (mpAccount) {
      whereConditions.mpAccount = mpAccount;
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
