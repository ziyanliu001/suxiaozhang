const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 🛡️ 全国总览/全部门店哨兵值：前端 index.ts 已经在 fetchStoreSponsor 里挡了
// 这两个值不再发起调用（见该方法注释），这里作为纵深防御同样识别、快速拒绝——
// 防止未来出现的其他调用方直接带着这类哨兵值调用本云函数时，绕开前端守卫，
// 退化成一次带假 storeId 的真实数据库查询
const NATIONAL_STORE_ID_SENTINELS = ['national_overview', 'ALL_STORES', 'all'];

exports.main = async (event, context) => {
  const { storeId } = event;

  if (!storeId || NATIONAL_STORE_ID_SENTINELS.includes(storeId)) {
    return { success: false, error: 'storeId required' };
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