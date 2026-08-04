// 云函数：manageStoreInviteCode
// 【新增特权邀请码】全链路重构：替代此前小程序端直接 db.collection('store_invites')
// .add()/.update() 的全客户端直连写库方案（真正的权限判定只停留在客户端 JS，
// 任何人打开开发者工具对同一个小程序会话直接调用 wx.cloud.database() 就能绕过）。
//
// action: 'generate' —— 越权前置阻断后生成一次性邀请码 + 太阳码
// action: 'redeem'   —— 一次性核销，多角色兼任写入 user_roles.roles 数组，
//                        且严禁抹除用户已有的义工打卡工时数据

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const CODE_TTL_MS = 24 * 3600 * 1000;
// 🌟 "高对比度"字符集：剔除 0/O、1/I 这类肉眼易混淆的字符对，人工朗读/誊抄邀请码时
// 不容易抄错，而不是指视觉设计意义上的高对比度配色
const CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const VALID_TARGET_ROLES = ['STORE_PATRIARCH', 'STORE_MANAGER', 'FINANCE', 'FAMILY', 'VOLUNTEER'];
// 🛡️ scene 字段硬限制 32 字符（wxacode.getUnlimited API 限制），与 getStoreQRCode
// 同一口径的防御性校验——邀请码固定 8 位 + "code=" 前缀恒为 13 字符，理论上不可能
// 超限，这里仍显式校验一次，任何未来调整编码格式的改动都会被这道校验立即拦下，
// 不会悄悄生成一个注定触发 errCode 40169 的太阳码
const MAX_SCENE_LENGTH = 32;

// 🛡️ 身份阶梯权限：数值越大权限越高，用于 redeem 时判断"是否需要提升调用者的主角色"，
// 与 authService.ts 的 UserRole 体系对齐——FAMILY 不是一个正式 role（家人/服务对象
// 是 role==='volunteer' 且 status!=='approved' 的默认态，见 checkUserRole 云函数），
// 不参与主角色晋升排名
const ROLE_RANK = {
  volunteer: 1,
  finance: 2,
  store_manager: 3,
  store_patriarch: 3,
  super_admin: 4
};

// 邀请目标角色 -> user_roles.role 单值字段应写入的值（FAMILY 例外，不提升主角色）
const TARGET_ROLE_TO_PRIMARY = {
  STORE_PATRIARCH: 'store_patriarch',
  STORE_MANAGER: 'store_manager',
  FINANCE: 'finance',
  VOLUNTEER: 'volunteer'
};

function generateRandomCode() {
  let raw = '';
  for (let i = 0; i < 8; i++) {
    raw += CODE_CHARSET[Math.floor(Math.random() * CODE_CHARSET.length)];
  }
  return { display: `${raw.slice(0, 4)}-${raw.slice(4)}`, normalized: raw };
}

function normalizeCodeInput(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

// 🏛️ 权限层级重构：大家长（store_patriarch）确立为门店最高负责人——与
// super_admin 一样解锁全部五档身份的生成权限（含继任大家长/门店店长），不再
// 卡在"仅超级管理员可授权"这道关卡；店长（store_manager）次一级，可任命
// 门店财务/家人/志愿者，但不能任命大家长/门店店长——这两档与店长自身同级
// 或更高，只有大家长本人或超管能任命。
// 只有 super_admin / store_manager / store_patriarch 三种角色允许发码，
// finance/volunteer/family 一律无权限（不在权限阶梯里，不能自我复制/越级授权）
function checkGeneratePermission(caller, storeId, targetRole) {
  if (!caller || caller.status !== 'approved') {
    return '无权限：账号尚未通过审核，不能生成邀请码';
  }
  if (caller.role === 'super_admin') {
    return null;
  }
  if (caller.role !== 'store_manager' && caller.role !== 'store_patriarch') {
    return '无权限：仅超级管理员/店长/大家长可生成邀请码';
  }
  // 单店店长 / 单店大家长：严格禁止跨店发码
  if (!caller.storeId || caller.storeId !== storeId) {
    return '无权限：不能为其他门店生成邀请码';
  }
  // 大家长是门店最高负责人：全部五档身份放行，含继任大家长/门店店长
  if (caller.role === 'store_patriarch') {
    return null;
  }
  // 店长次一级：不能任命大家长/门店店长——这两档与店长自身同级或更高，
  // 只有大家长本人或超管能任命
  if (targetRole === 'STORE_PATRIARCH' || targetRole === 'STORE_MANAGER') {
    return '无权限：店长不能生成"大家长"/"门店店长"邀请码，请联系大家长或超级管理员';
  }
  return null;
}

async function handleGenerate(event, OPENID) {
  const { storeId, targetRole } = event;
  if (!storeId) {
    return { success: false, error: '缺少 storeId 参数' };
  }
  if (!VALID_TARGET_ROLES.includes(targetRole)) {
    return { success: false, error: '无效的目标身份' };
  }

  const caller = await resolveCaller(OPENID);
  const permErr = checkGeneratePermission(caller, storeId, targetRole);
  if (permErr) {
    return { success: false, error: permErr };
  }

  const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
  const store = storeRes && storeRes.data;
  if (!store) {
    return { success: false, error: '目标门店不存在' };
  }
  // 🏢 多租户边界：super_admin 的管辖范围收敛为本机构，与 createStore/getStoreQRCode
  // 同一口径，禁止跨机构发码
  if (caller.role === 'super_admin' && caller.tenantId && store.tenantId && store.tenantId !== caller.tenantId) {
    return { success: false, error: '无权限：不能为其他机构门店生成邀请码' };
  }

  const storeName = store.storeName || '雨花斋';
  const { display: code, normalized: codeNormalized } = generateRandomCode();
  const now = Date.now();
  const expiresAt = now + CODE_TTL_MS;

  // 🌟 太阳码：scene 编码为 code=<邀请码>，与证书邀请 scene（见 getStoreQRCode 的
  // isPersonalCertificate 分支）同一套"极简 scene + app.ts 解析"思路——app.ts/
  // index.ts 扫码启动时按这个前缀识别出这是一张邀请码太阳码（而不是证书太阳码的
  // u=/s= 格式），拉起"确认绑定并加入 [门店名称]"引导 Modal，直接调用本函数的
  // redeem 动作核销，不需要用户再手动打字输入邀请码
  const qrScene = `code=${codeNormalized}`;
  let qrFileID = '';
  if (qrScene.length > MAX_SCENE_LENGTH) {
    console.error('[manageStoreInviteCode] scene 超出 32 字符硬限制:', qrScene, `(${qrScene.length} 字符)`);
  } else {
    try {
      const qrResult = await cloud.openapi.wxacode.getUnlimited({
        scene: qrScene,
        page: 'pages/index/index',
        width: 430,
        isHyaline: false
      });
      if (qrResult.errCode === 0) {
        const uploadRes = await cloud.uploadFile({
          cloudPath: `invite_qrcodes/qr_${codeNormalized}.png`,
          fileContent: qrResult.buffer
        });
        qrFileID = uploadRes.fileID;
      } else {
        console.warn('[manageStoreInviteCode] 太阳码生成失败:', qrResult);
      }
    } catch (qrErr) {
      console.warn('[manageStoreInviteCode] 太阳码生成异常，邀请码本身仍可正常使用:', qrErr);
    }
  }

  await db.collection('store_invite_codes').add({
    data: {
      code,
      codeNormalized,
      storeId,
      storeName,
      tenantId: store.tenantId || caller.tenantId || '',
      targetRole,
      createdBy: OPENID,
      createdAt: now,
      expiresAt,
      status: 'UNUSED',
      redeemedBy: null,
      redeemedAt: null
    }
  });

  return {
    success: true,
    data: { code, storeId, storeName, targetRole, expiresAt, qrFileID }
  };
}

async function handleRedeem(event, OPENID) {
  const codeNormalized = normalizeCodeInput(event.code);
  if (!codeNormalized) {
    return { success: false, error: '请输入有效的邀请码' };
  }

  const inviteRes = await db.collection('store_invite_codes')
    .where({ codeNormalized })
    .limit(1)
    .get();
  const invite = inviteRes.data && inviteRes.data[0];
  if (!invite) {
    return { success: false, error: '邀请码不存在或输入有误' };
  }
  if (invite.status !== 'UNUSED') {
    return { success: false, error: '该邀请码已被核销，一次性口令不可重复使用' };
  }
  if (invite.expiresAt && Date.now() > invite.expiresAt) {
    await db.collection('store_invite_codes').doc(invite._id).update({
      data: { status: 'EXPIRED' }
    });
    return { success: false, error: '邀请码已过期（有效期 24 小时），请联系发码人重新生成' };
  }

  const targetRole = invite.targetRole;
  const existingRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  const existing = existingRes.data && existingRes.data[0];

  // 🏛️ 多角色兼任：roles 数组只做追加去重，不覆盖——一个已经是 STORE_MANAGER 的账号
  // 再核销一张 FINANCE 邀请码，roles 变为 ['STORE_MANAGER','FINANCE']，两种身份能力兼得
  const prevRoles = (existing && Array.isArray(existing.roles)) ? existing.roles : (existing && existing.role ? [String(existing.role).toUpperCase()] : []);
  const nextRoles = prevRoles.includes(targetRole) ? prevRoles : [...prevRoles, targetRole];

  // 主角色（user_roles.role 单值字段，供 checkUserRole/authService 等既有单角色
  // 逻辑读取）只升不降：FAMILY 邀请不提升主角色（家人/服务对象本就是默认态，见
  // checkUserRole 的 status:'guest' 分支），其余角色按 ROLE_RANK 取"现有 vs 新增"
  // 两者中权限更高的一档，避免店长核销一张 VOLUNTEER 码后被意外降级
  const newPrimaryRole = TARGET_ROLE_TO_PRIMARY[targetRole];
  let finalRole = existing ? existing.role : 'volunteer';
  let finalStatus = existing ? existing.status : 'guest';
  if (newPrimaryRole) {
    const existingRank = ROLE_RANK[finalRole] || 0;
    const newRank = ROLE_RANK[newPrimaryRole] || 0;
    if (newRank > existingRank) {
      finalRole = newPrimaryRole;
    }
    finalStatus = 'approved';
  }

  // 🛡️ 工时数据无缝合并：这里只用 update()（部分字段更新）而不是 set()（整篇覆盖），
  // 且更新的字段列表里完全不包含 volunteer_hours/my_checkin_* 等打卡工时相关字段——
  // 用户原有的护持工时数据不会被本次角色变更以任何形式抹除或重置
  const updatePatch = {
    role: finalRole,
    status: finalStatus,
    storeId: invite.storeId,
    storeName: invite.storeName,
    roles: nextRoles,
    tenantId: (existing && existing.tenantId) || invite.tenantId || ''
  };

  if (existing) {
    await db.collection('user_roles').doc(existing._id).update({ data: updatePatch });
  } else {
    await db.collection('user_roles').add({
      data: { _openid: OPENID, ...updatePatch, createTime: db.serverDate() }
    });
  }

  await db.collection('store_invite_codes').doc(invite._id).update({
    data: {
      status: 'USED',
      redeemedBy: OPENID,
      redeemedAt: Date.now()
    }
  });

  return {
    success: true,
    data: { storeId: invite.storeId, storeName: invite.storeName, role: finalRole, roles: nextRoles }
  };
}

// 🌟 扫码直达：app.ts/index.ts 解析出邀请码太阳码的 scene（code=<邀请码>）后，
// 需要先把门店名/目标身份展示在"确认绑定并加入 [门店名称]"引导 Modal 里，用户
// 确认之后才真正调用 redeem 核销——peek 只读查询，不消耗、不修改这张一次性口令，
// 与 handleRedeem 共用同一套查找/状态/过期校验，但不落任何写操作
async function handlePeek(event) {
  const codeNormalized = normalizeCodeInput(event.code);
  if (!codeNormalized) {
    return { success: false, error: '请输入有效的邀请码' };
  }

  const inviteRes = await db.collection('store_invite_codes')
    .where({ codeNormalized })
    .limit(1)
    .get();
  const invite = inviteRes.data && inviteRes.data[0];
  if (!invite) {
    return { success: false, error: '邀请码不存在或输入有误' };
  }
  if (invite.status !== 'UNUSED') {
    return { success: false, error: '该邀请码已被核销，一次性口令不可重复使用' };
  }
  if (invite.expiresAt && Date.now() > invite.expiresAt) {
    return { success: false, error: '邀请码已过期（有效期 24 小时），请联系发码人重新生成' };
  }

  return {
    success: true,
    data: { storeId: invite.storeId, storeName: invite.storeName, targetRole: invite.targetRole, expiresAt: invite.expiresAt }
  };
}

exports.main = async (event) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();

  if (!OPENID) {
    return { success: false, error: '无法获取用户身份' };
  }

  try {
    if (action === 'generate') {
      return await handleGenerate(event, OPENID);
    }
    if (action === 'redeem') {
      return await handleRedeem(event, OPENID);
    }
    if (action === 'peek') {
      return await handlePeek(event);
    }
    return { success: false, error: `不支持的 action: ${action}` };
  } catch (err) {
    console.error('[manageStoreInviteCode] 异常:', err);
    return { success: false, error: err.message || '操作失败' };
  }
};
