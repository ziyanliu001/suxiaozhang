const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 🐛（2026-08-31 紧急修复：验真二维码 scene 45 字符超限）根因：验真场景
// scene 原编码为 `t_${storeId}_d_${dateDigits}`，云数据库自动生成的 _id 是
// 32 位十六进制字符串——2(t_) + 32(storeId) + 3(_d_) + 8(日期) = 45 字符，
// 远超 wxacode.getUnlimited 的 32 字符硬顶，生成必然失败。
//
// 🛡️ 压缩策略：不做有损截断（截断 storeId 前 N 位会导致扫码验真查到别家
// 门店，见下方分支保留的旧格式注释里对这个风险的说明），而是把 32 位十六进
// 制 _id（128 bit）当大整数用 BigInt 重新按 36 进制编码——128 bit 数值在
// 36 进制下最多 25 个字符（36^25 > 2^128 - 1 > 36^24），可逆、不丢精度，
// 比原样保留省下至少 7 个字符。日期同样按 36 进制编码：yyyymmdd 这个
// 8 位十进制数在 2000-01-01 至 2099-12-31 整个 21 世纪范围内换算成 36 进制
// 恒为 5 位（36^4 < 20000101 且 20991231 < 36^5），不需要额外补零对齐。
// 新格式 = base36(storeId) + base36(yyyymmdd)，全程不含分隔符——旧格式
// t_..._d_... 固定包含下划线，新格式的 36 进制字母表（0-9a-z）里没有下划线，
// 解析侧（public-verify resolveTarget）靠"是否包含下划线"零成本区分两种
// 格式，互不冲突，已经打印/分享出去的旧码不受影响。
const HEX32_PATTERN = /^[0-9a-f]{32}$/i;

function hexToBase36(hexStr) {
  return BigInt('0x' + hexStr).toString(36);
}

// 🛡️ 只在"能保证安全落在 32 字符硬顶内"时才启用压缩格式：非标准 32 位
// 十六进制 _id（如少量手工建的短字符串种子门店 'store_haicang_001'）本就
// 不长，直接沿用旧的可读格式即可，没有压缩必要，也避免对非十六进制输入
// 做 BigInt 转换出错
function buildVerifyScene(storeId, dateDigits) {
  if (HEX32_PATTERN.test(storeId) && dateDigits.length === 8) {
    const storeIdB36 = hexToBase36(storeId);
    const dateB36 = parseInt(dateDigits, 10).toString(36);
    if (dateB36.length === 5) {
      return storeIdB36 + dateB36;
    }
    // 极端兜底：日期换算后不是预期的 5 位（理论上只有 22 世纪之后才会发生），
    // 退回旧格式，交给下方 MAX_SCENE_LENGTH 校验兜底
  }
  return `t_${storeId}_d_${dateDigits}`;
}

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
    // 🐛 根因修复：打卡成功后的"餐报海报"底部"扫码查看透明账本"二维码
    // （index.ts generateQrCode()）此前没传 purpose，落进下面 else 分支——
    // 该分支要求 store_manager/super_admin，普通义工（打卡这个动作本身就是
    // 义工最主要的使用场景）调用必然被拒，"点击重试"点多少次都是同一个权限墙，
    // 永远卡在占位态。这枚二维码跟证书码同一个风险等级（都只是"扫码回到小程序"，
    // 不是对外招募注册管理身份），补一个 checkin_share 场景纳入同一档低风险豁免，
    // 同样限定"只能扫自己所在门店的码"
    const isLowRiskPersonalQr = purpose === 'certificate' || purpose === 'checkin_share';

    if (isLowRiskPersonalQr) {
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
    // subpackages/admin/pages/public-verify/index、且携带 storeId+date 的码，而不是首页推广码。
    // scene 字段上限 32 字符（wxacode.getUnlimited 硬限制），实际编码由
    // buildVerifyScene() 决定——32 位十六进制 _id 走 base36 压缩格式（不含
    // 下划线），短种子门店 ID 走旧的 t_<storeId>_d_<yyyymmdd> 可读格式，
    // 由 public-verify 页 resolveTarget 按"是否含下划线"自动区分解析
    // （见该页头部注释）
    const isVerifyQr = purpose === 'verify';
    // 🐛 与上面权限检查的 isLowRiskPersonalQr 是两个独立关注点：这里只决定
    // scene 该编码成"u=<openid前10位>&s=<storeId前10位>"（证书场景，供 app.ts
    // 朋友圈扫码引流识别"谁分享的"）还是裸 storeId（checkin_share 场景不需要
    // 这层引流归因，直接复用下面 else 分支的默认门店码格式即可）
    const isPersonalCertificate = purpose === 'certificate';
    const dateDigits = String(date || '').replace(/[^0-9]/g, '');
    // 🌟 证书二维码 scene 极简编码：证书场景不需要完整 storeId，只用于朋友圈扫码
    // 引流时让 app.ts 识别出"谁分享的、指向哪家门店"，两段各截取前 10 位足以
    // 支撑邀请弹窗的模糊匹配，且能稳定控制在 32 字符硬限制内（不像完整 storeId
    // 拼接后长度取决于云环境 ID 生成规则，存在超限风险，见下方 MAX_SCENE_LENGTH 校验）
    // 🐛 根治「scene 34 字符，上限 32」报错：门店主邀请码此前固定拼
    // `s=${storeId}`，而云数据库自动生成的 _id 本身就是 32 位十六进制字符串
    // （如 1a4410256a5e2c29015e01965a1550a4）——"s=" 这两个字符的前缀是纯浪费，
    // 32 + 2 = 34 必然超出 wxacode.getUnlimited 的 32 字符硬限制，等于但凡是
    // 云数据库自动 _id 的门店（绝大多数，只有少量手工建的种子门店如
    // 'store_haicang_001' 是短 ID）一律生成失败。既然这条主邀请码分支从不需要
    // 跟其它 key（如证书码的 u=&s=）共用一个 scene 承载多个字段，直接把 scene
    // 设为裸 storeId 本身，不做任何 key=value 包装——32 位 UUID 也刚好卡在
    // 32 字符上限内，不再有溢出空间可浪费。扫码解析侧同步适配（见
    // pages/index/index.ts onLoad），且保留对存量已生成/已分享二维码里
    // "s=<storeId>" 老格式的兼容解析，不影响已经印出去、发出去的海报
    const codeTarget = (isVerifyQr && dateDigits.length === 8)
      ? { page: 'subpackages/admin/pages/public-verify/index', scene: buildVerifyScene(storeId, dateDigits) }
      : isPersonalCertificate
        ? { page: 'pages/index/index', scene: `u=${String(OPENID || '').substring(0, 10)}&s=${String(storeId).substring(0, 10)}` }
        : { page: 'pages/index/index', scene: String(storeId) };

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
