// 🏛️（2026-08-31 Open-Core 第三阶段构建产物）scripts/build-open-core.js
// 打包 suxiaozhang-core 时，用本文件整体覆盖
// miniprogram/pages/profile/enterprise/index.ts，同时物理删除
// saasSubscriptionHandler.ts 真实实现文件——SaaS 订阅购买、配额进度条、
// 激活码兑换、在线支付下单等均是 Enterprise 专有的商业闭环，不随 Core
// 包分发。
//
// 导出结构必须与原文件完全一致，保证 profile.ts 里
// `import { saasSubscriptionHandlers } from './enterprise'` 这行代码本身
// 在 Core 包里也不需要改动、原样可编译。
//
// 🛡️ 与 pages/statistics 的 Core stub 同一套设计取舍：所有方法实现为安全
// 空操作，而不是彻底不导出——onOpenSubscriptionModal 本身已有
// `if (!ENTERPRISE_BUILD_ENABLED) return;` 早退（Core 构建下这个常量恒为
// false），profile.ts 里 onShow 生命周期与三处 WXML 按钮的调用点原样保留，
// 必须能找到这个方法本身，只是调用后什么都不做。isPerpetualPlan/
// formatTenantExpireText/PLAN_LABELS 等常量与纯函数则保留最基本的安全
// 返回值，避免任何遗漏调用点因"undefined 不是函数/对象没有这个属性"而
// 抛出运行时异常。
export const PLAN_LABELS: Record<string, string> = { basic: '基础版' };
export const PLAN_RANK: Record<string, number> = { basic: 0 };
export const PLAN_ACTION_META: Record<'pro' | 'enterprise', { icon: string; name: string; price: string }> = {
  pro: { icon: '', name: '', price: '' },
  enterprise: { icon: '', name: '', price: '' }
};

export function isPerpetualPlan(): boolean {
  return true;
}

export function formatTenantExpireText(): string {
  return '永久有效';
}

export function computeIOSPlanActionLabels(): Record<'pro' | 'enterprise', string> {
  return { pro: '', enterprise: '' };
}

export function computeRedundantRenewFlag(): boolean {
  return false;
}

export const saasSubscriptionHandlers = {
  async fetchSubscriptionInfo() {},
  computePlanActionLabels() { return { pro: '', enterprise: '' }; },
  // 🛡️ 唯一汇合点：Core 构建下调用即返回，不发起任何鉴权云调用/不展示弹窗
  async onOpenSubscriptionModal() {},
  onOpenProSubscriptionModal() {},
  onCloseSubscriptionModal() {},
  onToggleRedeemSection() {},
  onActivationCodeInput() {},
  onPasteActivationCode() {},
  async onRedeemActivationCode() {},
  onSwitchComparePlanTab() {},
  onIncreaseAddOnQuantity() {},
  onDecreaseAddOnQuantity() {},
  onPrimaryPlanAction() {},
  onClosePaymentPendingModal() {},
  onCopyPlatformSupportWechat() {},
  onGuideToRedeemSection() {},
  async onSubscribeAdvancedFeature() {}
};
