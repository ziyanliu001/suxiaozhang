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
//
// 🏛️ 双轨制架构（见仓库根目录 CLAUDE.md「多租户隔离与全国公信力大屏双轨制
// 设计」+ docs/BUSINESS_MODEL.md）：FEATURE_KEYS 按盈利模型分三组登记——
//   - 免费公开能力：全国大屏/义工打卡/阳光台账等公益侧能力。这些 key 只作为
//     跨模块统一的功能标识（埋点/日志/未来数据分析用），绝不允许接入
//     checkTenantPermission() 做拦截——公益专区的查看权限不挂钩商业套餐，
//     这是硬约束，不是待定项。
//   - 第一阶段付费能力：与下面 PERMISSION_TIER.ADVANCED 对应，要求
//     tenant_subscriptions.planType 为 pro/enterprise。MULTI_STORE_DASHBOARD/
//     EXCEL_EXPORT 两项已接入实际拦截（见各自调用点）；ADVANCED_ROLE_PERMISSION/
//     PRODUCTION_PIPELINE/SMS_NOTIFICATION 三项目前只登记常量本身——对应的
//     生产排单/多角色协同/短信通知功能页面尚未接入 checkTenantPermission()
//     调用，落地时需要先确认具体拦截哪些入口，避免一次性把现有免费用户正在
//     使用的功能突然锁死。
//   - 第二阶段预留能力：ESG_CARBON_REPORT/D2C_SUPPLY_CHAIN_ORDER 对应的实体
//     功能尚未建设，仅预先登记 key 占位，不接入任何鉴权调用。
import { isCloudAvailable } from './cloudGuard';
import { AuthService } from './authService';
import { callFunctionWithTimeout } from './withTimeout';

export const FEATURE_KEYS = {
  // ── 免费公开能力：仅作跨模块统一标识，严禁传入 checkTenantPermission() ──
  PUBLIC_NATIONAL_DASHBOARD: 'publicNationalDashboard',
  VOLUNTEER_CHECK_IN: 'volunteerCheckIn',
  PUBLIC_SUNSHINE_LEDGER: 'publicSunshineLedger',

  // ── 第一阶段付费 SaaS 增值能力（需订阅/加购）──
  // 🛡️ 以下两个 value（'multiStoreDashboard'/'excelExport'）是与
  // cloudfunctions/checkTenantPermission 的 FEATURE_PLAN_REQUIREMENTS 及
  // getNationalDashboard 的历史约定值，禁止修改字符串——改了会导致服务端
  // 矩阵查不到对应 key，按"未登记 featureKey 一律放行"的兜底策略静默变成免费
  EXCEL_EXPORT: 'excelExport',                          // 财务/审计级报表导出
  MULTI_STORE_DASHBOARD: 'multiStoreDashboard',          // 自家多门店/连锁聚合管理
  ADVANCED_ROLE_PERMISSION: 'advancedRolePermission',    // 多店长/财务协同审批（尚未接入拦截，见上方架构说明）
  PRODUCTION_PIPELINE: 'productionPipeline',             // 工坊生产排单与批次追溯（尚未接入拦截，见上方架构说明）
  SMS_NOTIFICATION: 'smsNotification',                   // 自动化短信/模板通知包（尚未接入拦截，见上方架构说明）

  // ── 第二阶段高阶资产能力预留（对应功能尚未建设，仅占位）──
  ESG_CARBON_REPORT: 'esgCarbonReport',                  // 企业 ESG 碳资产认证导出
  D2C_SUPPLY_CHAIN_ORDER: 'd2cSupplyChainOrder'          // 善意严选供应链下单与分销
} as const;

export type FeatureKey = typeof FEATURE_KEYS[keyof typeof FEATURE_KEYS];

// 🆕 权限与功能映射重构：把服务端 planType（'basic'/'pro'/'enterprise' 三档，
// 底层数据模型不变，仍是 tenant_subscriptions 唯一真源）在前端归纳成更好理解
// 的两档概念，仅供 UI 展示/文档使用，不引入新的数据字段：
//   - BASIC（基础功能）：单店日常管理、义工打卡、基础统计——全员默认免费自动
//     开通，压根不经过本模块的鉴权检查（这些功能的调用点从来不 import 本文件）。
//   - ADVANCED（高级功能）：FEATURE_KEYS 里"第一阶段付费"分组的几项，要求
//     tenant_subscriptions.planType 为 pro/enterprise
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
  // 🆕 已接入门店数：与 storeLimit 搭配展示"已接入 X / Y 家"配额进度（见
  // profile.ts fetchSubscriptionInfo），取自 tenants.currentStoreCount（与
  // createStore/manageTenantSubscription 原子自增写入的同一个字段，唯一真源）
  usedStoreCount: number;
  // 🆕 终身特权显式标记：与 profile.ts isPerpetualPlan() 同一套口径——只有
  // manageTenantSubscription 后台人工打上这个标记的订阅记录才会被判定为
  // "永久有效"，不再靠 serviceExpireDate 的日期形状反推（历史教训：pro/
  // enterprise 的真实年费到期日一旦落入脏数据区间会被误判成永久有效）
  isLifetimeGrant: boolean;
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
  // 🐛 根因修复：basic（免费默认档）真实门店上限是 2 家（见 checkTenantPermission
  // 云函数 PLAN_STORE_LIMITS 与雨花斋服务协议第 3 节费率表），此前这里写的 1
  // 与服务端口径不一致——虽然这只是"云不可用时的保守放行兜底值"，不参与任何
  // 服务端硬校验，但仍会导致弹窗在网络异常时短暂展示错误的配额基准
  storeLimit: 2,
  serviceExpireDate: null,
  reason: '',
  tenantName: '',
  usedStoreCount: 0,
  isLifetimeGrant: false
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
  tenantName: '',
  usedStoreCount: 0,
  isLifetimeGrant: true
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
      // 🐛 根因修复：与上方 FALLBACK_ALLOWED 同一处 basic 配额口径错误——
      // 真实兜底值应是 2 家，不是 1 家
      storeLimit: r.storeLimit || 2,
      serviceExpireDate: r.serviceExpireDate || null,
      reason: r.reason || '',
      tenantName: r.tenantName || '',
      usedStoreCount: r.usedStoreCount || 0,
      isLifetimeGrant: !!r.isLifetimeGrant
    };
    _cache[featureKey] = { result, expiresAt: Date.now() + CACHE_TTL_MS };
    return result;
  } catch (err) {
    console.warn('[tenantPermission] checkTenantPermission 调用异常，保守放行:', err);
    return FALLBACK_ALLOWED;
  }
}
