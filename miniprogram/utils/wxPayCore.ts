// 微信支付统一拉起工具：封装 wx.requestPayment 调用 + Mock 模式下的模拟支付确认，
// 统一处理 loading 状态、防重复点击、用户取消与失败提示——业务页面只需要：
//   1) 调用自己的业务云函数（内部已封装好调用 wxPayCore.createOrder 的定价/权限校验）拿到下单结果
//   2) 把下单结果传给 payForOrder()，根据返回的 PayOutcome 更新页面状态
// 与 cloudfunctions/wxPayCore 配套：业务云函数下单返回值的形状必须与
// wxPayCore.handleCreateOrder 的返回值一致（{ success, outTradeNo, payment, mockMode }）。

export interface WxPayPaymentPackage {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA' | 'MD5' | 'HMAC-SHA256';
  paySign: string;
  mock?: boolean;
}

export interface CreateOrderResponse {
  success: boolean;
  outTradeNo?: string;
  payment?: WxPayPaymentPackage | null;
  mockMode?: boolean;
  error?: string;
  // 真实凭证未配置齐全时由 wxPayCore 显式打标（见 cloudfunctions/wxPayCore/index.js
  // handleCreateOrder），业务方原样透传，前端据此展示"支付未开通"引导弹窗
  // 而不是普通错误 Toast
  paymentNotConfigured?: boolean;
}

export interface PayOutcome {
  ok: boolean;
  cancelled: boolean;
  message: string;
}

// 同一 outTradeNo 正在拉起支付时忽略后续重复调用——防止用户在支付面板弹出的
// 瞬间连续点击按钮导致 wx.requestPayment 被并发调用两次
const inFlightOrders = new Set<string>();

export async function payForOrder(orderResult: CreateOrderResponse): Promise<PayOutcome> {
  if (!orderResult || !orderResult.success || !orderResult.payment || !orderResult.outTradeNo) {
    return { ok: false, cancelled: false, message: orderResult?.error || '下单失败，请重试' };
  }

  const { outTradeNo, payment, mockMode } = orderResult;
  if (inFlightOrders.has(outTradeNo)) {
    return { ok: false, cancelled: false, message: '支付正在处理中，请勿重复操作' };
  }
  inFlightOrders.add(outTradeNo);

  try {
    // Mock 模式下不会、也不能拿到能通过微信客户端校验的真实签名，走"模拟支付
    // 确认弹窗"而不是 wx.requestPayment（见 cloudfunctions/wxPayCore/lib/mockClient.js
    // 头部注释：伪造签名传给真机只会得到"支付验证失败"）
    if (mockMode || payment.mock) {
      return await confirmMockPayment(outTradeNo);
    }
    return await requestRealPayment(payment);
  } finally {
    inFlightOrders.delete(outTradeNo);
  }
}

function confirmMockPayment(outTradeNo: string): Promise<PayOutcome> {
  return new Promise((resolve) => {
    wx.showModal({
      title: '模拟支付（Mock 模式）',
      content: '当前支付服务处于 Mock 模式（尚未接入真实微信商户号）。点击"确认支付"将模拟一笔支付成功，用于联调订单状态流转。',
      confirmText: '确认支付',
      cancelText: '取消',
      success: (modalRes) => {
        if (!modalRes.confirm) {
          resolve({ ok: false, cancelled: true, message: '已取消支付' });
          return;
        }
        wx.showLoading({ title: '模拟支付中...', mask: true });
        wx.cloud.callFunction({
          name: 'wxPayCore',
          data: { action: 'mockPaySuccess', outTradeNo }
        }).then((callRes) => {
          wx.hideLoading();
          const result = callRes.result as { success?: boolean; error?: string };
          if (result && result.success) {
            resolve({ ok: true, cancelled: false, message: '模拟支付成功' });
          } else {
            resolve({ ok: false, cancelled: false, message: (result && result.error) || '模拟支付失败' });
          }
        }).catch((err: any) => {
          wx.hideLoading();
          resolve({ ok: false, cancelled: false, message: err?.errMsg || '网络异常，请重试' });
        });
      },
      fail: () => resolve({ ok: false, cancelled: true, message: '已取消支付' })
    });
  });
}

function requestRealPayment(payment: WxPayPaymentPackage): Promise<PayOutcome> {
  return new Promise((resolve) => {
    wx.requestPayment({
      timeStamp: payment.timeStamp,
      nonceStr: payment.nonceStr,
      package: payment.package,
      signType: payment.signType,
      paySign: payment.paySign,
      success: () => resolve({ ok: true, cancelled: false, message: '支付成功' }),
      fail: (err: any) => {
        // wx.requestPayment 用户主动取消时 errMsg 包含 'cancel'，与 profile.ts
        // onSubscribeAdvancedFeature 现有判断口径保持一致
        const cancelled = typeof err?.errMsg === 'string' && err.errMsg.indexOf('cancel') !== -1;
        resolve({ ok: false, cancelled, message: cancelled ? '已取消支付' : (err?.errMsg || '支付失败，请重试') });
      }
    });
  });
}

// 端到端便捷封装：调用业务云函数下单 → 拉起支付 → 返回结果。业务云函数名与
// 业务参数由调用方指定，业务云函数内部负责校验权限/计算金额，再转发给
// wxPayCore 的 createOrder action（见 cloudfunctions/wxPayCore/index.js 头部
// "安全边界"说明：createOrder 只信任服务端调用方，本工具不会、也不能直接调用它）。
export async function createOrderAndPay(
  businessCloudFunctionName: string,
  businessPayload: Record<string, unknown>,
  loadingTitle = '正在生成订单...'
): Promise<PayOutcome> {
  wx.showLoading({ title: loadingTitle, mask: true });
  let orderResult: CreateOrderResponse;
  try {
    const res = await wx.cloud.callFunction({ name: businessCloudFunctionName, data: businessPayload });
    orderResult = res.result as CreateOrderResponse;
  } catch (err: any) {
    wx.hideLoading();
    return { ok: false, cancelled: false, message: err?.errMsg || '网络异常，请重试' };
  }
  wx.hideLoading();

  if (!orderResult || !orderResult.success) {
    return { ok: false, cancelled: false, message: orderResult?.error || '生成订单失败，请重试' };
  }
  return payForOrder(orderResult);
}
