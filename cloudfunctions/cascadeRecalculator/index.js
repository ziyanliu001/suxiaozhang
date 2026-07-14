const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function getPrevDayIsoString(dateString) {
  const d = new Date(dateString);
  d.setDate(d.getDate() - 1);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function cleanStoreName(name) {
  return String(name || '').replace(/[区市省店\s]/g, '').trim();
}

function calculateTodayBalance(yesterdayBalance, income, expense) {
  const numYb = parseFloat(yesterdayBalance || 0);
  const numIncome = parseFloat(income || 0);
  const numExpense = parseFloat(expense || 0);
  return Math.round((numYb + numIncome - numExpense) * 100) / 100;
}

function calculateTotalIncome(item) {
  return parseFloat(item.listDonationTotal || 0) + parseFloat(item.otherDonation || 0);
}

function calculateTotalExpense(item) {
  return parseFloat(item.dailyExpenseTotal || 0) + parseFloat(item.fixedExpenseTotal || 0);
}

async function cascadeUpdateRecords(storeFilter, startDate, initialTodayBalance = null) {
  let queryWhere = {
    dateString: _.gte(startDate)
  };

  if (storeFilter && storeFilter !== 'all') {
    queryWhere.shopName = storeFilter;
  }

  const listRes = await db.collection('report_logs')
    .where(queryWhere)
    .orderBy('dateString', 'asc')
    .get();

  const records = listRes.data || [];
  console.log(`🔍 [级联重算] 查找到参与重算的记录共 ${records.length} 条，起始日期: ${startDate}`);

  if (records.length <= 1) {
    return { updatedCount: 0, records: records };
  }

  let lastCalculatedTodayBalance = initialTodayBalance;
  const updatePromises = [];

  for (let i = 0; i < records.length; i++) {
    const item = records[i];

    if (i === 0) {
      if (lastCalculatedTodayBalance === null) {
        lastCalculatedTodayBalance = parseFloat(item.todayBalance || 0);
      }
      continue;
    }

    const currentYesterdayBal = lastCalculatedTodayBalance;
    const itemIncome = calculateTotalIncome(item);
    const itemExpense = calculateTotalExpense(item);
    const currentTodayBal = Math.round((currentYesterdayBal + itemIncome - itemExpense) * 100) / 100;
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

    console.log(`✏️ [级联重算] 校正 [${item.dateString}]: 昨日 ${currentYesterdayBal} ➔ 收入 ${itemIncome} ➔ 支出 ${itemExpense} ➔ 结余 ${currentTodayBal}`);
  }

  if (updatePromises.length > 0) {
    await Promise.all(updatePromises);
  }

  return {
    updatedCount: updatePromises.length + (initialTodayBalance !== null ? 1 : 0),
    records: records
  };
}

exports.main = async (event, context) => {
  const { action, docId, updateData, storeId, shopName, modifiedDate, dateString } = event;

  const storeFilter = shopName || storeId;
  const targetDate = dateString || modifiedDate;

  if (!action || !targetDate) {
    return { success: false, errMsg: '缺失必要的 action 或 dateString/modifiedDate 参数' };
  }

  console.log(`🚀 [cascadeRecalculator] 接收到请求: action=${action}, storeFilter=${storeFilter}, targetDate=${targetDate}`);

  try {
    switch (action) {
      case 'update_and_recalculate': {
        if (!docId) {
          return { success: false, errMsg: 'update_and_recalculate 模式需要 docId 参数' };
        }

        let updatedTodayBal = null;

        if (updateData) {
          const numYesterdayBal = parseFloat(updateData.yesterdayBalance || 0);
          const numIncome = parseFloat(updateData.listDonationTotal || 0) + parseFloat(updateData.otherDonation || 0);
          const numExpense = parseFloat(updateData.dailyExpenseTotal || 0) + parseFloat(updateData.fixedExpenseTotal || 0);
          updatedTodayBal = calculateTodayBalance(numYesterdayBal, numIncome, numExpense);

          const updateFields = { ...updateData };
          updateFields.todayBalance = updatedTodayBal;
          updateFields.lastCascadeCalculatedAt = db.serverDate();

          await db.collection('report_logs').doc(docId).update({
            data: updateFields
          });

          console.log(`✅ [update_and_recalculate] Step 1 - 已更新起始记录 ${targetDate}, 今日结余: ${updatedTodayBal}`);
        }

        const result = await cascadeUpdateRecords(storeFilter, targetDate, updatedTodayBal);

        return {
          success: true,
          updatedCount: result.updatedCount || 1,
          message: `成功联动校正了包含 ${targetDate} 在内的 ${result.updatedCount || 1} 天账目`
        };
      }

      case 'recalculate_only': {
        const result = await cascadeUpdateRecords(storeFilter, targetDate, null);

        return {
          success: true,
          updatedCount: result.updatedCount,
          message: `成功联动校正了后续 ${result.updatedCount} 天的账目数据`
        };
      }

      case 'recalculate_after_delete': {
        const prevDate = getPrevDayIsoString(targetDate);
        console.log(`⚠️ [recalculate_after_delete] 删除日期 ${targetDate}，从 ${prevDate} 开始重算`);

        const result = await cascadeUpdateRecords(storeFilter, prevDate, null);

        return {
          success: true,
          updatedCount: result.updatedCount,
          message: `删除 ${targetDate} 记录后，成功联动校正了后续 ${result.updatedCount} 天的账目数据`
        };
      }

      default:
        return { success: false, errMsg: `不支持的 action: ${action}` };
    }
  } catch (err) {
    console.error('❌ [cascadeRecalculator] 级联重算失败:', err);
    return { success: false, errMsg: err.message };
  }
};
