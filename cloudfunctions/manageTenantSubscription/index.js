// 云函数：manageTenantSubscription
// SaaS 平台管理员（开发者/运维方）专用：管理租户（机构）生命周期与服务订阅/云资源配额。
//
// 🛡️ 合规防腐边界：本函数只读写 tenants / tenant_subscriptions 两个集合，
// 全程不触碰 report_logs / donationItems 等任何门店业务与财务数据，
// 确保"商业运营方（platform_admin）"与"公益机构内部数据"彻底隔离。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 🛡️ -502005 DATABASE_COLLECTION_NOT_EXIST：tenant_subscriptions 可能在这套
// 环境里还没被写入过（全新机构，从未开通过订阅），与 submitFeedback/
// manageStoreInviteCode/manageNotice 同一套自愈口径——只读查询命中时直接降级
// 为"暂无订阅记录"，写路径（createOrRenewSubscription 的新建分支）命中时
// 显式建表再重试一次，任何一路都不能把裸的数据库报错抛给平台管理员控制台
function isCollectionNotExistError(err) {
  return !!err && (err.errCode === -502005 || /database collection not exists/i.test(String(err.errMsg || err.message || '')));
}

const TENANT_SUB_COLLECTION = 'tenant_subscriptions';

// 只读查询自愈：命中集合不存在时返回 null（语义等价于"这家机构还没有任何订阅
// 记录"），其余错误原样抛出给调用方处理
async function safeGetLatestSubscription(tenantId) {
  try {
    const subRes = await db.collection(TENANT_SUB_COLLECTION)
      .where({ tenantId })
      .orderBy('lastRenewedAt', 'desc')
      .limit(1)
      .get();
    return (subRes.data && subRes.data[0]) || null;
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    return null;
  }
}

async function requirePlatformAdmin() {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { allowed: false, openid: '' };

  const roleRes = await db.collection('user_roles')
    .where({ _openid: OPENID })
    .limit(1)
    .get();

  const isPlatformAdmin = !!(roleRes.data && roleRes.data.length > 0 && roleRes.data[0].role === 'platform_admin');
  return { allowed: isPlatformAdmin, openid: OPENID };
}

exports.main = async (event) => {
  const { allowed, openid } = await requirePlatformAdmin();
  if (!allowed) {
    return { success: false, error: '无权限：仅平台管理员（开发者）可执行租户管理操作' };
  }

  const { action } = event;

  try {
    switch (action) {
      case 'createTenant': {
        const { name, contactName, contactPhone } = event;
        if (!name || !String(name).trim()) {
          return { success: false, error: '机构名称不能为空' };
        }

        const tenantData = {
          name: String(name).trim(),
          contactName: contactName || '',
          contactPhone: contactPhone || '',
          status: 'trial',
          createdAt: db.serverDate(),
          createdBy: openid
        };

        let tenantRes;
        try {
          tenantRes = await db.collection('tenants').add({ data: tenantData });
        } catch (err) {
          // 🐛 根因修复：全新环境下 tenants 集合可能从未被写入过任何一条数据，
          // .add() 通常会在集合不存在时自动建表，这里兜底：万一这次环境没有
          // 自动建表，显式建一次再重试一次写入——不能让平台管理员创建的
          // 第一家机构直接失败
          if (!isCollectionNotExistError(err)) throw err;
          await db.createCollection('tenants').catch(() => {});
          tenantRes = await db.collection('tenants').add({ data: tenantData });
        }

        return { success: true, tenantId: tenantRes._id };
      }

      case 'listTenants': {
        // 📄 分页：机构数量会随平台增长持续变多，不能一次性拉全量——skip 由
        // 客户端"触底加载更多"累加传入，多查一条判断 hasMore，不额外发 count()
        const PAGE_SIZE = 20;
        const skip = Math.max(parseInt(event.skip, 10) || 0, 0);

        // 🐛 根因修复：全新环境（从未创建过任何机构）里 tenants 集合可能从未
        // 存在过，直接 .get() 会抛 -502005。"一家机构都还没有"是完全正常、
        // 该展示空状态的场景，不是错误——这里单独 try/catch 命中时直接返回
        // 空列表 + success:true，不让它冒泡到外层被判定成一次失败请求（那样
        // 客户端会弹一条不必要的错误提示，而不是安安静静展示空状态）
        let rows = [];
        try {
          const tenantsRes = await db.collection('tenants')
            .orderBy('createdAt', 'desc')
            .skip(skip)
            .limit(PAGE_SIZE + 1)
            .get();
          rows = tenantsRes.data || [];
        } catch (err) {
          if (!isCollectionNotExistError(err)) throw err;
          rows = [];
        }
        const hasMore = rows.length > PAGE_SIZE;
        const tenants = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

        // 逐一附带最新的订阅状态，供平台管理员在同一览表中查看服务到期时间
        const withSubs = await Promise.all(tenants.map(async t => {
          const sub = await safeGetLatestSubscription(t._id);
          return { ...t, subscription: sub };
        }));

        return { success: true, tenants: withSubs, hasMore, nextSkip: skip + tenants.length };
      }

      case 'getTenantDetail': {
        const { tenantId } = event;
        if (!tenantId) return { success: false, error: '缺少 tenantId' };

        const tenantRes = await db.collection('tenants').doc(tenantId).get();
        const subscription = await safeGetLatestSubscription(tenantId);
        // 仅统计门店/账号数量，不读取任何门店财务字段
        const storeCountRes = await db.collection('stores').where({ tenantId }).count();

        return {
          success: true,
          tenant: tenantRes.data,
          subscription,
          storeCount: storeCountRes.total
        };
      }

      case 'updateTenantStatus': {
        const { tenantId, status, reason } = event;
        const validStatuses = ['trial', 'active', 'suspended', 'expired'];
        if (!tenantId || !validStatuses.includes(status)) {
          return { success: false, error: '参数缺失或 status 非法' };
        }
        if (!reason || !String(reason).trim()) {
          return { success: false, error: '请填写状态变更原因' };
        }

        await db.collection('tenants').doc(tenantId).update({
          data: {
            status,
            lastStatusChangeReason: String(reason).trim(),
            lastStatusChangeBy: openid,
            lastStatusChangeAt: db.serverDate()
          }
        });

        return { success: true };
      }

      case 'createOrRenewSubscription': {
        const { tenantId, planType, serviceStartDate, serviceExpireDate, cloudQuota, reason } = event;
        const validPlans = ['basic', 'pro', 'enterprise'];
        if (!tenantId || !validPlans.includes(planType) || !serviceStartDate || !serviceExpireDate) {
          return { success: false, error: '参数缺失: tenantId / planType / serviceStartDate / serviceExpireDate' };
        }
        if (!reason || !String(reason).trim()) {
          return { success: false, error: '请填写开通/续费原因，便于后续对账审计' };
        }

        const existing = await safeGetLatestSubscription(tenantId);

        const renewalEntry = {
          operatorId: openid,
          operateTime: db.serverDate(),
          fromExpireDate: existing ? existing.serviceExpireDate : null,
          toExpireDate: serviceExpireDate,
          reason: String(reason).trim()
        };

        if (existing) {
          await db.collection(TENANT_SUB_COLLECTION).doc(existing._id).update({
            data: {
              planType,
              serviceStartDate,
              serviceExpireDate,
              cloudQuota: cloudQuota || existing.cloudQuota || {},
              status: 'active',
              lastRenewedAt: db.serverDate(),
              renewalHistory: _.push(renewalEntry)
            }
          });
          return { success: true, subscriptionId: existing._id };
        }

        const newSubData = {
          tenantId,
          planType,
          serviceStartDate,
          serviceExpireDate,
          cloudQuota: cloudQuota || {},
          status: 'active',
          lastRenewedAt: db.serverDate(),
          renewalHistory: [renewalEntry]
        };
        let createRes;
        try {
          createRes = await db.collection(TENANT_SUB_COLLECTION).add({ data: newSubData });
        } catch (err) {
          // .add() 通常会在集合不存在时自动建表，这里兜底：万一这次环境没有自动建表，
          // 显式建一次再重试一次写入，而不是让机构首次开通订阅直接失败
          if (!isCollectionNotExistError(err)) throw err;
          await db.createCollection(TENANT_SUB_COLLECTION).catch(() => {});
          createRes = await db.collection(TENANT_SUB_COLLECTION).add({ data: newSubData });
        }

        // 首次开通订阅时，机构状态从 trial 转为 active
        await db.collection('tenants').doc(tenantId).update({
          data: { status: 'active' }
        }).catch(() => {});

        return { success: true, subscriptionId: createRes._id };
      }

      default:
        return { success: false, error: `不支持的 action: ${action}` };
    }
  } catch (err) {
    console.error('[manageTenantSubscription] 异常:', err);
    // 🛡️ 严禁把裸的数据库报错（如 -502005 DATABASE_COLLECTION_NOT_EXIST）暴露给
    // 平台管理员控制台——上面各分支已经各自做了自愈/降级，这里是兜底防线：万一
    // 自愈本身也失败（如建表瞬间的并发竞态），也只回一句友好提示
    if (isCollectionNotExistError(err)) {
      return { success: false, error: '系统配置维护中，请联系技术支持' };
    }
    // 🐛 根因修复：此前兜底文案是 `err.message || '租户管理操作失败'`——
    // err.message 可能是任意底层异常的原始英文/数据库措辞，不该被平台管理员
    // 控制台原样展示。统一改为固定友好文案，详细堆栈已经在上面 console.error
    return { success: false, error: '租户管理操作失败，请重试' };
  }
};
