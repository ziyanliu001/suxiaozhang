// 物流信息校验：快递公司白名单 + 快递单号格式。纯逻辑，不依赖 wx-server-sdk。
'use strict';

const EXPRESS_COMPANIES = ['顺丰', '中通', '圆通', '韵达', '极兔', '邮政', '其他'];

// 快递单号在不同承运商之间格式差异很大（纯数字/字母数字混合/带短横线），
// 不追求精确校验某个承运商的真实编码规则（那需要为每家公司单独维护正则，
// 收益有限），只做一个宽松的"看起来像单号"的合理性检查：6-30 位字母/数字/
// 短横线，卡掉明显不是单号的输入（空字符串、纯符号、超长粘贴内容等）
const TRACKING_NUMBER_PATTERN = /^[A-Za-z0-9-]{6,30}$/;

/**
 * expressCompany/trackingNumber 必须同时提供或同时不提供——只填一个是半成品
 * 数据，比"两个都不填"更容易误导后续查看的人以为物流信息完整。
 * @returns {{valid: true, provided: boolean, expressCompany: string, trackingNumber: string} | {valid: false, error: string}}
 */
function validateShipment({ expressCompany, trackingNumber }) {
  const hasCompany = !!expressCompany;
  const hasTracking = !!trackingNumber;

  if (!hasCompany && !hasTracking) {
    return { valid: true, provided: false, expressCompany: '', trackingNumber: '' };
  }
  if (hasCompany !== hasTracking) {
    return { valid: false, error: '快递公司与快递单号必须同时填写' };
  }
  if (!EXPRESS_COMPANIES.includes(expressCompany)) {
    return { valid: false, error: '不支持的快递公司' };
  }

  const trimmed = String(trackingNumber).trim();
  if (!TRACKING_NUMBER_PATTERN.test(trimmed)) {
    return { valid: false, error: '快递单号格式不正确，应为 6-30 位字母/数字/短横线' };
  }

  return { valid: true, provided: true, expressCompany, trackingNumber: trimmed };
}

module.exports = { validateShipment, EXPRESS_COMPANIES, TRACKING_NUMBER_PATTERN };
