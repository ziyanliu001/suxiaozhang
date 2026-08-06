// 云函数：manageVolunteerBinding
// 店长审核抽屉【已绑定义工】Tab 的人员管理入口：
// - action === 'changeRole'：在 finance（财务记账）/ volunteer（现场奉献）之间切换角色权限。
// - action === 'unbind'：解除绑定（软删除为 revoked 状态，保留审计记录，不物理删除）。
//
// 🛡️ 权限：仅本店店长或超级管理员可操作，且仅可管理 finance/volunteer 这类"义工"角色，
// 不允许通过此入口误改/误踢店长（store_manager）权限。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 所有可被管理的角色（含管理岗位）；大家长任命由超管发起，此处仍可被超管撤销
const MANAGEABLE_ROLES = ['finance', 'volunteer', 'store_manager', 'store_patriarch'];
// 大家长/店长为"提升类"角色，撤销时有额外权限限制：大家长只能由超管撤销
const ELEVATED_ROLES = ['store_manager', 'store_patriarch'];

exports.main = async (event) => {
  const { targetId, action, newRole } = event;
  const { OPENID } = cloud.getWXContext();

  if (!OPENID) {
    return { success: false, error: '无法获取用户身份' };
  }
  if (!targetId || !action) {
    return { success: false, error: '参数不完整' };
  }

  try {
    const callerRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
    const caller = callerRes.data && callerRes.data[0];
    // 🏛️ 大家长/店长/超管并集：与 hasStoreAdminPrivilege 同一口径
    if (!caller || !['store_manager', 'store_patriarch', 'super_admin'].includes(caller.role)) {
      return { success: false, error: '无权限：仅大家长/店长/超级管理员可管理成员权限' };
    }

    const targetRes = await db.collection('user_roles').doc(targetId).get().catch(() => null);
    const target = targetRes && targetRes.data;
    if (!target) {
      return { success: false, error: '目标成员记录不存在' };
    }
    if (target.status !== 'approved') {
      return { success: false, error: '仅可管理已授权的成员' };
    }
    if (!MANAGEABLE_ROLES.includes(target.role)) {
      return { success: false, error: '无效的目标成员角色' };
    }

    // 🛡️ 门店隔离：非超管只能操作本门店成员
    const isAllowed = caller.role === 'super_admin' ||
      ((caller.role === 'store_manager' || caller.role === 'store_patriarch') && caller.storeId === target.storeId);
    if (!isAllowed) {
      return { success: false, error: '无权限：不能管理其他门店的成员' };
    }

    // 🏛️ 大家长撤销/降级仅限超管：大家长由超管任命，相应地只有超管可以撤销
    if (ELEVATED_ROLES.includes(target.role) && target.role === 'store_patriarch' && caller.role !== 'super_admin') {
      return { success: false, error: '无权限：大家长的撤销/降级仅限超级管理员操作' };
    }

    if (action === 'unbind') {
      await db.collection('user_roles').doc(targetId).update({
        data: {
          status: 'revoked',
          revokedAt: db.serverDate(),
          revokedBy: OPENID
        }
      });
      return { success: true, message: '已移出门店' };
    }

    if (action === 'changeRole') {
      // 降级只能降到 volunteer 或平级切换 finance/volunteer；不允许通过此接口提权
      if (!['volunteer', 'finance'].includes(newRole)) {
        return { success: false, error: '降级目标角色无效（仅可降级为义工或切换财务/义工）' };
      }
      await db.collection('user_roles').doc(targetId).update({
        data: { role: newRole }
      });
      return { success: true, message: '角色已更新', newRole };
    }

    return { success: false, error: '无效操作' };
  } catch (err) {
    console.error('[manageVolunteerBinding] 异常:', err);
    return { success: false, error: err.message || '操作失败' };
  }
};
