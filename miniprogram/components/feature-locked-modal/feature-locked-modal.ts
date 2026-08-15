// 统一的"功能受限"升级引导弹窗：多门店汇总看板/Excel 报表导出/月度财务审计表
// 导出等专业版专属功能触发时的拦截提示。原型是 pages/statistics/statistics.ts
// 里的 plan-upgrade-modal（现已迁移到本组件），收敛成一个可复用组件，避免每
// 新增一个受限功能入口就复制一遍同样的 WXML/WXSS/handler 三件套。
//
// 🛡️ 职责边界：这里只负责"告知受限 + 引导前往"，真正详细的"专业版/旗舰版
// 权益对比"卡片只在 pages/profile/profile.ts 的 showSubscriptionModal 维护
// 一份（唯一真源）——本组件"立即前往"按钮只是跳转过去 + 视情况自动唤起那张
// 卡片，不在这里重复一份权益列表文案，避免定价/权益说明散落多处逐渐漂移。
import { requestOpenSubscription } from '../../utils/subscriptionHandoff';

Component({
  options: {
    styleIsolation: 'apply-shared',
    addGlobalClass: true
  },

  properties: {
    visible: {
      type: Boolean,
      value: false
    },
    // 具体受限的功能名，拼进提示文案，如"Excel 报表导出"/"月度财务审计表导出"
    featureName: {
      type: String,
      value: '该功能'
    },
    // 大家长/超管本身就有权限直接开通套餐：确认按钮跳个人中心时自动唤起购买
    // 弹窗；其余角色只能联系大家长代为开通，跳个人中心后不强行弹出购买弹窗
    canSelfUpgrade: {
      type: Boolean,
      value: false
    }
  },

  methods: {
    noop() {
      // 阻止点击卡片内部时冒泡到外层遮罩触发关闭
    },

    onClose() {
      this.triggerEvent('close', {}, {});
    },

    onConfirm() {
      this.triggerEvent('close', {}, {});
      if (this.data.canSelfUpgrade) {
        requestOpenSubscription();
      }
      wx.switchTab({ url: '/pages/profile/profile' });
    }
  }
});
