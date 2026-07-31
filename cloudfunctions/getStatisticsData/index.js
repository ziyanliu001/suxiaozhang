const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function parseAmountFromText(textStr) {
  if (!textStr) return 0;
  const matches = String(textStr).match(/\d+(\.\d+)?/g);
  if (!matches) return 0;
  return matches.reduce((sum, num) => sum + parseFloat(num), 0);
}

exports.main = async (event, context) => {
  const { shopName, tabType, selectedYear, selectedMonth, startDate, endDate } = event;
  const { OPENID } = cloud.getWXContext();

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
  const todayStr = `${currentYear}-${currentMonth}-${String(now.getDate()).padStart(2, '0')}`;

  let startDateStr = startDate || '';
  let endDateStr = endDate || '';
  let isCurrentPeriod = false;
  let periodLabel = '';

  // 1. 精确计算查询时间边界
  if (tabType === 'month') {
    const year = selectedYear || currentYear;
    const month = selectedMonth || currentMonth;
    startDateStr = `${year}-${month}-01`;
    periodLabel = `${year}年${month}月`;

    if (String(year) === String(currentYear) && String(month) === String(currentMonth)) {
      endDateStr = todayStr;
      isCurrentPeriod = true;
    } else {
      const lastDay = new Date(year, parseInt(month, 10), 0).getDate();
      endDateStr = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;
    }
  } else if (tabType === 'year') {
    const year = selectedYear || currentYear;
    startDateStr = `${year}-01-01`;
    periodLabel = `${year}年度`;

    if (String(year) === String(currentYear)) {
      endDateStr = todayStr;
      isCurrentPeriod = true;
    } else {
      endDateStr = `${year}-12-31`;
    }
  } else if (tabType === 'week') {
    const dayOfWeek = now.getDay() || 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - dayOfWeek + 1);
    const mondayStr = monday.toISOString().split('T')[0];
    startDateStr = mondayStr;
    endDateStr = todayStr;
    isCurrentPeriod = true;
    periodLabel = '本周';
  } else if (tabType === 'custom') {
    if (!startDateStr || !endDateStr) {
      return { success: false, errMsg: '自定义模式必须传入 startDate 和 endDate' };
    }
    periodLabel = `${startDateStr} ~ ${endDateStr}`;
  } else {
    // 默认本周
    const dayOfWeek = now.getDay() || 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - dayOfWeek + 1);
    startDateStr = monday.toISOString().split('T')[0];
    endDateStr = todayStr;
    isCurrentPeriod = true;
    periodLabel = '本周';
  }

  console.log(`📅 [getStatisticsData] 类型: ${tabType}, 范围: ${startDateStr} ~ ${endDateStr}, 门店: ${shopName || '全部'}`);

  try {
    // 🏢 多租户边界：始终收敛到调用者所属机构，"全部门店"仅指本机构下的全部门店
    // 🛡️ 此前本函数完全没有角色校验：任何登录用户（甚至游客）传入 shopName='全部门店'
    // 即可拿到跨机构的收支明细聚合。现按角色收敛：本机构超管/总部财务/大区财务
    // （与 statistics 页面 canViewAllStoresDropdown 的口径保持一致）可查看"全部门店"汇总，
    // 其余角色一律强制收敛到本人所在门店；无法解析出所属机构/门店时直接拒绝，不再兜底放行。
    let tenantId = '';
    let userRole = 'volunteer';
    let userStoreId = '';
    let userStoreName = '';
    const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
    if (roleRes.data && roleRes.data.length > 0) {
      tenantId = roleRes.data[0].tenantId || '';
      userRole = roleRes.data[0].role || 'volunteer';
      userStoreId = roleRes.data[0].storeId || '';
      userStoreName = roleRes.data[0].storeName || '';
    }

    if (!tenantId) {
      return { success: false, errMsg: '无法确认您所属的机构，暂不支持查看统计数据' };
    }

    // 🛡️ 全网/全部门店查询权限严格收窄为仅 super_admin：hq_finance/regional_finance
    // 不在项目实际角色枚举（super_admin/store_manager/store_patriarch/finance/
    // volunteer/platform_admin）之内，checkUserRole 云函数永远不会下发这两个值，
    // 此前写在这里是永远不会命中的死判断，一并按明确要求收紧
    const isTenantWideAllowed = userRole === 'super_admin';
    const wantsAllStores = !shopName || shopName === '全部门店';
    if (wantsAllStores && !isTenantWideAllowed && !userStoreId && !userStoreName) {
      return { success: false, errMsg: '您尚未绑定门店，无法查看统计数据' };
    }

    // 2. 数据库条件过滤查询
    // 🛡️ 修复"统计数据全为 0"根因：多租户改造上线前写入的历史 report_logs 记录可能完全
    // 没有 tenantId 字段；此前用严格相等匹配 { tenantId } 会把这些历史数据整体过滤掉，
    // 造成明明有数据却查出全 0 的假象。改为"匹配当前机构 tenantId 或字段本身不存在"均放行。
    const andConditions = [
      { dateString: _.gte(startDateStr).and(_.lte(endDateStr)) },
      { isVoid: _.neq(true) },
      _.or([{ tenantId: tenantId }, { tenantId: _.exists(false) }]),
      // 🛡️ 二级审核门槛：义工/店长刚提交的记录 approvalStatus 恒为 'PENDING'，
      // 必须经店长核对确认（APPROVED）或财务稽核封账（AUDITED_LOCKED）才算真正
      // 归档，才该计入统计大盘——与 cloudfunctions/getSunshineLedger 的
      // approvalStatus 过滤同一条口径。本函数专供 pages/statistics 使用，不像
      // getReports 那样被审核列表/待办徽标共用，可以无条件收紧
      { approvalStatus: _.in(['APPROVED', 'AUDITED_LOCKED']) }
    ];

    if (!isTenantWideAllowed) {
      // 🛡️ 安全修复：非本机构总部级角色（店长/财务/家长）一律强制收敛到本人绑定
      // 门店，完全忽略客户端传入的 shopName——此前只在 wantsAllStores（未传店名/
      // 传"全部门店"）时才收敛，若客户端显式传入本机构内其他门店的 shopName，
      // 这里会原样放行查询，等同于任何店长/财务/家长账号都能查到同机构下
      // 其他门店的收支明细。现在不论客户端传了什么，非总部级角色一律只能查到
      // 自己绑定的门店
      andConditions.push(userStoreId ? { storeId: userStoreId } : { shopName: userStoreName });
    } else if (shopName && shopName !== '全部门店') {
      andConditions.push({ shopName: shopName });
    }

    // 🌾 核心物资消耗总量：大米/面粉/食用油/蔬菜累计斤数，来自 material_logs——
    // 义工登记的物资消耗经店长/家长/超管采纳后才会落到这张表（见
    // manageVolunteerSubmission writeMaterialLog），与 report_logs 完全独立，
    // 复用同一套 tenantId/门店范围收敛口径（material_logs 用 storeId/storeName
    // 存店，没有 shopName 字段，与 report_logs 的 shopName 口径不同，分开拼条件）
    const materialConditions = [
      { dateString: _.gte(startDateStr).and(_.lte(endDateStr)) },
      _.or([{ tenantId: tenantId }, { tenantId: _.exists(false) }])
    ];
    if (!isTenantWideAllowed) {
      materialConditions.push(userStoreId ? { storeId: userStoreId } : { storeName: userStoreName });
    } else if (shopName && shopName !== '全部门店') {
      materialConditions.push({ storeName: shopName });
    }

    // report_logs 与 material_logs 是两张互相独立的表，查询条件互不依赖，
    // 并发发起而非顺序 await，减少一次往返延迟
    const [recordRes, materialRes] = await Promise.all([
      db.collection('report_logs').where(_.and(andConditions)).limit(1000).get(),
      db.collection('material_logs').where(_.and(materialConditions)).limit(1000).get()
        // material_logs 集合可能尚未创建（该机构还没有任何一条物资消耗提交被
        // 采纳过）——这里单独兜底成空结果，不能让它拖垮上面的 report_logs 查询
        .catch(() => ({ data: [] }))
    ]);

    const records = recordRes.data || [];

    let riceTotal = 0;
    let flourTotal = 0;
    let oilTotal = 0;
    let vegetableTotal = 0;
    (materialRes.data || []).forEach((m) => {
      riceTotal += parseFloat(m.riceCount) || 0;
      flourTotal += parseFloat(m.flourCount) || 0;
      oilTotal += parseFloat(m.oilCount) || 0;
      vegetableTotal += parseFloat(m.vegetableCount) || 0;
    });

    // 3. 核心指标统计累加
    let totalIncome = 0;
    let selfSponsor = 0;
    let otherIncome = 0;
    let totalExpense = 0;
    let foodExpense = 0;
    let majorExpense = 0;
    let totalDiningPeople = 0;
    let totalVolunteers = 0;
    let totalVolunteerHours = 0;
    // 🆕 凭证合规率：与 getPatriarchDashboard 的 auditedCount/totalCount 同一套
    // 口径（approvalStatus === 'AUDITED_LOCKED' 视为已完成稽核/凭证合规），
    // 复用本函数已经查出来的 records，不需要额外发起一次查询
    let auditedCount = 0;
    const materialSummary = [];

    const FIXED_EXPENSE_KEYWORDS = ['租金', '房租', '服装', '义工服', '设备', '装修', '采购', '大件', '空调', '冰箱', '冰柜', '桌椅', '改造', '维修', '购置', '大额', '专项'];

    records.forEach(r => {
      const otherDonation = parseFloat(r.otherDonation) || 0;
      const listDonationTotal = parseFloat(r.listDonationTotal) || 0;
      const expenseAmount = parseFloat(r.expenseAmount) || 0;

      totalIncome += (otherDonation + listDonationTotal);
      selfSponsor += listDonationTotal;
      otherIncome += otherDonation;
      totalExpense += expenseAmount;

      // 食材支出
      let dailyExpense = parseFloat(r.dailyExpenseTotal) || 0;
      const dailyExpenseText = r.dailyExpenseText || r.dailyIngredientText || '';
      if (dailyExpense === 0 && dailyExpenseText) {
        dailyExpense = parseAmountFromText(dailyExpenseText);
      }
      if (dailyExpense === 0 && expenseAmount > 0) {
        const textContext = dailyExpenseText || r.expenses || r.remark || '';
        const hasFixedKeyword = FIXED_EXPENSE_KEYWORDS.some(kw => textContext.includes(kw));
        if (!hasFixedKeyword) {
          dailyExpense = expenseAmount;
        }
      }
      foodExpense += dailyExpense;

      // 大额专项支出
      let fixedExpense = parseFloat(r.fixedExpenseTotal) || 0;
      const fixedExpenseText = r.fixedExpenseText || r.fixedMajorText || r.remark || '';
      if (fixedExpense === 0 && fixedExpenseText) {
        fixedExpense = parseAmountFromText(fixedExpenseText);
      }
      if (fixedExpense === 0 && expenseAmount > 0) {
        const textContext = fixedExpenseText || r.expenses || r.remark || '';
        const hasFixedKeyword = FIXED_EXPENSE_KEYWORDS.some(kw => textContext.includes(kw));
        if (hasFixedKeyword) {
          fixedExpense = expenseAmount;
        }
      }
      majorExpense += fixedExpense;

      totalDiningPeople += parseFloat(r.diningCount) || 0;
      totalVolunteers += parseFloat(r.volunteerCount) || 0;
      totalVolunteerHours += parseFloat(r.volunteerHours) || 0;

      if (r.approvalStatus === 'AUDITED_LOCKED') auditedCount += 1;

      if (r.materials && Array.isArray(r.materials) && r.materials.length > 0) {
        r.materials.forEach(m => {
          if (m.item) {
            materialSummary.push(`${m.item}${m.quantity ? m.quantity + (m.unit || '') : ''}`);
          }
        });
      } else if (r.materials && typeof r.materials === 'string' && r.materials.trim()) {
        materialSummary.push(r.materials.trim());
      }
    });

    // 4. 计算单餐平均食材成本
    const costPerMeal = totalDiningPeople > 0
      ? (foodExpense / totalDiningPeople).toFixed(2)
      : '0.00';

    // 5. 本期净积累
    const netAccumulation = (totalIncome - totalExpense).toFixed(2);

    // 6. 凭证合规率：与 getPatriarchDashboard 同一口径，无记录时返回 null（区分
    // "0% 合规"与"本期还没有任何记账"两种语义，前端据此展示"暂无数据"而非误导的 0%）
    const complianceRate = records.length > 0
      ? Math.round((auditedCount / records.length) * 100)
      : null;

    const dateRangeText = isCurrentPeriod
      ? `${startDateStr} ~ ${endDateStr} (至今)`
      : `${startDateStr} ~ ${endDateStr}`;

    return {
      success: true,
      tabType,
      periodLabel,
      dateRangeText,
      startDate: startDateStr,
      endDate: endDateStr,
      totalIncome: totalIncome.toFixed(2),
      selfSponsor: selfSponsor.toFixed(2),
      otherIncome: otherIncome.toFixed(2),
      totalExpense: totalExpense.toFixed(2),
      foodExpense: foodExpense.toFixed(2),
      majorExpense: majorExpense.toFixed(2),
      netAccumulation,
      totalDiningPeople,
      totalVolunteers,
      totalVolunteerHours,
      costPerMeal,
      recordCount: records.length,
      auditedCount,
      complianceRate,
      materialSummaryText: materialSummary.length > 0 ? materialSummary.join('；') : '暂无捐赠明细记录',
      riceTotal: Math.round(riceTotal * 10) / 10,
      flourTotal: Math.round(flourTotal * 10) / 10,
      oilTotal: Math.round(oilTotal * 10) / 10,
      vegetableTotal: Math.round(vegetableTotal * 10) / 10
    };

  } catch (err) {
    console.error('💥 getStatisticsData 失败:', err);
    return { success: false, errMsg: err.message || '统计查询失败' };
  }
};
