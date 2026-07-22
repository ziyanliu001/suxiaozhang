import { isCloudAvailable } from './cloudGuard';

const OPENID_CACHE_KEY = 'auth_openid';
const USER_CACHE_KEY = 'auth_user';
const USER_ROLE_CACHE_KEY = 'auth_user_role';
const LOGIN_TIMEOUT_MS = 5000;
const TEMP_OPENID_PREFIX = 'local_';

// 🏢 platform_admin：SaaS 平台超级管理员（开发者/运维方），仅管理租户生命周期与云资源，
// 与业务角色（super_admin ~ volunteer）分属两个维度，二者互不包含、互不提升
export type UserRole = 'super_admin' | 'store_manager' | 'finance' | 'volunteer' | 'platform_admin';

interface RoleInfo {
  role: UserRole;
  storeId: string;
  storeName: string;
  status: string;
  // 🏢 多租户：所属机构 ID（一个机构下辖多个门店），platform_admin 无归属租户
  tenantId?: string;
  // 🙋 头像昵称填写规范
  avatarUrl?: string;
  nickName?: string;
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
  volunteer: '普通义工',
  platform_admin: '平台管理员（开发者）'
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
  const role = ((roleInfo && roleInfo.role) || 'volunteer') as UserRole;

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
    case 'platform_admin':
      // 🏢 平台管理员（开发者）：仅在租户管理专属页面操作 tenants / tenant_subscriptions，
      // 对任何门店的餐报业务数据一律不放行，与业务角色的权限彻底隔离，防止"商业运营方"
      // 借运维身份窥探或篡改公益机构内部敏感财务明细
      return {
        canSwitchStore: false,
        canAuditUser: false,
        canDeleteRecord: false,
        canEditBalance: false,
        canEditReport: false,
        canExportData: false,
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
        // 🛡️ 普通志工可查看全国大屏（成本类敏感数据由 sanitizeReportForVolunteer 在服务端脱敏），
        // 但门店选择器强制锁定为"全部门店"，与 statistics.ts 的 isVolunteerNationalView 逻辑保持一致
        canViewNationalDashboard: true
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
      // 🌟 云开发 SDK 不可用（如 wx.cloud.init 内部致命错误导致方法表损坏）时，
      // 直接跳过云端登录尝试，走下方 catch 分支的临时 openid 兜底，避免抛出
      // "Cannot read property 'getCloudAPI' of undefined" 之类的未受保护异常
      if (!isCloudAvailable()) {
        throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端登录');
      }

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

      console.warn('[AuthService] 登录失败，使用临时 openid:', r && r.error);
      const tempOpenid = generateTempOpenid();
      wx.setStorageSync(OPENID_CACHE_KEY, tempOpenid);
      return { success: true, openid: tempOpenid, isTemp: true };
    } catch (err: any) {
      const isCloudDown = !!(err && err.message && err.message.includes('CLOUD_SDK_UNAVAILABLE'));
      console.error(
        isCloudDown
          ? '[AuthService] 云开发 SDK 不可用，本次登录直接降级为临时 openid（本地模式）'
          : '[AuthService] 登录异常，使用临时 openid:',
        isCloudDown ? '' : err
      );
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
      if (!isCloudAvailable()) {
        throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过角色查询');
      }

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
          status: r.status || 'guest',
          tenantId: r.tenantId || '',
          avatarUrl: r.avatarUrl || '',
          nickName: r.nickName || ''
        };
        wx.setStorageSync(USER_ROLE_CACHE_KEY, JSON.stringify(roleInfo));
        return { success: true, roleInfo };
      }

      return { success: false, error: (r && r.error) || '角色查询失败' };
    } catch (err: any) {
      const isCloudDown = !!(err && err.message && err.message.includes('CLOUD_SDK_UNAVAILABLE'));
      console.error(
        isCloudDown
          ? '[AuthService] 云开发 SDK 不可用，角色查询已降级为本地缓存兜底'
          : '[AuthService] fetchUserRole 异常:',
        isCloudDown ? '' : err
      );
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
    return (roleInfo && roleInfo.role) || 'volunteer';
  },

  isAdmin(): boolean {
    const role = this.getRole();
    return role === 'super_admin' || role === 'admin';
  },

  isSuperAdmin(): boolean {
    return this.getRole() === 'super_admin';
  },

  // 🏢 平台管理员（开发者运维身份），与业务角色维度完全独立，详见 UserRole 定义处注释
  isPlatformAdmin(): boolean {
    return this.getRole() === 'platform_admin';
  },

  getRoleLabel(): string {
    const role = this.getRole() as UserRole;
    return ROLE_LABELS[role] || '普通义工';
  },

  // 🙋 头像昵称填写规范：更新云端记录并同步刷新本地缓存的 RoleInfo，
  // 调用方（如个人中心页）无需自行处理缓存失效
  async updateProfile(fields: { avatarUrl?: string; nickName?: string }): Promise<{ success: boolean; error?: string }> {
    try {
      if (!isCloudAvailable()) {
        throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过资料更新');
      }

      const result = await wx.cloud.callFunction({ name: 'updateUserProfile', data: fields });
      const r = result.result as any;

      if (r && r.success) {
        const cached = this.getCachedRoleInfo();
        const merged: RoleInfo = {
          role: (cached && cached.role) || 'volunteer',
          storeId: (cached && cached.storeId) || '',
          storeName: (cached && cached.storeName) || '',
          status: (cached && cached.status) || 'guest',
          tenantId: (cached && cached.tenantId) || '',
          avatarUrl: fields.avatarUrl !== undefined ? fields.avatarUrl : ((cached && cached.avatarUrl) || ''),
          nickName: fields.nickName !== undefined ? fields.nickName : ((cached && cached.nickName) || '')
        };
        wx.setStorageSync(USER_ROLE_CACHE_KEY, JSON.stringify(merged));
        return { success: true };
      }

      return { success: false, error: (r && r.error) || '更新失败' };
    } catch (err: any) {
      console.error('[AuthService] updateProfile 异常:', err);
      return { success: false, error: err.message || '更新异常' };
    }
  },

  clearAuth(): void {
    try {
      wx.removeStorageSync(OPENID_CACHE_KEY);
      wx.removeStorageSync(USER_CACHE_KEY);
      wx.removeStorageSync(USER_ROLE_CACHE_KEY);
      // 🛡️ 同一台设备换绑/切换账号时必须一并清掉：这是 pages/profile/profile.ts
      // 头像上传宽限期机制持久化的"上一次确认为真"的 fileID，键名与其定义处
      // CONFIRMED_AVATAR_CACHE_KEY 保持一致。若残留旧账号的记录，新账号登录后
      // checkUserRole 查到自己真实的 avatarUrl 时，会被误判成"与已确认值不一致的
      // 陈旧数据"而被忽略，导致新账号头像显示不出来——不是这里字面用到这个变量，
      // 而是必须与那处的字符串字面量保持同步。
      wx.removeStorageSync('confirmed_avatar_grace');
      console.log('[AuthService] 登录缓存已清除');
    } catch (err) {
      console.error('[AuthService] clearAuth 异常:', err);
    }
  }
};
