// 云函数：processProductionRefund — Module C：生产订单退款（微信退款 + 分账红冲 + 产能释放）
//
// 🏛️ 执行顺序刻意把"钱"放在最前面：先调用 wxPayCore.refund 真正发起微信退款，
// 只有网关明确接受这次退款请求（SUCCESS 或 PROCESSING，两者都代表微信支付
// 已经受理）之后，才继续冲销分账、释放产能、把订单标记为 refunded。如果先冲
// 账再退款，一旦退款调用失败会留下"账已经冲销、产能已经放出去，钱却没退"
// 这种更难收拾的不一致状态；反过来，退款失败时直接返回错误、不触碰任何本地
// 状态，出错后重试是安全的（wxPayCore.refund 本身按 outTradeNo 幂等复用未
// 完成的退款请求）。
//
// ⚠️ 残余风险（如实标注，未解决）：completeProductionOrder 把 direct_wechat
// 模式的自动分账放在"标记发货"这一步，是为了避开"刚付款就分账、马上退款
// 导致分账回退失败"这个高发窗口，但发货后仍可能发生售后退款——如果该订单
// 的分账已经完成（settlementStatus:'settled'，钱已经划给了制作方/推广人），
// 商户账户里可能没有足够的"未分账余额"覆盖这笔退款，微信支付会拒绝或要求
// 先从分账接收方那边把钱"回退"（另一套分账回退接口，本次未实现——技术规范
// 与建议接线方式已归档在 wxPayCore/lib/wxPayClient.js 文件底部「分账回退」
// 章节，供后续排期时参考）。下面的退款请求发出前会检查并在响应里带上这个
// 提示，但不会因此拦截退款——是否继续由商户自行判断，本函数不替他们做这个
// 决定。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 🚨 查 tenant_members 而不是 user_roles：见 createProductionSpace/index.js
// 头部注释——live_factory 成员记录绝不能混进雨花公益专区依赖的 user_roles。
async function verifyTenantAccess(openid, tenantId, requiredRoles) {
  const res = await db.collection('tenant_members')
    .where({ _openid: openid, tenantId, status: 'approved' })
    .get();
  return (res.data || []).find((r) => requiredRoles.includes(r.role)) || null;
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  const tenantId = String(event.tenantId || '');
  const orderId = String(event.orderId || '');
  const reason = String(event.reason || '').trim().slice(0, 200);
  if (!tenantId || !orderId) return { success: false, error: '参数缺失: tenantId/orderId' };

  const caller = await verifyTenantAccess(OPENID, tenantId, ['space_owner', 'space_admin']);
  if (!caller) return { success: false, error: '无权限：仅空间负责人/管理员可发起退款' };

  const orderRes = await db.collection('production_orders').doc(orderId).get().catch(() => null);
  const order = orderRes && orderRes.data;
  if (!order || order.tenantId !== tenantId) return { success: false, error: '订单不存在' };
  if (!['paid', 'in_production', 'shipped'].includes(order.orderStatus)) {
    return { success: false, error: `订单当前状态为 ${order.orderStatus}，不可退款` };
  }
  if (!order.outTradeNo) return { success: false, error: '订单缺少支付流水号，无法发起退款' };

  // 分账已完成的订单退款时给出提示（不拦截，见文件头 ⚠️ 残余风险说明）
  const settlementRes = await db.collection('order_settlements')
    .where({ tenantId, orderId, isReversal: false }).limit(1).get().catch(() => ({ data: [] }));
  const settlement = (settlementRes.data && settlementRes.data[0]) || null;
  const alreadyProfitShared = !!(settlement && settlement.settlementStatus === 'settled' && settlement.profitSharingOutOrderNo);

  // 1. 先退钱：只信任 wxPayCore 明确受理（SUCCESS/PROCESSING）后才继续
  const refundRes = await cloud.callFunction({
    name: 'wxPayCore',
    data: {
      action: 'refund',
      internalToken: process.env.WXPAY_INTERNAL_TOKEN || '',
      outTradeNo: order.outTradeNo,
      refundAmount: order.payAmount,
      reason: reason || '生产订单退款'
    }
  }).catch((err) => ({ result: { success: false, error: String(err.errMsg || err.message || '退款服务异常') } }));

  const refund = refundRes.result || {};
  if (!refund.success) {
    return { success: false, error: refund.error || '退款失败，请重试' };
  }
  if (refund.status === 'ABNORMAL' || refund.status === 'CLOSED') {
    return { success: false, error: `微信支付拒绝了这笔退款（状态：${refund.status}），请核实后重试` };
  }

  // 2. 分账红冲
  const internalToken = process.env.LIVE_FACTORY_INTERNAL_TOKEN || '';
  const reverseRes = await cloud.callFunction({
    name: 'liveFactoryCore',
    data: { action: 'reverseSettlement', internalToken, tenantId, orderId }
  }).catch((err) => ({ result: { success: false, error: String(err.errMsg || err.message || '分账冲销服务异常') } }));
  if (!(reverseRes.result || {}).success) {
    // 钱已经退了，账没冲成——记录下来供人工核对，不能再回滚已经发生的真实退款
    console.error('[processProductionRefund] 退款已受理但分账冲销失败，需人工核对:', { orderId, outTradeNo: order.outTradeNo, error: (reverseRes.result || {}).error });
    return { success: false, error: '退款已受理，但账目冲销失败，请联系技术人员核对（不要重复退款）' };
  }

  // 3. 释放已占用的生产产能
  await cloud.callFunction({
    name: 'liveFactoryCore',
    data: {
      action: 'releaseBatchCapacity', internalToken,
      tenantId, productId: order.productId, batchDate: order.batchDate, quantity: order.quantity
    }
  }).catch((err) => console.error('[processProductionRefund] 释放产能失败（需人工核对）:', err));

  await db.collection('production_orders').doc(orderId).update({
    data: { orderStatus: 'refunded', refundedAt: db.serverDate(), refundReason: reason, refundedBy: OPENID, refundStatus: refund.status }
  });

  return {
    success: true,
    refundStatus: refund.status,
    alreadyProfitShared,
    message:
      (refund.status === 'PROCESSING'
        ? '退款已提交微信支付处理中，账目已同步冲销、产能已释放。'
        : '退款成功，账目已冲销、产能已释放。') +
      (alreadyProfitShared ? '（该订单分账已完成，如商户账户余额不足，微信支付可能拒绝或延迟本次退款，请留意结果）' : '')
  };
};
