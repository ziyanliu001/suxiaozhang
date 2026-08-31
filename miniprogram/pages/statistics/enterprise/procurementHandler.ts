// 🏛️ Open-Core 架构拆分 · 终局阶段：爱心粮油集采直通车（Enterprise）
//
// 见 ./nationalDashboardService.ts 头部注释——本文件同样是被 spread 进
// statistics.ts Page({...}) 的方法集合，不是独立运行的模块。
//
// PLATFORM_SUPPORT_CONTACT 从 nationalDashboardService.ts 里 export 出来的
// 同一份拷贝导入，onConsultUpgrade（套餐升级咨询）与本文件（供应链集采
// 合作咨询）语义场景不同，但复用同一份平台联系方式常量，不各自重复维护
import { PLATFORM_SUPPORT_CONTACT } from './nationalDashboardService';

export const procurementHandlers = {
  // 🌾（2026-08-31 商业化生态延伸）爱心粮油源头集采直通车：卡片「提报集采
  // 意向 / 基地合作」按钮，弹出说明弹窗——不挂 isAdmin/isPatriarch 权限
  // 判断，任何能看到全国大屏的角色都能了解集采说明并登记意向，与
  // procurementSummary 本身"全角色可见、不挂订阅套餐"的口径保持一致
  onOpenProcurementModal() {
    if (!this.data.nationalData || !this.data.nationalData.procurementSummary) return;
    this.setData({ showProcurementModal: true });
  },

  onCloseProcurementModal() {
    this.setData({ showProcurementModal: false });
  },

  // 「登记合作意向」：产品原型阶段的轻量转化路径——复制集采对接联系方式，
  // 真正的意向表单/CRM 对接系统是独立的后续项目，本次不做，与
  // onConsultUpgrade 复用同一个平台联系方式常量，但语义场景不同（那是
  // "套餐升级咨询"，这是"供应链集采合作咨询"），不合并成同一个方法
  onRegisterProcurementIntent() {
    this.setData({ showProcurementModal: false });
    wx.setClipboardData({
      data: PLATFORM_SUPPORT_CONTACT.wechat,
      success: () => wx.showToast({ title: `已复制集采对接微信号：${PLATFORM_SUPPORT_CONTACT.wechat}，请添加好友沟通合作意向`, icon: 'none', duration: 3000 })
    });
  }
};
