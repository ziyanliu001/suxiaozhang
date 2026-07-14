const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
  const { storeId } = event;

  if (!storeId) {
    return { success: false, error: '缺少 storeId 参数' };
  }

  try {
    const db = cloud.database();
    const now = new Date();
    const nowStr = now.toISOString().split('T')[0];

    const res = await db.collection('sponsors')
      .where({
        storeId: db.command.in([storeId, 'all']),
        status: 'active',
        startDate: db.command.lte(nowStr),
        endDate: db.command.gte(nowStr)
      })
      .orderBy('storeId', 'asc')
      .limit(1)
      .get();

    if (res.data && res.data.length > 0) {
      return {
        success: true,
        data: res.data[0]
      };
    }

    return { success: true, data: null };
  } catch (err) {
    console.error('[getStoreSponsor] 查询失败:', err);
    return { success: true, data: null };
  }
};