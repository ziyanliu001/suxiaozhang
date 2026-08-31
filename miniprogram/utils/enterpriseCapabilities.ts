// 🏛️（2026-08-31 Open-Core 架构拆分）Enterprise 能力判定 SPI 前端落地层。
//
// 背景：Core（拟开源，单店透明记账/义工打卡/存证校验）与 Enterprise（商业
// 私有闭环，全国大屏聚合/跨店调拨/合并导出/SaaS 订阅门禁）之间，此前的
// "能不能用某个商业高级能力"判断是散落在页面代码里的裸字段访问——比如
// `quota.features.canExportNationalExcel` 直接读云函数返回体的嵌套字段。
// 这带来两个问题：① Core 页面代码里混进了"我知道 Enterprise 返回体长什么样"
// 的隐性耦合，一旦 Core 独立部署（Enterprise 云函数整体缺席），这些裸访问
// 全部要在调用点各自补 `quota && quota.features && ...` 空值判断；② 商业
// 能力矩阵改名/新增字段时，要在页面代码里到处找散落的字符串字面量改。
//
// 本文件就是把这层判断收口成命名函数——Core 调用方只需要问
// "canExportNationalExcel(quota)"，不需要关心 Enterprise 返回体的具体形状，
// 也不需要在每个调用点各自处理 quota 缺失的情况（本文件统一在这里兜底为
// false，即"未知/不可用"的安全默认值，与本项目一贯的"宁可保守拒绝也不误放行"
// 惯例一致）。
//
// 🛡️ 与云函数侧的关系：getNationalDashboard/checkTenantPermission/
// exportAccountExcel 三个云函数各自独立计算并返回同一份 features 语义
// （canExportNationalExcel/canUseRebalanceEngine/canAccessAuditProof）——
// 云函数之间没有共享模块机制，无法把这层判断也收口到一处，这是本仓库的
// 既有架构约束（见 CLAUDE.md）。本文件只解决前端消费侧的耦合问题，不能
// 消除云函数侧的重复实现，这一点在 SPI 契约文档（docs/OPEN_CORE_ARCHITECTURE.md）
// 里有更完整的说明。

export interface SubscriptionQuotaFeatures {
  canExportNationalExcel: boolean;
  canUseRebalanceEngine: boolean;
  canAccessAuditProof: boolean;
}

// 🌟 结构宽松：故意不要求调用方传入完整的 subscriptionQuota 形状，Core 独立
// 部署、或云调用尚未返回结果时，quota 本身可能是 undefined/null，或 features
// 字段缺失/为部分对象——所有判定函数都要在这些情况下安全返回 false，而不是
// 抛出 "Cannot read property 'xxx' of undefined"
export interface SubscriptionQuotaLike {
  features?: Partial<SubscriptionQuotaFeatures> | null;
}

function readFeature(
  quota: SubscriptionQuotaLike | null | undefined,
  key: keyof SubscriptionQuotaFeatures
): boolean {
  return !!(quota && quota.features && quota.features[key]);
}

// 机构多店合并阳光台账一键导出——见 exportAccountExcel isNationalExport 的
// 服务端强鉴权，本函数只做前端体验层的同口径判断
export function canExportNationalExcel(quota: SubscriptionQuotaLike | null | undefined): boolean {
  return readFeature(quota, 'canExportNationalExcel');
}

// 跨店智能调拨引擎——见 getNationalDashboard rebalanceSuggestions 的服务端
// 强鉴权（免费版直接跳过撮合计算，不下发数据）
export function canUseRebalanceEngine(quota: SubscriptionQuotaLike | null | undefined): boolean {
  return readFeature(quota, 'canUseRebalanceEngine');
}

// 防篡改存证验真徽章——见 getNationalDashboard auditProofSummary 的服务端
// 锁定占位（免费版返回 locked:true，不下发真实覆盖率）
export function canAccessAuditProof(quota: SubscriptionQuotaLike | null | undefined): boolean {
  return readFeature(quota, 'canAccessAuditProof');
}

// 供页面一次性算好三项能力，直接铺进 setData 的展示数据里（WXML 只能绑定
// 数据字段、不能调用任意 TS 函数），避免 WXML 里出现
// `{{nationalData.subscriptionQuota.features.xxx}}` 这种依赖云函数返回体
// 具体嵌套形状的裸路径表达式
export function resolveEnterpriseCapabilities(
  quota: SubscriptionQuotaLike | null | undefined
): SubscriptionQuotaFeatures {
  return {
    canExportNationalExcel: canExportNationalExcel(quota),
    canUseRebalanceEngine: canUseRebalanceEngine(quota),
    canAccessAuditProof: canAccessAuditProof(quota)
  };
}
