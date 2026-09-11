// 到店自提核销码：生成 + 校验。纯逻辑，不依赖 wx-server-sdk。
//
// 🛡️ 设计取舍：核销码是"店员当面核对买家口头/截图报出的码"这个场景的辅助
// 工具，不是支付密码级别的安全凭证——用 6 位数字（而不是更长的随机串）
// 换取买家口述/输入的便利性，与快递单号一样是"业务流程标识"而不是"访问
// 控制凭证"。真正的越权防线仍然是 completeProductionOrder/index.js 里
// verifyTenantAccess 的角色校验（只有 space_owner/space_admin/producer
// 才能提交核销），核销码本身只防"随手输错/其他订单的码"，不防"恶意穷举
// 6 位数字"这类攻击——不在同一门店的陌生人本就无法进入这段管理端流程。
'use strict';

const crypto = require('crypto');

const CODE_LENGTH = 6;

/**
 * 由 orderId 派生一个确定性的 6 位数字核销码——同一订单多次调用
 * （如买家重复打开订单详情页展示核销码）永远得到同一个码，不需要额外落库
 * 一个随机值再回读比对，也不会因为服务端重复生成而让买家手里的旧码失效。
 * @param {string} orderId
 * @returns {string} 固定 6 位数字（不足位补前导 0）
 */
function generatePickupCode(orderId) {
  const hash = crypto.createHash('md5').update(String(orderId || '')).digest('hex');
  // 取哈希前 8 位转成整数，对 10^6 取模得到 6 位数字空间内的确定性伪随机值
  const num = parseInt(hash.slice(0, 8), 16) % 1000000;
  return String(num).padStart(CODE_LENGTH, '0');
}

/**
 * 校验店员输入/扫描到的核销码是否与订单的核销码一致。做了去空白/统一成
 * 字符串比较，容忍买家口述报码时的前后空格。
 * @param {string} inputCode
 * @param {string} storedCode
 * @returns {boolean}
 */
function verifyPickupCode(inputCode, storedCode) {
  const a = String(inputCode || '').trim();
  const b = String(storedCode || '').trim();
  return !!a && !!b && a === b;
}

module.exports = { generatePickupCode, verifyPickupCode, CODE_LENGTH };
