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

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
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

// 权限：家长/督导锁定本店；超管可指定本机构内任意门店
async function resolveTarget(caller, requestedStoreId) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  if (caller.role === 'store_patriarch') {
    if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店' };
    return { allowed: true, storeId: caller.storeId };
  }

  if (caller.role === 'super_admin') {
    if (!requestedStoreId) return { allowed: false, error: '请指定目标门店' };
    const storeRes = await db.collection('stores').doc(requestedStoreId).get().catch(() => null);
    const store = storeRes && storeRes.data;
    if (!store) return { allowed: false, error: '目标门店不存在' };
    if (caller.tenantId && store.tenantId && caller.tenantId !== store.tenantId) {
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
    const caller = await resolveCaller(OPENID);
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
    monthReports.forEach((r) => {
      totalDiners += parseFloat(r.totalDineCount || r.diningCount || 0) || 0;
      totalIncome += (parseFloat(r.listDonationTotal || 0) || 0) + (parseFloat(r.otherDonation || 0) || 0);
      totalExpense += parseFloat(r.expenseAmount || 0) || 0;
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
        pendingVoidList,
        pendingProfileUpdate: store.pendingProfileUpdate || null
      }
    };
  } catch (err) {
    console.error('[getPatriarchDashboard] 异常:', err);
    return { success: false, error: err.message || '服务异常' };
  }
};
