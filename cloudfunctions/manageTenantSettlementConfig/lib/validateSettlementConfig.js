// 纯校验逻辑，不依赖 wx-server-sdk，便于单元测试（与 manageProduct 的
// validateProduct.js / wxPayCore 的 refundValidation.js 同一个拆分理由）。
'use strict';

// 🛡️ 全仓库唯一权威取值域：createProductionSpace 建空间时写死默认值 'none'，
// completeProductionOrder/markSettlementsSettled 分别用 === / !== 'direct_wechat'
// 做分账/结算分流判断——历史上从未出现过第三个字面量取值（手册里提到的
// "agent_settlement" 只是这两个函数在没有 direct_wechat 时那条分支的描述性
// 说法，代码里从未真的写过这个字符串），本函数按代码里实际存在的两个值校验，
// 不臆造第三个从未被任何函数读过/写过的枚举
const VALID_PAYMENT_MODES = ['none', 'direct_wechat'];

/**
 * 校验「支付模式 + 分账费率」配置表单的提交内容。
 *
 * producerRate/promoterRate 是 0~1 的小数（比例，不是百分数、也不是分），
 * 与 createProductionOrder.js 的 resolveSettlementRates() 读取 tenants
 * .settlementConfig 时的语义完全一致；两者之和不能超过 1——剩余部分就是
 * liveFactoryCore/lib/settlement.js 里 platformFee 的份额，必须留一个
 * 非负的余量，否则会出现"制作方+推广员分走的钱比订单实付金额还多"这种
 * 结算恒等式被破坏的情况。
 *
 * promoterRate 允许为 0（该商品/该机构从不走推广员分成的场景，如全部走
 * 私域自然流量，没有分享者），但不允许是负数或超过 1 的荒谬值。
 */
function validateSettlementConfigInput({ paymentMode, producerRate, promoterRate }) {
  if (!VALID_PAYMENT_MODES.includes(paymentMode)) {
    return { valid: false, error: `paymentMode 必须是 ${VALID_PAYMENT_MODES.join('/')} 之一` };
  }
  if (!Number.isFinite(producerRate) || producerRate < 0 || producerRate > 1) {
    return { valid: false, error: 'producerRate 必须是 0~1 之间的数字' };
  }
  if (!Number.isFinite(promoterRate) || promoterRate < 0 || promoterRate > 1) {
    return { valid: false, error: 'promoterRate 必须是 0~1 之间的数字' };
  }
  if (producerRate + promoterRate > 1) {
    return { valid: false, error: 'producerRate + promoterRate 之和不能超过 1（剩余部分是平台费率）' };
  }
  return { valid: true, error: '' };
}

module.exports = { validateSettlementConfigInput, VALID_PAYMENT_MODES };
