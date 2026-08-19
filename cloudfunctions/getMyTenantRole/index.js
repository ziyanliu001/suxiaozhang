// 云函数：getMyTenantRole — 查当前用户在某个 live_factory 租户下的角色（不限
// 角色类型，含 promoter），外加把调用者自己的 openid 一并返回。
//
// 用途：与 getMyProductionSpaces 是两个不同用途的查询，不合并——
// getMyProductionSpaces 特意只筛 space_owner/space_admin/producer（"排单与
// 发货管理"入口只对这几个角色有意义），如果把 promoter 也塞进那个函数的
// 结果里，会让纯推广员账号误以为自己能进发货管理页（进去后 getProductionBoard
// 会拒绝），是体验回归。本函数只服务"买家下单页要不要把当前浏览者自己的
// openid 作为推广人写进分享链接"这一个场景，任何角色（包括 promoter/customer/
// 甚至非成员）都可以查，返回真实结果（非成员时 role 为空字符串）。
//
// 🚨 查 tenant_members 而不是 user_roles：见 createProductionSpace/index.js
// 头部注释——live_factory 成员记录物理隔离在独立集合里。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  const tenantId = String(event.tenantId || '');
  if (!tenantId) return { success: false, error: '参数缺失: tenantId' };

  const res = await db.collection('tenant_members')
    .where({ _openid: OPENID, tenantId, status: 'approved' })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }));
  const member = (res.data && res.data[0]) || null;

  return { success: true, openid: OPENID, role: member ? member.role : '' };
};
