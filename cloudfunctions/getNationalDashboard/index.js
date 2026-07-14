const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();

  try {
    const roleRes = await db.collection('user_roles')
      .where({ _openid: OPENID })
      .limit(1)
      .get();

    let userRole = 'volunteer';
    if (roleRes.data && roleRes.data.length > 0) {
      userRole = roleRes.data[0].role || 'volunteer';
    } else {
      const userRes = await db.collection('users')
        .where({ _openid: OPENID })
        .limit(1)
        .get();
      if (userRes.data && userRes.data.length > 0) {
        userRole = userRes.data[0].role === 'admin' ? 'super_admin' : 'volunteer';
      }
    }

    if (userRole !== 'super_admin') {
      return { success: false, error: '无权限访问全国数据' };
    }

    // 1. 获取所有门店列表
    const storesRes = await db.collection('stores').get();
    const allStores = storesRes.data || [];

    // 2. 抓取全网餐报日志（分页累加）
    let allLogs = [];
    const batchLimit = 100;
    let skip = 0;
    while (true) {
      const batch = await db.collection('report_logs')
        .orderBy('dateString', 'desc')
        .skip(skip)
        .limit(batchLimit)
        .get();
      if (!batch.data || batch.data.length === 0) break;
      allLogs = allLogs.concat(batch.data);
      if (batch.data.length < batchLimit) break;
      skip += batchLimit;
      if (skip >= 1000) break;
    }

    let nationalTotalDiners = 0;
    let nationalTotalIncome = 0;
    let nationalTotalExpense = 0;
    let nationalOpenDays = 0;

    const storeStatsMap = {};

    allStores.forEach(s => {
      storeStatsMap[s._id] = {
        storeId: s._id,
        storeName: s.storeName || '未命名门店',
        city: s.city || '未知',
        totalDiners: 0,
        totalIncome: 0,
        totalExpense: 0,
        ingredientExpense: 0,
        openDays: 0,
        latestBalance: 0
      };
    });

    // 兜底门店（stores 集合中未注册但有日志的门店）
    const fallbackStoreMap = {};

    allLogs.forEach(log => {
      const logStoreName = log.shopName || '';
      const sId = log.storeId || logStoreName || 'store_haicang_001';

      // 尝试匹配 storeStatsMap
      let matchedKey = null;
      if (log.storeId && storeStatsMap[log.storeId]) {
        matchedKey = log.storeId;
      } else if (logStoreName) {
        for (const key of Object.keys(storeStatsMap)) {
          if (storeStatsMap[key].storeName === logStoreName) {
            matchedKey = key;
            break;
          }
        }
      }

      // 若未匹配到门店，创建兜底条目
      if (!matchedKey) {
        if (!fallbackStoreMap[sId]) {
          fallbackStoreMap[sId] = {
            storeId: sId,
            storeName: logStoreName || '未分类门店',
            city: '未知',
            totalDiners: 0,
            totalIncome: 0,
            totalExpense: 0,
            ingredientExpense: 0,
            openDays: 0,
            latestBalance: 0
          };
        }
        matchedKey = sId;
        if (!storeStatsMap[matchedKey]) {
          storeStatsMap[matchedKey] = fallbackStoreMap[sId];
        }
      }

      const diners = parseInt(log.diningCount || log.diners || 0, 10);
      const income = parseFloat(log.income || log.loveIncome || log.totalDonation || 0) || 0;
      const expense = parseFloat(log.expense || log.todayExpense || log.expenseAmount || 0) || 0;
      const dailyExpense = parseFloat(log.dailyExpense || log.ingredientCost || log.dailyIngredientText || 0) || 0;

      nationalTotalDiners += diners;
      nationalTotalIncome += income;
      nationalTotalExpense += expense;
      if (diners > 0 || dailyExpense > 0) nationalOpenDays++;

      const entry = storeStatsMap[matchedKey];
      if (entry) {
        entry.totalDiners += diners;
        entry.totalIncome += income;
        entry.totalExpense += expense;
        entry.ingredientExpense += dailyExpense;
        if (diners > 0) entry.openDays++;

        const bal = parseFloat(log.todayBalance || log.closingBalance || 0);
        if (bal > 0) entry.latestBalance = bal;
      }
    });

    // 计算各店单餐成本与续航预警
    const storeMatrix = Object.values(storeStatsMap).map(s => {
      const costPerMeal = s.totalDiners > 0
        ? (s.ingredientExpense / s.totalDiners).toFixed(2)
        : '—';
      const avgDailyExpense = s.openDays > 0
        ? (s.ingredientExpense / s.openDays)
        : 150;
      const runwayDays = avgDailyExpense > 0
        ? Math.floor((s.totalIncome - s.totalExpense) / avgDailyExpense)
        : 0;

      let healthStatus = 'healthy';
      if (runwayDays < 10) healthStatus = 'danger';
      else if (runwayDays < 30) healthStatus = 'warning';

      return {
        ...s,
        costPerMeal,
        runwayDays: runwayDays > 0 ? runwayDays : 0,
        healthStatus
      };
    });

    // 按服务人次降序排列
    storeMatrix.sort((a, b) => b.totalDiners - a.totalDiners);

    return {
      success: true,
      nationalSummary: {
        totalStores: allStores.length || Object.keys(storeStatsMap).length,
        nationalTotalDiners,
        nationalTotalIncome: nationalTotalIncome.toFixed(2),
        nationalTotalExpense: nationalTotalExpense.toFixed(2),
        nationalNetAccumulation: (nationalTotalIncome - nationalTotalExpense).toFixed(2),
        nationalOpenDays
      },
      storeMatrix
    };
  } catch (err) {
    console.error('[getNationalDashboard] 异常:', err);
    return { success: false, error: err.message || '全国大屏数据查询异常' };
  }
};
