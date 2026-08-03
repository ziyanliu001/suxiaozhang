// 云函数：manageFinanceLock - 财务批量稽核封账 / 解封（自定义起止日期区间）
//
// 与 manageReportApproval 单条"确认稽核并封账/解封"写入的字段完全一致，只是把范围从
// "单条记录"扩大到"自定义起止日期区间内所有满足条件的记录"一次性批量处理：
// - 封账（lockRange）：区间内 approvalStatus === 'APPROVED'（已通过店长确认）的记录批量
//   转为 AUDITED_LOCKED；转换前强制阻断——若区间内还存在 approvalStatus === 'PENDING'
//   （店长尚未核对确认）的记录，直接拒绝，要求先全部审核或作废。
// - 解封（unlockRange）：区间内 AUDITED_LOCKED 的记录批量退回 APPROVED；批量解封影响范围大，
//   权限比 manageReportApproval 里单条解封（finance 也可）更严格收紧到"大家长"级别——
//   仅 store_patriarch / super_admin 可调用，finance 无权批量解封。
// - 查询状态（checkRangeStatus）：供前端实时展示区间内待审核/已审核/已封账笔数与封账人信息。
//
// 权限：finance / store_patriarch / super_admin 可调用封账与查询；finance 只能操作本店，
// super_admin 限本机构内任意门店；解封仅 store_patriarch / super_admin。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 🐛 云函数容器时区固定为 UTC，new Date().toLocaleString() 不传 timeZone 会
// 直接按 UTC 渲染，导致落库的稽核时间字符串比北京时间少 8 小时
function formatBeijingTimeString(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(date instanceof Date ? date : new Date(date));
}

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

function buildRangeWhere(caller, storeId, startDate, endDate) {
  const where = {
    storeId,
    dateString: _.gte(startDate).and(_.lte(endDate)),
    isVoid: _.neq(true)
  };
  if (caller.tenantId) {
    where.tenantId = caller.tenantId;
  }
  return where;
}

async function handleCheckRangeStatus(where, startDate, endDate) {
  const [totalRes, pendingRes, approvedRes, lockedRes] = await Promise.all([
    db.collection('report_logs').where(where).count(),
    db.collection('report_logs').where({ ...where, approvalStatus: 'PENDING' }).count(),
    db.collection('report_logs').where({ ...where, approvalStatus: 'APPROVED' }).count(),
    db.collection('report_logs').where({ ...where, approvalStatus: 'AUDITED_LOCKED' }).count()
  ]);

  const totalCount = totalRes.total;
  const pendingCount = pendingRes.total;
  const approvedCount = approvedRes.total;
  const lockedCount = lockedRes.total;
  // 区间视为"已封账"：区间内存在记录，且已全部转为 AUDITED_LOCKED（无遗留的待审核/已审核未封账记录）
  const isLocked = totalCount > 0 && lockedCount === totalCount;

  let lockedBy = '';
  let lockedAt = '';
  if (lockedCount > 0) {
    const lockedDocRes = await db.collection('report_logs')
      .where({ ...where, approvalStatus: 'AUDITED_LOCKED' })
      .orderBy('financeAuditedAt', 'desc')
      .limit(1)
      .get();
    const lockedDoc = lockedDocRes.data && lockedDocRes.data[0];
    if (lockedDoc) {
      lockedBy = lockedDoc.financeAuditedBy || lockedDoc.auditedBy || '';
      lockedAt = lockedDoc.auditTime || '';
    }
  }

  return {
    success: true,
    startDate,
    endDate,
    totalCount,
    pendingCount,
    approvedCount,
    lockedCount,
    isLocked,
    lockedBy,
    lockedAt
  };
}

async function handleLockRange(where, caller, startDate, endDate) {
  // 🛡️ 强阻断：区间内若存在店长尚未核对确认的 PENDING 记录，一律拒绝封账
  const pendingRes = await db.collection('report_logs').where({
    ...where,
    approvalStatus: 'PENDING'
  }).count();
  if (pendingRes.total > 0) {
    return {
      success: false,
      error: 'SELECTED_RANGE_HAS_PENDING_REPORTS',
      message: '选中区间内存在待审核数据，请全部审核或作废后再封账！'
    };
  }

  const targetRes = await db.collection('report_logs').where({
    ...where,
    approvalStatus: 'APPROVED'
  }).limit(200).get();
  const targets = targetRes.data || [];

  if (targets.length === 0) {
    return { success: true, lockedCount: 0, message: `${startDate} 至 ${endDate} 没有可封账的记录（需先由店长完成确认）` };
  }

  const userName = caller.role === 'finance' ? '财务稽核员' : (caller.role === 'store_patriarch' ? '大家长' : '超级管理员');
  const nowStr = formatBeijingTimeString(new Date());

  let lockedCount = 0;
  const results = await Promise.allSettled(targets.map((item) =>
    db.collection('report_logs').doc(item._id).update({
      data: {
        isFinanceAudited: true,
        financeAuditedAt: db.serverDate(),
        financeAuditedBy: userName,
        isLocked: true,
        approvalStatus: 'AUDITED_LOCKED',
        auditedBy: userName,
        auditTime: nowStr,
        auditLogs: _.push({
          operator: userName,
          action: 'AUDIT_LOCK_BATCH',
          timestamp: nowStr,
          reason: `财务批量封账（${startDate} 至 ${endDate}）`
        })
      }
    })
  ));

  results.forEach((r) => {
    if (r.status === 'fulfilled') lockedCount++;
  });

  return {
    success: true,
    lockedCount,
    totalMatched: targets.length,
    message: `已成功封账 ${startDate} 至 ${endDate} 共 ${lockedCount} 条记录`
  };
}

async function handleUnlockRange(where, caller, startDate, endDate, reason) {
  const targetRes = await db.collection('report_logs').where({
    ...where,
    approvalStatus: 'AUDITED_LOCKED'
  }).limit(200).get();
  const targets = targetRes.data || [];

  if (targets.length === 0) {
    return { success: true, unlockedCount: 0, message: `${startDate} 至 ${endDate} 没有已封账的记录，无需解封` };
  }

  const userName = caller.role === 'store_patriarch' ? '大家长' : '超级管理员';
  const nowStr = formatBeijingTimeString(new Date());
  const unlockReason = reason || `${userName}批量反封账`;

  let unlockedCount = 0;
  const results = await Promise.allSettled(targets.map((item) =>
    db.collection('report_logs').doc(item._id).update({
      data: {
        isLocked: false,
        approvalStatus: 'APPROVED',
        isFinanceAudited: false,
        auditLogs: _.push({
          operator: userName,
          action: 'AUDIT_UNLOCK_BATCH',
          timestamp: nowStr,
          reason: `${unlockReason}（${startDate} 至 ${endDate}）`
        })
      }
    })
  ));

  results.forEach((r) => {
    if (r.status === 'fulfilled') unlockedCount++;
  });

  return {
    success: true,
    unlockedCount,
    totalMatched: targets.length,
    message: `已成功解封 ${startDate} 至 ${endDate} 共 ${unlockedCount} 条记录`
  };
}

exports.main = async (event) => {
  const { action, storeId, startDate, endDate, reason } = event;
  const { OPENID } = cloud.getWXContext();

  if (!OPENID) {
    return { success: false, errMsg: '未获取到用户身份' };
  }
  if (!['lockRange', 'unlockRange', 'checkRangeStatus'].includes(action)) {
    return { success: false, errMsg: `不支持的 action: ${action}` };
  }
  if (!storeId || !startDate || !endDate) {
    return { success: false, errMsg: '缺少 storeId / startDate / endDate 参数' };
  }
  if (startDate > endDate) {
    return { success: false, errMsg: '开始日期不能晚于结束日期' };
  }

  try {
    const caller = await resolveCaller(OPENID);
    // 🏛️ 权限向下继承：大家长天然拥有财务的全套日常管理权限
    if (!caller || !['finance', 'store_patriarch', 'super_admin'].includes(caller.role)) {
      return { success: false, errMsg: '无权限：仅财务/大家长与超级管理员可操作稽核封账' };
    }
    // 🛡️ 修复"空 storeId 恒真"漏洞：此前 `caller.storeId && caller.storeId !== storeId`
    // 在 caller.storeId 为空/未绑定门店时整个条件短路为 false，直接跳过拒绝分支——
    // 一个尚未绑定任何门店的 finance/store_patriarch 账号反而能对任意 storeId 的账本
    // 批量封账/解封。改为无条件要求 caller.storeId 与目标 storeId 严格相等（storeId
    // 参数在上方已校验非空），未绑定门店时必然不相等，正确落入拒绝分支
    if ((caller.role === 'finance' || caller.role === 'store_patriarch') && caller.storeId !== storeId) {
      return { success: false, errMsg: '无权限：不能操作其他门店的账本' };
    }

    const where = buildRangeWhere(caller, storeId, startDate, endDate);

    if (action === 'checkRangeStatus') {
      return await handleCheckRangeStatus(where, startDate, endDate);
    }

    if (action === 'lockRange') {
      return await handleLockRange(where, caller, startDate, endDate);
    }

    // unlockRange：批量解封的权限比单条解封更严格，仅大家长/超级管理员可执行，finance 拒绝
    if (caller.role !== 'store_patriarch' && caller.role !== 'super_admin') {
      return { success: false, errMsg: '无权限：仅大家长与超级管理员可执行解封/反封账' };
    }
    return await handleUnlockRange(where, caller, startDate, endDate, reason);
  } catch (err) {
    console.error('[manageFinanceLock] 异常:', err);
    return { success: false, errMsg: err.message || '操作失败' };
  }
};
