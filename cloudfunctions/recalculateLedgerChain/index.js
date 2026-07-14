const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { shopName, storeId } = event;
  const targetShop = shopName || storeId || '';
  console.log('🔄 [一键校准] 开始按时间线全量串行推算，传入门店:', targetShop);

  try {
    let query = db.collection('daily_records');
    if (targetShop && targetShop !== 'all') {
      query = query.where(db.command.or([
        { storeId: targetShop },
        { shopName: targetShop }
      ]));
    }

    const countRes = await query.count();
    const total = countRes.total;
    let records = [];
    const batchSize = 100;

    for (let i = 0; i < total; i += batchSize) {
      const batchRes = await query
        .orderBy('date', 'asc')
        .skip(i)
        .limit(batchSize)
        .get();
      records = records.concat(batchRes.data || []);
    }

    if (records.length === 0) {
      return { success: true, msg: '未找到待校准的记录', updatedCount: 0 };
    }

    console.log(`📋 成功检索到 ${records.length} 条历史记录，开始顺序校准...`);

    let runningBalance = 0;
    let updatedCount = 0;

    for (let i = 0; i < records.length; i++) {
      const doc = records[i];
      const income = Number(doc.income || doc.selfSponsor || doc.listDonationTotal || doc.otherDonation || 0);
      const expense = Number(doc.expense || doc.dailyExpenseTotal || doc.fixedExpenseTotal || 0);

      const yesterdayBal = (i === 0) ? Number(doc.yesterdayBalance || 0) : runningBalance;
      const todayBal = yesterdayBal + income - expense;

      await db.collection('daily_records').doc(doc._id).update({
        data: {
          yesterdayBalance: yesterdayBal.toFixed(2),
          todayBalance: todayBal.toFixed(2),
          netIncrease: (income - expense).toFixed(2),
          updateTime: db.serverDate()
        }
      });

      updatedCount++;
      runningBalance = todayBal;

      console.log(`✅ [已校准] ${doc.date}: 昨日(${yesterdayBal.toFixed(2)}) + 增(${income - expense}) => 今日(${todayBal.toFixed(2)})`);
    }

    return {
      success: true,
      updatedCount: updatedCount,
      finalBalance: runningBalance.toFixed(2),
      msg: `全线 ${updatedCount} 条记录已按时间顺序全量校准完成！`
    };

  } catch (err) {
    console.error('💥 [校准异常]:', err);
    return { success: false, errMsg: err.message };
  }
};
