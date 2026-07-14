const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { queryStoreId, startDate, endDate, limit = 100, viewMode } = event;

  if (!OPENID) {
    return {
      success: false,
      error: '无法获取用户身份'
    };
  }

  try {
    // 1. 校验请求者身份
    const roleResult = await cloud.callFunction({
      name: 'checkUserRole',
      data: {}
    });

    const userInfo = roleResult.result;

    if (!userInfo || !userInfo.success) {
      return {
        success: false,
        error: '身份校验失败'
      };
    }

    const role = userInfo.role;
    const userStoreId = userInfo.storeId;
    const userStoreName = userInfo.storeName;

    let matchCondition = {};

    // 2. 核心隔离逻辑
    if (role === 'super_admin' && (!queryStoreId || queryStoreId === 'ALL')) {
      // 超级管理员查看全部门店，不限制 storeId
    } else if (role === 'super_admin' && queryStoreId && queryStoreId !== 'ALL') {
      // 超级管理员选择查看特定门店
      matchCondition.shopName = queryStoreId;
    } else {
      // 普通义工/财务/店长，强制绑定其所属门店
      if (userStoreId) {
        matchCondition.shopName = userStoreName;
      }
      // 个人统计模式额外过滤 _openid
      if (viewMode === 'personal') {
        matchCondition._openid = OPENID;
      }
    }

    // 3. 日期范围过滤
    if (startDate && endDate) {
      matchCondition.dateString = _.gte(startDate).and(_.lte(endDate));
    } else if (startDate) {
      matchCondition.dateString = _.gte(startDate);
    } else if (endDate) {
      matchCondition.dateString = _.lte(endDate);
    }

    // 4. 执行查询
    let query = db.collection('report_logs');
    if (Object.keys(matchCondition).length > 0) {
      query = query.where(matchCondition);
    }

    const logsRes = await query
      .orderBy('dateString', 'desc')
      .limit(limit)
      .get();

    return {
      success: true,
      currentUserRole: role,
      userStoreName: userStoreName,
      data: logsRes.data || [],
      total: (logsRes.data || []).length
    };
  } catch (err) {
    console.error('[getStoreReportLogs] 异常:', err);
    return {
      success: false,
      error: err.message || '查询餐报记录异常'
    };
  }
};
