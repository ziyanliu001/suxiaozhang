'use strict';

// 📸（2026-09-11 适老化改造·双轨互补）「手写/转账识别」（ocrExpenseReceipt 默认
// action，宽松金额提取）与「超市小票识票」（action:'parseReceipt'，结构化多商品
// 解析）是刻意维护的两条独立解析引擎，各自面向不同票据形态（见 cloudfunctions/
// ocrExpenseReceipt/index.js 两个分支各自头部注释）。长辈按生活场景选按钮时不
// 一定选对——手写转账凭证误点了"超市小票识票"，或超市小票误点了"手写/转账
// 识别"，任一引擎在自己不擅长的票据上返回空/报错都很常见。这里只负责"怎么
// 判断一次调用结果算不算空"与"两种结果形状怎么互相转换"，不做任何新的 OCR/
// 金额提取逻辑——真正的兜底重试仍然是调用方（index.ts）用同一个已上传的
// fileID 再调一次云函数的另一个 action，不重新拍照/不重新上传。

// 默认 action：`success:false` 就是唯一的"识别失败"信号（见 index.js 默认分支，
// 找不到有效金额时明确返回 success:false，不会伪造数据）
function isDefaultOcrResultEmpty(result) {
  return !result || !result.success;
}

// action:'parseReceipt'：解析异常才会 success:false，识别不出任何东西时
// （lines 为空/一个金额一个商品都没认出来）仍然 success:true、只是
// items 为空数组、totalAmount 为 null——必须两者都判空才算真正"什么都没识别到"
function isParseReceiptResultEmpty(result) {
  if (!result || !result.success) return true;
  const hasItems = Array.isArray(result.items) && result.items.length > 0;
  const hasTotal = result.totalAmount !== null && result.totalAmount !== undefined;
  return !hasItems && !hasTotal;
}

// action:'parseReceipt' 的结构化 draft → 「手写/转账识别」批量结果列表期望的
// 旧字段形状（amount/totalAmount/itemList/formattedText/merchant/isHighConfidence/
// raw_total_amount/shipping_fee/discount_amount，见 index.ts onScanReceiptPhoto
// 消费 results 数组处），供默认引擎判空后换引擎兜底成功时使用
function adaptParseReceiptDraftToLegacyResult(draft) {
  const items = Array.isArray(draft && draft.items) ? draft.items : [];
  const totalAmount = draft && typeof draft.totalAmount === 'number' ? draft.totalAmount : null;
  const totalStr = totalAmount !== null ? totalAmount.toFixed(2) : '';
  const formattedText = items.length > 0
    ? items.map((it) => `• ${(it && it.name) || ''}：¥${Number((it && it.amount) || 0).toFixed(2)}`).join('\n')
    : (totalStr ? `• 小票金额：¥${totalStr}` : '');
  return {
    success: true,
    itemList: items.map((it) => ({ name: (it && it.name) || '', price: Number((it && it.amount) || 0).toFixed(2) })),
    formattedText,
    totalAmount: totalStr,
    amount: totalStr,
    raw_total_amount: '',
    shipping_fee: '',
    discount_amount: (draft && draft.discountAmount) ? Number(draft.discountAmount).toFixed(2) : '',
    isHighConfidence: !(draft && draft.flagNeedsReview),
    merchant: (draft && draft.merchant) || ''
  };
}

// 默认 action 的旧字段结果 → action:'parseReceipt' 结构化 draft 期望的形状
// （merchant/reportDate/totalAmount/items/flagNeedsReview/reviewReasons，见
// lib/smartReceiptDraft.js 与 index.wxml 智能识票确认卡片消费处），供
// 「超市小票识票」判空后换引擎兜底成功时使用。兜底结果统一标记
// flagNeedsReview，提醒用户这是备用引擎凑出来的、务必人工核对
function adaptLegacyOcrResultToParseReceiptDraft(legacyResult) {
  const itemList = Array.isArray(legacyResult && legacyResult.itemList) ? legacyResult.itemList : [];
  const rawTotal = legacyResult && (legacyResult.amount || legacyResult.totalAmount);
  const totalAmount = rawTotal ? parseFloat(rawTotal) : null;
  return {
    merchant: (legacyResult && legacyResult.merchant) || '',
    reportDate: '',
    totalAmount: Number.isFinite(totalAmount) ? totalAmount : null,
    items: itemList.map((it) => ({
      name: (it && it.name) || '',
      amount: Number((it && it.price) || 0),
      categoryLabel: '其他'
    })),
    flagNeedsReview: true,
    reviewReasons: ['本次识别经备用引擎兜底补救，请人工核对明细与总金额'],
    discountAmount: 0
  };
}

module.exports = {
  isDefaultOcrResultEmpty,
  isParseReceiptResultEmpty,
  adaptParseReceiptDraftToLegacyResult,
  adaptLegacyOcrResultToParseReceiptDraft
};
