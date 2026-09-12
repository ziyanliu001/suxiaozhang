'use strict';

// 纯逻辑：《功德芳名状 · 祈福长卷》海报正文一行的拼接规则，从
// utils/posterGenerator.ts drawMeritCertificatePoster 抽出——Canvas 绘制
// 本身依赖小程序运行时（wx.createSelectorQuery/canvas 节点），无法用
// node --test 直接跑，但"这一行到底该拼成什么文案"是纯字符串逻辑，值得
// 独立出来测试，避免金额/物资两个分支的边界情况（金额为 0、事项标签为空、
// 物资描述为空）只能靠人工截图核对。
//
// 🛡️ 合规口径：模板文案固定用"乐捐"，不用 CLAUDE.md 第7.2节明确禁用的
// "随喜"（无论新旧功能）——见 posterGenerator.ts MeritCertificatePosterData
// 接口注释的完整说明。eventTag/itemDescription 是调用方透传的真实记录
// 原文，不在本函数的改写范围内。
function formatMeritCertificateDetailText(data) {
  const eventTag = (data && data.eventTag) ? String(data.eventTag).trim() : '';
  const amount = (data && typeof data.amount === 'number') ? data.amount : 0;
  const itemDescription = (data && data.itemDescription) ? String(data.itemDescription).trim() : '';
  const tagPrefix = eventTag ? `${eventTag} ` : '';

  if (amount > 0) {
    return `乐捐 ${tagPrefix}¥${amount}`;
  }
  return `乐捐 ${tagPrefix}${itemDescription}`;
}

module.exports = { formatMeritCertificateDetailText };
