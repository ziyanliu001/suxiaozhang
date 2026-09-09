// 云函数：grantTenantAuthorization
// 方案三「authorizedTenants 轻量租户漫游」的唯一授权入口，见
// docs/architecture/02_user_roles_single_document_invariant.md。
//
// 🛡️ 核心安全约束（不是建议，是本函数存在的唯一理由）：
// - 绝不为任何 _openid 新增第二条 user_roles 文档——本函数只 update 已存在的
//   文档，目标 _openid 没有任何 user_roles 记录时直接拒绝，不会顺手帮它创建
//   一条。"每个 openid 至多一条 user_roles 文档"这条不变式由本函数在代码层
//   强制，不只是停留在文档约定里。
// - 只写同一条文档上的 authorizedTenants 数组字段，不触碰该文档的
//   tenantId/storeId/role 等身份主字段——调用者的"本来身份"永远不受影响，
//   漫游身份只在 resolveCaller() 识别到显式 targetTenantId/targetStoreId 时
//   才会在内存里临时替换，不会在数据库里留下"这个账号到底是哪个租户的"这种
//   歧义状态。
//
// action: 'grant'  —— 新增/覆盖一条 authorizedTenants 授权（按 tenantId 去重，
//                      同一租户再次 grant 会覆盖旧的 role/stores，不会重复追加）
// action: 'revoke' —— 移除某个 tenantId 的授权
// action: 'list'   —— 只读查看某个 openid 当前的 authorizedTenants 数组
//
// 三个 action 均仅限 platform_admin 调用——跨租户授权是平台级运营决策，不应
// 由任何机构自己的 super_admin 自助操作（这会让租户隔离的豁免权掌握在被隔离
// 的一方手里，等于没有隔离）

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 🛡️ 可通过本机制漫游授予的角色白名单——故意不包含 super_admin/platform_admin：
// 这两个角色代表"某个租户/平台的最高权威"，不该通过一条轻量数组条目就批量
// 授予，真要让某人成为另一个租户的 super_admin，应该走该租户自己的正常任命
// 流程（如 processRoleAudit 的家长任命申请），不是本函数的适用场景
const GRANTABLE_ROLES = ['store_manager', 'store_patriarch', 'finance', 'volunteer'];

async function requirePlatformAdmin(OPENID) {
  if (!OPENID) return false;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return !!(roleRes.data && roleRes.data.length > 0 && roleRes.data[0].role === 'platform_admin');
}

async function findTargetDoc(targetOpenId) {
  const res = await db.collection('user_roles').where({ _openid: targetOpenId }).limit(1).get();
  return (res.data && res.data[0]) || null;
}

async function handleGrant(event, OPENID) {
  const targetOpenId = String(event.targetOpenId || '').trim();
  const tenantId = String(event.tenantId || '').trim();
  const role = String(event.role || '').trim();
  const stores = Array.isArray(event.stores) ? event.stores.filter((s) => typeof s === 'string' && s) : [];

  if (!targetOpenId) return { success: false, error: '缺少 targetOpenId 参数' };
  if (!tenantId) return { success: false, error: '缺少 tenantId 参数' };
  if (!GRANTABLE_ROLES.includes(role)) {
    return { success: false, error: `role 必须是以下之一: ${GRANTABLE_ROLES.join('/')}` };
  }
  if (stores.length === 0) {
    // 🛡️ 最小权限原则：不提供"留空即授权该租户全部门店"的隐式默认值——
    // 漫游授权本就是一次精确、罕见的人工操作，要求调用方明确列出门店范围，
    // 而不是图省事留空换来一份比预期宽得多的授权
    return { success: false, error: '必须显式列出 stores（至少一个 storeId），不支持留空授予整租户' };
  }

  const targetDoc = await findTargetDoc(targetOpenId);
  if (!targetDoc) {
    return { success: false, error: '目标 openId 没有任何 user_roles 记录，本函数不会为其新建文档——请先确认该账号已完成正常登录/建档流程' };
  }

  // 🛡️ 严禁授权给自己已经归属的那个租户——那不叫"漫游"，是数据错乱的信号，
  // 这种情况下应该去核实 targetDoc.tenantId 本身是否正确，不是加一条授权掩盖过去
  if (tenantId === targetDoc.tenantId) {
    return { success: false, error: '目标账号本来就归属这个租户，不需要（也不应该）再加一条授权' };
  }

  const existingGrants = Array.isArray(targetDoc.authorizedTenants) ? targetDoc.authorizedTenants : [];
  const newGrant = { tenantId, role, stores, grantedBy: OPENID, grantedAt: db.serverDate() };
  // 按 tenantId 去重覆盖，不重复追加同一租户的多条授权
  const nextGrants = [...existingGrants.filter((g) => g && g.tenantId !== tenantId), newGrant];

  await db.collection('user_roles').doc(targetDoc._id).update({
    data: { authorizedTenants: nextGrants }
  });

  return { success: true, authorizedTenants: nextGrants };
}

async function handleRevoke(event) {
  const targetOpenId = String(event.targetOpenId || '').trim();
  const tenantId = String(event.tenantId || '').trim();
  if (!targetOpenId) return { success: false, error: '缺少 targetOpenId 参数' };
  if (!tenantId) return { success: false, error: '缺少 tenantId 参数' };

  const targetDoc = await findTargetDoc(targetOpenId);
  if (!targetDoc) return { success: false, error: '目标 openId 没有任何 user_roles 记录' };

  const existingGrants = Array.isArray(targetDoc.authorizedTenants) ? targetDoc.authorizedTenants : [];
  const nextGrants = existingGrants.filter((g) => g && g.tenantId !== tenantId);
  if (nextGrants.length === existingGrants.length) {
    return { success: true, authorizedTenants: nextGrants, note: '未找到该 tenantId 的授权记录，无需改动' };
  }

  await db.collection('user_roles').doc(targetDoc._id).update({
    data: { authorizedTenants: nextGrants }
  });

  return { success: true, authorizedTenants: nextGrants };
}

async function handleList(event) {
  const targetOpenId = String(event.targetOpenId || '').trim();
  if (!targetOpenId) return { success: false, error: '缺少 targetOpenId 参数' };

  const targetDoc = await findTargetDoc(targetOpenId);
  if (!targetDoc) return { success: false, error: '目标 openId 没有任何 user_roles 记录' };

  return {
    success: true,
    homeTenantId: targetDoc.tenantId || '',
    homeRole: targetDoc.role || '',
    authorizedTenants: Array.isArray(targetDoc.authorizedTenants) ? targetDoc.authorizedTenants : []
  };
}

exports.main = async (event) => {
  const { action } = event || {};
  const { OPENID } = cloud.getWXContext();

  if (!(await requirePlatformAdmin(OPENID))) {
    return { success: false, error: '无权限：仅平台管理员可操作跨租户授权' };
  }

  try {
    if (action === 'grant') return await handleGrant(event, OPENID);
    if (action === 'revoke') return await handleRevoke(event);
    if (action === 'list') return await handleList(event);
    return { success: false, error: `不支持的 action: ${action}` };
  } catch (err) {
    console.error('[grantTenantAuthorization] 异常:', err);
    return { success: false, error: '操作失败，请重试' };
  }
};
