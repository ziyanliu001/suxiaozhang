// 拼装 cloud.openapi.subscribeMessage.send 的入参。纯逻辑，不依赖
// wx-server-sdk，便于单测。结构与 completeProductionOrder/lib/
// buildSubscribeMessagePayload.js 的发货提醒模板 1:1 对照。
//
// ⚠️ data 里的字段 key（thing1/thing2/date3）是占位名称，必须替换成你在
// 「微信公众平台 -> 订阅消息 -> 我的模板」里申请的真实"长者多日未打卡关怀
// 提醒"类模板对应的真实字段 key——不同模板的字段名/字段数/字段类型完全不同，
// 这里没有办法替你猜出真实值，接入真实模板前务必对照控制台里选定模板的
// 详情页逐一核对替换（连带 index.js 里 ELDER_HEARTBEAT_TEMPLATE_ID 环境变量
// 要填的模板 ID 一起）。
'use strict';

const THING_MAX_LEN = 20;

function truncateThing(text) {
  const str = String(text || '').trim();
  if (!str) return '-'; // thing 类型不允许空字符串，用占位符兜底
  return str.length > THING_MAX_LEN ? `${str.slice(0, THING_MAX_LEN - 1)}…` : str;
}

/**
 * @param {Object} params
 * @param {string} params.guardianOpenId  接收通知的家属 openid（touser）
 * @param {string} params.templateId      订阅消息模板 ID
 * @param {string} [params.elderName]
 * @param {string} [params.storeName]
 * @param {string} [params.lastActiveDateStr]  'YYYY-MM-DD'，从未有过记录时传空串
 * @param {string} [params.page]  点击通知后打开的小程序页面路径，选填
 * @returns {Object|null} guardianOpenId/templateId 任一缺失时返回 null——
 *   调用方据此判断"这次不发"，不是校验失败，是明确的"条件不满足，跳过"
 */
function buildHeartbeatNoticePayload({ guardianOpenId, templateId, elderName, storeName, lastActiveDateStr, page }) {
  if (!guardianOpenId || !templateId) return null;

  const payload = {
    touser: guardianOpenId,
    templateId,
    data: {
      thing1: { value: truncateThing(elderName) },
      thing2: { value: truncateThing(storeName) },
      date3: { value: lastActiveDateStr || '暂无记录' }
    },
    miniprogramState: 'formal'
  };
  if (page) payload.page = page;
  return payload;
}

module.exports = { buildHeartbeatNoticePayload, truncateThing, THING_MAX_LEN };
