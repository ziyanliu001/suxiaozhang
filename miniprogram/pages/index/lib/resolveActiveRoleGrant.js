'use strict';

// 🐛 权限计算漏洞修复（2026-09-12）：首页"登记今日菜单与人数"等义工现场服务
// 工具卡片对通过【选择服务站点与身份】弹窗（store-picker.ts）以
// authorizedTenants 轻量租户漫游授权（"巡检漫游"，见 CLAUDE.md 8.2 节）临时
// 获得店长/大家长身份的账号显示"无权限"。
//
// 根因：refreshUserRoleView()（index.ts）此前的权限锁定逻辑只区分"是不是
// super_admin"——非 super_admin 账号一律强制锁定为自己在 user_roles 里的
// 真实绑定角色/门店（cached.role/cached.storeId），完全不检查
// cached.authorizedTenants 里是否存在一条覆盖【当前活跃店】
// （getCurrentActiveStore().storeId）的有效授权。这与邀请码核销（真正改写
// user_roles.role/storeId 本体）不同——巡检漫游是刻意设计成"不污染账号真实
// 身份"的临时覆盖层（见 manageDailyMenu/lib/resolveCaller.js 头部注释），
// 只存在于 authorizedTenants 数组里，锁定逻辑如果压根不看这个数组，被授权者
// 选完店长/大家长身份后，首页权限计算依然按他们自己的真实（可能是义工/无
// 门店）身份走，于是各类"店长专属"入口全部显示无权限。
//
// 本文件是 cloudfunctions/manageDailyMenu/lib/resolveCaller.js 里
// resolveEffectiveCaller() 核心决策逻辑的前端镜像（同一套 stores 命中 +
// isGrantStillValid 过期判定 + 多条命中取 grantedAt 最新一条的规则），只是
// 输出形状改成前端需要的 {role, tenantId, storeId}，且明确规定"未命中授权
// 时返回 null"（不像服务端版本那样回退成 own——调用方拿到 null 后自己决定
// 用 cached 的哪些字段兜底，职责边界更清晰，避免前端在这里重新发明一套
// "拼装 own 对象"的逻辑）。
//
// ⚠️ 安全边界：这里读的 authorizedTenants 是 AuthService.getCachedRoleInfo()
// 里随服务端角色一并下发的字段（checkUserRole 云函数返回值），不是用户可以
// 随意改写生效的 storage key——即使有人在 devtools 里手动篡改
// current_user_role/current_store_id 这类 storage，只要 authorizedTenants
// 数组里没有对应的真实授权记录，本函数也不会认可任何身份提升，不会重新
// 打开 refreshUserRoleView() 当年为修复"店长账号被残留 storage 顶成超管
// 视角"这个真实越权展示 bug 而收紧的口子。

/**
 * @param {{expiresAt?: string}} grant
 * @param {number} now
 * @returns {boolean}
 */
function isGrantStillValid(grant, now) {
  if (!grant || !grant.expiresAt) return true;
  const expiresAtMs = new Date(grant.expiresAt).getTime();
  if (Number.isNaN(expiresAtMs)) return true;
  return expiresAtMs > now;
}

function grantedAtMs(grant) {
  if (!grant || !grant.grantedAt) return 0;
  const ms = new Date(grant.grantedAt).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * @param {Array<{tenantId:string, role:string, stores?: string[], grantedAt?: string, expiresAt?: string}>} [authorizedTenants]
 * @param {string} activeStoreId 当前活跃店（getCurrentActiveStore().storeId），空值直接返回 null
 * @param {number} [now]
 * @returns {{role: string, tenantId: string, storeId: string} | null}
 */
function resolveActiveRoleGrant(authorizedTenants, activeStoreId, now) {
  if (!activeStoreId) return null;
  const effectiveNow = typeof now === 'number' ? now : Date.now();
  const grants = Array.isArray(authorizedTenants) ? authorizedTenants : [];
  const matches = grants.filter((g) => g && Array.isArray(g.stores) && g.stores.includes(activeStoreId) && isGrantStillValid(g, effectiveNow));
  if (matches.length === 0) return null;

  const grant = matches.length === 1 ? matches[0] : matches.reduce((latest, g) => {
    return grantedAtMs(g) >= grantedAtMs(latest) ? g : latest;
  });

  return { role: grant.role, tenantId: grant.tenantId, storeId: activeStoreId };
}

module.exports = { resolveActiveRoleGrant, isGrantStillValid, grantedAtMs };
