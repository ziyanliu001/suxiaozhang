const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const MASK_TEXT = '***（仅店长可见）';

// 🌟 超管专属高阶治理看板：时间维度切片 + 离线门店预警阈值
const RANGE_DAYS = { '7d': 7, 'month': 30, 'quarter': 90 };
const RANGE_LABELS = { '7d': '近7天', 'month': '本月', 'quarter': '本季度', 'all': '全部时间' };
const OFFLINE_ALERT_DAYS = 3;

function isoDateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysBetween(dateStr, todayStr) {
  if (!dateStr) return Infinity;
  const a = new Date(dateStr).getTime();
  const b = new Date(todayStr).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}

// 🛡️ 统一数据脱敏处理函数：分层开放、数据脱敏
// 志工（VOLUNTEER）只应看到"集体荣誉"类服务成果（服务人次、开餐天数、续航状态标签），
// 单餐成本、收支金额、结余、精确续航天数等运营/财务隐私字段一律在服务端就地清除，
// 而不是依赖前端隐藏——即使抓包/调试也不会拿到这些数据，从源头规避合规风险。
function sanitizeReportForVolunteer(data, userRole) {
  const isVolunteer = String(userRole || '').toLowerCase() === 'volunteer';
  if (!isVolunteer) {
    return data;
  }

  const SENSITIVE_KEYS = [
    'singleMealCost', 'costPerMeal',
    'totalIncome', 'totalExpense', 'ingredientExpense',
    'nationalTotalIncome', 'nationalTotalExpense', 'nationalNetAccumulation',
    'latestBalance', 'balance', 'todayBalance', 'yesterdayBalance',
    // 精确续航天数属于可反推资金余额的财务隐私，志工只保留 healthStatus 状态标签
    'runwayDays'
  ];

  const maskOne = (item) => {
    if (!item || typeof item !== 'object') return item;
    const masked = { ...item };
    SENSITIVE_KEYS.forEach((key) => {
      if (key in masked) {
        masked[key] = null;
      }
    });
    if ('costPerMeal' in item) {
      masked.costPerMealMasked = MASK_TEXT;
    }
    masked.isCostRestricted = true;
    return masked;
  };

  return Array.isArray(data) ? data.map(maskOne) : maskOne(data);
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();

  try {
    const roleRes = await db.collection('user_roles')
      .where({ _openid: OPENID })
      .limit(1)
      .get();

    let userRole = 'volunteer';
    let tenantId = '';
    if (roleRes.data && roleRes.data.length > 0) {
      userRole = roleRes.data[0].role || 'volunteer';
      tenantId = roleRes.data[0].tenantId || '';
    } else {
      const userRes = await db.collection('users')
        .where({ _openid: OPENID })
        .limit(1)
        .get();
      if (userRes.data && userRes.data.length > 0) {
        userRole = userRes.data[0].role === 'admin' ? 'super_admin' : 'volunteer';
      }
    }

    // 🛡️ 权限卡口：超管 / 总部财务 / 志工均可访问本机构大屏（志工侧为只读、脱敏视图，
    // 由前端强制锁定为"全部门店"且禁止切换门店，本函数末尾统一调用 sanitizeReportForVolunteer
    // 对返回数据做服务端脱敏，避免仅靠前端隐藏导致抓包/调试仍可看到真实运营成本数据）。
    // 🏢 platform_admin（SaaS 平台管理员）不在允许名单中 —— 大屏聚合的是门店财务数据，
    // 属于机构内部业务信息，平台运维方不应也无需访问，这里显式排除而非遗漏。
    const ALLOWED_ROLES = ['super_admin', 'hq_finance', 'regional_finance', 'volunteer'];
    if (!ALLOWED_ROLES.includes(userRole)) {
      return { success: false, error: '无权限访问本机构数据大屏' };
    }

    // 🛡️ 无法解析出所属机构（游客/未分配角色账号）时直接拒绝，绝不退化为跨机构全量聚合。
    // 此前 tenantId 为空时下面两处查询会直接变成 `{}`（无过滤条件），等于把全平台所有
    // 机构的门店与餐报都聚合进同一张"大屏"返回给调用者，是最严重的一类跨租户数据泄露。
    if (!tenantId) {
      return { success: false, error: '无法确认您所属的机构，暂不支持访问数据大屏' };
    }

    // 🛡️ 超管专属高阶治理看板：时间维度切片仅对已核验的 super_admin 生效——即使
    // hq_finance/regional_finance/volunteer 在 event 里传了 rangeType，也一律忽略，
    // 继续走原有的全量聚合，不额外扩大这些角色的数据访问范围（见需求4：后端二次校验）
    const isSuperAdmin = userRole === 'super_admin';
    const requestedRangeType = (event && event.rangeType) || '';
    const rangeType = (isSuperAdmin && RANGE_DAYS[requestedRangeType]) ? requestedRangeType : 'all';
    const rangeStartDate = RANGE_DAYS[rangeType] ? isoDateNDaysAgo(RANGE_DAYS[rangeType]) : null;
    const todayStr = isoDateNDaysAgo(0);

    // 1. 获取本机构下的门店列表（🏢 多租户：绝不跨机构聚合，"全国大屏"实为"本机构大屏"）
    // 🛡️ 修复"统计数据全为 0"根因：多租户改造上线前的历史 stores/report_logs 记录可能
    // 完全没有 tenantId 字段；严格相等匹配 { tenantId } 会把这些历史数据整体过滤掉，
    // 造成大屏明明有数据却全部显示 0 的假象。改为"匹配当前机构 tenantId 或字段本身不存在"均放行。
    const storesQuery = _.or([{ tenantId: tenantId }, { tenantId: _.exists(false) }]);
    const storesRes = await db.collection('stores').where(storesQuery).get();
    const allStores = storesRes.data || [];

    // 2. 抓取本机构餐报日志（分页累加）
    let allLogs = [];
    const batchLimit = 100;
    let skip = 0;
    const logsQueryConditions = [
      _.or([{ tenantId: tenantId }, { tenantId: _.exists(false) }]),
      { isVoid: _.neq(true) },
      // 🐛 二级审核门槛缺失：本函数此前唯独没有套用 getReports(approvedOnly)/
      // getStatisticsData 全站统一的 approvalStatus 过滤，义工/店长刚提交、店长
      // 还没核对确认的 PENDING 草稿会直接计入"全国总览"的人次/收支汇总，与
      // 单店视角（走 getStatisticsData，已过滤）口径不一致，数字对不上
      { approvalStatus: _.in(['APPROVED', 'AUDITED_LOCKED']) }
    ];
    if (rangeStartDate) {
      logsQueryConditions.push({ dateString: _.gte(rangeStartDate) });
    }
    const logsQueryWhere = _.and(logsQueryConditions);
    while (true) {
      const batch = await db.collection('report_logs')
        .where(logsQueryWhere)
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

    // 🌾 全国核心物资消耗总量：大米/面粉/食用油/蔬菜累计斤数，来自 material_logs——
    // 与 getStatisticsData 单店视角同一张表、同一套字段，这里只是把门店范围放宽到
    // 本机构全部门店，时间范围复用上面已经算好的 rangeStartDate（近7天/本月/
    // 本季度/全部时间）
    let nationalRiceTotal = 0;
    let nationalFlourTotal = 0;
    let nationalOilTotal = 0;
    let nationalVegetableTotal = 0;
    try {
      const materialConditions = [_.or([{ tenantId: tenantId }, { tenantId: _.exists(false) }])];
      if (rangeStartDate) {
        materialConditions.push({ dateString: _.gte(rangeStartDate) });
      }
      let allMaterialLogs = [];
      let materialSkip = 0;
      while (true) {
        const batch = await db.collection('material_logs')
          .where(_.and(materialConditions))
          .skip(materialSkip)
          .limit(batchLimit)
          .get();
        if (!batch.data || batch.data.length === 0) break;
        allMaterialLogs = allMaterialLogs.concat(batch.data);
        if (batch.data.length < batchLimit) break;
        materialSkip += batchLimit;
        if (materialSkip >= 1000) break;
      }
      allMaterialLogs.forEach((m) => {
        nationalRiceTotal += parseFloat(m.riceCount) || 0;
        nationalFlourTotal += parseFloat(m.flourCount) || 0;
        nationalOilTotal += parseFloat(m.oilCount) || 0;
        nationalVegetableTotal += parseFloat(m.vegetableCount) || 0;
      });
    } catch (err) {
      // material_logs 集合可能尚未创建（该机构还没有任何一条物资消耗提交被采纳过），
      // 视为总量 0，不影响主统计
    }

    let nationalTotalDiners = 0;
    let nationalTotalIncome = 0;
    let nationalTotalExpense = 0;
    let nationalOpenDays = 0;
    // 🌟 全国志愿服务：到岗人次与工时，与 getStatisticsData 单店视角同一套
    // report_logs.volunteerCount/volunteerHours 字段来源
    let nationalTotalVolunteers = 0;
    let nationalTotalVolunteerHours = 0;
    // 🌟 全国凭证合规率：有支出金额的记录中，附带小票/发票凭证图片的占比
    let nationalExpenseRecordCount = 0;
    let nationalReceiptRecordCount = 0;

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
        latestBalance: 0,
        lastReportDate: '',
        expenseRecordCount: 0,
        receiptRecordCount: 0
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
            latestBalance: 0,
            lastReportDate: '',
            expenseRecordCount: 0,
            receiptRecordCount: 0
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
      nationalTotalVolunteers += parseFloat(log.volunteerCount) || 0;
      nationalTotalVolunteerHours += parseFloat(log.volunteerHours) || 0;
      if (diners > 0 || dailyExpense > 0) nationalOpenDays++;

      // 🌟 凭证合规率统计：与 getRiskAlerts 同款判定口径（expenseAmount>0 且无
      // receiptImages/receiptImageList 视为缺失凭证），这里只做计数不生成明细告警
      const expenseAmount = parseFloat(log.expenseAmount || 0) || 0;
      const hasReceipt = (Array.isArray(log.receiptImages) && log.receiptImages.length > 0) ||
        (Array.isArray(log.receiptImageList) && log.receiptImageList.length > 0);
      if (expenseAmount > 0) {
        nationalExpenseRecordCount++;
        if (hasReceipt) nationalReceiptRecordCount++;
      }

      const entry = storeStatsMap[matchedKey];
      if (entry) {
        entry.totalDiners += diners;
        entry.totalIncome += income;
        entry.totalExpense += expense;
        entry.ingredientExpense += dailyExpense;
        if (diners > 0) entry.openDays++;
        // dateString 降序抓取，第一次命中某门店即为其在本次查询范围内最新的一条记录
        if (log.dateString && !entry.lastReportDate) entry.lastReportDate = log.dateString;
        if (expenseAmount > 0) {
          entry.expenseRecordCount++;
          if (hasReceipt) entry.receiptRecordCount++;
        }

        const bal = parseFloat(log.todayBalance || log.closingBalance || 0);
        if (bal > 0) entry.latestBalance = bal;
      }
    });

    // 计算各店单餐成本与续航预警
    const storeMatrix = Object.values(storeStatsMap).map(s => {
      // 🐛 "告急(0天)"误报根因：门店在查询窗口内一条 report_logs 都没有时，
      // openDays/totalIncome/totalExpense/ingredientExpense 全部是初始值 0——
      // avgDailyExpense 兜底成 150、runwayDays 算出来是 (0-0)/150=0，
      // 而下面 `runwayDays < 10` 的判断把这个"压根没数据"的 0 当成"资金见底"的 0，
      // 误判成 healthStatus='danger'，前端就渲染出一个吓人的红色"🔴 告急(0天)"。
      // 用 hasAnyData 显式区分"真的没数据"与"有数据算出来确实是 0 天"这两种情况，
      // 前者给一个中性的 nodata 状态，不再冒充成资金告急
      const hasAnyData = s.openDays > 0 || s.totalIncome > 0 || s.totalExpense > 0 || s.ingredientExpense > 0;

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
      if (!hasAnyData) {
        healthStatus = 'nodata';
      } else if (runwayDays < 10) {
        healthStatus = 'danger';
      } else if (runwayDays < 30) {
        healthStatus = 'warning';
      }

      const item = {
        storeId: s.storeId,
        storeName: s.storeName,
        city: s.city,
        totalDiners: s.totalDiners,
        openDays: s.openDays,
        // 无数据时 runwayDays 给 null 而不是 0，前端据此判断"有没有具体天数可展示"，
        // 不会拼出一个"(0天)"的假天数
        runwayDays: hasAnyData ? (runwayDays > 0 ? runwayDays : 0) : null,
        healthStatus,
        costPerMeal,
        totalIncome: s.totalIncome,
        totalExpense: s.totalExpense,
        ingredientExpense: s.ingredientExpense,
        latestBalance: s.latestBalance,
        isCostRestricted: false
      };

      // 🛡️ 凭证合规率 + 离线天数属于"超管专属高阶治理"维度，只在服务端确认调用者
      // 确系 super_admin 时才附加，hq_finance/regional_finance/volunteer 拿到的
      // storeMatrix 结构与升级前完全一致，不额外扩大这些角色的数据可见范围
      if (isSuperAdmin) {
        item.receiptComplianceRate = s.expenseRecordCount > 0
          ? Number(((s.receiptRecordCount / s.expenseRecordCount) * 100).toFixed(1))
          : null;
        item.lastReportDate = s.lastReportDate || '';
        item.daysSinceLastReport = s.lastReportDate ? daysBetween(s.lastReportDate, todayStr) : null;
        item.isOffline = !s.lastReportDate || daysBetween(s.lastReportDate, todayStr) > OFFLINE_ALERT_DAYS;
        // 🌟 全局大屏"今日预警门店数"用：凭证合规率不满 100%（即扫描区间内有支出
        // 记录缺失小票）即视为需要关注，与 store-management 页 getRiskAlerts 的
        // missing_receipt 判定同一个口径，这里不重新发起 N 次单店查询，直接复用
        // 本函数已经在跑的同一份逐日志聚合结果
        item.hasRiskFlag = item.receiptComplianceRate !== null && item.receiptComplianceRate < 100;
      }

      return item;
    });

    // 按服务人次降序排列
    storeMatrix.sort((a, b) => b.totalDiners - a.totalDiners);

    const nationalSummary = {
      totalStores: allStores.length || Object.keys(storeStatsMap).length,
      nationalTotalDiners,
      nationalTotalIncome: nationalTotalIncome.toFixed(2),
      nationalTotalExpense: nationalTotalExpense.toFixed(2),
      nationalNetAccumulation: (nationalTotalIncome - nationalTotalExpense).toFixed(2),
      nationalOpenDays,
      nationalTotalVolunteers,
      nationalTotalVolunteerHours: Math.round(nationalTotalVolunteerHours * 10) / 10,
      nationalRiceTotal: Math.round(nationalRiceTotal * 10) / 10,
      nationalFlourTotal: Math.round(nationalFlourTotal * 10) / 10,
      nationalOilTotal: Math.round(nationalOilTotal * 10) / 10,
      nationalVegetableTotal: Math.round(nationalVegetableTotal * 10) / 10
    };

    // 🌟 超管专属高阶治理看板：核心指标 + 时间切片 + 离线门店预警，见需求2/3
    let superAdminInsights = null;
    if (isSuperAdmin) {
      const offlineStores = storeMatrix
        .filter(s => s.isOffline)
        .map(s => ({ storeId: s.storeId, storeName: s.storeName, lastReportDate: s.lastReportDate, daysSinceLastReport: s.daysSinceLastReport }));

      // 🌟 全局数据大屏：活跃门店数（未离线） + 今日预警门店数（离线 或 凭证合规率不满 100%）
      const riskStoreIds = new Set();
      storeMatrix.forEach(s => {
        if (s.isOffline || s.hasRiskFlag) riskStoreIds.add(s.storeId);
      });
      const totalStoreCount = allStores.length || Object.keys(storeStatsMap).length;

      superAdminInsights = {
        rangeType,
        rangeLabel: RANGE_LABELS[rangeType] || RANGE_LABELS.all,
        avgCostPerMeal: nationalTotalDiners > 0
          ? Number((nationalTotalExpense / nationalTotalDiners).toFixed(2))
          : 0,
        complianceRate: nationalExpenseRecordCount > 0
          ? Number(((nationalReceiptRecordCount / nationalExpenseRecordCount) * 100).toFixed(1))
          : null,
        expenseRecordCount: nationalExpenseRecordCount,
        receiptRecordCount: nationalReceiptRecordCount,
        offlineAlertThresholdDays: OFFLINE_ALERT_DAYS,
        offlineStoreCount: offlineStores.length,
        offlineStores,
        activeStoreCount: Math.max(0, totalStoreCount - offlineStores.length),
        riskStoreCount: riskStoreIds.size
      };
    }

    // 🛡️ 统一在出口处做一次脱敏：志工角色下 storeMatrix 每一项与 nationalSummary
    // 中的收支/成本/结余/精确续航天数字段会被置空，其余角色原样返回
    return {
      success: true,
      nationalSummary: sanitizeReportForVolunteer(nationalSummary, userRole),
      storeMatrix: sanitizeReportForVolunteer(storeMatrix, userRole),
      superAdminInsights
    };
  } catch (err) {
    console.error('[getNationalDashboard] 异常:', err);
    return { success: false, error: err.message || '全国大屏数据查询异常' };
  }
};
