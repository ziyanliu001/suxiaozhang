// 云函数：processRoleAudit - 角色申请审批（含"新建门店"自动建店）
//
// 🌟 双模式门店申请配套能力：
// 1. 已有门店（storeSelectionType === 'existing'）：沿用原有店长/超管审核逻辑。
// 2. 新建门店（storeSelectionType === 'custom' 或 storeId 为空）：仅限超级管理员审批
//    （新门店尚不存在店长人选）。审批通过时：
//    - 按 {tenantId, storeName} 在 stores 表中查重，命中则复用该门店 _id；
//    - 未命中则新建门店记录（校验机构状态与 tenant_subscriptions 门店配额，
//      与 createStore 云函数的配额规则保持一致，避免此处成为配额限制的绕行口子）；
//    - 将最终确定的 storeId / storeName 连同 tenantId 一并回写进 user_roles 权限表。
//
// 🛡️ 安全加固：storeId/storeName 不再信任客户端传入，全部以服务端已存储的
// 申请记录（user_roles 文档本身）为准重新推导，杜绝伪造 storeId 越权审核。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const TRIAL_DEFAULT_STORE_LIMIT = 3;
const DEFAULT_TENANT_ID = 'yuhuazhai_national';
const DEFAULT_TENANT_STORE_LIMIT = 999;

// 确保默认机构（及其订阅配额）存在，供缺失 tenantId 的 super_admin 账号兜底使用
// （与 createStore 云函数保持一致的自愈逻辑）
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

// 🛡️ 修复"账号尚未分配所属机构"误拦截：super_admin 缺失 tenantId 时回退到默认机构，
// 并自愈回写，避免每次审批都要重新判定
async function resolveAuditorTenantId(auditor) {
  if (auditor.tenantId) return auditor.tenantId;

  await ensureNationalTenant();
  await db.collection('user_roles').doc(auditor._id).update({
    data: { tenantId: DEFAULT_TENANT_ID }
  }).catch(err => console.warn('[processRoleAudit] tenantId 自愈回写失败:', err));

  return DEFAULT_TENANT_ID;
}

// 按 {tenantId, storeName} 查重复用或新建门店，返回 { storeId, storeName }
async function resolveOrCreateStore(tenantId, storeName, operatorOpenId) {
  const existingRes = await db.collection('stores').where({ tenantId, storeName }).limit(1).get();
  if (existingRes.data && existingRes.data.length > 0) {
    const existing = existingRes.data[0];
    return { storeId: existing._id, storeName: existing.storeName };
  }

  // 校验机构状态
  const tenantRes = await db.collection('tenants').doc(tenantId).get().catch(() => null);
  const tenant = tenantRes && tenantRes.data;
  if (tenant && (tenant.status === 'suspended' || tenant.status === 'expired')) {
    throw new Error(`机构服务当前处于「${tenant.status}」状态，无法新建门店，请联系平台管理员续费`);
  }

  // 校验订阅门店配额（与 createStore 云函数保持一致）
  const subRes = await db.collection('tenant_subscriptions')
    .where({ tenantId })
    .orderBy('lastRenewedAt', 'desc')
    .limit(1)
    .get();
  const subscription = subRes.data && subRes.data[0];

  let storeLimit = TRIAL_DEFAULT_STORE_LIMIT;
  if (subscription) {
    if (subscription.status === 'suspended' || subscription.status === 'expired') {
      throw new Error('订阅服务已暂停/过期，无法新建门店，请联系平台管理员续费');
    }
    const todayStr = new Date().toISOString().slice(0, 10);
    if (subscription.serviceExpireDate && subscription.serviceExpireDate < todayStr) {
      throw new Error('服务已过期，无法新建门店，请联系平台管理员续费');
    }
    storeLimit = (subscription.cloudQuota && subscription.cloudQuota.storeLimit) || TRIAL_DEFAULT_STORE_LIMIT;
  }

  const currentCountRes = await db.collection('stores').where({ tenantId }).count();
  if (currentCountRes.total >= storeLimit) {
    throw new Error(`已达当前套餐门店数量上限（${storeLimit} 家），如需新增门店请联系平台管理员升级套餐`);
  }

  const createRes = await db.collection('stores').add({
    data: {
      storeName,
      tenantId,
      status: 'active',
      createdBy: operatorOpenId,
      createdAt: db.serverDate()
    }
  });

  return { storeId: createRes._id, storeName };
}

exports.main = async (event, context) => {
  const { applyId, action } = event;
  const { OPENID } = cloud.getWXContext();

  if (!applyId || !action) {
    return { success: false, error: '参数不完整' };
  }
  if (!OPENID) {
    return { success: false, error: '无法获取用户身份' };
  }

  try {
    // 1. 审核人身份
    const auditorRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
    const auditor = auditorRes.data && auditorRes.data[0];
    if (!auditor) {
      return { success: false, error: '无权限：未找到您的角色信息' };
    }

    // 2. 申请记录：以服务端存储数据为唯一依据，不再信任客户端传入的 storeId/storeName
    const applyRes = await db.collection('user_roles').doc(applyId).get();
    const applyData = applyRes.data;

    if (!applyData) {
      return { success: false, error: '申请记录不存在' };
    }
    if (applyData.status !== 'pending') {
      return { success: false, error: '该申请已处理' };
    }

    // 🏢 多租户边界：审核人与申请人必须同属一个机构
    if (auditor.tenantId && applyData.tenantId && auditor.tenantId !== applyData.tenantId) {
      return { success: false, error: '无权限：该申请不属于您所在的机构' };
    }

    if (action === 'reject') {
      await db.collection('user_roles').doc(applyId).update({
        data: {
          status: 'rejected',
          approveTime: db.serverDate()
        }
      });
      return { success: true, message: '已拒绝申请' };
    }

    if (action !== 'approve') {
      return { success: false, error: '无效操作' };
    }

    // 🏛️ 家长/督导任命仅限超级管理员审批：家长是监督店长的角色，店长本人（哪怕正是
    // 本店店长）不能审批自己门店的督导人选，无论是已有门店还是新建门店分支
    if (applyData.requestedRole === 'store_patriarch' && auditor.role !== 'super_admin') {
      return { success: false, error: '无权限：家长/督导任命仅限超级管理员审批' };
    }

    const isCustomStore = applyData.storeSelectionType === 'custom' || !applyData.storeId;
    let targetStoreId = applyData.storeId;
    let targetStoreName = applyData.storeName;
    let resolvedTenantId = applyData.tenantId || auditor.tenantId || '';

    if (isCustomStore) {
      // 🛡️ 新建门店的申请仅限超级管理员审批：新门店尚无店长人选，店长权限无从谈起
      if (auditor.role !== 'super_admin') {
        return { success: false, error: '无权限：新建门店的申请仅限超级管理员审批' };
      }

      const auditorTenantId = await resolveAuditorTenantId(auditor);
      resolvedTenantId = applyData.tenantId || auditorTenantId;

      const customName = (applyData.customStoreName || applyData.storeName || '').trim();
      if (!customName) {
        return { success: false, error: '申请记录缺少新门店名称' };
      }

      try {
        const resolved = await resolveOrCreateStore(auditorTenantId, customName, OPENID);
        targetStoreId = resolved.storeId;
        targetStoreName = resolved.storeName;
      } catch (storeErr) {
        return { success: false, error: storeErr.message || '建店失败' };
      }
    } else {
      // 已有门店：仅本店店长或本机构超级管理员可审核
      const isAuditorAllowed = auditor.role === 'super_admin' ||
        (auditor.role === 'store_manager' && auditor.storeId === targetStoreId);
      if (!isAuditorAllowed) {
        return { success: false, error: '无权限：仅本门店店长或超级管理员可审核角色申请' };
      }
    }

    // 3. 写入权限表：openid（申请记录本身即绑定 _openid）、role、tenantId、storeId 一并落地
    await db.collection('user_roles').doc(applyId).update({
      data: {
        role: applyData.requestedRole || 'volunteer',
        status: 'approved',
        approveTime: db.serverDate(),
        storeId: targetStoreId,
        storeName: targetStoreName,
        tenantId: resolvedTenantId
      }
    });

    // 🏛️ 家长/店长姓名回写到 stores 文档：海报落款、验真页、家长大盘展示姓名的唯一
    // 数据来源，避免每次展示都要另起 user_roles 联表查询
    if (applyData.requestedRole === 'store_patriarch') {
      await db.collection('stores').doc(targetStoreId).update({
        data: { patriarch: applyData.realName || '', patriarchOpenId: applyData._openid || '' }
      }).catch((err) => console.warn('[processRoleAudit] 回写门店家长姓名失败（不影响审批本身）:', err));
    } else if (applyData.requestedRole === 'store_manager') {
      await db.collection('stores').doc(targetStoreId).update({
        data: { manager: applyData.realName || '', managerOpenId: applyData._openid || '' }
      }).catch((err) => console.warn('[processRoleAudit] 回写门店店长姓名失败（不影响审批本身）:', err));
    }

    return {
      success: true,
      message: isCustomStore ? '已自动建店并授权通过' : '授权通过',
      storeId: targetStoreId,
      storeName: targetStoreName
    };
  } catch (err) {
    console.error('processRoleAudit error:', err);
    return { success: false, error: err.message || '审核失败' };
  }
};
