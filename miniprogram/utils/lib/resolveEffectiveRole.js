'use strict';

// 🛡️（2026-09-11 上帝账号路由完善）纯逻辑：AuthService.resolveEffectiveRole()
// 的核心决策拆到这里，不依赖 wx 全局，配套单测同目录 resolveEffectiveRole.test.js。
//
// 🐛 根因：current_user_role 这个 storage key 最初只为 super_admin 的
// "视角切换/预览"功能设计（store-picker 的"系统超管"角色胶囊点了别的身份后
// 写入），但 authService.ts 原实现无条件信任它、可以覆盖任意角色——包括
// platform_admin。platform_admin 从未在 store-picker 里展示过角色胶囊，
// 没有任何合法途径让这个 key 变成除 'platform_admin' 以外的值；一旦这个
// key 因历史遗留/调试残留等原因意外变成别的值（如 'store_manager'），原实现
// 不仅会用它覆盖当次展示，还会把这个错误值反向写回持久化角色缓存
// （overwriteCachedRole）——下一次页面加载即使重新向服务端确认了真实角色是
// platform_admin，也会立刻被这个残留 key 再次打回原形，形成永久自我强化的
// 降级循环，且没有任何应用内路径能自愈。
//
// 修复：当传入的 persistedRole 本身就是 platform_admin 时，这里的决策函数
// 直接原样保留它，不被 storageRole 覆盖，并要求调用方顺手清掉这个残留 key——
// 下一次服务端角色确认落地时不会再被污染，账号自愈，不需要用户手动清缓存。
//
// 🐛（2026-09-12 二次修复）"platform_admin 不接受任何覆盖"这条豁免上线后，
// 新增的 authorizedTenants 巡检漫游功能（platform_admin/super_admin 显式
// 漫游到某门店、选择店长/大家长/财务身份查看该店管理视图）被一并误伤——
// profile.ts initMinePage()/index.ts initCurrentUserRole() 都经由本方法
// 决策，platform_admin 巡检漫游到店长视图后，这两个页面会被强制打回
// platform_admin，看不到刚选好的店长管理面板。
// 根因：本方法此前完全不知道"漫游授权"这个概念，只能从 storageRole 这个
// 客户端可写的裸字符串里分辨"是合法预览还是陈旧残留"，platform_admin 干脆
// 一刀切全部当陈旧残留处理。现在新增 grantedRole 参数——调用方（
// authService.ts resolveEffectiveRole()）用 utils/lib/resolveActiveRoleGrant.js
// 对着服务端下发的 authorizedTenants 数组、针对"当前活跃店"验证过，只有
// 真正命中一条有效授权才会传非空值，不是简单信任 storageRole 本身。
// grantedRole 优先级最高、且不回写持久化缓存（临时以另一重身份巡检某家店，
// 不代表账号真实身份变了，不能污染 auth_user_role 这份长期缓存），platform_admin
// 的豁免规则依旧对"没有匹配授权的 storageRole"生效，两条规则互不冲突。

/**
 * @param {string} persistedRole 已持久化/刚从服务端确认的角色原始 token
 *   （如 'platform_admin'、'SUPER_ADMIN'、'store_manager'）
 * @param {string} storageRole current_user_role 里的本机覆盖值，可能为空字符串
 * @param {string} [grantedRole] 调用方已经用 resolveActiveRoleGrant 针对"当前
 *   活跃店"验证过的巡检漫游授权角色（snake_case，如 'store_manager'），
 *   未命中任何授权时应传空字符串/不传
 * @returns {{
 *   effectiveRole: string,
 *   shouldOverwriteCache: boolean,
 *   roleForCache?: string,
 *   shouldClearStaleStorage: boolean
 * }}
 */
function resolveEffectiveRoleDecision(persistedRole, storageRole, grantedRole) {
  if (grantedRole) {
    return { effectiveRole: grantedRole, shouldOverwriteCache: false, shouldClearStaleStorage: false };
  }

  if (!storageRole) {
    return { effectiveRole: persistedRole, shouldOverwriteCache: false, shouldClearStaleStorage: false };
  }

  // 🛡️ platform_admin 没有"预览"概念，任何覆盖值都视为陈旧残留，原样保留
  // persistedRole，并要求调用方清掉这个残留 key（自愈，不产生持续污染）
  const normalizedPersisted = String(persistedRole || '').toUpperCase();
  if (normalizedPersisted === 'PLATFORM_ADMIN') {
    return {
      effectiveRole: persistedRole,
      shouldOverwriteCache: false,
      shouldClearStaleStorage: storageRole !== persistedRole
    };
  }

  // 其余角色维持原有行为不变：storageRole 优先生效，且需要时回写缓存——
  // 这是 super_admin 视角切换等既有合法用法，不受本次修复影响
  const roleForCache = storageRole === 'store_family' ? 'volunteer' : storageRole;
  return {
    effectiveRole: storageRole,
    shouldOverwriteCache: persistedRole !== roleForCache,
    roleForCache,
    shouldClearStaleStorage: false
  };
}

module.exports = { resolveEffectiveRoleDecision };
