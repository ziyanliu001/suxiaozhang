// 租户订阅鉴权：多门店汇总看板、Excel 批量导出等高级功能的统一前端鉴权入口。
//
// 🏛️ 架构说明：订阅数据的唯一真源是云端 tenant_subscriptions 集合（由
// manageTenantSubscription 云函数 + pages/platform-admin 页面维护，字段是
// planType/serviceExpireDate/cloudQuota），不在这里另外维护一份影子数据——
// 本模块只是 cloudfunctions/checkTenantPermission 的一层前端封装：加缓存，
// 加"查询失败/云不可用时保守放行"的兜底，加统一的升级引导弹窗。
//
// 🛡️ 这里的检查是"体验层拦截"，防止用户点完操作才被拒绝；真正不可绕过的硬
// 校验在服务端——多门店汇总看板对应的 getNationalDashboard 云函数内部有一份
// 完全相同的判断逻辑，即使跳过这层前端弹窗直接发起云调用也会被拒绝。
// Excel 导出目前是纯客户端拼表操作，没有可拦截的云调用，这层前端检查就是
// 唯一的把关点。
import { isCloudAvailable } from './cloudGuard';

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
  reason: ''
};

// 🛡️ 轻量内存缓存：同一 featureKey 60s 内不重复发起云调用，避免用户在
// 全国总览/导出按钮上多次点击时打出去一串重复的鉴权请求
const CACHE_TTL_MS = 60000;
const _cache: Partial<Record<FeatureKey, { result: TenantPermissionResult; expiresAt: number }>> = {};

export async function checkTenantPermission(
  featureKey: FeatureKey,
  opts?: { skipCache?: boolean }
): Promise<TenantPermissionResult> {
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
      reason: r.reason || ''
    };
    _cache[featureKey] = { result, expiresAt: Date.now() + CACHE_TTL_MS };
    return result;
  } catch (err) {
    console.warn('[tenantPermission] checkTenantPermission 调用异常，保守放行:', err);
    return FALLBACK_ALLOWED;
  }
}

// 🎨 高级功能卡口提示：不做任何虚构的"自助订阅/付款页"跳转——目前订阅完全
// 由 platform_admin 通过 pages/platform-admin 后台管理，普通租户用户没有
// 自助升级入口，"确认"按钮引导去 pages/profile（tabBar 页）联系客服/反馈，
// 而不是链到一个并不存在的收银台
export function promptTenantUpgrade(): void {
  wx.showModal({
    title: '功能受限',
    content: '该功能为专业版专属，请联系大家长升级套餐',
    confirmText: '去反馈',
    cancelText: '知道了',
    success: (res) => {
      if (res.confirm) {
        wx.switchTab({ url: '/pages/profile/profile' });
      }
    }
  });
}
