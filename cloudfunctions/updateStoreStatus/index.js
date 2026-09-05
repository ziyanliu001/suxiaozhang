// 云函数：updateStoreStatus - 超级管理员启用/停用门店
//
// 权限：调用者必须是目标门店所属机构（tenantId）下的 super_admin。
// 与 createStore / updateStoreName / processRoleAudit 保持一致的自愈逻辑：super_admin 若缺失
// tenantId（历史遗留账号），自动回退到默认机构 yuhuazhai_national 并回写。
//
// 🛡️ 停用是软删除：只翻转 stores.status 字段，不删除门店文档、不动 report_logs /
// user_roles 等历史数据。停用后 getStoreList 会把该门店从"选择服务门店"/邀请码弹窗的
// 活跃列表里过滤掉，但门店管理页自己仍可见（用于随时重新启用）。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DEFAULT_TENANT_ID = 'yuhuazhai_national';
const DEFAULT_TENANT_STORE_LIMIT = 999;
const VALID_STATUSES = ['active', 'inactive'];

// 确保默认机构（及其订阅配额）存在，供缺失 tenantId 的 super_admin 账号兜底使用
async function ensureNationalTenant() {
  const tenantRes = await db.collection('tenants').doc(DEFAULT_TENANT_ID).get().catch(() => null);
  if (!tenantRes || !tenantRes.data) {
    await db.collection('tenants').doc(DEFAULT_TENANT_ID).set({
      data: {
        name: '雨花斋（全国总览机构）',
        status: 'active',
        createdAt: db.serverDate(),
        createdBy: 'system_auto_init'
      }
    });
  }

  const subRes = await db.collection('tenant_subscriptions')
    .where({ tenantId: DEFAULT_TENANT_ID })
    .limit(1)
    .get();
  if (!subRes.data || subRes.data.length === 0) {
    await db.collection('tenant_subscriptions').add({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        planType: 'enterprise',
        serviceStartDate: new Date().toISOString().slice(0, 10),
        serviceExpireDate: '2099-12-31',
        cloudQuota: { storeLimit: DEFAULT_TENANT_STORE_LIMIT },
        status: 'active',
        // 🐛 根因修复：见 createStore/index.js 同名函数同一处注释——不标记
        // isLifetimeGrant 会让这条兜底记录被前端当成一笔真实的、即将到期的
        // 企业版订阅展示，导致因缺失 tenantId 而兜底挂靠到这个共享机构的
        // 用户，误以为自己"已开通付费套餐"
        isLifetimeGrant: true,
        lastRenewedAt: db.serverDate(),
        renewalHistory: [{
          operatorId: 'system_auto_init',
          operateTime: db.serverDate(),
          fromExpireDate: null,
          toExpireDate: '2099-12-31',
          reason: '默认机构自动初始化'
        }]
      }
    });
  }
}

async function resolveCallerTenantId(caller) {
  if (caller.tenantId) return caller.tenantId;

  await ensureNationalTenant();
  await db.collection('user_roles').doc(caller._id).update({
    data: { tenantId: DEFAULT_TENANT_ID }
  }).catch(err => console.warn('[updateStoreStatus] tenantId 自愈回写失败:', err));

  return DEFAULT_TENANT_ID;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { storeId, status } = event;

  if (!OPENID) {
    return { success: false, error: '无法获取用户身份' };
  }
  if (!storeId) {
    return { success: false, error: '缺少 storeId 参数' };
  }
  if (!VALID_STATUSES.includes(status)) {
    return { success: false, error: `status 参数非法，仅支持 ${VALID_STATUSES.join('/')}` };
  }

  try {
    const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
    const caller = roleRes.data && roleRes.data[0];

    if (!caller || caller.role !== 'super_admin') {
      return { success: false, error: '无权限：仅超级管理员可启用/停用门店' };
    }

    const tenantId = await resolveCallerTenantId(caller);

    const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
    const store = storeRes && storeRes.data;
    if (!store) {
      return { success: false, error: '门店不存在' };
    }

    // 🏢 多租户边界：不能操作其他机构的门店
    if (store.tenantId && store.tenantId !== tenantId) {
      return { success: false, error: '无权限：该门店不属于您所在的机构' };
    }

    if (store.status === status) {
      return { success: true, message: '状态未变化', storeId, status };
    }

    // 🛡️ 操作日志留痕：lastStatusChangedBy/At 只是"最近一次变更"的快照，无法
    // 回答"这家门店历史上被谁停用/启用过几次"。operationLog 是追加式数组，
    // 与 manageTenantSubscription 云函数 renewalHistory 的留痕方式保持同一
    // 套约定，供门店管理页后续展示完整变更时间线
    await db.collection('stores').doc(storeId).update({
      data: {
        status,
        lastStatusChangedBy: OPENID,
        lastStatusChangedAt: db.serverDate(),
        operationLog: _.push({
          action: 'status_change',
          operatorId: OPENID,
          operateTime: db.serverDate(),
          before: store.status || '',
          after: status
        })
      }
    });

    return { success: true, storeId, status, storeName: store.storeName || '' };
  } catch (err) {
    console.error('[updateStoreStatus] 异常:', err);
    return { success: false, error: err.message || '更新门店状态失败' };
  }
};
