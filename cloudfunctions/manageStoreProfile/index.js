// 云函数：manageStoreProfile - 门店人员与服务人群画像（7 项人数指标）的读取与编辑
//
// 权限模型：
// - 读（get）：任意已绑定门店的角色（店长/财务/义工）只读本店画像；super_admin/
//   hq_finance/regional_finance 可传 storeId 或 storeName（统计大屏门店下拉框
//   目前只掌握 storeName，没有 storeId，见 statistics.ts 调用处）查看本机构内
//   任意门店，两者都未传时按各自 caller.storeId 兜底。
// - 写（update）：仅 store_manager（限本店，storeId 强制取自身份记录，不信任客户端
//   传入值）或 super_admin（限本机构内任意门店，校验目标门店 tenantId）。
//   与 manageDailyMenu/manageExpenseTemplate/manageNotice 同款权限校验模式。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const PROFILE_FIELDS = [
  'partyMembers',
  'socialWorkers',
  'volunteersCount',
  'dineInSeniorsCount',
  'deliverySeniorsCount',
  'listeningSeniorsCount',
  'otherCount'
];

// 允许跨店查看（不限于自己绑定门店）的角色：与 getStatisticsData/getNationalDashboard
// 里"总部级只读汇总"的角色口径一致，仅用于本函数的 get（只读），不影响 update 权限
const CROSS_STORE_VIEW_ROLES = ['super_admin', 'hq_finance', 'regional_finance'];

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

// 读权限：本店任意角色只读；总部级角色可传 storeId 或 storeName 查看机构内任意门店
async function resolveReadTarget(caller, requestedStoreId, requestedStoreName) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  if (CROSS_STORE_VIEW_ROLES.includes(caller.role) && (requestedStoreId || requestedStoreName)) {
    let store = null;
    if (requestedStoreId) {
      const storeRes = await db.collection('stores').doc(requestedStoreId).get().catch(() => null);
      store = storeRes && storeRes.data;
    } else {
      const where = { storeName: requestedStoreName };
      if (caller.tenantId) where.tenantId = caller.tenantId;
      const listRes = await db.collection('stores').where(where).limit(1).get().catch(() => null);
      store = listRes && listRes.data && listRes.data[0];
    }
    if (!store) return { allowed: false, error: '目标门店不存在' };
    if (caller.tenantId && store.tenantId && caller.tenantId !== store.tenantId) {
      return { allowed: false, error: '无权限：目标门店不属于您所在的机构' };
    }
    return { allowed: true, storeId: store._id };
  }

  if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店' };
  return { allowed: true, storeId: caller.storeId };
}

// 写权限：仅店长（限本店）或超管（限本机构内任意门店）
async function resolveWriteTarget(caller, requestedStoreId) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  if (caller.role === 'store_manager') {
    if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店，无法编辑门店画像' };
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

  return { allowed: false, error: '无权限：仅店长或超级管理员可编辑门店人员与服务人群画像' };
}

function clampCount(v) {
  const n = parseInt(v, 10);
  if (!isFinite(n) || n < 0) return 0;
  return n;
}

// 🏛️ 家长风控锁：门店是否绑定了家长/督导——绑定了才需要走"店长发起、家长/超管
// 确认"的挂起流程；未绑定家长的门店，行为与升级前完全一致（店长直接生效）
function hasBoundPatriarch(store) {
  return !!(store && store.patriarchOpenId);
}

exports.main = async (event, context) => {
  const { action, storeId, storeName } = event;
  const { OPENID } = cloud.getWXContext();

  try {
    const caller = await resolveCaller(OPENID);

    if (action === 'get') {
      const target = await resolveReadTarget(caller, storeId, storeName);
      if (!target.allowed) return { success: false, error: target.error };

      const storeRes = await db.collection('stores').doc(target.storeId).get().catch(() => null);
      const store = storeRes && storeRes.data;
      if (!store) return { success: false, error: '门店不存在' };

      const profile = {};
      PROFILE_FIELDS.forEach((f) => { profile[f] = store[f] || 0; });

      return {
        success: true,
        data: {
          storeId: target.storeId,
          storeName: store.storeName || '',
          address: store.address || '',
          canEdit: caller && (caller.role === 'store_manager' || caller.role === 'super_admin'),
          // 🏛️ 家长/店长姓名：海报落款、验真页、家长大盘展示姓名的唯一数据来源
          patriarch: store.patriarch || '',
          manager: store.manager || '',
          // 待审批的画像变更（若有）：供 store-profile 页展示"有一份更新正在等待审批"提示
          pendingProfileUpdate: store.pendingProfileUpdate || null,
          ...profile
        }
      };
    }

    if (action === 'update') {
      const target = await resolveWriteTarget(caller, storeId);
      if (!target.allowed) return { success: false, error: target.error };

      const updateFields = {};
      PROFILE_FIELDS.forEach((f) => { updateFields[f] = clampCount(event[f]); });

      // 🏛️ 家长风控锁：店长发起且本店已绑定家长/督导时，不直接生效，改为存入
      // pendingProfileUpdate 挂起对象等待确认；超管发起或门店未绑定家长时，
      // 行为与升级前完全一致（直接生效）
      if (caller.role === 'store_manager') {
        const storeRes = await db.collection('stores').doc(target.storeId).get().catch(() => null);
        const store = storeRes && storeRes.data;
        if (hasBoundPatriarch(store)) {
          if (store.pendingProfileUpdate) {
            return { success: false, error: '已有一份画像更新正在等待家长/超管审批，请勿重复提交' };
          }
          await db.collection('stores').doc(target.storeId).update({
            data: {
              pendingProfileUpdate: {
                ...updateFields,
                requestedBy: OPENID,
                requestedAt: db.serverDate()
              }
            }
          });
          return { success: true, pending: true, message: '已提交家长/超管审批，确认后生效' };
        }
      }

      const updateData = { ...updateFields };
      updateData.lastProfileUpdatedBy = OPENID;
      updateData.lastProfileUpdatedAt = db.serverDate();

      await db.collection('stores').doc(target.storeId).update({ data: updateData });

      return { success: true, message: '门店人员与服务人群画像已更新', data: updateData };
    }

    if (action === 'approveProfileUpdate' || action === 'rejectProfileUpdate') {
      if (!caller || (caller.role !== 'store_patriarch' && caller.role !== 'super_admin')) {
        return { success: false, error: '无权限：仅家长/督导或超级管理员可确认画像变更申请' };
      }
      if (!storeId) return { success: false, error: '缺少 storeId 参数' };

      const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
      const store = storeRes && storeRes.data;
      if (!store) return { success: false, error: '门店不存在' };
      if (caller.tenantId && store.tenantId && caller.tenantId !== store.tenantId) {
        return { success: false, error: '无权限：不能审批其他机构的门店' };
      }
      if (caller.role === 'store_patriarch' && caller.storeId !== storeId) {
        return { success: false, error: '无权限：不能审批其他门店的画像变更申请' };
      }
      if (!store.pendingProfileUpdate) {
        return { success: false, error: '该门店当前没有待确认的画像变更申请' };
      }

      if (action === 'rejectProfileUpdate') {
        await db.collection('stores').doc(storeId).update({ data: { pendingProfileUpdate: null } });
        return { success: true, message: '已驳回画像变更申请，数据保持原状' };
      }

      const pending = store.pendingProfileUpdate;
      const updateData = {};
      PROFILE_FIELDS.forEach((f) => { updateData[f] = clampCount(pending[f]); });
      updateData.lastProfileUpdatedBy = pending.requestedBy || '';
      updateData.lastProfileUpdatedAt = db.serverDate();
      updateData.pendingProfileUpdate = null;

      await db.collection('stores').doc(storeId).update({ data: updateData });

      return { success: true, message: '已确认画像变更', data: updateData };
    }

    return { success: false, error: '未知操作: ' + action };
  } catch (err) {
    console.error('[manageStoreProfile] 异常:', err);
    return { success: false, error: err.message || '服务异常' };
  }
};
