// 🏛️（2026-08-31 Open-Core 架构拆分）Enterprise 商业层 SPI 契约定义。
//
// 这份文件回答"Core 与 Enterprise 之间的边界长什么样"，是架构设计文档的
// TypeScript 落地，本身不包含任何实现——三个契约对应的真实实现分别在
// cloudfunctions/getNationalDashboard、cloudfunctions/exportAccountExcel、
// cloudfunctions/checkTenantPermission 三个独立部署的云函数里，各自完整
// 实现自己的一份，不共享代码（云函数之间没有跨函数共享模块的机制，这是
// 本仓库的既有架构约束，见 CLAUDE.md 与各云函数头部关于 DEFAULT_TENANT_ID/
// PLAN_STORE_LIMITS 等常量重复拷贝的说明）。
//
// 🛡️ 阶段说明：这是"契约定义"阶段（Open-Core 拆分第一阶段），不是"契约强制"
// 阶段——现有调用点（如 statistics.ts 的 loadNationalDashboard）尚未改造成
// 显式依赖这份类型定义做端到端类型检查，那需要对 nationalSummary 五十多个
// 字段逐一建模，属于更大规模的独立类型迁移工作，不在本次改动范围内。本文件
// 目前的价值是：①固定 Core/Enterprise 的方法级边界（入参/出参的顶层信封
// 结构），供未来任何一方（云函数团队/前端团队/第三方 Enterprise 插件开发者）
// 对齐实现；②在物理拆分成两个仓库时，作为"这些方法必须存在"的验收清单。
//
// 🏛️ 核心设计原则：Core 在完全没有接入任何 Enterprise 实现时，必须仍是一个
// 能正常运转的单店记账系统——因此这里的每一个方法都被前端封装成"缺席时
// 安全降级"的形态（见 utils/enterpriseCapabilities.ts 的 resolveXxx 系列
// 函数，以及各调用点里"quota 不存在时不阻塞、不抛错"的既有写法），不存在
// "缺了 Enterprise 就直接崩溃"的硬依赖点。

// ── IDashboardService：机构级跨店治理大盘 ──────────────────────────────
// 对应 cloudfunctions/getNationalDashboard。Core 层完全不需要认识这个接口——
// 单店记账/查询走的是 Core 自己的 getReports/getStatisticsData，与本接口
// 无任何依赖关系，这里只是把"Enterprise 提供了这个额外能力"的形状记录下来
export interface IDashboardService {
  // 入参：见 getNationalDashboard event 结构（tenantId 由服务端从调用者
  // user_roles 反查，不接受客户端直传，防止跨租户越权）
  getNationalDashboard(params: {
    rangeType?: '7d' | 'month' | 'quarter' | 'year' | 'all';
    orgType?: string;
    region?: { province?: string; city?: string };
    storeIds?: string[];
  }): Promise<{
    success: boolean;
    error?: string;
    // nationalSummary/storeMatrix/superAdminInsights 字段众多且随功能迭代
    // 持续增长（ingredientStats30d/volunteerSummary/subscriptionQuota/
    // rebalanceSuggestions/auditProofSummary 等，见该云函数历次改动），
    // 顶层契约只约束"信封"结构，不在这里逐字段建模
    nationalSummary?: Record<string, unknown>;
    storeMatrix?: Array<Record<string, unknown>>;
    superAdminInsights?: Record<string, unknown> | null;
    tenantName?: string;
  }>;
}

// ── IBatchExportService：多店合并阳光台账导出 ──────────────────────────
// 对应 cloudfunctions/exportAccountExcel 的 isNationalExport 分支——注意
// 该云函数文件本身是"混合文件"：isNationalExport:false 时走的是 Core 也会
// 用到的单店 Excel 导出能力（与本接口无关），只有 isNationalExport:true 的
// 那部分逻辑属于本 SPI 契约描述的 Enterprise 能力。物理拆分成两个仓库时，
// 这个文件需要按 isNationalExport 拆成两个独立云函数，是待办事项，不在
// 本次改动范围内（见架构文档"待办：混合文件清单"）
export interface IBatchExportService {
  exportNationalLedger(params: {
    tabType: 'custom';
    startDate: string;
    endDate: string;
  }): Promise<{
    success: boolean;
    errMsg?: string;
    requiresUpgrade?: boolean; // true 时前端应转去商业化升级引导，而不是普通报错提示
    tempFileURL?: string;
    fileName?: string;
    verificationCode?: string; // 存证核验码，仅 isNationalExport 场景下发
  }>;
}

// ── ISubscriptionQuotaService：SaaS 订阅配额与衍生能力门禁 ─────────────
// 对应 cloudfunctions/checkTenantPermission。与上面两个契约的关系：
// IDashboardService/IBatchExportService 各自的实现内部都会做一次等价的
// 订阅状态判断（服务端强鉴权，不依赖调用方先查过这个接口），本契约描述的
// 是"独立查询当前配额状态用于展示"这个场景（如 statistics.ts 顶部配额
// 微章、profile.ts 订阅管理弹窗），三处判断口径必须一致但物理实现各自独立
export interface ISubscriptionQuotaService {
  checkTenantPermission(params: { featureKey: string }): Promise<{
    success: boolean;
    allowed?: boolean;
    planType?: 'basic' | 'pro' | 'enterprise';
    planCode?: 'free' | 'pro' | 'enterprise';
    planName?: string;
    storeLimit?: number;
    usedStoreCount?: number;
    usagePercent?: number;
    serviceExpireDate?: string | null;
    isExpiringSoon?: boolean;
    isExpired?: boolean;
    isLifetimeGrant?: boolean;
    features?: {
      canExportNationalExcel: boolean;
      canUseRebalanceEngine: boolean;
      canAccessAuditProof: boolean;
    };
    reason?: string;
  }>;
}
