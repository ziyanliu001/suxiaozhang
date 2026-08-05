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
