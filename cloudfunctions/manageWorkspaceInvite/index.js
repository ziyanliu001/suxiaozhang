// 云函数：manageWorkspaceInvite — Module A：邀请码生成 / 兑换
// action: 'generate'（Owner/Admin 生成绑定角色的邀请码） | 'redeem'（任意登录用户兑换）
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const INVITABLE_ROLES = ['producer', 'promoter'];
const CODE_TTL_DAYS = 7;

// 多租户鉴权：与 Step 1 约定的内联 verifyTenantAccess 写法一致，各云函数各自拷贝一份
async function verifyTenantAccess(openid, tenantId, requiredRoles) {
  const res = await db.collection('user_roles')
    .where({ _openid: openid, tenantId, status: 'approved' })
    .get();
  return (res.data || []).find((r) => requiredRoles.includes(r.role)) || null;
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

  const now = new Date();
  const expiresAt = new Date(now.getTime() + CODE_TTL_DAYS * 24 * 60 * 60 * 1000);

  // 唯一索引兜底：极小概率随机码撞车时重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    const codeNormalized = generateCode();
    try {
      await db.collection('workspace_invite_codes').add({
        data: {
          codeNormalized, tenantId, role,
          createdBy: openid, createdAt: db.serverDate(),
          expiresAt, usedBy: null, usedAt: null
        }
      });
      return { success: true, code: codeNormalized, role, expiresAt: expiresAt.toISOString() };
    } catch (err) {
      if (attempt === 1) return { success: false, error: '生成邀请码失败，请重试' };
    }
  }
}

async function handleRedeem(event, openid) {
  const code = String(event.code || '').trim().toUpperCase();
  const realName = String(event.realName || '').trim().slice(0, 100);
  const phone = String(event.phone || '').trim().slice(0, 20);
  if (!code) return { success: false, error: '请输入邀请码' };
  if (!realName) return { success: false, error: '请填写您的真实姓名' };

  const codeRes = await db.collection('workspace_invite_codes').where({ codeNormalized: code }).limit(1).get();
  const invite = (codeRes.data && codeRes.data[0]) || null;
  if (!invite) return { success: false, error: '邀请码不存在' };
  if (invite.usedBy) return { success: false, error: '邀请码已被使用' };
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
    return { success: false, error: '邀请码已过期' };
  }

  // 🛡️ 单次使用的原子核销：where 里带 usedBy: null 作为条件，并发兑换只有一次能成功
  const claimRes = await db.collection('workspace_invite_codes').where({
    _id: invite._id, usedBy: null
  }).update({ data: { usedBy: openid, usedAt: db.serverDate() } });
  if (claimRes.stats.updated !== 1) {
    return { success: false, error: '邀请码已被使用' };
  }

  const now = db.serverDate();
  await db.collection('user_roles').add({
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

  return { success: true, tenantId: invite.tenantId, role: invite.role };
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  switch (event.action) {
    case 'generate': return handleGenerate(event, OPENID);
    case 'redeem': return handleRedeem(event, OPENID);
    default: return { success: false, error: `未知 action: ${event.action}` };
  }
};
