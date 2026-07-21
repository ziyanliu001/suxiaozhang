const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// 🛡️ 真正拥有"跨店查看本机构全部门店汇总"权限的角色；其余角色一律强制收敛到自己所在门店，
// 杜绝 viewMode==='all' 被普通义工/店长/财务用来越权拉取全机构财务汇总
// （此前 `userRole !== 'admin'` 的判断永远为真，等于形同虚设）。
const TENANT_WIDE_ROLES = ['super_admin', 'hq_finance', 'regional_finance'];

exports.main = async (event, context) => {
  const { startDate, endDate, shopName, storeId, viewMode } = event;
  const { OPENID } = cloud.getWXContext();

  if (!startDate || !endDate) {
    return {
      success: false,
      error: '缺少必要参数'
    };
  }

  try {
    // 🏢 多租户：优先从 user_roles 取角色与 tenantId，users 仅作旧数据兼容兜底
    const roleRes = await db.collection('user_roles')
      .where({ _openid: OPENID })
      .limit(1)
      .get();

    let userRole = 'user';
    let tenantId = '';
    let userStoreId = '';
    let userStoreName = '';
    if (roleRes.data && roleRes.data.length > 0) {
      userRole = roleRes.data[0].role || 'user';
      tenantId = roleRes.data[0].tenantId || '';
      userStoreId = roleRes.data[0].storeId || '';
      userStoreName = roleRes.data[0].storeName || '';
    } else {
      const userRes = await db.collection('users')
        .where({ _openid: OPENID })
        .limit(1)
        .get();
      userRole = userRes.data && userRes.data.length > 0 ? userRes.data[0].role : 'user';
    }

    let matchConditions = {
      dateString: db.command.gte(startDate).and(db.command.lte(endDate)),
      // 🛡️ 已作废（红字冲销）的记录不参与统计汇总
      isVoid: _.neq(true)
    };

    // 🏢 多租户边界：始终收敛到调用者所属机构；无法解析出 tenantId 时不再静默跳过过滤条件
    const isTenantWideAllowed = TENANT_WIDE_ROLES.includes(userRole) && !!tenantId;
    if (tenantId) {
      matchConditions.tenantId = tenantId;
    }

    // 🔑 多门店数据强隔离
    const wantsAllStores = !storeId || storeId === 'national_overview' || storeId === 'ALL_STORES';
    if (!wantsAllStores) {
      matchConditions.storeId = storeId;
    } else if (!isTenantWideAllowed) {
      // 🛡️ 非超管请求"全部门店"一律强制收敛为本人所在门店
      if (userStoreId) {
        matchConditions.storeId = userStoreId;
      } else if (userStoreName) {
        matchConditions.shopName = userStoreName;
      } else {
        matchConditions._openid = OPENID;
      }
    }

    if (shopName) {
      matchConditions.shopName = shopName;
    }

    const shouldFilterByOpenid = (viewMode === 'personal') || (!isTenantWideAllowed && !matchConditions.storeId && !matchConditions.shopName);
    if (shouldFilterByOpenid) {
      matchConditions._openid = OPENID;
    }

    const result = await db.collection('report_logs')
      .aggregate()
      .match(matchConditions)
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
      endDate: endDate,
      role: userRole
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
      .where(matchConditions)
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
