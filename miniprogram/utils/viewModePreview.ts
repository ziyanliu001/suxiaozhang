/**
 * 超级管理员"视角切换"预览模式
 *
 * 用于超级管理员在【超级管理员全景】/【大家长】/【店长】/【财务】/【义工】/【家人】六种
 * 视角之间快速切换首页与个人中心的展示样式，便于无缝预览/测试系统中所有角色能看到的
 * 界面形态与操作入口。
 *
 * 🛡️ 安全边界：这是纯展示层的"降级模拟"——只重写前端用于 wx:if 分支渲染的角色标志位，
 * 不会、也不可能改写云端 user_roles 里的真实角色。任何云函数调用仍以服务端记录的
 * 真实身份鉴权，预览模式下点击"店长专属"按钮，服务端依然按真实的 super_admin 权限放行。
 * 调用方必须先确认 realRole === 'super_admin' 才允许生效（applyRoleViewOverride 内已强制
 * 二次校验），杜绝店长/财务/志工账号通过本地缓存伪造出更高权限的展示效果。
 */

export type PreviewViewMode = 'SUPER_ADMIN' | 'STORE_PATRIARCH' | 'STORE_MANAGER' | 'FINANCE' | 'VOLUNTEER' | 'FAMILY';

const STORAGE_KEY = 'super_admin_preview_view_mode';

export const PREVIEW_VIEW_MODE_LABELS: Record<PreviewViewMode, string> = {
  SUPER_ADMIN: '超级管理员全景',
  STORE_PATRIARCH: '大家长视角',
  STORE_MANAGER: '店长视角',
  FINANCE: '财务视角',
  VOLUNTEER: '义工视角',
  FAMILY: '家人视角'
};

const VALID_MODES: PreviewViewMode[] = ['SUPER_ADMIN', 'STORE_PATRIARCH', 'STORE_MANAGER', 'FINANCE', 'VOLUNTEER', 'FAMILY'];

export function getPreviewViewMode(): PreviewViewMode {
  const v = wx.getStorageSync(STORAGE_KEY);
  if (VALID_MODES.indexOf(v) !== -1) return v;
  return 'SUPER_ADMIN';
}

export function setPreviewViewMode(mode: PreviewViewMode) {
  wx.setStorageSync(STORAGE_KEY, mode);
}

// 🐛 根因修复：currentViewMode（驱动 Banner"正在预览【XX视角】"文案与"管理视角
// 切换"卡片当前选中项）此前在 index.ts/profile.ts 里都是无条件 getPreviewViewMode()——
// 但这个函数只读独立的 STORAGE_KEY，跟 store-picker 手动切换身份（写入
// current_user_role，即 resolveEffectiveRole 读的那个 key）完全是两套本地存储。
// 一旦手动切换生效（如切到 volunteer），角色相关的 isVolunteer/isManager 等标志位
// 已经正确更新，但 currentViewMode 依然读着那份可能早已过期、从未被这次切换touch过
// 的旧值，导致 Banner/切换卡片显示的"视角"文案跟页面实际渲染的角色对不上。
// resolveDisplayViewMode 统一收敛这条判断：effective role（已经过 resolveEffectiveRole
// 融合过 storageRole 的最终角色）不是 super_admin 时，直接从这个角色反推视角枚举，
// 不再看那份独立、可能过期的预览态；effective role 仍是 super_admin 时（真正的
// "视角切换"预览场景，或压根没有任何手动切换），才读 getPreviewViewMode()——与
// applyRoleViewOverride() 自身"realRole !== 'super_admin' 时原样返回"的分支口径
// 完全一致，不是另起一套新规则
const NORMALIZED_ROLE_TO_VIEW_MODE: Record<string, PreviewViewMode> = {
  super_admin: 'SUPER_ADMIN',
  store_patriarch: 'STORE_PATRIARCH',
  store_manager: 'STORE_MANAGER',
  finance: 'FINANCE',
  volunteer: 'VOLUNTEER',
  store_family: 'FAMILY'
};

/**
 * 计算当前应展示的视角模式（PreviewViewMode），供 Banner 文案 / "管理视角切换"卡片
 * 当前选中项使用。normalizedRole 传已经过 AuthService.resolveEffectiveRole 融合过
 * storageRole 的最终生效角色（如 'volunteer'/'store_manager'），不是原始服务端角色。
 */
export function resolveDisplayViewMode(normalizedRole: string): PreviewViewMode {
  if (normalizedRole === 'super_admin') return getPreviewViewMode();
  return NORMALIZED_ROLE_TO_VIEW_MODE[normalizedRole] || 'SUPER_ADMIN';
}

export interface RoleDisplayFlags {
  currentUserRole: string;
  isVolunteer: boolean;
  isManager: boolean;
  isFinance: boolean;
  isSuperAdmin: boolean;
  // 🌟 家人视角与"真实义工"底层 currentUserRole 都是 'volunteer'，靠 isFamily
  // 单独区分展示哪一套版面；补齐视角选项后预览模式也需要能够降级模拟出家人态
  isFamily: boolean;
}

/**
 * 在真实角色计算结果之上应用预览覆盖。realRole 必须是服务端下发的规范化角色
 * （如 'super_admin'/'store_manager'/'finance'/'volunteer'），非 super_admin 一律原样返回。
 */
export function applyRoleViewOverride(realRole: string, real: RoleDisplayFlags): RoleDisplayFlags {
  if (realRole !== 'super_admin') return real;

  const mode = getPreviewViewMode();
  if (mode === 'SUPER_ADMIN') return real;

  switch (mode) {
    case 'STORE_PATRIARCH':
      return { currentUserRole: 'store_patriarch', isVolunteer: false, isManager: true, isFinance: true, isSuperAdmin: false, isFamily: false };
    case 'STORE_MANAGER':
      return { currentUserRole: 'store_manager', isVolunteer: false, isManager: true, isFinance: false, isSuperAdmin: false, isFamily: false };
    case 'FINANCE':
      return { currentUserRole: 'finance', isVolunteer: false, isManager: false, isFinance: true, isSuperAdmin: false, isFamily: false };
    case 'VOLUNTEER':
      return { currentUserRole: 'volunteer', isVolunteer: true, isManager: false, isFinance: false, isSuperAdmin: false, isFamily: false };
    case 'FAMILY':
      // 家人视角底层角色仍是 'volunteer'（与真实义工共用同一份服务端取值），
      // isVolunteer 置 false、isFamily 置 true，交由 isFamily 区分展示哪一套版面
      return { currentUserRole: 'volunteer', isVolunteer: false, isManager: false, isFinance: false, isSuperAdmin: false, isFamily: true };
    default:
      return real;
  }
}
