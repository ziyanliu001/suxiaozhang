// 订阅消息唤起工具：封装"关键动作成功后引导用户订阅服务通知"这一步，统一
// 处理"模板 ID 未配置"和"用户拒绝/调用异常"两种静默降级路径——业务页面
// 调用后直接继续自己的成功态展示，不需要关心这两种情况怎么处理。
//
// ⚠️（2026-09-13 从主包下沉）本文件原本放在主包 miniprogram/utils/ 下，
// 因为它同时被 factory/personal 两个分包引用——微信规则下"分包之间不能
// 互相引用私有文件，只有主包资源可被所有分包共享"，主包一度是唯一合法的
// 存放位置。但这会触发开发者工具"主包内不应存在主包未使用的JS文件"质量
// 扫描告警（主包自身从未 import 过这个文件）。为彻底消除该告警、同时把
// 这部分体积从主包移出，改为在每个消费方分包内各放一份独立拷贝（与
// recentPages.ts 在 admin/reports 两个分包各自维护一份是同一种既有惯例）。
//
// ⚠️ 与 subpackages/factory/utils/subscribeMessage.ts 是两处独立维护的
// 镜像，行为必须保持一致——改动一处记得同步另一处。
//
// ⚠️ SHIPPING_NOTICE_TEMPLATE_ID 是占位值（空字符串）：真实值需要在
// 「微信公众平台 -> 订阅消息 -> 我的模板」里申请"发货提醒"类目下的模板后
// 替换——这个字符串必须和 cloudfunctions/completeProductionOrder/index.js
// 里 SHIPPING_NOTICE_TEMPLATE_ID 环境变量配的是同一个模板 ID，两边分别配置
// （前端唤起授权用这份，后端云函数实际推送用环境变量那份），改动一处记得
// 同步另一处。未替换前本函数会直接跳过，不会弹出订阅授权框，也不会报错。
const SHIPPING_NOTICE_TEMPLATE_ID = '';

export function requestShippingNoticeSubscription(): Promise<void> {
  return new Promise((resolve) => {
    if (!SHIPPING_NOTICE_TEMPLATE_ID) {
      console.warn('[subscribeMessage] 发货通知模板 ID 未配置，跳过订阅授权弹窗');
      resolve();
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: [SHIPPING_NOTICE_TEMPLATE_ID],
      success: () => resolve(),
      fail: (err: any) => {
        // 用户点了"拒绝"、点了"总是保持以上，不再询问"、或本次调用异常，
        // 都只是拿不到订阅资格而已，不影响下单本身已经成功
        console.warn('[subscribeMessage] 用户未授权或调用失败（静默处理，不影响下单结果）:', err);
        resolve();
      }
    });
  });
}

// ⚠️ DAILY_REPORT_REMINDER_TEMPLATE_ID 同样是占位值：真实值需要在「微信公众平台 ->
// 订阅消息 -> 我的模板」申请"提醒通知"类目下的一次性/长期模板后替换，并与实际负责
// 定时推送的云函数（例如某个 scheduled trigger）里的模板 ID 环境变量保持一致——这里
// 只负责在用户打开设置页开关时唤起订阅授权弹窗，真正的每日定时推送逻辑不在本文件内。
// 未替换前本函数直接跳过，仅把开关状态持久化在本地，不会弹出授权框，也不会报错。
const DAILY_REPORT_REMINDER_TEMPLATE_ID = '';

export function requestDailyReportReminderSubscription(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!DAILY_REPORT_REMINDER_TEMPLATE_ID) {
      console.warn('[subscribeMessage] 每日餐报提醒模板 ID 未配置，跳过订阅授权弹窗（开关状态仍会正常保存）');
      resolve(true);
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: [DAILY_REPORT_REMINDER_TEMPLATE_ID],
      success: (res: any) => resolve(res[DAILY_REPORT_REMINDER_TEMPLATE_ID] === 'accept'),
      fail: (err: any) => {
        console.warn('[subscribeMessage] 每日餐报提醒订阅授权失败/被拒绝:', err);
        resolve(false);
      }
    });
  });
}
