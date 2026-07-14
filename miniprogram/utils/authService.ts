const OPENID_CACHE_KEY = 'auth_openid';
const USER_CACHE_KEY = 'auth_user';
const USER_ROLE_CACHE_KEY = 'auth_user_role';
const LOGIN_TIMEOUT_MS = 5000;
const TEMP_OPENID_PREFIX = 'local_';

export type UserRole = 'super_admin' | 'store_manager' | 'finance' | 'volunteer';

interface RoleInfo {
  role: UserRole;
  storeId: string;
  storeName: string;
  status: string;
}

function withTimeout(promise, timeoutMs, timeoutMsg) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMsg)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function generateTempOpenid(): string {
  return TEMP_OPENID_PREFIX + Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

export const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: '超级管理员',
  store_manager: '店长',
  finance: '财务义工',
  volunteer: '普通义工'
};

export interface PermissionFlags {
  canSwitchStore: boolean;
  canAuditUser: boolean;
  canDeleteRecord: boolean;
  canEditBalance: boolean;
  canEditReport: boolean;
  canExportData: boolean;
  canViewNationalDashboard: boolean;
}

export function getPermissionFlags(roleInfo: { role?: string } | null | undefined): PermissionFlags {
  const role = (roleInfo?.role || 'volunteer') as UserRole;

  switch (role) {
    case 'super_admin':
      return {
        canSwitchStore: true,
        canAuditUser: true,
        canDeleteRecord: true,
        canEditBalance: true,
        canEditReport: true,
        canExportData: true,
        canViewNationalDashboard: true
      };
    case 'store_manager':
      return {
        canSwitchStore: false,
        canAuditUser: true,
        canDeleteRecord: true,
        canEditBalance: true,
        canEditReport: true,
        canExportData: true,
        canViewNationalDashboard: false
      };
    case 'finance':
      return {
        canSwitchStore: false,
        canAuditUser: false,
        canDeleteRecord: false,
        canEditBalance: true,
        canEditReport: true,
        canExportData: true,
        canViewNationalDashboard: false
      };
    case 'volunteer':
    default:
      return {
        canSwitchStore: false,
        canAuditUser: false,
        canDeleteRecord: false,
        canEditBalance: false,
        canEditReport: false,
        canExportData: false,
        canViewNationalDashboard: false
      };
  }
}

export const AuthService = {
  async ensureLogin(): Promise<{ success: boolean; openid?: string; error?: string; isTemp?: boolean }> {
    const cached = this.getOpenid();
    if (cached) {
      return { success: true, openid: cached, isTemp: cached.startsWith(TEMP_OPENID_PREFIX) };
    }

    try {
      const result = await withTimeout(
        wx.cloud.callFunction({ name: 'login' }),
        LOGIN_TIMEOUT_MS,
        '登录超时，请检查网络后重试'
      );

      const r = result.result as any;
      if (r && r.success && r.openid) {
        wx.setStorageSync(OPENID_CACHE_KEY, r.openid);
        if (r.user) {
          wx.setStorageSync(USER_CACHE_KEY, JSON.stringify(r.user));
        }
        console.log('[AuthService] 静默登录成功:', r.openid);
        return { success: true, openid: r.openid, isTemp: false };
      }

      console.warn('[AuthService] 登录失败，使用临时 openid:', r?.error);
      const tempOpenid = generateTempOpenid();
      wx.setStorageSync(OPENID_CACHE_KEY, tempOpenid);
      return { success: true, openid: tempOpenid, isTemp: true };
    } catch (err: any) {
      console.error('[AuthService] 登录异常，使用临时 openid:', err);
      const tempOpenid = generateTempOpenid();
      wx.setStorageSync(OPENID_CACHE_KEY, tempOpenid);
      return { success: true, openid: tempOpenid, isTemp: true };
    }
  },

  getOpenid(): string | null {
    try {
      return wx.getStorageSync(OPENID_CACHE_KEY) || null;
    } catch {
      return null;
    }
  },

  getUser(): any | null {
    try {
      const data = wx.getStorageSync(USER_CACHE_KEY);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  },

  isLoggedIn(): boolean {
    return !!this.getOpenid();
  },

  isTempOpenid(): boolean {
    const openid = this.getOpenid();
    return !!openid && openid.startsWith(TEMP_OPENID_PREFIX);
  },

  // 新角色体系
  async fetchUserRole(): Promise<{ success: boolean; roleInfo?: RoleInfo; error?: string }> {
    try {
      const result = await withTimeout(
        wx.cloud.callFunction({ name: 'checkUserRole' }),
        LOGIN_TIMEOUT_MS,
        '角色查询超时'
      );

      const r = result.result as any;
      if (r && r.success) {
        const roleInfo: RoleInfo = {
          role: (r.role || 'volunteer') as UserRole,
          storeId: r.storeId || '',
          storeName: r.storeName || '',
          status: r.status || 'guest'
        };
        wx.setStorageSync(USER_ROLE_CACHE_KEY, JSON.stringify(roleInfo));
        return { success: true, roleInfo };
      }

      return { success: false, error: r?.error || '角色查询失败' };
    } catch (err: any) {
      console.error('[AuthService] fetchUserRole 异常:', err);
      return { success: false, error: err.message || '角色查询异常' };
    }
  },

  getCachedRoleInfo(): RoleInfo | null {
    try {
      const data = wx.getStorageSync(USER_ROLE_CACHE_KEY);
      if (data) {
        return JSON.parse(data);
      }
    } catch {
      // ignore
    }
    // 降级到旧 user 缓存
    const user = this.getUser();
    if (user) {
      const oldRole = user.role || 'user';
      return {
        role: oldRole === 'admin' ? 'super_admin' : 'volunteer',
        storeId: user.storeId || '',
        storeName: user.storeName || '',
        status: 'approved'
      };
    }
    return null;
  },

  getRole(): string {
    const roleInfo = this.getCachedRoleInfo();
    return roleInfo?.role || 'volunteer';
  },

  isAdmin(): boolean {
    const role = this.getRole();
    return role === 'super_admin' || role === 'admin';
  },

  isSuperAdmin(): boolean {
    return this.getRole() === 'super_admin';
  },

  getRoleLabel(): string {
    const role = this.getRole() as UserRole;
    return ROLE_LABELS[role] || '普通义工';
  },

  clearAuth(): void {
    try {
      wx.removeStorageSync(OPENID_CACHE_KEY);
      wx.removeStorageSync(USER_CACHE_KEY);
      wx.removeStorageSync(USER_ROLE_CACHE_KEY);
      console.log('[AuthService] 登录缓存已清除');
    } catch (err) {
      console.error('[AuthService] clearAuth 异常:', err);
    }
  }
};
