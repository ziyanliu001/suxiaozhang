// 🏛️ Open-Core 架构拆分 · 终局阶段：pages/profile 的 Enterprise 扩展包
// 统一汇合点——见 pages/statistics/enterprise/index.ts 头部注释，同一套设计：
// profile.ts 只从这一个文件 import，scripts/build-open-core.js 打包 Core 包时
// 用一份 core-overrides/profile.enterprise.index.ts stub 整份覆盖本文件，
// saasSubscriptionHandler.ts 真实实现文件直接物理删除。
export {
  saasSubscriptionHandlers,
  PLAN_LABELS,
  PLAN_RANK,
  PLAN_ACTION_META,
  isPerpetualPlan,
  formatTenantExpireText,
  computeIOSPlanActionLabels,
  computeRedundantRenewFlag
} from './saasSubscriptionHandler';
