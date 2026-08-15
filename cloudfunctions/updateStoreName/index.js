// 云函数：updateStoreName - 超级管理员修改/重命名门店名称
//
// 权限：调用者必须是目标门店所属机构（tenantId）下的 super_admin。
// 与 createStore / processRoleAudit 保持一致的自愈逻辑：super_admin 若缺失
// tenantId（历史遗留账号），自动回退到默认机构 yuhuazhai_national 并回写。
//
// 防重：新名称不能与本机构内其他门店（排除自身）完全重名。
//
// 🛡️ 历史数据不回溯：仅更新 stores 集合本身的 storeName 字段；report_logs.shopName /
// user_roles.storeName 是提交当时的快照式冗余字段，代表"当时的门店名"，不做批量回写，
// 保持历史餐报与角色审批记录的原始留痕，不因后续改名而失真。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DEFAULT_TENANT_ID = 'yuhuazhai_national';
const DEFAULT_TENANT_STORE_LIMIT = 999;
const MAX_NAME_LENGTH = 40;

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
  }).catch(err => console.warn('[updateStoreName] tenantId 自愈回写失败:', err));

  return DEFAULT_TENANT_ID;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { storeId, newStoreName } = event;

  if (!OPENID) {
    return { success: false, error: '无法获取用户身份' };
  }
  if (!storeId) {
    return { success: false, error: '缺少 storeId 参数' };
  }

  const trimmedName = String(newStoreName || '').trim();
  if (!trimmedName) {
    return { success: false, error: '请输入新的门店名称' };
  }
  if (trimmedName === '全国总览') {
    return { success: false, error: '门店名称不能设置为"全国总览"' };
  }
  if (trimmedName.length > MAX_NAME_LENGTH) {
    return { success: false, error: `门店名称过长（最多 ${MAX_NAME_LENGTH} 字）` };
  }

  try {
    const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
    const caller = roleRes.data && roleRes.data[0];

    if (!caller || caller.role !== 'super_admin') {
      return { success: false, error: '无权限：仅超级管理员可修改门店名称' };
    }

    const tenantId = await resolveCallerTenantId(caller);

    const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
    const store = storeRes && storeRes.data;
    if (!store) {
      return { success: false, error: '门店不存在' };
    }

    // 🏢 多租户边界：不能修改其他机构的门店
    if (store.tenantId && store.tenantId !== tenantId) {
      return { success: false, error: '无权限：该门店不属于您所在的机构' };
    }

    if (store.storeName === trimmedName) {
      return { success: true, message: '名称未变化', storeId, storeName: trimmedName };
    }

    // 防重校验：本机构内是否已存在同名门店（排除自身）
    const dupRes = await db.collection('stores')
      .where({ tenantId, storeName: trimmedName })
      .get();
    const hasDuplicate = (dupRes.data || []).some(s => s._id !== storeId);
    if (hasDuplicate) {
      return { success: false, error: '已存在同名门店' };
    }

    // 仅更新 stores 表本身，不回溯 report_logs / user_roles 中的历史冗余门店名
    // 🛡️ 操作日志留痕：与 updateStoreStatus 云函数同一套 operationLog 追加式
    // 数组约定，lastRenamedFrom/By/At 仍保留作为"最近一次变更"的快照兜底
    await db.collection('stores').doc(storeId).update({
      data: {
        storeName: trimmedName,
        lastRenamedFrom: store.storeName || '',
        lastRenamedBy: OPENID,
        lastRenamedAt: db.serverDate(),
        operationLog: _.push({
          action: 'rename',
          operatorId: OPENID,
          operateTime: db.serverDate(),
          before: store.storeName || '',
          after: trimmedName
        })
      }
    });

    return { success: true, storeId, storeName: trimmedName };
  } catch (err) {
    console.error('[updateStoreName] 异常:', err);
    return { success: false, error: err.message || '修改门店名称失败' };
  }
};
