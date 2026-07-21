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

        const tenantRes = await db.collection('tenants').add({
          data: {
            name: String(name).trim(),
            contactName: contactName || '',
            contactPhone: contactPhone || '',
            status: 'trial',
            createdAt: db.serverDate(),
            createdBy: openid
          }
        });

        return { success: true, tenantId: tenantRes._id };
      }

      case 'listTenants': {
        const tenantsRes = await db.collection('tenants').orderBy('createdAt', 'desc').get();
        const tenants = tenantsRes.data || [];

        // 逐一附带最新的订阅状态，供平台管理员在同一览表中查看服务到期时间
        const withSubs = await Promise.all(tenants.map(async t => {
          const subRes = await db.collection('tenant_subscriptions')
            .where({ tenantId: t._id })
            .orderBy('lastRenewedAt', 'desc')
            .limit(1)
            .get();
          const sub = (subRes.data && subRes.data[0]) || null;
          return { ...t, subscription: sub };
        }));

        return { success: true, tenants: withSubs };
      }

      case 'getTenantDetail': {
        const { tenantId } = event;
        if (!tenantId) return { success: false, error: '缺少 tenantId' };

        const tenantRes = await db.collection('tenants').doc(tenantId).get();
        const subRes = await db.collection('tenant_subscriptions')
          .where({ tenantId })
          .orderBy('lastRenewedAt', 'desc')
          .limit(1)
          .get();
        // 仅统计门店/账号数量，不读取任何门店财务字段
        const storeCountRes = await db.collection('stores').where({ tenantId }).count();

        return {
          success: true,
          tenant: tenantRes.data,
          subscription: (subRes.data && subRes.data[0]) || null,
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

        const existingRes = await db.collection('tenant_subscriptions')
          .where({ tenantId })
          .orderBy('lastRenewedAt', 'desc')
          .limit(1)
          .get();
        const existing = existingRes.data && existingRes.data[0];

        const renewalEntry = {
          operatorId: openid,
          operateTime: db.serverDate(),
          fromExpireDate: existing ? existing.serviceExpireDate : null,
          toExpireDate: serviceExpireDate,
          reason: String(reason).trim()
        };

        if (existing) {
          await db.collection('tenant_subscriptions').doc(existing._id).update({
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

        const createRes = await db.collection('tenant_subscriptions').add({
          data: {
            tenantId,
            planType,
            serviceStartDate,
            serviceExpireDate,
            cloudQuota: cloudQuota || {},
            status: 'active',
            lastRenewedAt: db.serverDate(),
            renewalHistory: [renewalEntry]
          }
        });

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
    return { success: false, error: err.message || '租户管理操作失败' };
  }
};
