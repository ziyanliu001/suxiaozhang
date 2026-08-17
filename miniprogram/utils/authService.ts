import { isCloudAvailable } from './cloudGuard';

const OPENID_CACHE_KEY = 'auth_openid';
const USER_CACHE_KEY = 'auth_user';
const USER_ROLE_CACHE_KEY = 'auth_user_role';
// 🐛 与下面 ROLE_QUERY_TIMEOUT_MS 同一处根因：开发者工具网络波动 / 云函数
// 冷启动偶尔会超过原先 5s 的阈值，实测复现频率不低。8s 起步 + ensureLogin 内
// 新增的"超时自动重试 1 次"，两道保险叠加后才会真正落到临时 openid 兜底
const LOGIN_TIMEOUT_MS = 8000;
// 8s 足够覆盖冷启动场景，配合 fetchUserRole 内的"超时自动重试 1 次"，两道
// 保险叠加后才会真正落到本地缓存兜底
const ROLE_QUERY_TIMEOUT_MS = 8000;
const TEMP_OPENID_PREFIX = 'local_';

// 🏢 platform_admin：SaaS 平台超级管理员（开发者/运维方），仅管理租户生命周期与云资源，
// 与业务角色（super_admin ~ volunteer）分属两个维度，二者互不包含、互不提升
//
// 🏛️ store_patriarch（家长/督导）：与 store_manager 平级、各自独立绑定同一门店的
// 监督角色（雨花斋人文架构里"家长管对外与文化督导，店长管日常记账执行"的分工），
// 二者是两个不同的自然人，各自持有自己的 user_roles 记录——不是同一人身兼两角色，
// 因此完整复用本项目"一个 openid = 一条 user_roles 记录 = 一个角色"的既有假设
export type UserRole = 'super_admin' | 'store_manager' | 'store_patriarch' | 'finance' | 'volunteer' | 'platform_admin';

interface RoleInfo {
  role: UserRole;
  storeId: string;
  storeName: string;
  status: string;
  // 🏢 多租户：所属机构 ID（一个机构下辖多个门店），platform_admin 无归属租户
  tenantId?: string;
  // 🏢 工作空间过滤权威口径：随身份绑定门店（stores.orgType）一并下发，供
  // pages/index/index.ts 的雨花/通用工作空间路由使用——不再用 tenantId 前缀猜，
  // 详见 checkUserRole 云函数同名字段注释。未绑定门店时为空字符串
  orgType?: string;
  // 🙋 头像昵称填写规范
  avatarUrl?: string;
  nickName?: string;
  // 🏛️ 多角色兼任：manageStoreInviteCode 的 redeem 动作核销邀请码时追加写入
  // user_roles.roles（如 ['STORE_MANAGER','FINANCE']），由 checkUserRole 随
  // 角色信息一并下发。role 字段仍是"当前展示角色"这唯一权威值，roles 只是
  // "还持有哪些身份"的清单，供 profile.ts 的"切换身份"面板判断是否需要展示
  // 多身份切换列表
  roles?: string[];
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
  store_patriarch: '家长',
  finance: '财务义工',
  volunteer: '普通义工',
  platform_admin: '平台管理员（开发者）'
};

// 🏛️ 三级权限分层：L3 全网级（仅超级管理员——跨机构查看/租户续费/风控），
// L2 门店管理级（家长/店长——本店业务管理、邀请码生成），L1 日常执行级
// （义工/财务——日常打卡与报表填写）。"family"（家人/服务对象）不是一个独立
// 的服务端角色，它是 role==='volunteer' 且 status!=='approved' 的默认展示态
// （见各页面 isFamily 判定），底层同样归入 L1。platform_admin 是与业务角色
// 完全独立的运维维度（详见 UserRole 定义处注释），不参与这套业务分层，
// 这里仅为类型完整性给一个占位值，任何业务权限判断都不应依赖它。
export type RoleTier = 'L1' | 'L2' | 'L3';

export const ROLE_TIER: Record<UserRole, RoleTier> = {
  super_admin: 'L3',
  store_patriarch: 'L2',
  store_manager: 'L2',
  finance: 'L1',
  volunteer: 'L1',
  platform_admin: 'L1'
};

export interface PermissionFlags {
  canSwitchStore: boolean;
  canAuditUser: boolean;
  canDeleteRecord: boolean;
  canEditBalance: boolean;
  canEditReport: boolean;
  canExportData: boolean;
  canViewNationalDashboard: boolean;
  // 🏛️ 家长/督导专属：对店长发起的门店画像变更、餐报作废等高风险操作有确认/驳回权
  canApproveSensitiveOps: boolean;
  // 供页面 wx:if 判断"当前是否为家长视角"，避免各页面各自重复 role === 'store_patriarch' 字面量比较
  isPatriarch: boolean;
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
        canViewNationalDashboard: true,
        canApproveSensitiveOps: true,
        isPatriarch: false
      };
    case 'store_manager':
      return {
        canSwitchStore: false,
        canAuditUser: true,
        canDeleteRecord: true,
        canEditBalance: true,
        canEditReport: true,
        canExportData: true,
        canViewNationalDashboard: false,
        canApproveSensitiveOps: false,
        isPatriarch: false
      };
    // 🏛️ 家长/督导：权限向下继承——新店开业"大家长与店长为同一人"场景下，大家长
    // 天然拥有 store_manager + finance 的全套日常管理权限（录入餐报/发布食谱/
    // 编写日志/管理工时/审核义工/编辑账目等），无需再额外兼任多重角色；
    // canApproveSensitiveOps 是叠加在这之上的家长专属监督权（对店长发起的高风险
    // 操作——门店画像变更、餐报作废——仍有确认/驳回权，这是普通店长/财务没有的）
    case 'store_patriarch':
      return {
        canSwitchStore: false,
        canAuditUser: true,
        canDeleteRecord: true,
        canEditBalance: true,
        canEditReport: true,
        canExportData: true,
        canViewNationalDashboard: false,
        canApproveSensitiveOps: true,
        isPatriarch: true
      };
    case 'finance':
      return {
        canSwitchStore: false,
        canAuditUser: false,
        canDeleteRecord: false,
        canEditBalance: true,
        canEditReport: true,
        canExportData: true,
        canViewNationalDashboard: false,
        canApproveSensitiveOps: false,
        isPatriarch: false
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
        canViewNationalDashboard: false,
        canApproveSensitiveOps: false,
        isPatriarch: false
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
        canViewNationalDashboard: true,
        canApproveSensitiveOps: false,
        isPatriarch: false
      };
  }
}

/**
 * 门店管理权限判定：大家长、店长、超级管理员均具备门店审批权。
 * 采用并集逻辑，任意一项满足即视为具备门店管理员特权，可审核本门店内
 * 义工、财务、店长的角色申请。
 */
export function hasStoreAdminPrivilege(role: string | undefined | null): boolean {
  return role === 'store_patriarch' || role === 'store_manager' || role === 'super_admin';
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

      let result;
      try {
        result = await withTimeout(
          wx.cloud.callFunction({ name: 'login' }),
          LOGIN_TIMEOUT_MS,
          '登录超时，请检查网络后重试'
        );
      } catch (firstErr: any) {
        // 🔁 只对"登录超时"自动重试 1 次（云函数冷启动/开发者工具网络波动很容易
        // 偶发命中一次，与 fetchUserRole 同款套路），SDK 不可用等其它异常没有
        // 重试的意义，直接抛给外层走临时 openid 兜底
        if (!(firstErr && firstErr.message === '登录超时，请检查网络后重试')) {
          throw firstErr;
        }
        console.warn('[AuthService] 登录首次超时，自动重试 1 次...');
        result = await withTimeout(
          wx.cloud.callFunction({ name: 'login' }),
          LOGIN_TIMEOUT_MS,
          '登录超时，请检查网络后重试'
        );
      }

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

      let result;
      try {
        result = await withTimeout(
          wx.cloud.callFunction({ name: 'checkUserRole' }),
          ROLE_QUERY_TIMEOUT_MS,
          '角色查询超时'
        );
      } catch (firstErr: any) {
        // 🔁 只对"角色查询超时"自动重试 1 次（云函数冷启动/开发者工具网络波动很容易
        // 偶发命中一次），SDK 不可用等其它异常没有重试的意义，直接抛给外层走缓存兜底
        if (!(firstErr && firstErr.message === '角色查询超时')) {
          throw firstErr;
        }
        console.warn('[AuthService] 角色查询首次超时，自动重试 1 次...');
        result = await withTimeout(
          wx.cloud.callFunction({ name: 'checkUserRole' }),
          ROLE_QUERY_TIMEOUT_MS,
          '角色查询超时'
        );
      }

      const r = result.result as any;
      if (r && r.success) {
        const roleInfo: RoleInfo = {
          role: (r.role || 'volunteer') as UserRole,
          storeId: r.storeId || '',
          storeName: r.storeName || '',
          status: r.status || 'guest',
          tenantId: r.tenantId || '',
          orgType: r.orgType || '',
          avatarUrl: r.avatarUrl || '',
          nickName: r.nickName || '',
          roles: Array.isArray(r.roles) ? r.roles : []
        };
        wx.setStorageSync(USER_ROLE_CACHE_KEY, JSON.stringify(roleInfo));
        return { success: true, roleInfo };
      }

      // 云函数返回业务失败（非网络异常），尝试降级到本地缓存
      const cached = this.getCachedRoleInfo();
      if (cached) {
        console.warn('[AuthService] 角色查询业务失败，已降级为本地缓存角色:', cached.role);
        return { success: true, roleInfo: cached };
      }
      return { success: false, error: (r && r.error) || '角色查询失败' };
    } catch (err: any) {
      const isCloudDown = !!(err && err.message && err.message.includes('CLOUD_SDK_UNAVAILABLE'));
      const isTimeout = !!(err && err.message === '角色查询超时');
      console.error(
        isCloudDown
          ? '[AuthService] 云开发 SDK 不可用，角色查询已降级为本地缓存兜底'
          : '[AuthService] fetchUserRole 异常:',
        isCloudDown ? '' : err
      );
      // 网络异常 / SDK 不可用 / 重试后仍超时：降级到本地缓存，绝不向调用方抛出
      // 未捕获异常，避免阻塞页面 onShow 生命周期
      const cached = this.getCachedRoleInfo();
      if (cached) {
        if (isTimeout) {
          console.warn('[AuthService] 角色查询超时，已自动降级使用本地角色缓存');
        } else {
          console.warn('[AuthService] fetchUserRole 降级为缓存角色:', cached.role);
        }
        return { success: true, roleInfo: cached };
      }
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

  // 🏛️ 三级权限分层查询：供云函数调用前的前端提前拦截、或页面按层级显隐入口
  // 使用，与 getPermissionFlags 的细粒度能力位互补——这里只回答"大致在哪一层"
  getRoleTier(): RoleTier {
    const role = this.getRole() as UserRole;
    return ROLE_TIER[role] || 'L1';
  },

  // 🐛 根因修复的集中版：cachedRole（AuthService 本地持久化的服务端角色缓存）与
  // storageRole（store-picker 手动切换身份后写入 current_user_role 的生效角色）
  // 冲突时，storageRole 必须无条件优先生效，并立即写回持久化缓存，避免其他页面
  // 直接调用 getCachedRoleInfo() 时撞见这个窗口期的残留旧角色（典型场景：曾经是
  // super_admin、后来被切换/降级为 store_manager，但缓存没人主动更新过）。
  // 此前 index.ts/profile.ts/statistics.ts/daily-menu.ts/store-management.ts/
  // activity-log.ts 等多个页面各自拷贝了一份几乎一样的判断逻辑，任何一次修复
  // 都要同步改好几遍——收敛成这一个方法，页面直接调用即可，不再各自维护副本。
  //
  // @param persistedRole 当前已持久化的角色（一般传 cached.role/info.role），
  //   用来判断是否需要触发一次 overwriteCachedRole 回写——不一致才写，避免
  //   每次调用都触发不必要的 setStorageSync
  // @returns 生效角色的原始 token：storageRole 存在则原样返回它（可能是
  //   'store_family' 这个仅用于展示分流的伪角色，调用方自行按需归一化展示），
  //   否则原样返回 persistedRole
  resolveEffectiveRole(persistedRole: string): string {
    const storageRole = wx.getStorageSync('current_user_role');
    if (!storageRole) return persistedRole;

    // store_family 是页面展示层用来区分"家人视角"的伪角色，不在 UserRole 枚举里，
    // 它对应的真实底层角色就是 volunteer，写回缓存时要按真实角色归一化，
    // 否则 overwriteCachedRole 会把一个非法的 role 值落进持久化缓存
    const roleForCache = storageRole === 'store_family' ? 'volunteer' : storageRole;
    if (persistedRole !== roleForCache) {
      this.overwriteCachedRole(roleForCache as UserRole);
    }
    return storageRole;
  },

  // 🐛 根因修复：cachedRole（本地持久化的服务端角色缓存）与 storageRole（手动
  // 切换身份后写入的 current_user_role 生效角色）不一致时，调用方必须立即用这个
  // 方法把生效角色写回持久化缓存——否则任何直接调用 getCachedRoleInfo()/getRole()
  // 的页面（例如统计页 initUserRole 里 fetchUserRole() 异步校验落地前的同步兜底
  // 分支），在这个窗口期读到的仍是残留的旧角色（典型场景：曾经是 super_admin、
  // 后来被切换/降级为 store_manager，但 auth_user_role 缓存没人主动更新过），
  // 从而把"全部门店"等超管专属能力错误地放给非超管账号
  overwriteCachedRole(role: UserRole): void {
    try {
      const cached = this.getCachedRoleInfo();
      const merged: RoleInfo = {
        role,
        storeId: (cached && cached.storeId) || '',
        storeName: (cached && cached.storeName) || '',
        status: (cached && cached.status) || 'guest',
        tenantId: (cached && cached.tenantId) || '',
        orgType: (cached && cached.orgType) || '',
        avatarUrl: (cached && cached.avatarUrl) || '',
        nickName: (cached && cached.nickName) || '',
        roles: (cached && cached.roles) || []
      };
      wx.setStorageSync(USER_ROLE_CACHE_KEY, JSON.stringify(merged));
    } catch (e) {
      console.warn('[AuthService] overwriteCachedRole 异常:', e);
    }
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
          orgType: (cached && cached.orgType) || '',
          avatarUrl: fields.avatarUrl !== undefined ? fields.avatarUrl : ((cached && cached.avatarUrl) || ''),
          nickName: fields.nickName !== undefined ? fields.nickName : ((cached && cached.nickName) || ''),
          roles: (cached && cached.roles) || []
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
