// 云函数：wxPayCore
// 微信支付 APIv3 核心服务模块——统一下单(JSAPI) / 订单查询 / 主动关单 / 回调验签解密，
// 通过 PAYMENT_MOCK_MODE 环境变量在「完全模拟」与「真实 APIv3」之间无缝切换。
//
// 🏛️ 定位：本函数是纯粹的支付基础设施，不认识任何具体业务（订阅/捐赠/…）。
// 业务方云函数（如未来的 createSubscriptionOrderV2）先完成自己的定价与权限校验，
// 再通过 cloud.callFunction 把已核验好的 bizType/bizId/amount/description 交给
// 本函数下单；本函数只负责"这笔钱有没有真的付成功"，付成功后回调业务方登记的
// notifyFn 云函数，让业务方自己决定"付成功了该怎么办"（延期订阅/开发票/…）。
//
// 🛡️ 安全边界：
//   1) createOrder/closeOrder 是"花钱/关单"操作，只信任携带正确 WXPAY_INTERNAL_TOKEN
//      的服务端调用方（业务云函数），绝不接受客户端直接传入 amount——与仓库里
//      "totalFee 永远服务端算，不信任客户端"的一贯口径一致（见 createSubscriptionOrder）。
//   2) mockPaySuccess 只在 PAYMENT_MOCK_MODE=true 时可用，且只允许订单归属人
//      （openid 与订单一致）触发自己那笔订单，不做金额/身份伪造。
//   3) 真实回调（HTTP 触发入口）验签失败一律拒绝处理，绝不信任未验签的回调数据。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { isMockMode, getRealPayConfig } = require('./lib/payConfig');
const wxPayClient = require('./lib/wxPayClient');
const mockClient = require('./lib/mockClient');
const orderService = require('./lib/orderService');
const refundService = require('./lib/refundService');
const profitSharingService = require('./lib/profitSharingService');

function requireInternalCaller(event) {
  const expected = process.env.WXPAY_INTERNAL_TOKEN || '';
  if (!expected) {
    // 未配置内部令牌时（如本地/演示环境）不做拦截，但打印告警——生产环境
    // 必须配置，否则 createOrder/closeOrder 会退化成"谁都能调用"
    console.warn('[wxPayCore] WXPAY_INTERNAL_TOKEN 未配置，createOrder/closeOrder 未做调用方鉴权！');
    return true;
  }
  return event.internalToken === expected;
}

// ── action: createOrder ──────────────────────────────────────────────────
// 入参（均由业务方服务端计算好后传入，不接受客户端直传）：
//   openid, tenantId, bizType, bizId, amount(分), description, notifyFn
async function handleCreateOrder(event) {
  if (!requireInternalCaller(event)) {
    return { success: false, error: '无权限：createOrder 仅限内部业务云函数调用' };
  }
  const { openid, tenantId, bizType, bizId, amount, description, notifyFn } = event;
  if (!openid || !bizType || !(amount > 0) || !description) {
    return { success: false, error: '参数缺失: openid/bizType/amount/description' };
  }

  const mockMode = isMockMode();
  // createPendingOrder 内部已做"10 分钟内同一 openid+bizType+bizId 复用未支付订单"
  // 的防重复下单；这里仍然对复用到的订单重新调一次 unifiedorder——微信支付允许对
  // 同一未支付的 out_trade_no 重复统一下单（返回的 prepay_id 有效期 2 小时，足够覆盖
  // 用户"生成订单后迟迟不点确认支付"的场景），比额外维护一条"直接复用旧 prepay_id
  // 重新签一次 paySign"的分支更简单，也不需要担心 prepay_id 过期的边界情况
  const order = await orderService.createPendingOrder({
    openid, tenantId, bizType, bizId, amount, description, notifyFn, mockMode
  });

  try {
    const { prepayId, payment } = mockMode
      ? await mockClient.createUnifiedOrder({ outTradeNo: order.outTradeNo })
      : await wxPayClient.createUnifiedOrder({
          outTradeNo: order.outTradeNo,
          description,
          totalFee: amount,
          openid,
          realConfig: getRealPayConfig()
        });

    await orderService.attachPrepayId(order.outTradeNo, prepayId);
    console.log('[wxPayCore] 下单成功:', { outTradeNo: order.outTradeNo, bizType, bizId, mockMode });
    return { success: true, outTradeNo: order.outTradeNo, payment, mockMode };
  } catch (err) {
    console.error('[wxPayCore] 统一下单失败:', err);
    await orderService.markClosed(order.outTradeNo, String(err.message || '统一下单异常')).catch(() => {});
    // 🆕 真实凭证未配置齐全是"环境没就绪"而不是"这次请求本身有问题"，显式打上
    // paymentNotConfigured 标记，业务云函数原样透传给前端后即可复用既有的
    // "支付未开通"引导弹窗分支，不需要靠字符串猜测错误原因
    const paymentNotConfigured = err.code === 'WXPAY_CONFIG_INCOMPLETE';
    return { success: false, error: `下单失败：${err.message || '请重试'}`, paymentNotConfigured };
  }
}

// ── action: queryOrder ───────────────────────────────────────────────────
// 🌟 鉴权二选一：内部业务云函数走 internalToken；小程序端直接查自己名下订单
// （如调试页展示下单结果）走 openid 归属校验——查询本身不动钱，放宽给订单
// 所有者本人是安全的，与 mockPaySuccess 同一条口径
async function handleQueryOrder(event) {
  const { outTradeNo } = event;
  const order = await orderService.getByOutTradeNo(outTradeNo);
  if (!order) return { success: false, error: '订单不存在' };

  const { OPENID } = cloud.getWXContext();
  const isOwner = !!OPENID && order.openid === OPENID;
  if (!requireInternalCaller(event) && !isOwner) {
    return { success: false, error: '无权限：只能查询内部业务调用或本人名下的订单' };
  }

  try {
    const result = order.mockMode
      ? await mockClient.queryOrderByOutTradeNo({ localOrder: order })
      : await wxPayClient.queryOrderByOutTradeNo({ outTradeNo, realConfig: getRealPayConfig() });
    return { success: true, status: order.status, tradeState: result.tradeState, transactionId: result.transactionId };
  } catch (err) {
    console.error('[wxPayCore] 查询订单失败:', err);
    return { success: false, error: `查询失败：${err.message || '请重试'}` };
  }
}

// ── action: closeOrder（超时取消/主动关单）────────────────────────────────
async function handleCloseOrder(event) {
  if (!requireInternalCaller(event)) {
    return { success: false, error: '无权限：closeOrder 仅限内部业务云函数调用' };
  }
  const { outTradeNo, reason } = event;
  const order = await orderService.getByOutTradeNo(outTradeNo);
  if (!order) return { success: false, error: '订单不存在' };
  if (order.status !== orderService.STATUS.PENDING_PAY) {
    return { success: false, error: `订单当前状态为 ${order.status}，无法关闭` };
  }

  try {
    if (!order.mockMode) {
      await wxPayClient.closeOrder({ outTradeNo, realConfig: getRealPayConfig() });
    }
    await orderService.markClosed(outTradeNo, reason || '主动关单');
    return { success: true };
  } catch (err) {
    console.error('[wxPayCore] 关闭订单失败:', err);
    return { success: false, error: `关闭订单失败：${err.message || '请重试'}` };
  }
}

// ── action: refund ──────────────────────────────────────────────────────
// 入参同 createOrder 一样只信任服务端调用方：refundAmount 由业务方算好传入，
// 不接受客户端直传。原订单必须是 PAID（或已退过一部分、仍可继续部分退款）。
async function handleRefund(event) {
  if (!requireInternalCaller(event)) {
    return { success: false, error: '无权限：refund 仅限内部业务云函数调用' };
  }
  const { outTradeNo, refundAmount, reason, notifyFn } = event;
  if (!outTradeNo || !(refundAmount > 0)) {
    return { success: false, error: '参数缺失: outTradeNo/refundAmount' };
  }
  const order = await orderService.getByOutTradeNo(outTradeNo);
  if (!order) return { success: false, error: '原支付订单不存在' };
  if (order.status !== orderService.STATUS.PAID && order.status !== orderService.STATUS.REFUNDED) {
    return { success: false, error: `原订单状态为 ${order.status}，不可退款` };
  }

  const alreadyRefunded = await refundService.getSuccessfulRefundedTotal(outTradeNo);
  const validation = refundService.validateRefundAmount({
    refundAmount, totalAmount: order.amount, alreadyRefundedAmount: alreadyRefunded
  });
  if (!validation.valid) return { success: false, error: validation.error };

  const mockMode = isMockMode();
  // createPendingRefund 内部会在 10 分钟窗口内复用同一笔未终结的 PROCESSING
  // 记录（与 orderService.createPendingOrder 同一套防重复下单写法），这里
  // 拿到的要么是全新记录、要么是仍在 PROCESSING 的既有记录，两种情况都需要
  // 继续走一次网关调用去推进/确认状态
  const refundRecord = await refundService.createPendingRefund({
    outTradeNo, transactionId: order.transactionId, tenantId: order.tenantId,
    bizType: order.bizType, bizId: order.bizId, refundAmount, totalAmount: order.amount,
    reason, mockMode, notifyFn: notifyFn || order.notifyFn
  });

  try {
    const result = mockMode
      ? await mockClient.createRefund({ outRefundNo: refundRecord.outRefundNo })
      : await wxPayClient.createRefund({
          outRefundNo: refundRecord.outRefundNo, outTradeNo, transactionId: order.transactionId,
          totalAmount: order.amount, refundAmount, reason, realConfig: getRealPayConfig()
        });

    const { transitioned, record } = await refundService.markRefundStatus(refundRecord.outRefundNo, result.status, { refundId: result.refundId || '' });
    if (result.status === 'SUCCESS') {
      await orderService.markRefunded(outTradeNo, reason);
      if (transitioned) await refundService.dispatchRefundNotifyHook(record);
    }
    console.log('[wxPayCore] 退款请求已提交:', { outRefundNo: refundRecord.outRefundNo, status: result.status, mockMode });
    return { success: true, outRefundNo: refundRecord.outRefundNo, status: result.status, mockMode };
  } catch (err) {
    await refundService.markRefundStatus(refundRecord.outRefundNo, 'ABNORMAL', { failReason: String(err.message || err) }).catch(() => {});
    console.error('[wxPayCore] 申请退款失败:', err);
    return { success: false, error: `申请退款失败：${err.message || '请重试'}` };
  }
}

// ── action: queryRefund（轮询 PROCESSING 状态的退款结果）───────────────────
async function handleQueryRefund(event) {
  if (!requireInternalCaller(event)) {
    return { success: false, error: '无权限：queryRefund 仅限内部业务云函数调用' };
  }
  const { outRefundNo } = event;
  const record = await refundService.getByOutRefundNo(outRefundNo);
  if (!record) return { success: false, error: '退款记录不存在' };
  if (record.status !== refundService.STATUS.PROCESSING) {
    return { success: true, status: record.status };
  }

  const mockMode = isMockMode();
  try {
    const result = mockMode
      ? await mockClient.queryRefund({ outRefundNo })
      : await wxPayClient.queryRefund({ outRefundNo, realConfig: getRealPayConfig() });

    const { transitioned, record: updated } = await refundService.markRefundStatus(outRefundNo, result.status, {});
    if (result.status === 'SUCCESS') {
      await orderService.markRefunded(record.outTradeNo, record.reason);
      if (transitioned) await refundService.dispatchRefundNotifyHook(updated);
    }
    return { success: true, status: result.status };
  } catch (err) {
    console.error('[wxPayCore] 查询退款失败:', err);
    return { success: false, error: `查询退款失败：${err.message || '请重试'}` };
  }
}

// ── action: addProfitSharingReceiver ────────────────────────────────────
async function handleAddProfitSharingReceiver(event) {
  if (!requireInternalCaller(event)) {
    return { success: false, error: '无权限：addProfitSharingReceiver 仅限内部业务云函数调用' };
  }
  const { type, account, name, relationType } = event;
  if (!type || !account) return { success: false, error: '参数缺失: type/account' };

  const mockMode = isMockMode();
  try {
    const result = mockMode
      ? await mockClient.addProfitSharingReceiver({ type, account })
      : await wxPayClient.addProfitSharingReceiver({ type, account, name, relationType, realConfig: getRealPayConfig() });
    return { success: true, receiver: result, mockMode };
  } catch (err) {
    console.error('[wxPayCore] 添加分账接收方失败:', err);
    return { success: false, error: `添加分账接收方失败：${err.message || '请重试'}` };
  }
}

// ── action: requestProfitSharing ─────────────────────────────────────────
async function handleRequestProfitSharing(event) {
  if (!requireInternalCaller(event)) {
    return { success: false, error: '无权限：requestProfitSharing 仅限内部业务云函数调用' };
  }
  const { outTradeNo, tenantId, bizType, bizId, receivers, unfreezeUnsplit, notifyFn } = event;
  if (!outTradeNo) return { success: false, error: '参数缺失: outTradeNo' };

  const order = await orderService.getByOutTradeNo(outTradeNo);
  if (!order || order.status !== orderService.STATUS.PAID) {
    return { success: false, error: '原订单不存在或未支付成功，无法分账' };
  }

  const validation = profitSharingService.validateReceivers({ receivers, transactionAmount: order.amount });
  if (!validation.valid) return { success: false, error: validation.error };

  const mockMode = isMockMode();
  const shareRecord = await profitSharingService.createPendingShare({
    outTradeNo, transactionId: order.transactionId, tenantId: tenantId || order.tenantId,
    bizType: bizType || order.bizType, bizId: bizId || order.bizId, receivers, mockMode, notifyFn
  });

  try {
    const result = mockMode
      ? await mockClient.requestProfitSharing({ outOrderNo: shareRecord.outOrderNo, receivers })
      : await wxPayClient.requestProfitSharing({
          outOrderNo: shareRecord.outOrderNo, transactionId: order.transactionId,
          receivers, unfreezeUnsplit, realConfig: getRealPayConfig()
        });
    await profitSharingService.markShareStatus(shareRecord.outOrderNo, result.status, { receiversResult: result.receivers });
    console.log('[wxPayCore] 分账请求已提交:', { outOrderNo: shareRecord.outOrderNo, status: result.status, mockMode });
    return { success: true, outOrderNo: shareRecord.outOrderNo, status: result.status, mockMode };
  } catch (err) {
    await profitSharingService.markShareStatus(shareRecord.outOrderNo, 'CLOSED', { failReason: String(err.message || err) }).catch(() => {});
    console.error('[wxPayCore] 请求分账失败:', err);
    return { success: false, error: `请求分账失败：${err.message || '请重试'}` };
  }
}

// ── action: queryProfitSharing ───────────────────────────────────────────
async function handleQueryProfitSharing(event) {
  if (!requireInternalCaller(event)) {
    return { success: false, error: '无权限：queryProfitSharing 仅限内部业务云函数调用' };
  }
  const record = await profitSharingService.getByOutOrderNo(event.outOrderNo);
  if (!record) return { success: false, error: '分账记录不存在' };
  return { success: true, status: record.status, receivers: record.receiversResult || [] };
}

// ── action: finishProfitSharing（释放未分完的冻结资金）──────────────────────
async function handleFinishProfitSharing(event) {
  if (!requireInternalCaller(event)) {
    return { success: false, error: '无权限：finishProfitSharing 仅限内部业务云函数调用' };
  }
  const { outOrderNo, description } = event;
  const record = await profitSharingService.getByOutOrderNo(outOrderNo);
  if (!record) return { success: false, error: '分账记录不存在' };

  const mockMode = isMockMode();
  try {
    const result = mockMode
      ? await mockClient.finishProfitSharing({ outOrderNo })
      : await wxPayClient.finishProfitSharing({ outOrderNo, transactionId: record.transactionId, description, realConfig: getRealPayConfig() });
    await profitSharingService.markShareStatus(outOrderNo, result.status, {});
    return { success: true, status: result.status, mockMode };
  } catch (err) {
    console.error('[wxPayCore] 完结分账失败:', err);
    return { success: false, error: `完结分账失败：${err.message || '请重试'}` };
  }
}

// ── action: mockPaySuccess（仅 Mock 模式）──────────────────────────────────
// 对应需求里的 "/api/test/mock-pay-success"：在云函数世界里落地为一个 action，
// 前端点击"模拟支付成功"按钮时直接调用，跑通完整的订单状态流转与业务回调。
async function handleMockPaySuccess(event) {
  if (!isMockMode()) {
    return { success: false, error: 'PAYMENT_MOCK_MODE=false，当前环境不允许模拟支付' };
  }
  const { OPENID } = cloud.getWXContext();
  const { outTradeNo } = event;
  const order = await orderService.getByOutTradeNo(outTradeNo);
  if (!order) return { success: false, error: '订单不存在' };
  if (OPENID && order.openid && order.openid !== OPENID) {
    return { success: false, error: '无权限：只能模拟支付自己发起的订单' };
  }

  const mockTransactionId = `MOCK_TXN_${Date.now()}`;
  const { transitioned, order: latest } = await orderService.markPaidIdempotent(outTradeNo, mockTransactionId);
  // 🐛 此前只在 transitioned===true（第一次由本次调用触发 PENDING_PAY→PAID）
  // 时才调用 dispatchNotifyHook——一旦第一次通知失败（业务方云函数异常/未
  // 部署/拒绝处理），payment_orders 已经是 PAID，之后 transitioned 永远是
  // false，重复点"模拟支付成功"也不会再重试通知，业务方状态永久卡死在
  // "钱已付、业务侧没同步"。业务方的 paymentSucceeded 处理本身是幂等的
  // （见 createProductionOrder/createSubscriptionOrder 的 order.status===
  // 'paid' 提前返回），所以无论是否本次触发了状态迁移都可以放心重试通知。
  const notify = await orderService.dispatchNotifyHook(latest);
  console.log('[wxPayCore] Mock 支付成功已触发:', { outTradeNo, transitioned, notifySuccess: notify.success });
  return { success: true, status: latest.status, transitioned, notifyDispatched: notify.success, notifyError: notify.success ? undefined : notify.error };
}

// ── HTTP 触发入口：真实微信支付异步通知 ────────────────────────────────────
// 需要在云开发控制台 → 云函数 wxPayCore →「HTTP 访问服务」里开启并绑定路径，
// 拿到的公网地址就是 WXPAY_NOTIFY_URL 环境变量的值。微信支付服务器会以
// POST 方式把加密的支付结果推送到这个地址。
async function handleHttpNotify(event) {
  const okResponse = (code, message) => ({
    statusCode: code === 'SUCCESS' ? 200 : 400,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, message })
  });

  if (isMockMode()) {
    // Mock 模式下不应该有真实回调打进来，但防御性拒绝而不是崩溃
    return okResponse('FAIL', 'PAYMENT_MOCK_MODE=true，未接受真实回调');
  }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body || '');
  const headers = Object.keys(event.headers || {}).reduce((acc, k) => {
    acc[k.toLowerCase()] = event.headers[k];
    return acc;
  }, {});

  try {
    const realConfig = getRealPayConfig();
    const { eventType, decrypted } = await wxPayClient.decryptNotify({ headers, rawBody, realConfig });

    if (eventType !== 'TRANSACTION.SUCCESS' || !decrypted) {
      console.log('[wxPayCore] 忽略非支付成功回调事件:', eventType);
      return okResponse('SUCCESS', '已忽略非支付成功事件');
    }
    if (decrypted.trade_state !== 'SUCCESS') {
      console.log('[wxPayCore] 回调 trade_state 非 SUCCESS，忽略:', decrypted.trade_state);
      return okResponse('SUCCESS', '已忽略非成功交易状态');
    }

    const outTradeNo = decrypted.out_trade_no;
    const transactionId = decrypted.transaction_id;
    const { transitioned, order } = await orderService.markPaidIdempotent(outTradeNo, transactionId);
    // 同 handleMockPaySuccess 的修复：不再只在 transitioned===true 时才通知，
    // 业务方 paymentSucceeded 处理本身幂等，重复通知安全；这样即使微信重推
    // 同一笔回调（真实网络场景下常见），也能顺带重试一次此前可能失败的通知
    const notify = await orderService.dispatchNotifyHook(order);
    console.log('[wxPayCore] 真实支付回调处理完成:', { outTradeNo, transactionId, transitioned, notifySuccess: notify.success });
    return okResponse('SUCCESS', '成功');
  } catch (err) {
    console.error('[wxPayCore] 处理支付回调异常:', err);
    // 验签失败/解密失败等场景返回非 200，微信支付会按其重试策略重推——这是期望行为，
    // 不能因为一次异常就假装处理成功，否则真实的支付成功事件会被永久丢弃
    return okResponse('FAIL', String(err.message || '处理失败'));
  }
}

exports.main = async (event) => {
  // HTTP 触发的 event 一定带 httpMethod 字段，据此和 cloud.callFunction 的
  // action 路由区分开——两种入口共享同一份订单状态机逻辑，但语义完全不同
  // （前者服务微信支付服务器，后者服务小程序端/业务云函数）。
  if (typeof event.httpMethod === 'string') {
    return handleHttpNotify(event);
  }

  const { action } = event;
  try {
    switch (action) {
      case 'createOrder':
        return await handleCreateOrder(event);
      case 'queryOrder':
        return await handleQueryOrder(event);
      case 'closeOrder':
        return await handleCloseOrder(event);
      case 'mockPaySuccess':
        return await handleMockPaySuccess(event);
      case 'refund':
        return await handleRefund(event);
      case 'queryRefund':
        return await handleQueryRefund(event);
      case 'addProfitSharingReceiver':
        return await handleAddProfitSharingReceiver(event);
      case 'requestProfitSharing':
        return await handleRequestProfitSharing(event);
      case 'queryProfitSharing':
        return await handleQueryProfitSharing(event);
      case 'finishProfitSharing':
        return await handleFinishProfitSharing(event);
      default:
        return { success: false, error: `不支持的 action: ${action}` };
    }
  } catch (err) {
    console.error('[wxPayCore] 未捕获异常:', err);
    return { success: false, error: '支付服务异常，请重试' };
  }
};
