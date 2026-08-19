// 云函数：getMyProductionSpaces — Module A：查当前用户参与的「直播产销协同」工作空间列表
//
// 用途：个人中心页面用它判断"排单与发货管理"入口是否显示——只有当前用户在
// 至少一个 live_factory 工作空间里拥有 space_owner/space_admin/producer 角色
// 时才显示，与 getProductionBoard/completeProductionOrder 等页面要求的角色
// 集合保持一致（promoter/customer 不需要发货管理，不在此列）。
//
// 🚨 查 tenant_members 而不是 user_roles：见 createProductionSpace/index.js
// 头部注释——live_factory 成员记录物理隔离在独立集合里，本函数从设计上就不
// 会触碰雨花公益专区依赖的 user_roles，不存在角色混淆风险。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { buildSpacesList } = require('./lib/buildSpacesList');

const FULFILLMENT_ROLES = ['space_owner', 'space_admin', 'producer'];

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  const memberRes = await db.collection('tenant_members')
    .where({ _openid: OPENID, status: 'approved', role: _.in(FULFILLMENT_ROLES) })
    .get()
    .catch(() => ({ data: [] }));
  const memberships = memberRes.data || [];
  if (memberships.length === 0) return { success: true, spaces: [] };

  const tenantIds = [...new Set(memberships.map((m) => m.tenantId))];
  const tenantsRes = await db.collection('tenants').where({ tenantId: _.in(tenantIds) }).get().catch(() => ({ data: [] }));
  const tenantNameMap = {};
  (tenantsRes.data || []).forEach((t) => { tenantNameMap[t.tenantId] = t.tenantName || ''; });

  const spaces = buildSpacesList(memberships, tenantNameMap);

  return { success: true, spaces };
};
