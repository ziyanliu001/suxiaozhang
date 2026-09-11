// 云函数：getPatriarchDashboard - 家长/督导专属【极简门店健康大盘】
//
// 权限：store_patriarch（锁定本店）或 super_admin（本机构内任意店，需传 storeId）。
// 只读聚合，不涉及任何写操作。
//
// 🛡️ 设计取舍：这里只查询"极简大盘"真正需要的几个数字（本月服务人次/收支总览/
// 验真状态），不跨云函数调用 getStatisticsData 复用其完整统计口径——WeChat 云函数间
// cloud.callFunction 是否透传原始终端用户身份并不可靠（版本/场景依赖），对一段只读聚合
// 没必要为了"不写重复代码"去冒身份误判的风险，这里选择自包含实现一段小聚合。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
// 🛡️（2026-09-11 巡检漫游审计日志·方向3）与 manageStoreProfile/lib/、
// manageReportApproval/lib/ 下的同名文件是三处独立维护的镜像，见该文件
// 头部注释
const { buildAuditLogEntry, isRoamingConsumed } = require('./lib/buildAuditLogEntry');
// 🐛🛡️（2026-09-11 过期校验 drift 修复）此前本文件的 resolveCaller 是
// 2026-09-10 那轮真实故障修复"之前"的旧版本拷贝——完全没有 isGrantStillValid
// 过期校验，一条已经超过 2 小时有效期的巡检授权在这里仍会被判定为有效，
// 是一个真实存在过的越权窗口。现在改为直接复用 manageStoreProfile/lib/
// resolveCaller.js 的同一份镜像（含过期校验 + storeId 直接匹配，不再需要
// 反查 stores.tenantId 这一步），配套单测见 lib/resolveCaller.test.js——
// 与 manageStoreProfile/lib/resolveCaller.test.js 逐条对应的同一份回归矩阵
const { resolveEffectiveCaller } = require('./lib/resolveCaller');

// 🛡️（2026-09-09 方案三：authorizedTenants 轻量租户漫游，见
// docs/architecture/02_user_roles_single_document_invariant.md）opts 可选，
// 不传（或命中不了任何授权）时返回值与改造前逐字节一致。命中授权时返回的
// "有效身份"把 tenantId/role/storeId 替换成授权值，下游 resolveTarget 的
// store_patriarch/finance 分支不用改，直接复用 caller.storeId。决策逻辑
// 全部在 lib/resolveCaller.js，这里只负责把数据库查出来的 own 文档喂给它
async function resolveCaller(OPENID, opts) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  const own = (roleRes.data && roleRes.data[0]) || null;
  const targetStoreId = opts && (opts.targetStoreId || opts.storeId);
  const effectiveCaller = resolveEffectiveCaller(own, targetStoreId);

  // 🛡️（2026-09-11 巡检漫游审计日志）只在真的发生了漫游身份替换时才写一条
  // 留痕；写入失败不阻断真正的只读查询，最大努力记录
  if (isRoamingConsumed(own, effectiveCaller)) {
    // 🐛（2026-09-11 根因修复）targetStoreName 不能从 effectiveCaller.storeName
    // 读——它仍是调用者自己的本来名称（platform_admin 是"全国总览"），见
    // lib/buildAuditLogEntry.js 头部注释与配套回归单测。这里额外查一次真实
    // 门店名称
    const targetStoreNameRes = await db.collection('stores').doc(targetStoreId).field({ storeName: true }).get().catch(() => null);
    const targetStoreName = (targetStoreNameRes && targetStoreNameRes.data && targetStoreNameRes.data.storeName) || '';
    const logEntry = buildAuditLogEntry({
      operatorOpenId: OPENID,
      own,
      effectiveCaller,
      targetStoreId,
      targetStoreName,
      cloudFunctionName: 'getPatriarchDashboard',
      action: opts && opts.action
    });
    if (logEntry) {
      await db.collection('tenant_authorization_audit_logs').add({
        data: { ...logEntry, createTime: db.serverDate() }
      }).catch((err) => console.warn('[getPatriarchDashboard] 巡检审计日志写入失败:', err));
    }
  }

  return effectiveCaller;
}

// 🐛 云函数容器时区固定为 UTC，new Date(...).toLocaleDateString('zh-CN') 不传
// timeZone 会直接按 UTC 渲染日期——跨越北京时间零点前后几小时的申请会被显示成
// 前一天/后一天，这里显式指定 Asia/Shanghai
function formatBeijingDateString(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date instanceof Date ? date : new Date(date));
}

// 权限：家长/督导锁定本店；财务锁定本店（🆕 财务个人页【财务稽核专区】KPI
// 看板复用本聚合——本月服务人次/收支/验真进度对财务而言同样是稽核职责范围内
// 的数据，与家长完全相同的"只读、锁定本人绑定门店"口径，不额外放宽）；
// 超管可指定本机构内任意门店
async function resolveTarget(caller, requestedStoreId) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  if (caller.role === 'store_patriarch' || caller.role === 'finance') {
    if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店' };
    return { allowed: true, storeId: caller.storeId };
  }

  if (caller.role === 'super_admin') {
    if (!requestedStoreId) return { allowed: false, error: '请指定目标门店' };
    const storeRes = await db.collection('stores').doc(requestedStoreId).get().catch(() => null);
    const store = storeRes && storeRes.data;
    if (!store) return { allowed: false, error: '目标门店不存在' };
    // 🛡️ 多租户越权修复：两侧 tenantId 都必须存在且相等才放行，任一缺失时不再
    // 无条件放行。
    if (!caller.tenantId || !store.tenantId || caller.tenantId !== store.tenantId) {
      return { allowed: false, error: '无权限：目标门店不属于您所在的机构' };
    }
    return { allowed: true, storeId: requestedStoreId };
  }

  return { allowed: false, error: '无权限：仅家长或超级管理员可查看本大盘' };
}

exports.main = async (event) => {
  const { storeId } = event;
  const { OPENID } = cloud.getWXContext();

  try {
    // 🛡️ 本云函数没有多 action 分发（只做一件事：查大盘），审计日志的 action
    // 字段固定填 'viewDashboard' 便于跨云函数聚合时一眼看出这是查看类操作
    const caller = await resolveCaller(OPENID, { targetStoreId: storeId, action: 'viewDashboard' });
    const target = await resolveTarget(caller, storeId);
    if (!target.allowed) return { success: false, error: target.error };

    const storeRes = await db.collection('stores').doc(target.storeId).get().catch(() => null);
    const store = storeRes && storeRes.data;
    if (!store) return { success: false, error: '门店不存在' };

    // 本月日期范围（与 getStatisticsData 同款计算口径：当月 1 号 ~ 今天）
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const monthStart = `${year}-${month}-01`;
    const monthEnd = `${year}-${month}-${String(now.getDate()).padStart(2, '0')}`;

    const monthReportsRes = await db.collection('report_logs')
      .where({
        storeId: target.storeId,
        dateString: _.gte(monthStart).and(_.lte(monthEnd)),
        isVoid: _.neq(true)
      })
      .get();
    const monthReports = monthReportsRes.data || [];

    let totalDiners = 0;
    let totalIncome = 0;
    let totalExpense = 0;
    let auditedCount = 0;
    // 🆕（2026-09-09 超管全国总览工作台重构）本月志愿团队人次：首页
    // manager-home-card"志愿团队/人"指标此前是从未赋值的假数字兜底
    // （wxml `{{activeVolunteersCount || 28}}`），这里补一个真实字段——
    // 对 report_logs.volunteerCount（当日到岗义工人数）按月求和，与
    // getNationalDashboard 自己算 nationalTotalVolunteers 的手法完全
    // 一致（同一份"本月人次汇总"口径，不是发明一个新统计定义）
    let monthVolunteerCount = 0;
    monthReports.forEach((r) => {
      totalDiners += parseFloat(r.totalDineCount || r.diningCount || 0) || 0;
      totalIncome += (parseFloat(r.listDonationTotal || 0) || 0) + (parseFloat(r.otherDonation || 0) || 0);
      totalExpense += parseFloat(r.expenseAmount || 0) || 0;
      monthVolunteerCount += parseFloat(r.volunteerCount || 0) || 0;
      if (r.approvalStatus === 'AUDITED_LOCKED') auditedCount += 1;
    });

    // 待确认的作废申请（不限当月，只要还挂起就展示）
    const pendingVoidRes = await db.collection('report_logs')
      .where({ storeId: target.storeId, voidPending: true })
      .orderBy('dateString', 'desc')
      .limit(20)
      .get();
    const pendingVoidList = (pendingVoidRes.data || []).map((r) => ({
      docId: r._id,
      dateString: r.dateString || '',
      todayBalance: r.todayBalance || 0,
      expenseAmount: r.expenseAmount || 0
    }));

    // 🏛️ 待审核角色申请（店长/财务/家长/新店）已迁移到 processRoleAudit 的
    // listPendingApplications action + profile.ts 的独立弹窗入口，这里不再重复查询/返回

    return {
      success: true,
      data: {
        storeId: target.storeId,
        storeName: store.storeName || '',
        patriarch: store.patriarch || '',
        manager: store.manager || '',
        monthLabel: `${year}年${month}月`,
        monthDiners: totalDiners,
        monthIncome: totalIncome,
        monthExpense: totalExpense,
        monthNet: totalIncome - totalExpense,
        auditedCount,
        totalCount: monthReports.length,
        monthVolunteerCount,
        pendingVoidList,
        pendingProfileUpdate: store.pendingProfileUpdate || null
      }
    };
  } catch (err) {
    console.error('[getPatriarchDashboard] 异常:', err);
    return { success: false, error: err.message || '服务异常' };
  }
};
