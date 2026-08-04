// 云函数：checkTenantPermission
// 通用租户订阅鉴权 Helper：给定 tenantId + featureKey，判断该机构当前有效
// 套餐下这个高级功能是否放行。
//
// 🏛️ 架构说明：订阅数据的唯一真源是 tenant_subscriptions 集合（已由
// manageTenantSubscription 云函数 + pages/platform-admin 页面维护，字段是
// planType/serviceExpireDate/cloudQuota），本函数不在 tenants 文档上另开一份
// planType/expireAt 字段——两处都记"套餐是什么"，后续一旦某次续费/降级只改了
// 其中一处，就会出现"两个地方说法不一致"，是自找的数据一致性 bug。免费版
// （对应 tenant_subscriptions 里的 'basic'）等价于没有生效中的订阅记录。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 🔐 功能-套餐矩阵：新增付费功能时只需要在这里登记一行。未登记的 featureKey
// 一律放行——宁可漏管制，也不要因为忘记登记而误伤既有的免费功能
const FEATURE_PLAN_REQUIREMENTS = {
  multiStoreDashboard: ['pro', 'enterprise'],
  excelExport: ['pro', 'enterprise']
};

// 🏛️ 通用鉴权 Helper（与云函数入口分离，方便未来其它云函数直接复制这一小段
// 逻辑做服务端硬校验——项目里各云函数独立部署，没有跨函数共享模块的机制，
// 这是本仓库一贯的做法，见各处重复出现的 DEFAULT_TENANT_ID 常量）。
// 取"最近一次续费的订阅记录"（orderBy lastRenewedAt desc limit 1）；到期
// （serviceExpireDate 已过）自动降级为 basic；从未订阅过（无记录）同样按
// basic 处理；storeLimit 取 cloudQuota.storeLimit，缺省 1（免费版门店数上限）
async function checkTenantPermission(tenantId, featureKey) {
  if (!tenantId) {
    return { allowed: false, planType: 'basic', isExpired: false, storeLimit: 1, reason: '无法确认所属机构' };
  }

  const subRes = await db.collection('tenant_subscriptions')
    .where({ tenantId })
    .orderBy('lastRenewedAt', 'desc')
    .limit(1)
    .get();
  const sub = subRes.data && subRes.data[0];

  let planType = 'basic';
  let isExpired = false;
  let storeLimit = 1;
  if (sub) {
    const expireTime = sub.serviceExpireDate ? new Date(sub.serviceExpireDate).getTime() : NaN;
    isExpired = !Number.isNaN(expireTime) && expireTime < Date.now();
    planType = isExpired ? 'basic' : (sub.planType || 'basic');
    storeLimit = (sub.cloudQuota && sub.cloudQuota.storeLimit) || 1;
  }

  const requiredPlans = FEATURE_PLAN_REQUIREMENTS[featureKey];
  const allowed = !requiredPlans || requiredPlans.includes(planType);

  return {
    allowed,
    planType,
    isExpired,
    storeLimit,
    requiredPlans: requiredPlans || null,
    reason: allowed ? '' : '该功能为专业版专属，请联系大家长升级套餐'
  };
}

exports.main = async (event) => {
  const { featureKey } = event;
  if (!featureKey) {
    return { success: false, error: '缺少 featureKey 参数' };
  }

  try {
    const { OPENID } = cloud.getWXContext();
    // 🛡️ tenantId 只从调用者自己的 user_roles 记录反查，绝不信任客户端传参——
    // 否则任何人传别的机构 tenantId 就能探测出别人家的套餐状态
    const roleRes = await db.collection('user_roles')
      .where({ _openid: OPENID })
      .limit(1)
      .get();
    const tenantId = (roleRes.data && roleRes.data[0] && roleRes.data[0].tenantId) || '';

    const result = await checkTenantPermission(tenantId, featureKey);
    return { success: true, ...result };
  } catch (err) {
    console.error('[checkTenantPermission] 异常:', err);
    return { success: false, error: err.message || '权限校验失败' };
  }
};
