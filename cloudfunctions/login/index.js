const cloud = require('wx-server-sdk');

cloud.init({
  env: 'cloudbase-d8g7hg2bf851750ab'
});

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
    const now = db.serverDate();
    const existing = await db.collection('users')
      .where({ _openid: OPENID })
      .limit(1)
      .get();

    let user;

    if (existing.data && existing.data.length > 0) {
      user = existing.data[0];
      await db.collection('users').doc(user._id).update({
        data: { lastLoginTime: now }
      });
      console.log('[login] 老用户登录，更新 lastLoginTime:', OPENID);
    } else {
      const addRes = await db.collection('users').add({
        data: {
          _openid: OPENID,
          createTime: now,
          lastLoginTime: now,
          nickName: '',
          avatarUrl: '',
          role: 'user'
        }
      });
      user = {
        _id: addRes._id,
        _openid: OPENID,
        createTime: now,
        lastLoginTime: now,
        nickName: '',
        avatarUrl: '',
        role: 'user'
      };
      console.log('[login] 新用户注册:', OPENID);
    }

    return {
      success: true,
      openid: OPENID,
      user: {
        _id: user._id,
        _openid: user._openid,
        createTime: user.createTime,
        lastLoginTime: user.lastLoginTime,
        nickName: user.nickName || '',
        avatarUrl: user.avatarUrl || '',
        role: user.role || 'user'
      }
    };
  } catch (err) {
    console.error('[login] 异常:', err);
    return {
      success: false,
      error: err.message || '登录服务异常'
    };
  }
};
