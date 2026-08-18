// 🧪 支付 Mock 联调调试页：跑通「下单 → wxPayCore 生成 Mock 预支付参数 →
// 模拟支付成功 → 订单状态流转（PENDING_PAY → PAID）→ 业务回调激活订阅」的
// 完整闭环，走的是与生产环境完全相同的代码路径（createSubscriptionOrder →
// wxPayCore），只是 PAYMENT_MOCK_MODE=true 时不需要真实微信支付账户。
// 仅供开发自测，未挂载在任何 tabBar/导航入口，需手动 wx.navigateTo 进入。
import { createOrderAndPay, CreateOrderResponse } from '../../utils/wxPayCore';

interface LogLine {
  time: string;
  text: string;
}

Page({
  data: {
    logs: [] as LogLine[],
    submitting: false,
    lastOutTradeNo: ''
  },

  onLoad() {
    this.appendLog('测试页加载完成，PAYMENT_MOCK_MODE 由云端环境变量决定（默认 true）');
  },

  appendLog(text: string) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const logs = [{ time, text }, ...this.data.logs].slice(0, 50);
    this.setData({ logs });
    console.log(`[wxpay-test] ${text}`);
  },

  async onTestSubscribe(e: any) {
    if (this.data.submitting) return;
    const planType = e.currentTarget.dataset.plan as 'PRO_YEARLY' | 'FLAGSHIP_YEARLY' | 'ADD_ON_STORE';
    this.setData({ submitting: true });
    this.appendLog(`① 调用 createSubscriptionOrder 下单（planType=${planType}）...`);

    try {
      const businessPayload = planType === 'ADD_ON_STORE' ? { planType, quantity: 2 } : { planType };
      // createOrderAndPay 内部依次完成：调用业务云函数算价下单 → 拉起支付
      // （Mock 模式下自动切换为模拟确认弹窗，不会误调 wx.requestPayment）
      const outcome = await createOrderAndPay('createSubscriptionOrder', businessPayload, '下单中...');
      if (outcome.ok) {
        this.appendLog(`✅ 全流程完成：${outcome.message}`);
        this.appendLog('② 订单已由 wxPayCore 标记为 PAID，并已回调 createSubscriptionOrder 更新 tenant_subscriptions');
      } else if (outcome.cancelled) {
        this.appendLog(`⚠️ 已取消：${outcome.message}`);
      } else {
        this.appendLog(`❌ 失败：${outcome.message}`);
      }
    } catch (err: any) {
      this.appendLog(`❌ 异常：${err?.errMsg || err?.message || '未知错误'}`);
    } finally {
      this.setData({ submitting: false });
    }
  },

  // 🌟 幂等性验证：直接对刚下单的 outTradeNo 再触发一次 mockPaySuccess，
  // 预期第二次 transitioned:false（orderService.markPaidIdempotent 的 CAS
  // 条件更新只在 PENDING_PAY→PAID 这一次迁移时命中），不会重复延期
  async onCreateThenReplay(e: any) {
    if (this.data.submitting) return;
    const planType = e.currentTarget.dataset.plan as 'PRO_YEARLY' | 'FLAGSHIP_YEARLY';
    this.setData({ submitting: true });
    this.appendLog(`① 下单（planType=${planType}）...`);

    try {
      wx.showLoading({ title: '下单中...', mask: true });
      const orderRes = await wx.cloud.callFunction({ name: 'createSubscriptionOrder', data: { planType } });
      wx.hideLoading();
      const orderResult = orderRes.result as CreateOrderResponse;
      if (!orderResult.success || !orderResult.outTradeNo) {
        this.appendLog(`❌ 下单失败：${orderResult.error}`);
        return;
      }
      this.setData({ lastOutTradeNo: orderResult.outTradeNo });
      this.appendLog(`✅ 下单成功，outTradeNo=${orderResult.outTradeNo}`);

      this.appendLog('② 第一次触发 mockPaySuccess...');
      const first = await wx.cloud.callFunction({ name: 'wxPayCore', data: { action: 'mockPaySuccess', outTradeNo: orderResult.outTradeNo } });
      const firstResult = first.result as { success: boolean; transitioned?: boolean; status?: string; error?: string };
      this.appendLog(`   结果：success=${firstResult.success} transitioned=${firstResult.transitioned} status=${firstResult.status}`);

      this.appendLog('③ 立即再次触发 mockPaySuccess（验证幂等）...');
      const second = await wx.cloud.callFunction({ name: 'wxPayCore', data: { action: 'mockPaySuccess', outTradeNo: orderResult.outTradeNo } });
      const secondResult = second.result as { success: boolean; transitioned?: boolean; status?: string; error?: string };
      this.appendLog(`   结果：success=${secondResult.success} transitioned=${secondResult.transitioned} status=${secondResult.status}`);

      if (firstResult.transitioned === true && secondResult.transitioned === false) {
        this.appendLog('✅ 幂等性验证通过：第二次调用未重复处理（transitioned:false）');
      } else {
        this.appendLog('❌ 幂等性异常：期望第二次 transitioned:false，请检查 orderService.markPaidIdempotent');
      }
    } catch (err: any) {
      wx.hideLoading();
      this.appendLog(`❌ 异常：${err?.errMsg || err?.message || '未知错误'}`);
    } finally {
      this.setData({ submitting: false });
    }
  },

  onClearLogs() {
    this.setData({ logs: [] });
  }
});
