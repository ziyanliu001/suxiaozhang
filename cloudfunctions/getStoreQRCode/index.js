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
    // 🌟 证书二维码 scene 极简编码：证书场景不需要完整 storeId，只用于朋友圈扫码
    // 引流时让 app.ts 识别出"谁分享的、指向哪家门店"，两段各截取前 10 位足以
    // 支撑邀请弹窗的模糊匹配，且能稳定控制在 32 字符硬限制内（不像完整 storeId
    // 拼接后长度取决于云环境 ID 生成规则，存在超限风险，见下方 MAX_SCENE_LENGTH 校验）
    const codeTarget = (isVerifyQr && dateDigits.length === 8)
      ? { page: 'pages/public-verify/index', scene: `t_${storeId}_d_${dateDigits}` }
      : isPersonalCertificate
        ? { page: 'pages/index/index', scene: `u=${String(OPENID || '').substring(0, 10)}&s=${String(storeId).substring(0, 10)}` }
        : { page: 'pages/index/index', scene: `s=${storeId}` };

    // 🛡️ scene 字段硬限制 32 字符（wxacode.getUnlimited API 限制）——storeId 是微信
    // 云数据库自动生成的 _id，不保证是短字符串，实际长度取决于云环境的 ID 生成规则，
    // 拼上 t_/s=/_d_<8位日期> 等前缀后有可能超出 32 字符硬顶。
    // 这里刻意不做有损截断：无论是 pages/index/index 扫码后的"自动识别门店并提示
    // 申请加入"（fetchStoreInfoAndPromptApply），还是 pages/public-verify 的
    // "扫码验真"，两端解析 scene 时都要求拿到完整、精确的 storeId 去做数据库精确
    // 查询——截断成短前缀的话，两端要么查不到任何门店，要么（更危险）误撞到另一家
    // 门店，让"扫码验真"这种关系到公众信任的功能悄悄指向错误数据。宁可在生成阶段
    // 就明确失败并返回可诊断的错误信息，也不要发一个注定超限、或即使侥幸成功也
    // 无法被正确解析回真实门店的二维码。
    const MAX_SCENE_LENGTH = 32;
    if (codeTarget.scene.length > MAX_SCENE_LENGTH) {
      console.error('[getStoreQRCode] scene 超出 32 字符硬限制:', codeTarget.scene, `(${codeTarget.scene.length} 字符)`);
      return { success: false, error: `门店标识过长（scene ${codeTarget.scene.length} 字符，上限 32），暂无法生成二维码` };
    }

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
