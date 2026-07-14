const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  try {
    const results = [];

    await db.collection('stores').createIndex({
      name: 'storeName_asc',
      keys: [{ storeName: 1 }],
      unique: false
    });
    results.push({ collection: 'stores', index: 'storeName_asc', status: 'success' });

    await db.collection('daily_reports').createIndex({
      name: 'storeId_date',
      keys: [{ storeId: 1 }, { reportDate: 1 }],
      unique: false
    });
    results.push({ collection: 'daily_reports', index: 'storeId_date', status: 'success' });

    await db.collection('daily_reports').createIndex({
      name: 'reportDate_asc',
      keys: [{ reportDate: 1 }],
      unique: false
    });
    results.push({ collection: 'daily_reports', index: 'reportDate_asc', status: 'success' });

    await db.collection('report_logs').createIndex({
      name: 'shopName_date',
      keys: [{ shopName: 1 }, { dateString: 1 }],
      unique: false
    });
    results.push({ collection: 'report_logs', index: 'shopName_date', status: 'success' });

    await db.collection('user_roles').createIndex({
      name: 'openid',
      keys: [{ _openid: 1 }],
      unique: false
    });
    results.push({ collection: 'user_roles', index: 'openid', status: 'success' });

    await db.collection('store_sponsor').createIndex({
      name: 'storeId',
      keys: [{ storeId: 1 }],
      unique: false
    });
    results.push({ collection: 'store_sponsor', index: 'storeId', status: 'success' });

    return {
      success: true,
      message: '索引创建完成',
      results
    };

  } catch (err) {
    console.error('索引创建失败:', err);
    return {
      success: false,
      errMsg: err.message,
      note: '部分索引可能已存在，这是正常情况。索引只需创建一次。'
    };
  }
};