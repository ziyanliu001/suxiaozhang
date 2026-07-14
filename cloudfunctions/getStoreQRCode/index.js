const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { storeId, storeName } = event;

  if (!storeId) {
    return { success: false, error: '缺少 storeId 参数' };
  }

  try {
    const db = cloud.database();

    const roleRes = await db.collection('user_roles')
      .where({ _openid: OPENID })
      .limit(1)
      .get();

    let userRole = 'volunteer';
    let userStoreId = '';

    if (roleRes.data && roleRes.data.length > 0) {
      userRole = roleRes.data[0].role || 'volunteer';
      userStoreId = roleRes.data[0].storeId || '';
    } else {
      const userRes = await db.collection('users')
        .where({ _openid: OPENID })
        .limit(1)
        .get();
      if (userRes.data && userRes.data.length > 0) {
        userRole = userRes.data[0].role === 'admin' ? 'super_admin' : 'volunteer';
        userStoreId = userRes.data[0].storeId || '';
      }
    }

    if (userRole !== 'super_admin') {
      if (userRole !== 'store_manager') {
        return { success: false, error: '无权限生成二维码' };
      }
      if (userStoreId && userStoreId !== storeId) {
        return { success: false, error: '无权生成其他门店二维码' };
      }
    }

    const result = await cloud.openapi.wxacode.getUnlimited({
      scene: `s=${storeId}`,
      page: 'pages/index/index',
      width: 430,
      isHyaline: false
    });

    if (result.errCode === 0) {
      const uploadRes = await cloud.uploadFile({
        cloudPath: `store_qrcodes/qr_${storeId}.png`,
        fileContent: result.buffer
      });

      return {
        success: true,
        fileID: uploadRes.fileID
      };
    }

    console.error('[getStoreQRCode] 生成失败:', result);
    return { success: false, error: result };
  } catch (err) {
    console.error('[getStoreQRCode] 异常:', err);
    return { success: false, error: err.message || '生成二维码异常' };
  }
};
