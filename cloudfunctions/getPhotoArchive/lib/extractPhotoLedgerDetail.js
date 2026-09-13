'use strict';

// 🖼️（2026-09-13 图单联动）纯逻辑：把已经查到的 report_logs/daily_menus/
// activity_logs 原始文档，提取/格式化成图册"长按详情"弹窗要展示的图单联动
// 字段。不做 db I/O、不依赖 wx-server-sdk，配套单测同目录
// extractPhotoLedgerDetail.test.js。index.js 的 'detail' action 只负责按
// type 查出对应文档（含 log 类型额外反查同店同日的 report_logs），真正的
// 字段提取/兜底规则全部收在这里，便于独立单测。

/**
 * 报销凭证：优先在 fixedExpenseItems（大额专项逐条独立凭证，见
 * pages/index/index.ts 的 independent_image_urls）里找出这张图片具体挂在
 * 哪一条项目上，命中则展示该条目的真实名称+金额——这是"笔笔可溯"的精确
 * 情形。找不到（图片来自 receiptImages 通用小票池，没有绑定到任何单一
 * 专项条目）时不编造一个假条目名，兜底展示"当日综合支出"+ report_logs
 * 的 expenseAmount（当日支出总额）。
 *
 * @param {object} reportLog report_logs 文档（至少含 dateString/expenseAmount/
 *   fixedExpenseItems/_openid）
 * @param {string} photoUrl 本次查看的这张图片的 url，用于匹配
 *   fixedExpenseItems[].independent_image_urls
 * @param {string} [submitterRealName] 调用方按 reportLog._openid 反查
 *   user_roles 得到的姓名，查不到时传空字符串/undefined
 * @returns {object} { categoryLabel, amount, submitterName, dateString }
 */
function extractReceiptLedgerDetail(reportLog, photoUrl, submitterRealName) {
  const doc = reportLog || {};
  const items = Array.isArray(doc.fixedExpenseItems) ? doc.fixedExpenseItems : [];
  const matched = photoUrl
    ? items.find((item) => item && Array.isArray(item.independent_image_urls) && item.independent_image_urls.includes(photoUrl))
    : null;

  const categoryLabel = matched && matched.name ? matched.name : '当日综合支出';
  const amount = matched && matched.amount != null ? matched.amount : (doc.expenseAmount || 0);

  return {
    categoryLabel,
    amount,
    submitterName: submitterRealName || '义工',
    dateString: doc.dateString || ''
  };
}

/**
 * 每日食谱：daily_menus.menuText 已经是人类可读的菜品描述自由文本（含
 * "四菜一汤"信息），不需要额外解析出结构化菜名数组——直接透传即可。
 */
function extractMenuLedgerDetail(dailyMenu) {
  const doc = dailyMenu || {};
  return {
    menuText: doc.menuText || '（未填写菜品说明）'
  };
}

/**
 * 温馨瞬间：activity_logs 本身不含就餐/义工人次字段，这些数字实际记在
 * 当天同门店的 report_logs 里。totalDineCount/totalVolunteers 是"细分统计"
 * 补录后的准确合计，diningCount/volunteerCount 是没有细分时的原始汇总
 * 字段——优先取前者，前者为空/0 时才回退后者，与 history.wxml 卡片头部
 * 标签（`item.hasDiningBreakdown`）同一套优先级约定。
 *
 * @param {object|null} sameDayReportLog 按 {tenantId, storeId,
 *   dateString: activityLog.eventTime} 反查到的当天报告，查不到时传 null
 */
function extractActivityLedgerDetail(sameDayReportLog) {
  const doc = sameDayReportLog || {};
  const diningCount = doc.totalDineCount || doc.diningCount || 0;
  const volunteerCount = doc.totalVolunteers || doc.volunteerCount || 0;
  return {
    diningCount,
    volunteerCount,
    // 当天确实没有对应报告时如实标注，前端据此展示"暂无当日台账数据"而
    // 不是误导性的 0
    hasSameDayReport: !!sameDayReportLog
  };
}

module.exports = {
  extractReceiptLedgerDetail,
  extractMenuLedgerDetail,
  extractActivityLedgerDetail
};
