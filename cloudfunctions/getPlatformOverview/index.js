// 云函数：getPlatformOverview
// SaaS 平台管理员（开发者/运维方）专用：查看系统运行状态与云资源消耗概览。
//
// 🛡️ 合规防腐边界：本函数只做 count() 计数聚合，绝不 get() 读取 report_logs 的
// 任何具体记录内容（余额/收入/支出/捐赠人姓名等），从数据访问层面杜绝平台管理员
// 借运维之便窥探公益机构内部敏感财务明细。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

async function requirePlatformAdmin() {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return false;

  const roleRes = await db.collection('user_roles')
    .where({ _openid: OPENID })
    .limit(1)
    .get();

  return !!(roleRes.data && roleRes.data.length > 0 && roleRes.data[0].role === 'platform_admin');
}

exports.main = async () => {
  const allowed = await requirePlatformAdmin();
  if (!allowed) {
    return { success: false, error: '无权限：仅平台管理员（开发者）可查看平台运行概览' };
  }

  try {
    const [tenantTotal, activeSubTotal, expiredSubTotal, storeTotal, reportLogTotal, volunteerTotal] = await Promise.all([
      db.collection('tenants').count(),
      db.collection('tenant_subscriptions').where({ status: 'active' }).count(),
      db.collection('tenant_subscriptions').where({ status: _.in(['expired', 'suspended']) }).count(),
      db.collection('stores').count(),
      // 仅统计记录条数（云资源/DB 读写用量参考），不读取具体记录内容
      db.collection('report_logs').count(),
      db.collection('user_roles').count()
    ]);

    // 服务即将到期（7 天内）的租户清单：仅暴露 tenantId + 到期日，不涉及门店业务数据
    const soonExpireDate = new Date();
    soonExpireDate.setDate(soonExpireDate.getDate() + 7);
    const soonExpireDateStr = soonExpireDate.toISOString().slice(0, 10);
    const todayStr = new Date().toISOString().slice(0, 10);

    const soonExpiringRes = await db.collection('tenant_subscriptions')
      .where({
        status: 'active',
        serviceExpireDate: _.and(_.gte(todayStr), _.lte(soonExpireDateStr))
      })
      .field({ tenantId: true, serviceExpireDate: true, planType: true })
      .get();

    return {
      success: true,
      totals: {
        tenantCount: tenantTotal.total,
        activeSubscriptionCount: activeSubTotal.total,
        expiredOrSuspendedSubscriptionCount: expiredSubTotal.total,
        storeCount: storeTotal.total,
        reportLogCount: reportLogTotal.total,
        userAccountCount: volunteerTotal.total
      },
      soonExpiringTenants: soonExpiringRes.data || []
    };
  } catch (err) {
    console.error('[getPlatformOverview] 异常:', err);
    return { success: false, error: err.message || '平台概览查询失败' };
  }
};
