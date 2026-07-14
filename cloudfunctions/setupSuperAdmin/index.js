const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const targetOpenid = event.openid || OPENID;

  if (!targetOpenid) {
    return { success: false, error: '请传入 openid 参数或在小程序端调用' };
  }

  try {
    // 查询是否已存在记录
    const existingRes = await db.collection('user_roles')
      .where({ _openid: targetOpenid })
      .limit(1)
      .get();

    if (existingRes.data && existingRes.data.length > 0) {
      const existingDoc = existingRes.data[0];
      // 已存在记录，更新为 super_admin
      await db.collection('user_roles').doc(existingDoc._id).update({
        data: {
          role: 'super_admin',
          status: 'approved',
          storeId: '',
          storeName: '全国总览',
          realName: event.realName || existingDoc.realName || '超级管理员',
          phone: event.phone || existingDoc.phone || '',
          setupTime: db.serverDate()
        }
      });

      return {
        success: true,
        message: '已升级为超级管理员',
        openid: targetOpenid,
        action: 'updated'
      };
    }

    await db.collection('user_roles').add({
      data: {
        _openid: targetOpenid,
        realName: event.realName || '超级管理员',
        phone: event.phone || '',
        storeId: '',
        storeName: '全国总览',
        requestedRole: 'super_admin',
        role: 'super_admin',
        status: 'approved',
        applyTime: db.serverDate(),
        approveTime: db.serverDate()
      }
    });

    return {
        success: true,
        message: '已创建超级管理员记录',
        openid: targetOpenid,
        action: 'created'
      };
  } catch (err) {
    console.error('[setupSuperAdmin] 异常:', err);
    return { success: false, error: err.message || '设置失败' };
  }
};
