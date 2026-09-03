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
  const { startDate, endDate, shopName, storeId, mpAccount, limit = 100, viewMode, approvedOnly } = event;
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

    // 🛡️ 二级审核门槛：approvedOnly 仅供"大盘统计"类调用方（如 statistics.ts）
    // 显式传入——义工提交后先是 PENDING（未经店长核对），只有店长核对确认
    // （APPROVED）或财务稽核封账（AUDITED_LOCKED）后才算真正归档，才该计入统计。
    // 【默认不加这层过滤】：本函数同时被 history.ts（店长/财务的待审核列表，必须
    // 看到 PENDING 记录才能审核）、custom-tab-bar/notice.ts（待处理徽标/通知，同样
    // 需要 PENDING 记录）共用，默认收紧会直接弄坏这几处审核工作流。与
    // cloudfunctions/getSunshineLedger 的 approvalStatus 过滤同一条口径
    if (approvedOnly) {
      whereConditions.approvalStatus = _.in(['APPROVED', 'AUDITED_LOCKED']);
    }

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
    } else if (TENANT_WIDE_ROLES.includes(userRole) && !tenantId) {
      // 🐛 根因修复："全国总览"查询全部为空的一个真实成因：本该有权跨店查看的
      // super_admin，若自己的 user_roles 记录缺失 tenantId（账号数据不完整，
      // 常见于早期未走完整入驻流程的历史账号），isTenantWideAllowed 会静默
      // 判 false，直接掉进下面 !isTenantWideAllowed 分支收敛成
      // { _openid: OPENID }——超管账号自己几乎从不提交餐报，这条查询条件
      // 几乎总是精确命中 0 条记录，页面表现为"全国总览没有任何数据"却没有
      // 任何报错信息，容易被误诊为查询/聚合逻辑坏了。这里改为显式报错，指向
      // 真正的根因（账号缺少 tenantId），而不是放宽 tenantId 隔离本身去"兼容"
      return { success: false, error: '您的管理员账号缺少所属机构（tenantId）信息，无法查看全国总览，请联系技术支持为该账号补全归属机构后重试' };
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

    // 🛡️ 越权修复（核心）：本函数返回的是逐条原始记录（含未核实的 PENDING/REJECTED
    // 待审凭证、收据图片等私密数据），此前只要客户端传入一个具体 storeId/shopName，
    // 服务端就直接原样用它过滤查询条件——完全没有核实调用者本人是否真的在该门店
    // 任职。store-picker 的 FAMILY/VOLUNTEER 访客身份对同租户下任意门店都天然
    // "已授权"（无需邀请码，见该组件 refreshRolePermissions 注释），用户随手切换
    // 到其它门店后打开 history.ts「凭证与账本」页面，loadReports() 默认不传
    // approvedOnly，就会把该店完整的 PENDING/REJECTED 记录（含收据图片、驳回
    // 理由等）原样拉给这个跟该店毫无关系的访客——这正是本次要堵的越权漏洞。
    //
    // 判定"是否在查看非本人所属门店"：优先按 storeId 精确比对（同名门店不会
    // 误判）；调用方若走 shopName 兼容路径（storeId 为空场景），退化按门店名比对。
    // isTenantWideAllowed（当前只有 super_admin）豁免——超管本就该能看到全租户
    // 任意门店的完整账目用于稽核，这也是全国大屏"公信力大屏"双轨制里唯一保留的
    // 管理向穿透权限（与 getNationalDashboard 的公开只读查询是两条不同轨道，见
    // CLAUDE.md 多租户隔离说明）。
    const requestedStoreId = whereConditions.storeId || '';
    const requestedShopName = whereConditions.shopName || '';
    const isViewingOwnStoreById = !!userStoreId && requestedStoreId === userStoreId;
    const isViewingOwnStoreByName = !userStoreId && !!userStoreName && requestedShopName === userStoreName;
    const isViewingSpecificStore = !!requestedStoreId || !!requestedShopName;
    const isForeignStoreRequest = isViewingSpecificStore && !isTenantWideAllowed
      && !isViewingOwnStoreById && !isViewingOwnStoreByName;

    if (isForeignStoreRequest) {
      // 非本店：无论客户端 approvedOnly 传了什么，一律强制收敛为已归档
      // （APPROVED/AUDITED_LOCKED）的公开阳光账本数据，PENDING/REJECTED 严禁下发——
      // 与 cloudfunctions/getSunshineLedger"已通过数据允许公开跨店查阅"同一条口径，
      // 只是这里额外收紧到"未归档数据绝不允许跨店查阅"
      whereConditions.approvalStatus = _.in(['APPROVED', 'AUDITED_LOCKED']);
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
