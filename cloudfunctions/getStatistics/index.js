const cloud = require('wx-server-sdk');

cloud.init({
  env: 'cloudbase-d8g7hg2bf851750ab'
});

const db = cloud.database();

exports.main = async (event, context) => {
  const { period, year, month } = event;
  const { OPENID } = cloud.getWXContext();

  try {
    let startDate, endDate;

    if (period === 'week') {
      const now = new Date();
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1);
      startDate = new Date(now.setDate(diff));
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 7);
      endDate.setHours(0, 0, 0, 0);
    } else if (period === 'month') {
      startDate = new Date(year, month - 1, 1);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(year, month, 1);
      endDate.setHours(0, 0, 0, 0);
    } else {
      return {
        success: false,
        error: 'Invalid period parameter'
      };
    }

    const startTimestamp = startDate.getTime();
    const endTimestamp = endDate.getTime();

    const result = await db.collection('meal_reports')
      .aggregate()
      .match({
        createTime: db.command.gte(startTimestamp).and(db.command.lt(endTimestamp)),
        _openid: OPENID
      })
      .group({
        _id: null,
        totalDonations: db.command.aggregate.sum('donationsTotal'),
        totalBatch4: db.command.aggregate.sum('batch4'),
        totalExpenses: db.command.aggregate.sum('expensesAmount'),
        totalIncome: db.command.aggregate.sum('todayTotalSum'),
        recordCount: db.command.aggregate.sum(1)
      })
      .end();

    let statistics = {
      totalDonations: 0,
      totalBatch4: 0,
      totalExpenses: 0,
      totalIncome: 0,
      recordCount: 0,
      period: period,
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0]
    };

    if (result.list && result.list.length > 0) {
      const data = result.list[0];
      statistics.totalDonations = Math.round((data.totalDonations || 0) * 100) / 100;
      statistics.totalBatch4 = Math.round((data.totalBatch4 || 0) * 100) / 100;
      statistics.totalExpenses = Math.round((data.totalExpenses || 0) * 100) / 100;
      statistics.totalIncome = Math.round((data.totalIncome || 0) * 100) / 100;
      statistics.recordCount = data.recordCount || 0;
    }

    statistics.netBalance = Math.round((statistics.totalIncome - statistics.totalExpenses) * 100) / 100;

    const dailyResult = await db.collection('meal_reports')
      .where({
        createTime: db.command.gte(startTimestamp).and(db.command.lt(endTimestamp)),
        _openid: OPENID
      })
      .orderBy('createTime', 'asc')
      .get();

    statistics.dailyRecords = dailyResult.data.map(item => ({
      date: item.reportDate,
      donations: item.donationsTotal || 0,
      batch4: item.batch4 || 0,
      expenses: item.expensesAmount || 0,
      income: item.todayTotalSum || 0,
      balance: item.newBalance || 0
    }));

    return {
      success: true,
      data: statistics
    };
  } catch (error) {
    console.error('Statistics calculation error:', error);
    return {
      success: false,
      error: error.message
    };
  }
};