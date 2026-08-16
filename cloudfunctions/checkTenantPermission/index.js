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

// 🏛️ 「方案一：按机构维度统一授权与门店配额管理」——三档套餐的门店配额口径。
// 各云函数独立部署、没有跨函数共享模块机制（本仓库一贯做法，见 DEFAULT_TENANT_ID
// 等常量的重复定义），这份常量在 createStore/activateTenantSubscription/
// manageTenantSubscription 四处各自保有一份完全一致的拷贝，任何一档配额调整
// 需要同步改这四个文件。basic（含到期自动降级为 basic 的情形）固定为该值，
// pro/enterprise 是"缺省建议值"——平台管理员仍可在开通/续费弹窗里为单个机构
// 手动调高（如购买扩容包），服务端只保证"不低于当前套餐档位的默认配额"
const PLAN_STORE_LIMITS = { basic: 2, pro: 10, enterprise: 30 };

// 🕊️ 到期宽限期（Grace Period）：与 createStore 完全同一份拷贝（各云函数独立
// 部署，没有跨函数共享模块机制）。套餐到期后 7 天内，机构仍按到期前的档位
// 正常使用——一线公益门店的记账/日常流水不能因为财务同事没来得及续费就立即
// 中断。超出宽限期才真正降级为 basic 并收紧高级功能
const GRACE_PERIOD_DAYS = 7;

// 🛡️ -502005 DATABASE_COLLECTION_NOT_EXIST：tenant_subscriptions 可能在这套
// 环境里还没被写入过，与 submitFeedback/manageStoreInviteCode/manageNotice/
// manageTenantSubscription 同一套自愈口径——只读查询命中时按"从未订阅过"降级
// 处理（basic 版），不把裸的数据库报错抛给调用方
function isCollectionNotExistError(err) {
  return !!err && (err.errCode === -502005 || /database collection not exists/i.test(String(err.errMsg || err.message || '')));
}

// 🏛️ 通用鉴权 Helper（与云函数入口分离，方便未来其它云函数直接复制这一小段
// 逻辑做服务端硬校验——项目里各云函数独立部署，没有跨函数共享模块的机制，
// 这是本仓库一贯的做法，见各处重复出现的 DEFAULT_TENANT_ID 常量）。
// 取"最近一次续费的订阅记录"（orderBy lastRenewedAt desc limit 1）；到期
// （serviceExpireDate 已过）自动降级为 basic；从未订阅过（无记录）同样按
// basic 处理；storeLimit 取 cloudQuota.storeLimit，缺省 1（免费版门店数上限）
async function checkTenantPermission(tenantId, featureKey) {
  if (!tenantId) {
    return {
      allowed: false, planType: 'basic', isExpired: false, isInGracePeriod: false,
      graceExpireDate: null, coreReadOnly: false, storeLimit: 1, serviceExpireDate: null,
      reason: '无法确认所属机构'
    };
  }

  let sub = null;
  try {
    const subRes = await db.collection('tenant_subscriptions')
      .where({ tenantId })
      .orderBy('lastRenewedAt', 'desc')
      .limit(1)
      .get();
    sub = subRes.data && subRes.data[0];
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    sub = null;
  }

  let planType = 'basic';
  let isExpired = false;
  let isInGracePeriod = false;
  let graceExpireDate = null;
  // 🕊️ 核心记账（记账/日常流水/历史查看等未登记进 FEATURE_PLAN_REQUIREMENTS 的
  // 基础功能）在宽限期内、乃至宽限期结束后都不整个拦死——只读/基础可用，
  // 由调用方（如 saveReport 等写路径）自行读取这个信号决定是否拒绝写操作，
  // 本函数只负责把"是否已经超出宽限期"这一权威判断透传出去
  let coreReadOnly = false;
  let storeLimit = PLAN_STORE_LIMITS.basic;
  let serviceExpireDate = null;
  if (sub) {
    const expireTime = sub.serviceExpireDate ? new Date(sub.serviceExpireDate).getTime() : NaN;
    const rawExpired = !Number.isNaN(expireTime) && expireTime < Date.now();
    if (rawExpired) {
      const graceDeadline = expireTime + GRACE_PERIOD_DAYS * 24 * 3600 * 1000;
      graceExpireDate = new Date(graceDeadline).toISOString().slice(0, 10);
      isInGracePeriod = graceDeadline >= Date.now();
      // 🌟 只有真正超出宽限期才降级为 basic + 收紧高级功能；宽限期内仍按到期前
      // 的档位放行，给机构留出续费缓冲时间，不因为财务同事晚了几天续费就让
      // 已经在用的跨店大屏/导出功能当场失效
      isExpired = !isInGracePeriod;
      coreReadOnly = !isInGracePeriod;
    }
    planType = isExpired ? 'basic' : (sub.planType || 'basic');
    storeLimit = (sub.cloudQuota && sub.cloudQuota.storeLimit) || PLAN_STORE_LIMITS[planType] || PLAN_STORE_LIMITS.basic;
    // 🛡️ 服务端硬校验：basic（含到期自动降级为 basic 的情形）固定套餐门店配额，
    // 不管 tenant_subscriptions.cloudQuota.storeLimit 里存的是什么历史/脏数据
    // （如平台管理员绕开小程序前端直接调用 manageTenantSubscription 云函数写入
    // 的旧记录），一律强制收敛为 basic 档配额，不信任已落库的数值
    if (planType === 'basic') {
      storeLimit = PLAN_STORE_LIMITS.basic;
    }
    // 🌟 到期日期原样透传（哪怕已过期也保留原值）——前端"套餐升级/续费"卡片需要
    // 展示真实到期日，而不只是一个 isExpired 布尔值，"7月1日已到期"比"已过期"
    // 对续费决策更有信息量
    serviceExpireDate = sub.serviceExpireDate || null;
  }

  const requiredPlans = FEATURE_PLAN_REQUIREMENTS[featureKey];
  // 🕊️ 宽限期内高级功能仍放行（与上面 planType 未被降级为 basic 是同一条判断
  // 结果，这里不重复判一遍到期），超出宽限期后 planType 已收敛为 basic，
  // 自然被下面这条“套餐矩阵”规则拦下
  const allowed = !requiredPlans || requiredPlans.includes(planType);

  return {
    allowed,
    planType,
    isExpired,
    isInGracePeriod,
    graceExpireDate,
    coreReadOnly,
    storeLimit,
    serviceExpireDate,
    requiredPlans: requiredPlans || null,
    reason: allowed ? '' : '该功能为付费套餐专属，请联系大家长升级套餐或购买/兑换授权'
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
    const callerRole = (roleRes.data && roleRes.data[0] && roleRes.data[0].role) || '';
    const tenantId = (roleRes.data && roleRes.data[0] && roleRes.data[0].tenantId) || '';

    // 🛡️ 平台管理员豁免：platform_admin（SaaS 平台运维方）与业务角色/租户套餐
    // 彻底隔离——这堵付费墙是针对"某个机构自己的 super_admin"设计的，防止免费版
    // 租户靠自己的超管账号绕过 pro/enterprise 专属功能（每个机构都有自己的
    // super_admin，若对它放行等于付费墙对所有租户失效）。platform_admin 不属于
    // 任何机构的付费主体，不该被这堵墙拦下——但这只解除这一层套餐拦截，
    // getNationalDashboard 云函数自身的 ALLOWED_ROLES 仍把 platform_admin 排除
    // 在外，机构财务数据对平台运维方依旧不可见，是另一层独立的隐私边界
    if (callerRole === 'platform_admin') {
      return {
        success: true,
        allowed: true,
        planType: 'enterprise',
        isExpired: false,
        isInGracePeriod: false,
        graceExpireDate: null,
        coreReadOnly: false,
        storeLimit: Number.MAX_SAFE_INTEGER,
        serviceExpireDate: null,
        reason: '',
        // 🏢 platform_admin 不隶属任何机构（见 authService.ts UserRole 注释），
        // 空字符串即语义正确，不需要伪造一个"平台方"机构名
        tenantName: ''
      };
    }

    const result = await checkTenantPermission(tenantId, featureKey);

    // 🏢 机构名称：与 planType/storeLimit 同一次调用一并下发，供个人中心页顶部
    // "归属机构"展示使用（不再把门店名误当机构名展示，见 profile.ts/profile.wxml
    // 的 belong-store-tag 修复）。只读 name 字段，不新增权限面——tenantId 本就
    // 只从调用者自己的 user_roles 记录反查，与上面套餐查询同一条安全边界
    let tenantName = '';
    if (tenantId) {
      const tenantRes = await db.collection('tenants').doc(tenantId).field({ name: true }).get().catch(() => null);
      tenantName = (tenantRes && tenantRes.data && tenantRes.data.name) || '';
    }

    return { success: true, ...result, tenantName };
  } catch (err) {
    console.error('[checkTenantPermission] 异常:', err);
    // 🛡️ 严禁把裸的数据库报错暴露给调用方——checkTenantPermission() 内部已经
    // 对 tenant_subscriptions 查询做了自愈，这里是兜底防线
    if (isCollectionNotExistError(err)) {
      return { success: false, error: '系统配置维护中，请联系技术支持' };
    }
    return { success: false, error: err.message || '权限校验失败' };
  }
};
