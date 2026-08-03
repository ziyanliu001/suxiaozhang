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
        status: user.status || 'approved',
        // 🏢 多租户：随身份一并下发所属机构 ID；platform_admin 账号本身不挂在任何 tenantId 下
        tenantId: user.tenantId || '',
        // 🙋 头像昵称填写规范：随角色信息一并下发，个人中心页面无需再单独查询
        avatarUrl: user.avatarUrl || '',
        nickName: user.nickName || '',
        // 🏛️ 多角色兼任：manageStoreInviteCode 的 redeem 动作会往这个数组里追加
        // 已核销的邀请码身份（如 ['STORE_MANAGER','FINANCE']）；此前从未随
        // checkUserRole 下发过，客户端完全看不到，profile.ts 的"切换身份"面板
        // 需要靠它判断当前账号是否兼任了多个身份
        roles: Array.isArray(user.roles) ? user.roles : []
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
        status: 'approved',
        avatarUrl: user.avatarUrl || '',
        nickName: user.nickName || '',
        roles: []
      };
    }

    // 默认新用户为普通义工
    return {
      success: true,
      openid: OPENID,
      role: 'volunteer',
      storeId: '',
      storeName: '未绑定门店',
      status: 'guest',
      avatarUrl: '',
      nickName: '',
      roles: []
    };
  } catch (err) {
    console.error('[checkUserRole] 异常:', err);
    return {
      success: false,
      error: err.message || '角色查询异常'
    };
  }
};
