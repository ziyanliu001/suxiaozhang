// 云函数：createTenant — 自助创建新公益组织/机构
//
// 🌐 开放式自裂变：任何人无需超管审批，即可创建属于自己组织的独立账套。
// 创建成功后调用方自动获得首任大家长权限（store_patriarch + store_manager 兼任）。
//
// 🛡️ 数据隔离：生成全局唯一的 tenantId，后续本组织的所有数据（门店/报表/成员）
// 均强绑定该 tenantId，与其他组织 100% 隔离，互不可见。
//
// 🔒 安全约束：
//   - 已有已审核角色的用户不允许通过此接口再次创建新组织（防止多租户污染）
//   - 使用数据库事务保证"创建机构 + 创建门店 + 授权角色"三步原子执行

'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const MAX_LEN = 100;
const ORG_TYPES = ['charity', 'elderly_care', 'community', 'vegetarian', 'rescue', 'other'];

function sanitize(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen || MAX_LEN);
}

// 生成可读的唯一 tenantId：t_<base36时间戳>_<4位随机>
// 示例：t_lzr8k0_a3f9，长度固定，可索引，无业务含义
function generateTenantId() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `t_${ts}_${rnd}`;
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();

  try {
    // ── 参数清洗 ──────────────────────────────────────────────────────────
    const orgName   = sanitize(event.orgName);
    const orgType   = ORG_TYPES.includes(event.orgType) ? event.orgType : 'charity';
    // storeName 若未填写，默认与组织同名（单门店机构常见做法）
    const storeName = sanitize(event.storeName) || orgName;
    const realName  = sanitize(event.realName);
    const phone     = sanitize(event.phone, 20);
    const address   = sanitize(event.address);
    const province  = sanitize(event.province, 20);
    const city      = sanitize(event.city, 20);

    if (!orgName)   return { success: false, error: '请填写组织/机构名称' };
    if (!storeName) return { success: false, error: '请填写门店/站点名称' };
    if (!realName)  return { success: false, error: '请填写您的真实姓名（用于档案备注）' };

    // ── 禁止重复创建：已有审核通过角色的用户不能再开新账套 ────────────────
    const existingRes = await db.collection('user_roles')
      .where({ _openid: OPENID, status: 'approved' })
      .limit(1)
      .get();
    if (existingRes.data && existingRes.data.length > 0) {
      return {
        success: false,
        error: '您已归属于某个门店，如需创建新门店请通过"个人中心 → 生成邀请码"进行扩店，或联系平台管理员'
      };
    }

    // ── 生成租户 ID ───────────────────────────────────────────────────────
    const tenantId = generateTenantId();
    const now      = db.serverDate();

    // ── 事务原子写入：租户 + 门店 + 两条角色记录 ─────────────────────────
    // 微信云开发事务注意：add() 在事务内返回的 _id 是异步的，
    // 用 transaction.collection().add() 拿到的 res._id 即为新文档 ID
    const transaction = await db.startTransaction();
    try {
      // 1. 创建机构（tenant）记录
      await transaction.collection('tenants').add({
        data: {
          tenantId,            // 业务主键（_id 由云数据库自动生成，这里额外存一份方便查询）
          tenantName: orgName,
          orgType,
          status: 'active',
          createdBy: OPENID,
          createdAt: now
        }
      });

      // 2. 创建首个门店（store）记录
      const storeAddRes = await transaction.collection('stores').add({
        data: {
          storeName,
          tenantId,
          status: 'active',
          patriarch:      realName,
          patriarchOpenId: OPENID,
          manager:        realName,
          managerOpenId:  OPENID,
          address:        address || '',
          contactPhone:   phone   || '',
          province:       province || '',
          city:           city     || '',
          // 🍚 供餐餐次配置：绝大多数雨花斋只供午餐，默认单餐次——与
          // manageStoreProfile/createStore 同一份默认档口径
          mealConfig: { supportedMeals: ['lunch'] },
          createdBy: OPENID,
          createdAt: now
        }
      });
      const storeId = storeAddRes._id;

      // 3. 授予首任大家长 + 店长兼任角色
      const baseRole = {
        _openid:       OPENID,
        tenantId,
        storeId,
        storeName,
        realName,
        phone:         phone || '',
        status:        'approved',
        approveTime:   now,
        createTime:    now
      };
      await Promise.all([
        transaction.collection('user_roles').add({
          data: { ...baseRole, role: 'store_patriarch', requestedRole: 'store_patriarch' }
        }),
        transaction.collection('user_roles').add({
          data: { ...baseRole, role: 'store_manager', requestedRole: 'store_manager' }
        })
      ]);

      await transaction.commit();

      return {
        success:   true,
        tenantId,
        storeId,
        storeName,
        orgName,
        message: `「${orgName}」创建成功！您已成为首任负责人（大家长 + 店长），可通过"个人中心"生成邀请码邀请成员加入。`
      };

    } catch (txErr) {
      await transaction.rollback();
      console.error('[createTenant] 事务回滚:', txErr);
      throw txErr;
    }

  } catch (err) {
    console.error('[createTenant] 异常:', err);
    return { success: false, error: err.message || '创建失败，请稍后重试' };
  }
};
