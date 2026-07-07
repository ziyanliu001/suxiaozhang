const cloud = require('wx-server-sdk');

cloud.init({
  env: 'cloudbase-d8g7hg2bf851750ab'
});

const db = cloud.database();

exports.main = async (event, context) => {
  const { startDate, endDate, shopName } = event;
  const { OPENID } = cloud.getWXContext();

  try {
    if (!startDate || !endDate) {
      return {
        success: false,
        error: 'Missing startDate or endDate parameter'
      };
    }

    const result = await db.collection('report_logs')
      .aggregate()
      .match({
        dateString: db.command.gte(startDate).and(db.command.lte(endDate)),
        _openid: OPENID,
        ...(shopName && { shopName: shopName })
      })
      .group({
        _id: null,
        totalOtherDonation: db.command.aggregate.sum('otherDonation'),
        totalListDonation: db.command.aggregate.sum('listDonationTotal'),
        totalExpense: db.command.aggregate.sum('expenseAmount'),
        recordCount: db.command.aggregate.sum(1)
      })
      .end();

    let statistics = {
      totalIncome: 0,
      totalOtherDonation: 0,
      totalListDonation: 0,
      totalExpense: 0,
      recordCount: 0,
      netBalance: 0,
      startDate: startDate,
      endDate: endDate
    };

    if (result.list && result.list.length > 0) {
      const data = result.list[0];
      statistics.totalOtherDonation = Math.round((data.totalOtherDonation || 0) * 100) / 100;
      statistics.totalListDonation = Math.round((data.totalListDonation || 0) * 100) / 100;
      statistics.totalExpense = Math.round((data.totalExpense || 0) * 100) / 100;
      statistics.recordCount = data.recordCount || 0;
    }

    statistics.totalIncome = Math.round((statistics.totalOtherDonation + statistics.totalListDonation) * 100) / 100;
    statistics.netBalance = Math.round((statistics.totalIncome - statistics.totalExpense) * 100) / 100;

    const dailyResult = await db.collection('report_logs')
      .where({
        dateString: db.command.gte(startDate).and(db.command.lte(endDate)),
        _openid: OPENID,
        ...(shopName && { shopName: shopName })
      })
      .orderBy('dateString', 'asc')
      .get();

    statistics.dailyRecords = dailyResult.data.map(item => ({
      date: item.dateString,
      otherDonation: item.otherDonation || 0,
      listDonation: item.listDonationTotal || 0,
      expense: item.expenseAmount || 0,
      income: (item.otherDonation || 0) + (item.listDonationTotal || 0),
      balance: item.todayBalance || 0
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