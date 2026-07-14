const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { storeId, shopName, modifiedDate } = event;

  // 兼容：优先使用 shopName，其次回退到 storeId
  const storeFilter = shopName || storeId;

  if (!storeFilter || !modifiedDate) {
    return { success: false, errMsg: '缺失必要的 shopName/storeId 或 modifiedDate 参数' };
  }

  try {
    // 查询 report_logs 集合（非 daily_reports），使用 dateString 做 ISO 日期比较
    const listRes = await db.collection('report_logs')
      .where({
        shopName: storeFilter,
        dateString: _.gte(modifiedDate)
      })
      .orderBy('dateString', 'asc')
      .get();

    const records = listRes.data || [];
    if (records.length === 0) {
      return { success: true, updatedCount: 0 };
    }

    let lastCalculatedTodayBalance = null;
    const updatePromises = [];

    for (let i = 0; i < records.length; i++) {
      const item = records[i];
      let currentYesterdayBal = parseFloat(item.yesterdayBalance || 0);

      // 收入 = 列表捐款总额 + 其他支持金额
      let income = parseFloat(item.listDonationTotal || 0) + parseFloat(item.otherDonation || 0);

      // 支出 = 每日食材支出 + 固定大额支出
      let expense = parseFloat(item.dailyExpenseTotal || 0) + parseFloat(item.fixedExpenseTotal || 0);

      // 从第二天起，昨日余额 = 前一天的今日结余
      if (i > 0 && lastCalculatedTodayBalance !== null) {
        currentYesterdayBal = lastCalculatedTodayBalance;
      }

      const currentTodayBal = Math.round((currentYesterdayBal + income - expense) * 100) / 100;
      lastCalculatedTodayBalance = currentTodayBal;

      updatePromises.push(
        db.collection('report_logs').doc(item._id).update({
          data: {
            yesterdayBalance: currentYesterdayBal,
            todayBalance: currentTodayBal,
            lastCascadeCalculatedAt: db.serverDate()
          }
        })
      );
    }

    await Promise.all(updatePromises);

    return {
      success: true,
      updatedCount: records.length,
      message: `成功联动校正了 ${records.length} 天的账目数据`
    };

  } catch (err) {
    console.error('Cascade recalculation failed:', err);
    return { success: false, errMsg: err.message };
  }
};
