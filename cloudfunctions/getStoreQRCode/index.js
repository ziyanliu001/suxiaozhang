const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { storeId, storeName, purpose, date } = event;

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
    let userTenantId = '';

    if (roleRes.data && roleRes.data.length > 0) {
      userRole = roleRes.data[0].role || 'volunteer';
      userStoreId = roleRes.data[0].storeId || '';
      userTenantId = roleRes.data[0].tenantId || '';
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

    // 🌟 个人荣誉证书场景：任何已登录角色（含普通义工）都需要能拿到一个指向本小程序的
    // 二维码贴在自己的证书上，不应该被"仅店长/超管可生成门店推广二维码"这条规则挡住——
    // 门店邀请海报的二维码用于对外招募，权限要求高；证书二维码只是"扫码回到小程序"，
    // 风险等级完全不同。这里放宽的前提是"只能扫自己所在门店的码"，不允许越权生成他人门店的。
    const isPersonalCertificate = purpose === 'certificate';

    if (isPersonalCertificate) {
      if (userStoreId && userStoreId !== storeId) {
        return { success: false, error: '仅可生成本人所属门店的二维码' };
      }
    } else if (userRole !== 'super_admin') {
      if (userRole !== 'store_manager') {
        return { success: false, error: '无权限生成二维码' };
      }
      if (userStoreId && userStoreId !== storeId) {
        return { success: false, error: '无权生成其他门店二维码' };
      }
    } else if (userTenantId) {
      // 🏢 多租户边界：super_admin 的管辖范围收敛为本机构，禁止为他机构门店生成二维码
      const targetStoreRes = await db.collection('stores').doc(storeId).get().catch(() => null);
      const targetStore = targetStoreRes && targetStoreRes.data;
      if (targetStore && targetStore.tenantId && targetStore.tenantId !== userTenantId) {
        return { success: false, error: '无权生成其他机构门店二维码' };
      }
    }

    // 🌟 验真二维码场景：海报右下角"扫码验真"需要一个指向公开只读页面
    // pages/public-verify/index、且携带 storeId+date 的码，而不是首页推广码。
    // scene 字段上限 32 字符（wxacode.getUnlimited 硬限制），装不下完整门店名/
    // 带连字符的日期，编码成 t_<storeId>_d_<yyyymmdd> 由 public-verify 页自行解析
    // （见该页 resolveTarget 里的兼容格式）
    const isVerifyQr = purpose === 'verify';
    const dateDigits = String(date || '').replace(/[^0-9]/g, '');
    const codeTarget = (isVerifyQr && dateDigits.length === 8)
      ? { page: 'pages/public-verify/index', scene: `t_${storeId}_d_${dateDigits}` }
      : { page: 'pages/index/index', scene: `s=${storeId}` };

    const result = await cloud.openapi.wxacode.getUnlimited({
      scene: codeTarget.scene,
      page: codeTarget.page,
      width: 430,
      isHyaline: false
    });

    if (result.errCode === 0) {
      const cloudPath = isVerifyQr
        ? `store_qrcodes/qr_verify_${storeId}_${dateDigits}.png`
        : `store_qrcodes/qr_${storeId}.png`;
      const uploadRes = await cloud.uploadFile({
        cloudPath,
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
