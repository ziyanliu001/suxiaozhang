const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { applyId, action, storeId, storeName } = event;

  if (!applyId || !action || !storeId) {
    return { success: false, error: '参数不完整' };
  }

  try {
    const applyRes = await db.collection('user_roles').doc(applyId).get();
    const applyData = applyRes.data;

    if (!applyData) {
      return { success: false, error: '申请记录不存在' };
    }

    if (applyData.status !== 'pending') {
      return { success: false, error: '该申请已处理' };
    }

    if (applyData.storeId !== storeId) {
      return { success: false, error: '无权审核其他门店申请' };
    }

    if (action === 'approve') {
      await db.collection('user_roles').doc(applyId).update({
        data: {
          role: applyData.requestedRole || 'volunteer',
          status: 'approved',
          approveTime: db.serverDate()
        }
      });
      return { success: true, message: '授权通过' };
    } else if (action === 'reject') {
      await db.collection('user_roles').doc(applyId).update({
        data: {
          status: 'rejected',
          approveTime: db.serverDate()
        }
      });
      return { success: true, message: '已拒绝申请' };
    }

    return { success: false, error: '无效操作' };
  } catch (err) {
    console.error('processRoleAudit error:', err);
    return { success: false, error: err.message || '审核失败' };
  }
};
