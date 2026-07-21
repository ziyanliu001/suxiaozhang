const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// 🛡️ 真正拥有"跨店查看本机构全部门店"权限的角色，其余角色（含历史遗留的 'admin'）
// 一律强制收敛到自己所在门店，杜绝 viewMode==='all' 被普通义工/店长/财务用来越权拉取
// 全机构数据——此前 `userRole !== 'admin'` 的判断永远为真会让该分支形同虚设。
// 注意：hq_finance/regional_finance 在 statistics 页面拥有跨店查看"汇总统计"的权限
// （见 getStatistics/getStatisticsData/exportAccountExcel），但本函数返回的是逐条原始
// 记录（含收据图片/详细品项等），敏感度更高，且 history 页面从未把这两个角色当作
// manager/finance 处理，因此这里刻意不放开，保持"总部财务只看汇总数字，不看单店流水明细"。
const TENANT_WIDE_ROLES = ['super_admin'];

exports.main = async (event, context) => {
  const { startDate, endDate, shopName, storeId, mpAccount, limit = 100, viewMode } = event;
  const { OPENID } = cloud.getWXContext();

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

    let whereConditions = {
      // 🛡️ 已作废（红字冲销）的记录不参与正常报表展示/汇总，与 recalculateLedger 的口径保持一致
      isVoid: _.neq(true)
    };

    // 🏢 多租户边界：始终收敛到调用者所属机构；若无法解析出 tenantId（新用户/未分配角色），
    // 一律拒绝任何"跨门店/全部"查询，只允许强制退回本人提交的记录，绝不静默退化为全库扫描。
    const isTenantWideAllowed = TENANT_WIDE_ROLES.includes(userRole) && !!tenantId;
    if (tenantId) {
      whereConditions.tenantId = tenantId;
    }

    if (startDate && endDate) {
      whereConditions.dateString = db.command.gte(startDate).and(db.command.lte(endDate));
    } else if (startDate) {
      whereConditions.dateString = db.command.gte(startDate);
    } else if (endDate) {
      whereConditions.dateString = db.command.lte(endDate);
    }

    // 🔑 多门店数据强隔离：storeId 非空且不是全国总览标识时加入查询条件
    const wantsAllStores = !storeId || storeId === 'national_overview' || storeId === 'ALL_STORES' || storeId === 'all_stores';
    if (!wantsAllStores) {
      whereConditions.storeId = storeId;
    } else if (!isTenantWideAllowed) {
      // 🛡️ 非超管请求"全部门店"一律强制收敛为本人所在门店，禁止跨店查看他店流水
      if (userStoreId) {
        whereConditions.storeId = userStoreId;
      } else if (userStoreName) {
        whereConditions.shopName = userStoreName;
      } else {
        // 既无所属机构也无所属门店（游客/未审批账号）：拒绝任何跨店查询，仅允许查看本人记录
        whereConditions._openid = OPENID;
      }
    }

    if (shopName) {
      whereConditions.shopName = shopName;
    }

    if (mpAccount) {
      whereConditions.mpAccount = mpAccount;
    }

    // 🛡️ viewMode==='all' 仅对真正的跨店角色（本机构超管）生效；其余情况下，
    // 只要不是明确的 'personal'，也不再无条件放行为全店查询——上面的门店收敛已兜底。
    const shouldFilterByOpenid = (viewMode === 'personal') || (!isTenantWideAllowed && !whereConditions.storeId && !whereConditions.shopName);
    if (shouldFilterByOpenid) {
      whereConditions._openid = OPENID;
    }

    let query = db.collection('report_logs');
    if (Object.keys(whereConditions).length > 0) {
      query = query.where(whereConditions);
    }

    const result = await query.orderBy('dateString', 'desc').limit(limit).get();

    return {
      success: true,
      data: result.data || [],
      role: userRole,
      total: (result.data || []).length
    };
  } catch (error) {
    console.error('getReports error:', error);
    return {
      success: false,
      error: error.message
    };
  }
};
