// 纯校验逻辑，不依赖 wx-server-sdk，便于单元测试（与 manageProduct 的
// validateProduct.js / manageTenantSettlementConfig 的
// validateSettlementConfig.js 同一个拆分理由）。
'use strict';

const REDEEM_NOTE_MAX_LEN = 200;

/**
 * 校验工坊侧发起「转捐」时提交的字段。amount 单位是分（与 order_settlements
 * 里 producerAmount 同一单位），只能从一笔已经 settled、非红冲的分账记录里
 * 转出，且金额不能超过该笔记录的 producerAmount——制作方分成才是工坊主
 * 自己能支配的那份钱，推广员分成/platformFee 不在可转捐范围内，不能拿
 * 别人的分成去做"善事"。
 *
 * settlement 参数是调用方已经从数据库查出来的 order_settlements 文档
 * （不在本函数内查库，保持纯函数、可单测）。
 */
function validatePledgeInput({ amount, settlement }) {
  if (!settlement) {
    return { valid: false, error: '分账记录不存在' };
  }
  if (settlement.isReversal) {
    return { valid: false, error: '红冲记录不能转捐' };
  }
  if (settlement.settlementStatus !== 'settled') {
    return { valid: false, error: '只有已结算的订单才能转捐（待结算/已撤销状态均不可转捐）' };
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return { valid: false, error: '转捐金额必须是正整数（分）' };
  }
  if (amount > settlement.producerAmount) {
    return { valid: false, error: '转捐金额不能超过该笔订单制作方分成金额' };
  }
  return { valid: true, error: '' };
}

/**
 * 校验公益侧核销领用时提交的备注字段——核销动作本身的权限校验（是否是
 * 目标门店的店长/大家长/超管）依赖数据库查询，不属于纯函数范畴，在
 * index.js 里单独做。
 */
function validateRedeemInput({ redeemNote }) {
  const trimmed = String(redeemNote || '').trim();
  if (trimmed.length > REDEEM_NOTE_MAX_LEN) {
    return { valid: false, error: `核销备注不能超过 ${REDEEM_NOTE_MAX_LEN} 个字符` };
  }
  return { valid: true, error: '', redeemNote: trimmed };
}

module.exports = { validatePledgeInput, validateRedeemInput };
