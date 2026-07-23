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

const MANAGEABLE_ROLES = ['finance', 'volunteer'];

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
    // 🏛️ 权限向下继承：大家长天然拥有店长的全套日常管理权限
    if (!caller || !['store_manager', 'store_patriarch', 'super_admin'].includes(caller.role)) {
      return { success: false, error: '无权限：仅店长/大家长/超级管理员可管理义工绑定' };
    }

    const targetRes = await db.collection('user_roles').doc(targetId).get().catch(() => null);
    const target = targetRes && targetRes.data;
    if (!target) {
      return { success: false, error: '目标绑定记录不存在' };
    }
    if (target.status !== 'approved') {
      return { success: false, error: '仅可管理已绑定的义工' };
    }
    if (!MANAGEABLE_ROLES.includes(target.role)) {
      return { success: false, error: '无权限：不能通过此入口调整店长权限' };
    }

    const isAllowed = caller.role === 'super_admin' ||
      ((caller.role === 'store_manager' || caller.role === 'store_patriarch') && caller.storeId === target.storeId);
    if (!isAllowed) {
      return { success: false, error: '无权限：不能管理其他门店的义工绑定' };
    }

    if (action === 'unbind') {
      await db.collection('user_roles').doc(targetId).update({
        data: {
          status: 'revoked',
          revokedAt: db.serverDate(),
          revokedBy: OPENID
        }
      });
      return { success: true, message: '已解除绑定' };
    }

    if (action === 'changeRole') {
      if (!MANAGEABLE_ROLES.includes(newRole)) {
        return { success: false, error: '无效的目标角色' };
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
