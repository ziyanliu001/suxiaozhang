// 租户订阅鉴权：多门店汇总看板、Excel 批量导出等高级功能的统一前端鉴权入口。
//
// 🏛️ 架构说明：订阅数据的唯一真源是云端 tenant_subscriptions 集合（由
// manageTenantSubscription 云函数 + pages/platform-admin 页面维护，字段是
// planType/serviceExpireDate/cloudQuota），不在这里另外维护一份影子数据——
// 本模块只是 cloudfunctions/checkTenantPermission 的一层前端封装：加缓存，
// 加"查询失败/云不可用时保守放行"的兜底，加 platform_admin 豁免。升级引导弹窗
// 不在这里——原生 wx.showModal 按钮无法用 WXSS 定制样式，改由各调用页面自己
// 用一个半屏卡片弹窗承接（见 pages/statistics/statistics.ts
// onOpenPlanUpgradeModal），本模块只负责回答"允不允许"。
//
// 🛡️ 这里的检查是"体验层拦截"，防止用户点完操作才被拒绝；真正不可绕过的硬
// 校验在服务端——多门店汇总看板对应的 getNationalDashboard 云函数内部有一份
// 完全相同的判断逻辑，即使跳过这层前端弹窗直接发起云调用也会被拒绝。
// Excel 导出目前是纯客户端拼表操作，没有可拦截的云调用，这层前端检查就是
// 唯一的把关点。
import { isCloudAvailable } from './cloudGuard';
import { AuthService } from './authService';
import { callFunctionWithTimeout } from './withTimeout';

export const FEATURE_KEYS = {
  MULTI_STORE_DASHBOARD: 'multiStoreDashboard',
  EXCEL_EXPORT: 'excelExport'
} as const;

export type FeatureKey = typeof FEATURE_KEYS[keyof typeof FEATURE_KEYS];

// 🆕 权限与功能映射重构：把服务端 planType（'basic'/'pro'/'enterprise' 三档，
// 底层数据模型不变，仍是 tenant_subscriptions 唯一真源）在前端归纳成更好理解
// 的两档概念，仅供 UI 展示/文档使用，不引入新的数据字段：
//   - BASIC（基础功能）：单店日常管理、义工打卡、基础统计——全员默认免费自动
//     开通，压根不经过本模块的鉴权检查（这些功能的调用点从来不 import 本文件）。
//   - ADVANCED（高级功能）：即 FEATURE_KEYS 里登记的这两项（全国/跨店汇总大屏、
//     Excel 批量导出），要求 tenant_subscriptions.planType 为 pro/enterprise
//     且未到期，由 resolveTier() 从 checkTenantPermission() 已经算好的
//     planType/isExpired 结果派生，不重复实现一遍到期判断逻辑
export const PERMISSION_TIER = {
  BASIC: 'BASIC',
  ADVANCED: 'ADVANCED'
} as const;

export type PermissionTier = typeof PERMISSION_TIER[keyof typeof PERMISSION_TIER];

// 从一次 checkTenantPermission() 的结果推导出简化的 BASIC/ADVANCED 展示档位——
// isExpired 已经把"到期即降级"这条规则包含在 planType 里了（见 checkTenantPermission
// 云函数：isExpired 时 planType 会被服务端提前改写回 'basic'），这里直接读
// planType 即可，不需要再单独判断 isExpired
export function resolveTier(planType: string): PermissionTier {
  return (planType === 'pro' || planType === 'enterprise') ? PERMISSION_TIER.ADVANCED : PERMISSION_TIER.BASIC;
}

export interface TenantPermissionResult {
  allowed: boolean;
  planType: string;
  isExpired: boolean;
  // 🕊️ 到期宽限期（7 天，GRACE_PERIOD_DAYS，见 checkTenantPermission 云函数）：
  // 到期后仍在宽限期内时 isExpired 为 true 但 isInGracePeriod 也为 true，
  // planType/高级功能仍保持到期前的档位不降级；coreReadOnly 只在真正超出
  // 宽限期后才为 true，供核心记账相关的写路径（如 saveReport）判断是否需要
  // 收紧为只读——本模块只透传服务端算好的结果，不重复实现判断逻辑
  isInGracePeriod: boolean;
  graceExpireDate: string | null;
  coreReadOnly: boolean;
  storeLimit: number;
  // 🌟 原始到期日期字符串（YYYY-MM-DD），从未订阅过/查询失败时为 null——
  // 供"套餐升级/续费"卡片展示真实到期日，而不只是一个 isExpired 布尔值
  serviceExpireDate: string | null;
  reason: string;
  // 🏢 机构名称：供个人中心页顶部"归属机构"展示，不是门店名（那是 currentStoreName，
  // 两者是两个不同层级，见 profile.ts fetchCurrentTenantName 注释）。platform_admin/
  // 未归属任何机构/查询失败时为空字符串
  tenantName: string;
}

// 保守放行的默认结果：查询失败/云不可用/未命中缓存前的兜底值。宁可放行一次
// 让用户操作，也不要因为鉴权服务本身抖动就把正常付费用户挡在门外——真正的
// 硬校验交给服务端（见上方架构说明）
const FALLBACK_ALLOWED: TenantPermissionResult = {
  allowed: true,
  planType: 'basic',
  isExpired: false,
  isInGracePeriod: false,
  graceExpireDate: null,
  coreReadOnly: false,
  storeLimit: 1,
  serviceExpireDate: null,
  reason: '',
  tenantName: ''
};

// 🛡️ 轻量内存缓存：同一 featureKey 60s 内不重复发起云调用，避免用户在
// 全国总览/导出按钮上多次点击时打出去一串重复的鉴权请求
const CACHE_TTL_MS = 60000;
const _cache: Partial<Record<FeatureKey, { result: TenantPermissionResult; expiresAt: number }>> = {};

// 🆕 激活码自助兑换成功后，立即清空这份内存缓存——否则用户兑换完当场跳转去
// 统计页/导出功能，最多还要再等到 60s 缓存自然过期才会看到解锁生效，体验上
// 像是"兑换了但没生效"。调用方（profile.ts 兑换成功回调）应在这里清一次，
// 保证下一次 checkTenantPermission() 一定重新发起云调用拿到最新套餐状态
export function clearTenantPermissionCache() {
  (Object.keys(_cache) as FeatureKey[]).forEach((key) => {
    delete _cache[key];
  });
}

// 🛡️ 平台管理员豁免：platform_admin（SaaS 平台运维方，见 authService.ts
// UserRole 定义处注释）与业务角色/租户套餐彻底隔离——这堵付费墙是针对
// "某个机构自己的 super_admin"设计的，防止免费版租户靠自己的超管账号绕过
// pro/enterprise 专属功能（每个机构都有自己的 super_admin，若对它放行等于
// 付费墙对所有租户失效）。platform_admin 不属于任何机构的付费主体，不该被
// 这堵墙拦下——但这只解除"多门店看板/Excel 导出"这一层套餐拦截，
// getNationalDashboard 云函数自身的 ALLOWED_ROLES 仍把 platform_admin 排除
// 在外（机构财务数据对平台运维方本就不该可见，是另一层更基础、彼此独立的
// 隐私边界，不受本次改动影响，platform_admin 依然看不到大屏具体内容）
const PLATFORM_ADMIN_ALLOWED: TenantPermissionResult = {
  allowed: true,
  planType: 'enterprise',
  isExpired: false,
  isInGracePeriod: false,
  graceExpireDate: null,
  coreReadOnly: false,
  storeLimit: Number.MAX_SAFE_INTEGER,
  serviceExpireDate: null,
  reason: '',
  tenantName: ''
};

export async function checkTenantPermission(
  featureKey: FeatureKey,
  opts?: { skipCache?: boolean }
): Promise<TenantPermissionResult> {
  if (AuthService.isPlatformAdmin()) {
    return PLATFORM_ADMIN_ALLOWED;
  }

  const cached = _cache[featureKey];
  if (!opts?.skipCache && cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  if (!isCloudAvailable()) {
    return FALLBACK_ALLOWED;
  }

  try {
    const res = await callFunctionWithTimeout({ name: 'checkTenantPermission', data: { featureKey } });
    const r = res.result as any;
    if (!r || !r.success) {
      console.warn('[tenantPermission] checkTenantPermission 返回失败，保守放行:', r);
      return FALLBACK_ALLOWED;
    }

    const result: TenantPermissionResult = {
      allowed: !!r.allowed,
      planType: r.planType || 'basic',
      isExpired: !!r.isExpired,
      isInGracePeriod: !!r.isInGracePeriod,
      graceExpireDate: r.graceExpireDate || null,
      coreReadOnly: !!r.coreReadOnly,
      storeLimit: r.storeLimit || 1,
      serviceExpireDate: r.serviceExpireDate || null,
      reason: r.reason || '',
      tenantName: r.tenantName || ''
    };
    _cache[featureKey] = { result, expiresAt: Date.now() + CACHE_TTL_MS };
    return result;
  } catch (err) {
    console.warn('[tenantPermission] checkTenantPermission 调用异常，保守放行:', err);
    return FALLBACK_ALLOWED;
  }
}
