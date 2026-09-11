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
const _ = db.command;

const { validateRefundAmount } = require('./lib/partialRefund');

// 🚨 查 tenant_members 而不是 user_roles：见 createProductionSpace/index.js
// 头部注释——live_factory 成员记录绝不能混进雨花公益专区依赖的 user_roles。
async function verifyTenantAccess(openid, tenantId, requiredRoles) {
  const res = await db.collection('tenant_members')
    .where({ _openid: openid, tenantId, status: 'approved' })
    .get();
  return (res.data || []).find((r) => requiredRoles.includes(r.role)) || null;
}

async function releaseRefundClaim(orderId) {
  await db.collection('production_orders').doc(orderId).update({
    data: { refundClaimedAt: _.remove(), refundClaimedBy: _.remove() }
  }).catch((err) => console.error('[processProductionRefund] 释放退款占位失败（需人工核对是否卡死）:', orderId, err));
}

// 🏛️（2026-09-12 履约状态机双轨化）可退款起点状态：物流路径的 shipped 与
// 到店自提路径的 ready_for_pickup/verified 并列——自提订单即便已经核销
// 完成（verified，买家已取走实物），仍可能因质量问题等原因发起售后退款，
// 与物流路径"已发货仍可退款"是同一条业务逻辑，不应该只放开 shipped 一个值
const REFUNDABLE_STATUSES = ['paid', 'in_production', 'shipped', 'ready_for_pickup', 'verified'];

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
  if (!REFUNDABLE_STATUSES.includes(order.orderStatus)) {
    return { success: false, error: `订单当前状态为 ${order.orderStatus}，不可退款` };
  }
  if (!order.outTradeNo) return { success: false, error: '订单缺少支付流水号，无法发起退款' };

  // 🏛️（2026-09-12 部分退款治理）此前 refundAmount 硬编码为 order.payAmount
  // （只支持全额退款），现在允许调用方传入实际退款金额（分），服务端强校验
  // 不超过订单实付金额——见 lib/partialRefund.js
  const amountCheck = validateRefundAmount(order.payAmount, event.refundAmount);
  if (!amountCheck.valid) return { success: false, error: amountCheck.error };
  const refundAmount = amountCheck.amount;
  const isFullRefund = amountCheck.isFullRefund;

  // 🛡️ 原子领单（claim）：上面这次读 orderStatus 判断"是否可退款"和下面真正
  // 发起退款之间存在窗口——双击提交、或网络超时后客户端自动重试，都可能让
  // 两次调用同时通过上面的判断，各自继续走到 wxPayCore.refund，等于对同一笔
  // 订单发起两次真实退款请求。改用与 wxPayCore.orderService.markPaidIdempotent
  // 同一套 CAS（条件更新）手法：where 同时命中 orderStatus 仍在可退范围 +
  // refundClaimedAt 尚不存在，两个条件都满足才允许更新；并发调用只有一次能
  // 抢到 stats.updated===1，抢不到的直接拒绝，不再往下发起退款。
  // 🛡️ 范围说明（如实标注）：本仓库当前架构里一笔订单只允许发起一次真正的
  // 退款动作，无论这次是全额还是部分——refundClaimedAt 领单成功后，只有
  // "全额退款"分支会在最终清空这个占位（订单同时转入终态 refunded，
  // REFUNDABLE_STATUSES 天然排除它，不会再被选中发起第二次退款）；"部分
  // 退款"分支故意不清空这个占位，把它当成"这笔订单已经用掉唯一一次退款
  // 机会"的永久标记——不支持对同一笔订单分多次逐步退到全额，那需要引入
  // 累计已退款金额字段与更大范围的状态机设计，本次不做。
  const claimRes = await db.collection('production_orders').where({
    _id: orderId,
    orderStatus: _.in(REFUNDABLE_STATUSES),
    refundClaimedAt: _.exists(false)
  }).update({ data: { refundClaimedAt: db.serverDate(), refundClaimedBy: OPENID } });
  if (!claimRes.stats || claimRes.stats.updated !== 1) {
    return { success: false, error: '该订单退款正在处理中或状态已变更，请勿重复提交' };
  }

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
      refundAmount,
      reason: reason || (isFullRefund ? '生产订单退款' : '生产订单部分退款')
    }
  }).catch((err) => ({ result: { success: false, error: String(err.errMsg || err.message || '退款服务异常') } }));

  const refund = refundRes.result || {};
  if (!refund.success) {
    // 网关明确没有受理这笔退款：释放占位，允许调用方直接重试
    await releaseRefundClaim(orderId);
    return { success: false, error: refund.error || '退款失败，请重试' };
  }
  if (refund.status === 'ABNORMAL' || refund.status === 'CLOSED') {
    await releaseRefundClaim(orderId);
    return { success: false, error: `微信支付拒绝了这笔退款（状态：${refund.status}），请核实后重试` };
  }

  // 2. 分账红冲——按 refundAmount 精确冲销（部分退款时按比例，见
  // liveFactoryCore/lib/settlement.js decideRefundReversal 头部注释）
  const internalToken = process.env.LIVE_FACTORY_INTERNAL_TOKEN || '';
  const reverseRes = await cloud.callFunction({
    name: 'liveFactoryCore',
    data: { action: 'reverseSettlement', internalToken, tenantId, orderId, refundAmount }
  }).catch((err) => ({ result: { success: false, error: String(err.errMsg || err.message || '分账冲销服务异常') } }));
  if (!(reverseRes.result || {}).success) {
    // 钱已经退了，账没冲成——记录下来供人工核对，不能再回滚已经发生的真实退款。
    // 🔒 故意不释放退款占位：真实退款已经发往微信支付，一旦放开占位允许重试，
    // 会对同一笔订单再发起一次真实退款请求，这里宁可让占位保持"卡住"状态，
    // 逼人工介入核对，而不是自动放行重复退款
    console.error('[processProductionRefund] 退款已受理但分账冲销失败，需人工核对:', { orderId, outTradeNo: order.outTradeNo, error: (reverseRes.result || {}).error });
    return { success: false, error: '退款已受理，但账目冲销失败，请联系技术人员核对（不要重复退款）' };
  }

  // 🏛️（2026-09-12 部分退款治理）产能/拼团份额释放只在"全额退款"（订单
  // 真正取消/退货，实体不再交付给买家）时执行——部分退款是价格调整/质量
  // 补偿性质，买家仍然保留实物，释放产能会错误地把"已经真实用掉的产能"
  // 重新标记为可用，制造超卖风险
  if (isFullRefund) {
    // 3. 释放已占用的生产产能
    await cloud.callFunction({
      name: 'liveFactoryCore',
      data: {
        action: 'releaseBatchCapacity', internalToken,
        tenantId, productId: order.productId, batchDate: order.batchDate, quantity: order.quantity
      }
    }).catch((err) => console.error('[processProductionRefund] 释放产能失败（需人工核对）:', err));

    // 3.5（护城河二）若该订单是通过拼团批次成交的，退款时同步释放已认购的
    // 拼团份额——否则拼团进度条会一直算上这笔已经退掉的订单，显示虚高的
    // "已认购 N 件"，也可能因此错误维持一个本不该解锁的阶梯价
    if (order.groupBuyBatchId) {
      await cloud.callFunction({
        name: 'liveFactoryCore',
        data: {
          action: 'releaseGroupBuyProgress', internalToken,
          tenantId, productId: order.productId, batchDate: order.batchDate, quantity: order.quantity
        }
      }).catch((err) => console.error('[processProductionRefund] 释放拼团份额失败（需人工核对）:', err));
    }
  }

  const refundUpdateData = isFullRefund
    ? {
        orderStatus: 'refunded', refundedAt: db.serverDate(), refundReason: reason, refundedBy: OPENID, refundStatus: refund.status,
        refundedAmount: refundAmount, isPartiallyRefunded: false,
        refundClaimedAt: _.remove(), refundClaimedBy: _.remove()
      }
    : {
        // 部分退款：订单状态保持不变（买家仍会/已收到实物），故意不清空
        // refundClaimedAt/refundClaimedBy——见上方"范围说明"注释，这是本
        // 订单唯一一次退款机会已用掉的永久标记
        refundedAt: db.serverDate(), refundReason: reason, refundedBy: OPENID, refundStatus: refund.status,
        refundedAmount: refundAmount, isPartiallyRefunded: true
      };
  await db.collection('production_orders').doc(orderId).update({ data: refundUpdateData });

  return {
    success: true,
    refundStatus: refund.status,
    refundAmount,
    isFullRefund,
    alreadyProfitShared,
    message:
      (refund.status === 'PROCESSING'
        ? `退款已提交微信支付处理中，账目已同步冲销${isFullRefund ? '、产能已释放' : ''}。`
        : `退款成功，账目已冲销${isFullRefund ? '、产能已释放' : ''}。`) +
      (alreadyProfitShared ? '（该订单分账已完成，如商户账户余额不足，微信支付可能拒绝或延迟本次退款，请留意结果）' : '')
  };
};
