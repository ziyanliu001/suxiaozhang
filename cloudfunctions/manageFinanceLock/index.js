// 云函数：manageFinanceLock - 财务批量稽核封账（按月）
//
// 与 history 页面单条"确认稽核并封账"（onFinanceAuditClick）写入的字段完全一致，
// 只是把范围从"单条记录"扩大到"某月内所有已通过店长确认、尚未封账的记录"一次性批量锁定。
// 锁定后的记录 approvalStatus 变为 AUDITED_LOCKED，history 页面既有的"已封账禁止编辑/作废"
// 逻辑无需任何改动即可直接生效。
//
// 权限：仅 finance / super_admin 可调用；finance 只能锁定本店，super_admin 限本机构内任意门店。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

exports.main = async (event) => {
  const { action, storeId, year, month } = event;
  const { OPENID } = cloud.getWXContext();

  if (!OPENID) {
    return { success: false, errMsg: '未获取到用户身份' };
  }
  if (action !== 'lockMonth') {
    return { success: false, errMsg: `不支持的 action: ${action}` };
  }
  if (!storeId || !year || !month) {
    return { success: false, errMsg: '缺少 storeId / year / month 参数' };
  }

  try {
    const caller = await resolveCaller(OPENID);
    // 🏛️ 权限向下继承：大家长天然拥有财务的全套日常管理权限
    if (!caller || !['finance', 'store_patriarch', 'super_admin'].includes(caller.role)) {
      return { success: false, errMsg: '无权限：仅财务/大家长与超级管理员可执行稽核封账' };
    }
    if ((caller.role === 'finance' || caller.role === 'store_patriarch') && caller.storeId && caller.storeId !== storeId) {
      return { success: false, errMsg: '无权限：不能封账其他门店的账本' };
    }

    const mm = String(month).padStart(2, '0');
    const startDate = `${year}-${mm}-01`;
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    const endDate = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;

    const where = {
      storeId,
      dateString: _.gte(startDate).and(_.lte(endDate)),
      approvalStatus: 'APPROVED',
      isVoid: _.neq(true)
    };
    if (caller.tenantId) {
      where.tenantId = caller.tenantId;
    }

    const targetRes = await db.collection('report_logs').where(where).limit(200).get();
    const targets = targetRes.data || [];

    if (targets.length === 0) {
      return { success: true, lockedCount: 0, message: `${year}年${mm}月没有可封账的记录（需先由店长完成确认）` };
    }

    const userName = caller.role === 'finance' ? '财务稽核员' : (caller.role === 'store_patriarch' ? '大家长' : '超级管理员');
    const nowStr = new Date().toLocaleString();

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
            reason: `财务按月批量封账（${year}年${mm}月）`
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
      message: `已成功封账 ${year}年${mm}月 共 ${lockedCount} 条记录`
    };
  } catch (err) {
    console.error('[manageFinanceLock] 异常:', err);
    return { success: false, errMsg: err.message || '封账失败' };
  }
};
