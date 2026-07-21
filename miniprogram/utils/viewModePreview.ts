/**
 * 超级管理员"视角切换"预览模式
 *
 * 仅用于超级管理员在【超级管理员全景】/【店长视角】/【财务视角】之间快速切换首页与
 * 个人中心的展示样式，便于预览/测试各角色能看到的界面与操作入口。
 *
 * 🛡️ 安全边界：这是纯展示层的"降级模拟"——只重写前端用于 wx:if 分支渲染的角色标志位，
 * 不会、也不可能改写云端 user_roles 里的真实角色。任何云函数调用仍以服务端记录的
 * 真实身份鉴权，预览模式下点击"店长专属"按钮，服务端依然按真实的 super_admin 权限放行。
 * 调用方必须先确认 realRole === 'super_admin' 才允许生效（applyRoleViewOverride 内已强制
 * 二次校验），杜绝店长/财务/志工账号通过本地缓存伪造出更高权限的展示效果。
 */

export type PreviewViewMode = 'SUPER_ADMIN' | 'STORE_MANAGER' | 'FINANCE';

const STORAGE_KEY = 'super_admin_preview_view_mode';

export const PREVIEW_VIEW_MODE_LABELS: Record<PreviewViewMode, string> = {
  SUPER_ADMIN: '超级管理员全景',
  STORE_MANAGER: '店长视角',
  FINANCE: '财务视角'
};

export function getPreviewViewMode(): PreviewViewMode {
  const v = wx.getStorageSync(STORAGE_KEY);
  if (v === 'STORE_MANAGER' || v === 'FINANCE' || v === 'SUPER_ADMIN') return v;
  return 'SUPER_ADMIN';
}

export function setPreviewViewMode(mode: PreviewViewMode) {
  wx.setStorageSync(STORAGE_KEY, mode);
}

export interface RoleDisplayFlags {
  currentUserRole: string;
  isVolunteer: boolean;
  isManager: boolean;
  isFinance: boolean;
  isSuperAdmin: boolean;
}

/**
 * 在真实角色计算结果之上应用预览覆盖。realRole 必须是服务端下发的规范化角色
 * （如 'super_admin'/'store_manager'/'finance'/'volunteer'），非 super_admin 一律原样返回。
 */
export function applyRoleViewOverride(realRole: string, real: RoleDisplayFlags): RoleDisplayFlags {
  if (realRole !== 'super_admin') return real;

  const mode = getPreviewViewMode();
  if (mode === 'SUPER_ADMIN') return real;

  if (mode === 'STORE_MANAGER') {
    return { currentUserRole: 'store_manager', isVolunteer: false, isManager: true, isFinance: false, isSuperAdmin: false };
  }

  // FINANCE
  return { currentUserRole: 'finance', isVolunteer: false, isManager: false, isFinance: true, isSuperAdmin: false };
}
