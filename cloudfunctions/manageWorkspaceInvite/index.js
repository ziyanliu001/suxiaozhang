// 云函数：manageWorkspaceInvite — Module A：邀请码生成 / 兑换
// action: 'generate'（Owner/Admin 生成绑定角色的邀请码 + 小程序码）|
//         'peek'（只读预览，扫码/输码后先看清楚要加入哪个工坊、什么角色，
//         不核销）| 'redeem'（任意登录用户兑换，实际核销）
//
// 🌟 小程序码 scene 编码为 wcode=<邀请码>，与雨花公益专区 manageStoreInviteCode
// 的 code=<邀请码> 是同一个模式，但用不同前缀（wcode= 而不是 code=）——两套邀请码
// 分属不同集合（workspace_invite_codes vs store_invite_codes），前缀不同才能让
// 落地页自己一眼分清这张码是哪套体系的，不会混淆着去查错集合。
//
// 🎯 与雨花的 code=<...> 扫码落地方案不同：本模块的小程序码 page 直接指向
// pages/workspace-join/workspace-join（而不是像雨花那样统一落地 pages/index/index
// 再由 app.ts/index.ts 全局解析 scene）——微信扫码启动时，options.scene 会同时
// 传给 App.onLaunch/onShow 和目标页面自己的 onLoad，让 workspace-join 页面自己
// 解析 scene 即可完全自洽，不需要改动 app.ts/index.ts 这类雨花公益专区的全局
// 入口文件，把改动面严格收在本模块自己的文件里。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const INVITABLE_ROLES = ['producer', 'promoter'];
const CODE_TTL_DAYS = 7;
const MAX_SCENE_LENGTH = 32; // wxacode.getUnlimited 硬限制，与 manageStoreInviteCode 同一口径

const ROLE_LABEL = { producer: '制作方', promoter: '推广员' };

// 多租户鉴权：与 Step 1 约定的内联 verifyTenantAccess 写法一致，各云函数各自拷贝一份。
// 🚨 查 tenant_members 而不是 user_roles：live_factory 成员记录绝不能混进雨花
// 公益专区依赖的 user_roles 集合（详见 createProductionSpace/index.js 头部注释）。
async function verifyTenantAccess(openid, tenantId, requiredRoles) {
  const res = await db.collection('tenant_members')
    .where({ _openid: openid, tenantId, status: 'approved' })
    .get();
  return (res.data || []).find((r) => requiredRoles.includes(r.role)) || null;
}

// tenants 文档 _id 是自动生成的，tenantId 只是业务字段（见 createProductionSpace
// 的 add() 写法），必须按字段查，不能 .doc(tenantId)（见 completeProductionOrder
// 等文件的同类修复注释）
async function getTenantName(tenantId) {
  const res = await db.collection('tenants').where({ tenantId }).limit(1).get().catch(() => ({ data: [] }));
  return (res.data && res.data[0] && res.data[0].tenantName) || '未命名工坊';
}

function generateCode() {
  // 6 位大写字母数字，去掉易混淆字符（0/O/1/I），与 store_invite_codes 的
  // codeNormalized 唯一索引同一套约定：生成后统一转大写比对，避免大小写造成
  // "看起来一样却兑换失败"的用户困惑
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

async function handleGenerate(event, openid) {
  const { tenantId, role } = event;
  if (!tenantId || !INVITABLE_ROLES.includes(role)) {
    return { success: false, error: '参数缺失或角色不支持邀请：role 仅支持 producer/promoter' };
  }
  const caller = await verifyTenantAccess(openid, tenantId, ['space_owner', 'space_admin']);
  if (!caller) return { success: false, error: '无权限：仅空间负责人/管理员可生成邀请码' };

  const tenantName = await getTenantName(tenantId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CODE_TTL_DAYS * 24 * 60 * 60 * 1000);

  // 唯一索引兜底：极小概率随机码撞车时重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    const codeNormalized = generateCode();
    try {
      await db.collection('workspace_invite_codes').add({
        data: {
          codeNormalized, tenantId, tenantName, role,
          createdBy: openid, createdAt: db.serverDate(),
          expiresAt, usedBy: null, usedAt: null
        }
      });

      // 🌟 小程序码：失败不影响邀请码本身可用（与 manageStoreInviteCode 同一
      // 容错口径）——生成失败时前端仍能展示纯文本邀请码，走手动输入兑换
      let qrFileID = '';
      const qrScene = `wcode=${codeNormalized}`;
      if (qrScene.length > MAX_SCENE_LENGTH) {
        console.error('[manageWorkspaceInvite] scene 超出 32 字符硬限制:', qrScene);
      } else {
        try {
          const qrResult = await cloud.openapi.wxacode.getUnlimited({
            scene: qrScene,
            page: 'pages/workspace-join/workspace-join',
            width: 430,
            isHyaline: false
          });
          if (qrResult.errCode === 0) {
            const uploadRes = await cloud.uploadFile({
              cloudPath: `workspace_qrcodes/qr_${codeNormalized}.png`,
              fileContent: qrResult.buffer
            });
            qrFileID = uploadRes.fileID;
            await db.collection('workspace_invite_codes').where({ codeNormalized }).update({ data: { qrFileID } });
          } else {
            console.warn('[manageWorkspaceInvite] 小程序码生成失败:', qrResult);
          }
        } catch (qrErr) {
          console.warn('[manageWorkspaceInvite] 小程序码生成异常，邀请码本身仍可正常使用:', qrErr);
        }
      }

      return {
        success: true, code: codeNormalized, role,
        roleLabel: ROLE_LABEL[role] || role,
        tenantName, qrFileID,
        expiresAt: expiresAt.toISOString()
      };
    } catch (err) {
      if (attempt === 1) return { success: false, error: '生成邀请码失败，请重试' };
    }
  }
}

async function findValidInvite(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { error: '请输入邀请码' };

  const codeRes = await db.collection('workspace_invite_codes').where({ codeNormalized: code }).limit(1).get();
  const invite = (codeRes.data && codeRes.data[0]) || null;
  if (!invite) return { error: '邀请码不存在' };
  if (invite.usedBy) return { error: '邀请码已被使用' };
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
    return { error: '邀请码已过期' };
  }
  return { invite };
}

// 只读预览：不核销，供扫码/输码后先展示"即将加入【工坊名】担任【角色】"确认弹窗
//
// 🎯 附带查一下工坊主理人（space_owner）姓名：workspace-join 页面的确认卡片
// 需要多一个身份锚点防止用户误入同名/相似工坊，tenant_members 里 role
// 恰好就是 space_owner 的那条记录的 realName 即可——查不到（理论上每个工坊
// 创建时 createProductionSpace 都会写一条 space_owner 记录，查不到只可能是
// 极端历史数据缺失）就留空，前端据此隐藏这一行，不编造一个"主理人"出来
async function handlePeek(event) {
  const { invite, error } = await findValidInvite(event.code);
  if (error) return { success: false, error };

  let ownerName = '';
  try {
    const ownerRes = await db.collection('tenant_members')
      .where({ tenantId: invite.tenantId, role: 'space_owner', status: 'approved' })
      .limit(1)
      .get();
    ownerName = (ownerRes.data && ownerRes.data[0] && ownerRes.data[0].realName) || '';
  } catch (err) {
    console.warn('[manageWorkspaceInvite] handlePeek 查询主理人姓名失败（不影响主流程）:', err);
  }

  return {
    success: true,
    tenantId: invite.tenantId,
    tenantName: invite.tenantName || '未命名工坊',
    role: invite.role,
    roleLabel: ROLE_LABEL[invite.role] || invite.role,
    ownerName
  };
}

async function handleRedeem(event, openid) {
  const realName = String(event.realName || '').trim().slice(0, 100);
  const phone = String(event.phone || '').trim().slice(0, 20);
  if (!realName) return { success: false, error: '请填写您的真实姓名' };

  const { invite, error } = await findValidInvite(event.code);
  if (error) return { success: false, error };

  // 🛡️ 单次使用的原子核销：where 里带 usedBy: null 作为条件，并发兑换只有一次能成功
  const claimRes = await db.collection('workspace_invite_codes').where({
    _id: invite._id, usedBy: null
  }).update({ data: { usedBy: openid, usedAt: db.serverDate() } });
  if (claimRes.stats.updated !== 1) {
    return { success: false, error: '邀请码已被使用' };
  }

  const now = db.serverDate();
  await db.collection('tenant_members').add({
    data: {
      _openid: openid,
      tenantId: invite.tenantId,
      role: invite.role,
      requestedRole: invite.role,
      realName, phone,
      status: 'approved',
      approveTime: now,
      createTime: now
    }
  });

  return { success: true, tenantId: invite.tenantId, tenantName: invite.tenantName || '', role: invite.role };
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  switch (event.action) {
    case 'generate': return handleGenerate(event, OPENID);
    case 'peek': return handlePeek(event);
    case 'redeem': return handleRedeem(event, OPENID);
    default: return { success: false, error: `未知 action: ${event.action}` };
  }
};
