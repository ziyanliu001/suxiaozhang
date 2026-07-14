const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  try {
    const res = await db.collection('volunteer_logs')
      .where({ _openid: openid })
      .get();

    const logs = res.data || [];

    let totalHours = 0;
    let totalTimes = logs.length;
    const servedStoresSet = new Set();

    logs.forEach(log => {
      totalHours += Number(log.hours || 0);
      if (log.storeName) servedStoresSet.add(log.storeName);
      if (log.storeId) servedStoresSet.add(log.storeId);
    });

    let honorTitle = '爱心义工';
    if (totalHours >= 100) {
      honorTitle = '金牌义工';
    } else if (totalHours >= 30) {
      honorTitle = '资深义工';
    }

    return {
      success: true,
      data: {
        totalHours: parseFloat(totalHours.toFixed(2)),
        totalTimes: totalTimes,
        servedStoresCount: servedStoresSet.size,
        servedStoresList: Array.from(servedStoresSet),
        honorTitle: honorTitle
      }
    };

  } catch (err) {
    return { success: false, errMsg: err.message };
  }
};