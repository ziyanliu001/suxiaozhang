const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();

  if (!OPENID) {
    return {
      success: false,
      error: '无法获取用户身份'
    };
  }

  try {
    // 优先查询 user_roles 权限集合
    const roleRes = await db.collection('user_roles')
      .where({ _openid: OPENID })
      .limit(1)
      .get();

    if (roleRes.data && roleRes.data.length > 0) {
      const user = roleRes.data[0];
      return {
        success: true,
        openid: OPENID,
        role: user.role || 'volunteer',
        storeId: user.storeId || '',
        storeName: user.storeName || '未绑定门店',
        status: user.status || 'approved'
      };
    }

    // 降级查询 users 集合（兼容旧数据）
    const userRes = await db.collection('users')
      .where({ _openid: OPENID })
      .limit(1)
      .get();

    if (userRes.data && userRes.data.length > 0) {
      const user = userRes.data[0];
      const oldRole = user.role || 'user';
      // 映射旧角色到新体系
      let mappedRole = 'volunteer';
      if (oldRole === 'admin') {
        mappedRole = 'super_admin';
      }

      return {
        success: true,
        openid: OPENID,
        role: mappedRole,
        storeId: user.storeId || '',
        storeName: user.storeName || '',
        status: 'approved'
      };
    }

    // 默认新用户为普通义工
    return {
      success: true,
      openid: OPENID,
      role: 'volunteer',
      storeId: '',
      storeName: '未绑定门店',
      status: 'guest'
    };
  } catch (err) {
    console.error('[checkUserRole] 异常:', err);
    return {
      success: false,
      error: err.message || '角色查询异常'
    };
  }
};
