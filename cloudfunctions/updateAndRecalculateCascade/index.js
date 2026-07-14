const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function round2(num) {
  return Math.round((parseFloat(num || 0) + Number.EPSILON) * 100) / 100;
}

function calculateIncome(doc) {
  return round2(parseFloat(doc.listDonationTotal || 0) + parseFloat(doc.otherDonation || 0));
}

function calculateExpense(doc) {
  return round2(parseFloat(doc.dailyExpenseTotal || 0) + parseFloat(doc.fixedExpenseTotal || 0));
}

async function checkCanEdit(doc) {
  const { OPENID } = cloud.getWXContext();
  if (!doc || doc._openid === OPENID) return true;

  try {
    const roleRes = await db.collection('user_roles')
      .where({ _openid: OPENID })
      .limit(1)
      .get();

    if (roleRes.data && roleRes.data.length > 0 && roleRes.data[0].role === 'super_admin') {
      return true;
    }

    const userRes = await db.collection('users')
      .where({ _openid: OPENID })
      .limit(1)
      .get();

    if (userRes.data && userRes.data.length > 0 && userRes.data[0].role === 'admin') {
      return true;
    }
  } catch (e) {
    console.warn('[updateAndRecalculateCascade] 权限校验异常:', e);
  }

  return false;
}

exports.main = async (event, context) => {
  console.log('📥 [updateAndRecalculateCascade] 收到请求参数:', JSON.stringify(event));

  const { docId, shopName, storeId, reportDate, yesterdayBalance, income, expense, diningPeople, volunteers, receiptImageList, modifyReason } = event;
  const targetShop = shopName || storeId || '';
  const strReportDate = String(reportDate || '').trim();

  if (!docId || !strReportDate || !targetShop) {
    return { success: false, errMsg: '核心参数缺失: docId / reportDate / shopName' };
  }

  try {
    const numYesterdayBal = round2(yesterdayBalance);
    const numIncome = round2(income);
    const numExpense = round2(expense);
    const newTodayBal = round2(numYesterdayBal + numIncome - numExpense);
    const netIncrease = round2(numIncome - numExpense);

    // 1. 取出原记录做权限校验
    const logRes = await db.collection('report_logs').doc(docId).get();
    const logData = logRes.data;
    if (!logData) {
      return { success: false, errMsg: '记录不存在' };
    }

    const canEdit = await checkCanEdit(logData);
    if (!canEdit) {
      return { success: false, errMsg: '无权限修改该记录' };
    }

    console.log(`📊 [Step 1] 更新起始记录: Date=${strReportDate}, NewBalance=${newTodayBal}`);

    // 2. 更新被编辑的单条记录（把简化后的收入/支出归入主要字段）
    await db.collection('report_logs').doc(docId).update({
      data: {
        yesterdayBalance: numYesterdayBal,
        listDonationTotal: numIncome,
        otherDonation: 0,
        dailyExpenseTotal: numExpense,
        fixedExpenseTotal: 0,
        expenseAmount: numExpense,
        todayBalance: newTodayBal,
        netIncrease: netIncrease,
        diningPeople: Number(diningPeople || 0),
        volunteers: Number(volunteers || 0),
        receiptImageList: receiptImageList || [],
        modifyReason: modifyReason || '',
        updateTime: db.serverDate()
      }
    });

    // 3. 拉取目标日期及之后的所有记录进行级联
    const listRes = await db.collection('report_logs')
      .where({
        shopName: targetShop,
        dateString: _.gte(strReportDate)
      })
      .orderBy('dateString', 'asc')
      .get();

    const records = listRes.data || [];
    console.log(`📦 [Step 2] 查找到 >= ${strReportDate} 的记录共 ${records.length} 条`);

    if (records.length === 0) {
      return { success: true, updatedCount: 1, message: '已更新当前记录' };
    }

    let runningTodayBal = round2(records[0].todayBalance || newTodayBal);
    let updatedCount = 0;
    const updatePromises = [];

    for (let i = 1; i < records.length; i++) {
      const item = records[i];
      const itemIncome = calculateIncome(item);
      const itemExpense = calculateExpense(item);

      const currentYesterday = runningTodayBal;
      const currentTodayBal = round2(currentYesterday + itemIncome - itemExpense);
      const currentNetInc = round2(itemIncome - itemExpense);

      runningTodayBal = currentTodayBal;

      updatePromises.push(
        db.collection('report_logs').doc(item._id).update({
          data: {
            yesterdayBalance: currentYesterday,
            todayBalance: currentTodayBal,
            netIncrease: currentNetInc,
            lastCascadeCalculatedAt: db.serverDate()
          }
        })
      );

      updatedCount++;
      console.log(`✏️ [Step 3] 校正 [${item.dateString}]: 昨日(${currentYesterday}) -> 今日结余(${currentTodayBal})`);
    }

    if (updatePromises.length > 0) {
      await Promise.all(updatePromises);
    }

    return {
      success: true,
      updatedCount: updatedCount + 1,
      message: `成功联动校正了包含 ${strReportDate} 在内的 ${updatedCount + 1} 天账目`
    };

  } catch (err) {
    console.error('💥 [updateAndRecalculateCascade] 异常:', err);

    let userFriendlyMsg = err.message || '未知错误';
    if (err.errCode === -502005 || (err.message && err.message.includes('DATABASE_COLLECTION_NOT_EXIST'))) {
      userFriendlyMsg = '数据库缺失 [report_logs] 集合，请前往微信云开发控制台创建该集合！';
    } else if (err.errCode === -502002 || (err.message && err.message.includes('DOCUMENT_NOT_FOUND'))) {
      userFriendlyMsg = '未找到要更新的记录，请确认数据是否已被删除';
    } else if (err.errCode === -502001 || (err.message && err.message.includes('PERMISSION_DENIED'))) {
      userFriendlyMsg = '权限不足，请联系管理员授权';
    }

    return {
      success: false,
      errMsg: userFriendlyMsg,
      stack: err.stack
    };
  }
};
