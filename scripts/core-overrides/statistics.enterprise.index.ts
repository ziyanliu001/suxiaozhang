// 🏛️（2026-08-31 Open-Core 第三阶段构建产物）scripts/build-open-core.js
// 打包 suxiaozhang-core 时，用本文件整体覆盖
// miniprogram/pages/statistics/enterprise/index.ts，同时物理删除
// nationalDashboardService.ts/drillDownHandler.ts/procurementHandler.ts
// 三个真实实现文件——它们承载的是跨机构/跨门店聚合、SaaS 配额、集采撮合
// 等 Enterprise 专有逻辑，不随 Core 包分发。
//
// 导出结构必须与原文件完全一致（三个同名对象），保证 statistics.ts 里
// `import { nationalDashboardHandlers, drillDownHandlers, procurementHandlers }
// from './enterprise'` 这行代码本身在 Core 包里也不需要改动、原样可编译。
//
// 每个方法都实现为安全的空操作/极简兜底，而不是彻底不导出——排查确认
// statistics.ts 里仍有少量 Core 生命周期/流程代码会调用到
// loadNationalDashboard()/ensureStoreDirectory()/onOpenPlanUpgradeModal()
// 这三个方法（如 applyRolePermissions 里"超管默认展示全国视图"分支、
// loadShopList 构建门店选择器、exportToExcel 单店导出的订阅拦截兜底），
// 这些调用点在 Core 部署下依然会被执行到——不能让它们因为找不到方法而报
// "xxx is not a function"，哪怕 Core 用户永远不会真正看到全国大屏本身。
export const nationalDashboardHandlers = {
  animateCareCountUp() {},
  buildNationalExportDateRange() { return { startDate: '', endDate: '' }; },
  buildNationalFinanceAuditCSV() { return ''; },
  buildNationalOperationsCSV() { return ''; },
  buildSelectedNationalReportCSV() { return null; },
  deriveSupportNeededStores() { return []; },
  // 🛡️ Core 构建下没有 getStoreList 之外任何"全国门店目录"概念，statistics.ts
  // 的 loadShopList() 会 await 本方法的返回值来决定是否继续——返回 true 且
  // 不写入 storeDirectory，让调用方后续的地区筛选/自定义门店对比入口
  // （本就只在全国大屏 Enterprise 场景下出现）静默拿到空列表，不阻断单店门店
  // 选择器的正常构建流程
  async ensureStoreDirectory() { return true; },
  fallbackCopyToClipboard() {},
  formatNationalMatrixData() { return []; },
  formatSuperAdminInsights() { return null; },
  // 🛡️ Core 部署没有 getNationalDashboard 云函数，调用即挂起——直接空操作，
  // 由守卫条件（canViewNationalDashboard/isAllStoresMode）保证的"全国视图"
  // 在 Core 下永远不会真正展示任何数据，属于预期内的优雅降级
  async loadNationalDashboard() {},
  noop() {},
  onCallStoreManager() {},
  onCancelCustomStores() {},
  onCancelRegionFilter() {},
  onChangeNationalFilter() {},
  onCloseNationalExcelExportModal() {},
  onCloseNationalReportModal() {},
  onClosePlanUpgradeModal() {},
  onCloseSaasBenefitsModal() {},
  onConfirmCustomStores() {},
  async onConfirmNationalExcelExport() {},
  onConfirmRegionFilter() {},
  onConsultUpgrade() {},
  onCopyCareMessage() {},
  onCopyNationalReport() {},
  onCopyRebalanceSuggestion() {},
  onCustomStoreSearchInput() {},
  onExportNationalReport() {},
  onGenerateNationalPoster() {},
  onGoToNationalDashboard() {},
  onNationalPhotoError() {},
  onOpenNationalExcelExportModal() {},
  onOpenNationalReportModal() {},
  // 🛡️ Core 构建下没有订阅套餐概念，这个"付费墙拦截弹窗"永远不应该真正
  // 弹出——exportToExcel 等 Core 调用点在 checkTenantPermission 云函数缺失、
  // 走 FALLBACK_ALLOWED 保守放行的前提下本就不会触发这条分支，这里留空只是
  // 双重保险
  onOpenPlanUpgradeModal() {},
  onPatriarchGoNational() {},
  onPreviewNationalPhoto() {},
  onSelectAllByProvince() {},
  onSelectCityOption() {},
  onSelectProvinceOption() {},
  onShowSubscriptionQuotaDetail() {},
  onSwitchMatrixFilter() {},
  onSwitchNationalRange() {},
  onSwitchRankingTab() {},
  onToggleCityDropdown() {},
  onToggleCustomStoreDraft() {},
  onToggleProvinceDropdown() {},
  onToggleReportSelection() {},
  async openCustomStoreModal() {},
  async openRegionFilterModal() {},
  saveNationalSnapshot() {},
  async _triggerPatriarchNationalView() {},
  tryRenderNationalSnapshot() { return false; }
};

export const drillDownHandlers = {
  onDrillDownStore() {},
  onReturnToNationalDashboard() {}
};

export const procurementHandlers = {
  onOpenProcurementModal() {},
  onCloseProcurementModal() {},
  onRegisterProcurementIntent() {}
};
