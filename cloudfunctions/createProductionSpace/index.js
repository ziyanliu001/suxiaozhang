// 云函数：createProductionSpace — Module A：零门槛开通「直播产销协同」工作空间
//
// 🌐 与 createTenant（雨花公益自助建机构）的关键差异：不创建 stores 文档——
// 直播产销是"一个租户 = 一个生产工作室"的单层模型，没有多门店/餐次/账目模板
// 这些语义，强行套用会污染 stores 集合（见 Step 1 方案）。
//
// 🛡️ 不写 orgType 字段：orgType 是雨花公益 stores/tenants 的既有分类字段
// （yuhuazhai/elderly_canteen 等），与本模块的 businessType/entityType 是两套
// 完全独立的分类体系，字段名刻意不复用，避免混淆两套语义（见 [[feedback-two-orgtype-pickers]]）。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAX_LEN = 100;
function sanitize(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen || MAX_LEN);
}

function generateTenantId() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `lf_${ts}_${rnd}`;
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  const spaceName = sanitize(event.spaceName);
  const realName = sanitize(event.realName);
  const phone = sanitize(event.phone, 20);
  if (!spaceName) return { success: false, error: '请填写工作室/空间名称' };
  if (!realName) return { success: false, error: '请填写您的真实姓名（用于档案备注）' };

  const tenantId = generateTenantId();
  const now = db.serverDate();

  const transaction = await db.startTransaction();
  try {
    await transaction.collection('tenants').add({
      data: {
        tenantId,
        tenantName: spaceName,
        businessType: 'live_factory',
        entityType: 'individual',
        paymentMode: 'none',
        status: 'active',
        createdBy: OPENID,
        createdAt: now
      }
    });

    await transaction.collection('user_roles').add({
      data: {
        _openid: OPENID,
        tenantId,
        role: 'space_owner',
        requestedRole: 'space_owner',
        realName,
        phone: phone || '',
        status: 'approved',
        approveTime: now,
        createTime: now
      }
    });

    await transaction.commit();
    return {
      success: true,
      tenantId,
      spaceName,
      message: `「${spaceName}」创建成功！您已成为该空间的负责人，可通过"生成邀请码"邀请制作方/主播加入。`
    };
  } catch (txErr) {
    await transaction.rollback();
    console.error('[createProductionSpace] 事务回滚:', txErr);
    return { success: false, error: txErr.message || '创建失败，请稍后重试' };
  }
};
