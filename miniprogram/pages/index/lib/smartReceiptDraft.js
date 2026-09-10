'use strict';

// 📸（2026-09-10 发票/小票 OCR 智能记账·第一阶段前端接入）拆出「拍照智能识票」
// 确认卡片用到的纯格式化逻辑，与 store-profile/lib/qualificationPhotoActions.js
// 同一套既定写法——不依赖 wx.*/this.setData，便于 node:test 直接单测；index.ts
// 里的 onTapSmartReceiptScan/onApplySmartReceiptDraft 只负责 wx API 调用与
// setData，具体的"draft 该怎么格式化成展示值/怎么拼成待填入文本"全部委托给这里。
//
// 🛡️ 与 cloudfunctions/ocrExpenseReceipt/lib/parseReceiptPayload.js 的关系：
// 那边产出 draft（{merchant, reportDate, totalAmount, items, flagNeedsReview,
// reviewReasons, ...}），这里只消费这个 draft 做前端展示/文本拼装，不重新
// 做任何金额提取/分类判断——避免前后端各自维护一套业务规则、口径漂移。

function toAmountDisplay(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(2) : '0.00';
}

/**
 * 将 draft.items 转成 WXML 可直接渲染的展示数组（WXML 里不能调 toFixed）。
 * @param {Array<{name?:string, categoryLabel?:string, amount?:number}>} items
 * @returns {Array<{name:string, categoryLabel:string, amountDisplay:string}>}
 */
function buildSmartReceiptDisplayItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((it) => ({
    name: (it && it.name) || '',
    categoryLabel: (it && it.categoryLabel) || '其他',
    amountDisplay: toAmountDisplay(it && it.amount)
  }));
}

/**
 * 总金额展示值：null/undefined（彻底未识别）时返回空字符串，交给 WXML 显示
 * "未识别"，而不是伪造一个 ¥0.00 误导用户以为真的识别到了零元。
 * @param {number|null|undefined} totalAmount
 * @returns {string}
 */
function formatSmartReceiptTotalDisplay(totalAmount) {
  if (totalAmount === null || totalAmount === undefined) return '';
  const num = Number(totalAmount);
  return Number.isFinite(num) ? num.toFixed(2) : '';
}

// 与既有 _applyOcrCategory（index.ts）的拼接格式逐字一致：「• 品名：¥金额」
// 明细行 + 「实付合计：¥总额」锚点行。calculateTodayExpenseFromText 靠
// ANCHOR_REGEX 识别"实付合计"关键词，锚点值整体覆盖前面逐条累加的商品行，
// 不会重复计入——这是本仓库已经验证过的既定约定，这里原样复用，不新发明
// 一套格式。
//
// 🛡️ 刻意不拼商户名称/日期：parseExpenseTextToItems 的兜底分支会把"没有
// 匹配到任何 品名+数字 pattern"的整行按 fallbackAmount（当天支出总额）
// 单独计成一条虚假明细，商户名称行通常不含数字，写进去会在提交时污染
// dailyIngredientItems[] 明细数组。商户/日期只用于确认卡片只读展示。
function buildSmartReceiptApplyText(draft) {
  if (!draft) return '';
  const items = Array.isArray(draft.items) ? draft.items : [];
  const lines = items
    .filter((it) => it && it.name)
    .map((it) => `• ${it.name}：¥${toAmountDisplay(it.amount)}`);

  const totalStr = toAmountDisplay(draft.totalAmount);
  lines.push(`实付合计：¥${totalStr}`);

  return lines.join('\n');
}

module.exports = {
  buildSmartReceiptDisplayItems,
  formatSmartReceiptTotalDisplay,
  buildSmartReceiptApplyText
};
