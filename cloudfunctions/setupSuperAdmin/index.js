const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const targetOpenid = event.openid || OPENID;

  if (!targetOpenid) {
    return { success: false, error: '请传入 openid 参数或在小程序端调用' };
  }

  // 🏢 平台管理员（开发者）账号也走本引导脚本创建，避免额外开一个专用云函数；
  // 仅接受 super_admin / platform_admin 两种目标角色，防止被误用于其他角色提权
  const targetRole = ['super_admin', 'platform_admin'].includes(event.role) ? event.role : 'super_admin';

  try {
    // 查询是否已存在记录
    const existingRes = await db.collection('user_roles')
      .where({ _openid: targetOpenid })
      .limit(1)
      .get();

    // 🏢 多租户：super_admin 现为"本机构"超管，需指定归属 tenantId
    // （console 手动调用时传入，未传则沿用旧记录已有值，供迁移过渡期兼容）
    // platform_admin 不归属任何机构；super_admin 必须归属某一机构（tenantId）
    const targetTenantId = targetRole === 'platform_admin' ? '' : event.tenantId;
    const targetStoreName = targetRole === 'platform_admin' ? 'SaaS 平台管理' : '全国总览';
    const targetLabel = targetRole === 'platform_admin' ? '平台管理员' : '超级管理员';

    if (existingRes.data && existingRes.data.length > 0) {
      const existingDoc = existingRes.data[0];
      await db.collection('user_roles').doc(existingDoc._id).update({
        data: {
          role: targetRole,
          status: 'approved',
          storeId: '',
          storeName: targetStoreName,
          tenantId: targetTenantId || existingDoc.tenantId || '',
          realName: event.realName || existingDoc.realName || targetLabel,
          phone: event.phone || existingDoc.phone || '',
          setupTime: db.serverDate()
        }
      });

      return {
        success: true,
        message: `已升级为${targetLabel}`,
        openid: targetOpenid,
        action: 'updated'
      };
    }

    await db.collection('user_roles').add({
      data: {
        _openid: targetOpenid,
        realName: event.realName || targetLabel,
        phone: event.phone || '',
        storeId: '',
        storeName: targetStoreName,
        tenantId: targetTenantId || '',
        requestedRole: targetRole,
        role: targetRole,
        status: 'approved',
        applyTime: db.serverDate(),
        approveTime: db.serverDate()
      }
    });

    return {
        success: true,
        message: `已创建${targetLabel}记录`,
        openid: targetOpenid,
        action: 'created'
      };
  } catch (err) {
    console.error('[setupSuperAdmin] 异常:', err);
    return { success: false, error: err.message || '设置失败' };
  }
};
