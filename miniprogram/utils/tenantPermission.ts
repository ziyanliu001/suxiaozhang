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

export const FEATURE_KEYS = {
  MULTI_STORE_DASHBOARD: 'multiStoreDashboard',
  EXCEL_EXPORT: 'excelExport'
} as const;

export type FeatureKey = typeof FEATURE_KEYS[keyof typeof FEATURE_KEYS];

export interface TenantPermissionResult {
  allowed: boolean;
  planType: string;
  isExpired: boolean;
  storeLimit: number;
  // 🌟 原始到期日期字符串（YYYY-MM-DD），从未订阅过/查询失败时为 null——
  // 供"套餐升级/续费"卡片展示真实到期日，而不只是一个 isExpired 布尔值
  serviceExpireDate: string | null;
  reason: string;
}

// 保守放行的默认结果：查询失败/云不可用/未命中缓存前的兜底值。宁可放行一次
// 让用户操作，也不要因为鉴权服务本身抖动就把正常付费用户挡在门外——真正的
// 硬校验交给服务端（见上方架构说明）
const FALLBACK_ALLOWED: TenantPermissionResult = {
  allowed: true,
  planType: 'basic',
  isExpired: false,
  storeLimit: 1,
  serviceExpireDate: null,
  reason: ''
};

// 🛡️ 轻量内存缓存：同一 featureKey 60s 内不重复发起云调用，避免用户在
// 全国总览/导出按钮上多次点击时打出去一串重复的鉴权请求
const CACHE_TTL_MS = 60000;
const _cache: Partial<Record<FeatureKey, { result: TenantPermissionResult; expiresAt: number }>> = {};

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
  storeLimit: Number.MAX_SAFE_INTEGER,
  serviceExpireDate: null,
  reason: ''
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
    const res = await wx.cloud.callFunction({ name: 'checkTenantPermission', data: { featureKey } });
    const r = res.result as any;
    if (!r || !r.success) {
      console.warn('[tenantPermission] checkTenantPermission 返回失败，保守放行:', r);
      return FALLBACK_ALLOWED;
    }

    const result: TenantPermissionResult = {
      allowed: !!r.allowed,
      planType: r.planType || 'basic',
      isExpired: !!r.isExpired,
      storeLimit: r.storeLimit || 1,
      serviceExpireDate: r.serviceExpireDate || null,
      reason: r.reason || ''
    };
    _cache[featureKey] = { result, expiresAt: Date.now() + CACHE_TTL_MS };
    return result;
  } catch (err) {
    console.warn('[tenantPermission] checkTenantPermission 调用异常，保守放行:', err);
    return FALLBACK_ALLOWED;
  }
}
