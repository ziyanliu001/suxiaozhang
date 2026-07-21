const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { recordId, updateData } = event;

  if (!recordId || !updateData) {
    return { success: false, error: '参数不完整' };
  }

  try {
    const logRes = await db.collection('report_logs').doc(recordId).get();
    const logData = logRes.data;

    if (!logData) {
      return { success: false, error: '记录不存在' };
    }

    // 🛡️ 状态机闭环：财务稽核封账（AUDITED_LOCKED）后任何人（含提交人本人）都不能再
    // 修改该记录，必须先由财务走"解封"流程。此前本函数完全没有校验锁定状态，
    // 即使记录已被 manageFinanceLock/AUDITED_LOCKED 锁定，提交人仍可绕过封账直接改字段。
    if (logData.approvalStatus === 'AUDITED_LOCKED' || logData.isLocked) {
      return { success: false, error: '该记录已被财务稽核锁定，请先联系财务解封后再修改' };
    }

    const isCreator = logData._openid === OPENID;

    if (!isCreator) {
      const roleRes = await db.collection('user_roles')
        .where({ _openid: OPENID })
        .limit(1)
        .get();

      let userRole = 'volunteer';
      let userTenantId = '';
      if (roleRes.data && roleRes.data.length > 0) {
        userRole = roleRes.data[0].role || 'volunteer';
        userTenantId = roleRes.data[0].tenantId || '';
      } else {
        const userRes = await db.collection('users')
          .where({ _openid: OPENID })
          .limit(1)
          .get();
        if (userRes.data && userRes.data.length > 0) {
          userRole = userRes.data[0].role === 'admin' ? 'super_admin' : 'volunteer';
        }
      }

      // 🏢 多租户边界：super_admin 的越权兜底权限收敛到本机构内
      const sameTenant = !userTenantId || !logData.tenantId || userTenantId === logData.tenantId;
      if (userRole !== 'super_admin' || !sameTenant) {
        return { success: false, error: '无权限修改该记录' };
      }
    }

    const cleanData = {};
    if (updateData.fixedMajorText !== undefined) cleanData.fixedMajorText = updateData.fixedMajorText;
    if (updateData.fixedExpenseText !== undefined) cleanData.fixedExpenseText = updateData.fixedExpenseText;
    if (updateData.remark !== undefined) cleanData.remark = updateData.remark;
    if (updateData.diningCount !== undefined) cleanData.diningCount = updateData.diningCount;
    cleanData.updateTime = db.serverDate();

    await db.collection('report_logs').doc(recordId).update({
      data: cleanData
    });

    return { success: true, message: '更新成功' };
  } catch (err) {
    console.error('[updateReportLog] 异常:', err);
    return { success: false, error: err.message || '更新失败' };
  }
};
