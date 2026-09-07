// 拼装 cloud.openapi.subscribeMessage.send 的入参——"待人工确认结算"提醒。
// 纯逻辑，不依赖 wx-server-sdk，便于单测。
//
// ⚠️ data 里的字段 key（thing1/number2/amount3/thing4）是占位名称，必须替换
// 成你在「微信公众平台 -> 订阅消息 -> 我的模板」里申请的真实"待办提醒"类
// 模板对应的真实字段 key——不同模板的字段名/字段数/字段类型完全不同，这里
// 没有办法替你猜出真实值，接入真实模板前务必对照控制台里选定模板的详情页
// 逐一核对替换（连带 index.js 里 SETTLEMENT_REMINDER_TEMPLATE_ID 环境变量要
// 填的模板 ID 一起）。同一套写法参考 completeProductionOrder/lib/
// buildSubscribeMessagePayload.js 的发货提醒，字段截断策略保持一致。
'use strict';

const THING_MAX_LEN = 20;

function truncateThing(text) {
  const str = String(text || '').trim();
  if (!str) return '-'; // thing 类型不允许空字符串，用占位符兜底
  return str.length > THING_MAX_LEN ? `${str.slice(0, THING_MAX_LEN - 1)}…` : str;
}

/**
 * @param {Object} params
 * @param {string} params.ownerOpenId   接收提醒的空间负责人 openid（touser）
 * @param {string} params.templateId    订阅消息模板 ID
 * @param {string} [params.tenantName]  工坊/空间名称
 * @param {number} params.pendingCount  待人工确认的订单笔数
 * @param {string} [params.pendingAmountYuan]  待确认总金额（元，字符串，如 "128.50"）
 * @param {string} [params.page]  点击通知后打开的小程序页面路径，选填
 * @returns {Object|null} ownerOpenId/templateId 缺失或 pendingCount<=0 时返回
 *   null——调用方据此判断"这次不发"，不是校验失败，是明确的"条件不满足，跳过"
 */
function buildSettlementReminderPayload({ ownerOpenId, templateId, tenantName, pendingCount, pendingAmountYuan, page }) {
  if (!ownerOpenId || !templateId) return null;
  const count = Number(pendingCount) || 0;
  if (count <= 0) return null;

  const payload = {
    touser: ownerOpenId,
    templateId,
    data: {
      thing1: { value: truncateThing(tenantName || '您的工坊') },
      number2: { value: String(count) },
      amount3: { value: pendingAmountYuan || '0.00' },
      thing4: { value: truncateThing('发货满24小时未确认分账，请及时核对') }
    },
    miniprogramState: 'formal'
  };
  if (page) payload.page = page;
  return payload;
}

module.exports = { buildSettlementReminderPayload, truncateThing, THING_MAX_LEN };
