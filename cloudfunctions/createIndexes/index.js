const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  try {
    const results = [];

    await db.collection('stores').createIndex({
      name: 'storeName_asc',
      keys: [{ storeName: 1 }],
      unique: false
    });
    results.push({ collection: 'stores', index: 'storeName_asc', status: 'success' });

    await db.collection('daily_reports').createIndex({
      name: 'storeId_date',
      keys: [{ storeId: 1 }, { reportDate: 1 }],
      unique: false
    });
    results.push({ collection: 'daily_reports', index: 'storeId_date', status: 'success' });

    await db.collection('daily_reports').createIndex({
      name: 'reportDate_asc',
      keys: [{ reportDate: 1 }],
      unique: false
    });
    results.push({ collection: 'daily_reports', index: 'reportDate_asc', status: 'success' });

    await db.collection('report_logs').createIndex({
      name: 'shopName_date',
      keys: [{ shopName: 1 }, { dateString: 1 }],
      unique: false
    });
    results.push({ collection: 'report_logs', index: 'shopName_date', status: 'success' });

    await db.collection('user_roles').createIndex({
      name: 'openid',
      keys: [{ _openid: 1 }],
      unique: false
    });
    results.push({ collection: 'user_roles', index: 'openid', status: 'success' });

    await db.collection('store_sponsor').createIndex({
      name: 'storeId',
      keys: [{ storeId: 1 }],
      unique: false
    });
    results.push({ collection: 'store_sponsor', index: 'storeId', status: 'success' });

    // 🏢 多租户改造：tenantId 复合索引，支撑按机构维度的高频查询
    await db.collection('stores').createIndex({
      name: 'tenantId',
      keys: [{ tenantId: 1 }],
      unique: false
    });
    results.push({ collection: 'stores', index: 'tenantId', status: 'success' });

    await db.collection('user_roles').createIndex({
      name: 'tenantId',
      keys: [{ tenantId: 1 }],
      unique: false
    });
    results.push({ collection: 'user_roles', index: 'tenantId', status: 'success' });

    await db.collection('report_logs').createIndex({
      name: 'tenantId_date',
      keys: [{ tenantId: 1 }, { dateString: 1 }],
      unique: false
    });
    results.push({ collection: 'report_logs', index: 'tenantId_date', status: 'success' });

    // 🛡️ report_logs.auditedBy 缺索引告警：profile.ts 的"已稽核"荣誉墙统计对 auditedBy
    // 做 exists(true) + count()，此前既没有单字段索引，查询也没带 tenantId，实际是对
    // report_logs 全表（跨所有机构）扫描。这里补两条索引：
    //   1）auditedBy 单字段索引：兜底所有直接按 auditedBy 过滤的查询
    //   2）tenantId + auditedBy 复合索引：查询代码已同步改为强制带 tenantId 前缀，
    //      真正命中的是这条复合索引，比单字段索引更能收窄扫描范围
    await db.collection('report_logs').createIndex({
      name: 'auditedBy_asc',
      keys: [{ auditedBy: 1 }],
      unique: false
    });
    results.push({ collection: 'report_logs', index: 'auditedBy_asc', status: 'success' });

    await db.collection('report_logs').createIndex({
      name: 'tenantId_auditedBy',
      keys: [{ tenantId: 1 }, { auditedBy: 1 }],
      unique: false
    });
    results.push({ collection: 'report_logs', index: 'tenantId_auditedBy', status: 'success' });

    // 🛡️ profile.ts fetchMeritStats 的"已稽核"荣誉墙统计实际查询条件是
    // {tenantId, storeId, auditedBy: exists(true)}（见该函数注释），比上面的
    // tenantId_auditedBy 两字段索引多一层 storeId 收窄——两字段索引虽然能用上
    // tenantId 前缀，但 storeId 过滤仍落不到索引里，控制台会持续弹【索引建议】。
    // 补一条完全匹配查询形状的三字段复合索引；与 submittedCount 那条查询对应的
    // tenantId_storeId_openid 索引（已存在，见下方，最初为 saveReport 查重新增）
    // 字段顺序同构，一并覆盖 profile.ts 这两条统计查询
    await db.collection('report_logs').createIndex({
      name: 'tenantId_storeId_auditedBy',
      keys: [{ tenantId: 1 }, { storeId: 1 }, { auditedBy: 1 }],
      unique: false
    });
    results.push({ collection: 'report_logs', index: 'tenantId_storeId_auditedBy', status: 'success' });

    await db.collection('tenant_subscriptions').createIndex({
      name: 'tenantId',
      keys: [{ tenantId: 1 }],
      unique: false
    });
    results.push({ collection: 'tenant_subscriptions', index: 'tenantId', status: 'success' });

    // 🔐 manageTenantSubscription 的 getTenantDetail/listTenants、以及新增的
    // checkTenantPermission（多门店汇总看板/Excel 导出鉴权）、getNationalDashboard
    // 的服务端硬校验，都是同一个查询形状：{tenantId} + orderBy(lastRenewedAt desc)
    // + limit(1) 取"最近一次续费的订阅记录"——此前只有上面的单字段 tenantId
    // 索引，排序落不到索引里，随着调用点变多(从 1 个变成 4 个) 有必要补一条
    // 完全匹配查询形状的复合索引
    await db.collection('tenant_subscriptions').createIndex({
      name: 'tenantId_lastRenewedAt',
      keys: [{ tenantId: 1 }, { lastRenewedAt: -1 }],
      unique: false
    });
    results.push({ collection: 'tenant_subscriptions', index: 'tenantId_lastRenewedAt', status: 'success' });

    // 🍽️ 每日菜单 / 📌 活动大事记：门店+日期(时间) 复合索引，支撑分页列表查询
    await db.collection('daily_menus').createIndex({
      name: 'store_date',
      keys: [{ storeId: 1 }, { dateString: -1 }],
      unique: false
    });
    results.push({ collection: 'daily_menus', index: 'store_date', status: 'success' });

    await db.collection('activity_logs').createIndex({
      name: 'store_eventTime',
      keys: [{ storeId: 1 }, { eventTime: -1 }],
      unique: false
    });
    results.push({ collection: 'activity_logs', index: 'store_eventTime', status: 'success' });

    // 🧾 高频账目模板：门店+分类复合索引，支撑填报页快速拉取模板列表
    await db.collection('expense_item_templates').createIndex({
      name: 'store_category',
      keys: [{ storeId: 1 }, { category: 1 }],
      unique: false
    });
    results.push({ collection: 'expense_item_templates', index: 'store_category', status: 'success' });

    // 📢 首页跑马灯通知：机构+门店复合索引，支撑"当前视角严格互斥查询"
    await db.collection('notices').createIndex({
      name: 'tenant_store',
      keys: [{ tenantId: 1 }, { storeId: 1 }],
      unique: false
    });
    results.push({ collection: 'notices', index: 'tenant_store', status: 'success' });

    // 📢 公告模板库：机构+门店+公共标记复合索引，支撑 getTemplates 的
    // tenantId + (isSystem:true ∪ storeId=当前门店) 组合查询
    await db.collection('notice_templates').createIndex({
      name: 'tenant_store_system',
      keys: [{ tenantId: 1 }, { storeId: 1 }, { isSystem: 1 }],
      unique: false
    });
    results.push({ collection: 'notice_templates', index: 'tenant_store_system', status: 'success' });

    // 🏛️ 门店大事记/发展历程：门店+发生日期复合索引，支撑 manageStoreMilestone 的
    // list（按 storeId 过滤 + eventDate 倒序）查询
    await db.collection('store_milestones').createIndex({
      name: 'store_eventDate',
      keys: [{ storeId: 1 }, { eventDate: -1 }],
      unique: false
    });
    results.push({ collection: 'store_milestones', index: 'store_eventDate', status: 'success' });

    // 🏪 门店审核弹窗（index.ts fetchPendingAuditList/fetchApprovedVolunteerList，
    // processRoleAudit.js listPendingApplications）四类高频组合查询，此前只有
    // user_roles 上的单字段 openid/tenantId 索引，status+applyTime/approveTime 排序
    // 全部落到内存排序，控制台会持续弹出【索引建议】警告。按实际查询形状逐一补全：
    //   - 超管按机构维度看待审核：{status, tenantId} + orderBy(applyTime)
    //   - 店长/家长按本店看待审核：{status, storeId} + orderBy(applyTime)
    //   - 已审核通过按本店查：{status, storeId} + orderBy(approveTime)
    //   - storeId 缺失时的兜底（历史数据/异常态）按门店名查：{status, storeName} + orderBy(approveTime)
    await db.collection('user_roles').createIndex({
      name: 'tenantId_status_applyTime',
      keys: [{ tenantId: 1 }, { status: 1 }, { applyTime: -1 }],
      unique: false
    });
    results.push({ collection: 'user_roles', index: 'tenantId_status_applyTime', status: 'success' });

    await db.collection('user_roles').createIndex({
      name: 'storeId_status_applyTime',
      keys: [{ storeId: 1 }, { status: 1 }, { applyTime: -1 }],
      unique: false
    });
    results.push({ collection: 'user_roles', index: 'storeId_status_applyTime', status: 'success' });

    await db.collection('user_roles').createIndex({
      name: 'storeId_status_approveTime',
      keys: [{ storeId: 1 }, { status: 1 }, { approveTime: -1 }],
      unique: false
    });
    results.push({ collection: 'user_roles', index: 'storeId_status_approveTime', status: 'success' });

    await db.collection('user_roles').createIndex({
      name: 'storeName_status_approveTime',
      keys: [{ storeName: 1 }, { status: 1 }, { approveTime: -1 }],
      unique: false
    });
    results.push({ collection: 'user_roles', index: 'storeName_status_approveTime', status: 'success' });

    // storeId 均缺失时（历史数据）待审核列表按门店名兜底查询，见 fetchPendingAuditList 的 else 分支
    await db.collection('user_roles').createIndex({
      name: 'storeName_status_applyTime',
      keys: [{ storeName: 1 }, { status: 1 }, { applyTime: -1 }],
      unique: false
    });
    results.push({ collection: 'user_roles', index: 'storeName_status_applyTime', status: 'success' });

    // 🍱 report_logs 的 upsert 查重（DataService.saveReport/syncLocalDataToCloud，
    // 见 miniprogram/utils/dataService.ts）此前只按 dateString+shopName(+storeId)
    // 匹配，从未带 tenantId，云开发控制台会对这类高频组合查询持续弹【索引建议】
    // 警告。补一条 {tenantId, storeId, openid} 复合索引，与查询同步加上的 tenantId
    // 过滤条件对齐，同时也是 saveReport 新增的"防抖锁"（reportSaveLocks，按
    // tenantId+storeId+openid 维度阻止并发重复提交）天然对应的查询维度
    await db.collection('report_logs').createIndex({
      name: 'tenantId_storeId_openid',
      keys: [{ tenantId: 1 }, { storeId: 1 }, { _openid: 1 }],
      unique: false
    });
    results.push({ collection: 'report_logs', index: 'tenantId_storeId_openid', status: 'success' });

    // 🙋 护持岗位班次打卡云端台账（manageVolunteerCheckIn，volunteer_duty_logs 集合）：
    // checkin 时按 {tenantId, storeId, _openid, dateString, status} 现查"今日已打卡记录"
    // 重算工时上限与同工种去重，高频命中，补一条对齐查询形状的复合索引；status 单独放在
    // 复合索引末位（低基数字段放后面，避免抢占更具区分度的 dateString 排序位置）
    await db.collection('volunteer_duty_logs').createIndex({
      name: 'tenantId_storeId_openid_dateString',
      keys: [{ tenantId: 1 }, { storeId: 1 }, { _openid: 1 }, { dateString: 1 }, { status: 1 }],
      unique: false
    });
    results.push({ collection: 'volunteer_duty_logs', index: 'tenantId_storeId_openid_dateString', status: 'success' });

    // ❤️ 爱心护持榜（manageVolunteerCheckIn action:'leaderboard'）按 {tenantId, storeId,
    // status} + dateString 区间扫描全店（不限定单个 _openid）来聚合每位义工的工时排名——
    // 与上面 checkin 用的复合索引字段顺序不同（_openid 排在 dateString/status 之前，
    // 一旦查询不带 _openid 就无法命中该索引的有效前缀），需要单独补一条不含 _openid
    // 的复合索引
    await db.collection('volunteer_duty_logs').createIndex({
      name: 'tenantId_storeId_status_dateString',
      keys: [{ tenantId: 1 }, { storeId: 1 }, { status: 1 }, { dateString: 1 }],
      unique: false
    });
    results.push({ collection: 'volunteer_duty_logs', index: 'tenantId_storeId_status_dateString', status: 'success' });

    // 🔑 特权邀请码（manageStoreInviteCode）：redeem/peek 都是按 codeNormalized
    // 精确查找一次性口令，8 位随机码理论上不会重复，这里用 unique 索引把"不重复"
    // 这条约束也落到数据库层，而不是只靠业务代码里"随机生成不去重"的乐观假设
    await db.collection('store_invite_codes').createIndex({
      name: 'codeNormalized_unique',
      keys: [{ codeNormalized: 1 }],
      unique: true
    });
    results.push({ collection: 'store_invite_codes', index: 'codeNormalized_unique', status: 'success' });

    return {
      success: true,
      message: '索引创建完成',
      results
    };

  } catch (err) {
    console.error('索引创建失败:', err);
    return {
      success: false,
      errMsg: err.message,
      note: '部分索引可能已存在，这是正常情况。索引只需创建一次。'
    };
  }
};