// 拼装 cloud.openapi.subscribeMessage.send 的入参。纯逻辑，不依赖
// wx-server-sdk，便于单测。
//
// ⚠️ data 里的字段 key（thing1/thing2/character_string3/date4）是占位名称，
// 必须替换成你在「微信公众平台 -> 订阅消息 -> 我的模板」里申请的真实"发货
// 提醒"类模板对应的真实字段 key——不同模板的字段名/字段数/字段类型完全不同，
// 这里没有办法替你猜出真实值，接入真实模板前务必对照控制台里选定模板的
// 详情页逐一核对替换（连带 index.js 里 SHIPPING_NOTICE_TEMPLATE_ID 环境变量
// 要填的模板 ID 一起）。
'use strict';

// 微信订阅消息 thing 类型字段硬限制 20 个 UTF-8 字符，character_string 类型
// 硬限制 32 个字符——这里做的是防御性截断，不是"聪明地摘要"，超长内容会被
// 直接截断加省略号，业务方应该保证传入的商品名/快递公司名本来就在合理长度内
const THING_MAX_LEN = 20;
const CHAR_STRING_MAX_LEN = 32;

function truncateThing(text) {
  const str = String(text || '').trim();
  if (!str) return '-'; // thing 类型不允许空字符串，用占位符兜底
  return str.length > THING_MAX_LEN ? `${str.slice(0, THING_MAX_LEN - 1)}…` : str;
}

function truncateCharString(text) {
  const str = String(text || '').trim();
  if (!str) return '-';
  return str.length > CHAR_STRING_MAX_LEN ? str.slice(0, CHAR_STRING_MAX_LEN) : str;
}

/**
 * @param {Object} params
 * @param {string} params.buyerOpenId  接收通知的买家 openid（touser）
 * @param {string} params.templateId   订阅消息模板 ID
 * @param {string} [params.productName]
 * @param {string} [params.expressCompany]
 * @param {string} [params.trackingNumber]
 * @param {string} [params.shippedAtStr]  'YYYY-MM-DD'
 * @param {string} [params.page]  点击通知后打开的小程序页面路径，选填
 * @returns {Object|null} buyerOpenId/templateId 任一缺失时返回 null——
 *   调用方据此判断"这次不发"，不是校验失败，是明确的"条件不满足，跳过"
 */
function buildShippingNoticePayload({ buyerOpenId, templateId, productName, expressCompany, trackingNumber, shippedAtStr, page }) {
  if (!buyerOpenId || !templateId) return null;

  const payload = {
    touser: buyerOpenId,
    templateId,
    data: {
      thing1: { value: truncateThing(productName) },
      thing2: { value: truncateThing(expressCompany) },
      character_string3: { value: truncateCharString(trackingNumber) },
      date4: { value: shippedAtStr || '' }
    },
    miniprogramState: 'formal'
  };
  if (page) payload.page = page;
  return payload;
}

module.exports = { buildShippingNoticePayload, truncateThing, truncateCharString, THING_MAX_LEN, CHAR_STRING_MAX_LEN };
