// 🌾 登记物资消耗与报损——弹窗表单唯一实现，供首页金刚区（index.wxml）与个人页
// 【我的】义工现场服务工具（profile.wxml）共用。用法与 daily-menu-modal 完全对称，
// 见该组件文件头部注释
import { getSelectedStore } from '../../utils/storeManager';
import { checkContentSafety } from '../../utils/contentSafety';

type StockStatus = 'sufficient' | 'normal' | 'urgent';

interface MaterialUsageForm {
  riceCount: string;
  flourCount: string;
  oilCount: string;
  vegetableCount: string;
  lossNote: string;
  // 🌟 大米/食用油库存状态：单轨制改造后，这是全店唯一能设置该状态的地方
  // （原"填写今日明细"表单里的重复选择器已移除），首页依赖这里最近一次
  // 提交的值展示"今日餐况"的充足/一般/告急标签
  riceStatus: StockStatus;
  oilStatus: StockStatus;
}

const BLANK_FORM: MaterialUsageForm = {
  riceCount: '',
  flourCount: '',
  oilCount: '',
  vegetableCount: '',
  lossNote: '',
  riceStatus: 'normal',
  oilStatus: 'sufficient'
};

Component({
  properties: {
    visible: {
      type: Boolean,
      value: false
    },
    // 是否按"免二次审核"角色展示提示文案——真正的免审批判定始终由服务端
    // manageVolunteerSubmission 云函数按登录者真实角色重新核定，这里仅影响文案
    isAutoApproveRole: {
      type: Boolean,
      value: false
    }
  },

  data: {
    submitting: false,
    form: { ...BLANK_FORM } as MaterialUsageForm
  },

  methods: {
    stopPropagation() {},

    resetForm() {
      this.setData({ form: { ...BLANK_FORM } });
    },

    // 把一条已驳回记录的原始数据带回表单，供"重新修改并提交"入口调用
    presetForm(item: {
      riceCount?: number;
      flourCount?: number;
      oilCount?: number;
      vegetableCount?: number;
      lossNote?: string;
      riceStatus?: StockStatus;
      oilStatus?: StockStatus;
    }) {
      const toStr = (v: number | undefined) => (v || v === 0) ? String(v) : '';
      this.setData({
        form: {
          riceCount: toStr(item.riceCount),
          flourCount: toStr(item.flourCount),
          oilCount: toStr(item.oilCount),
          vegetableCount: toStr(item.vegetableCount),
          lossNote: item.lossNote || '',
          riceStatus: item.riceStatus || 'normal',
          oilStatus: item.oilStatus || 'sufficient'
        }
      });
    },

    onClose() {
      if (this.data.submitting) return;
      this.triggerEvent('close', {}, {});
    },

    onRiceCountInput(e: any) {
      this.setData({ 'form.riceCount': e.detail.value });
    },

    onFlourCountInput(e: any) {
      this.setData({ 'form.flourCount': e.detail.value });
    },

    onOilCountInput(e: any) {
      this.setData({ 'form.oilCount': e.detail.value });
    },

    onVegetableCountInput(e: any) {
      this.setData({ 'form.vegetableCount': e.detail.value });
    },

    onLossNoteInput(e: any) {
      this.setData({ 'form.lossNote': e.detail.value });
    },

    onSelectRiceStatus(e: any) {
      this.setData({ 'form.riceStatus': e.currentTarget.dataset.value });
    },

    onSelectOilStatus(e: any) {
      this.setData({ 'form.oilStatus': e.currentTarget.dataset.value });
    },

    async onSubmit() {
      if (this.data.submitting) return;

      const { riceCount, flourCount, oilCount, vegetableCount, lossNote, riceStatus, oilStatus } = this.data.form;
      if (!riceCount && !flourCount && !oilCount && !vegetableCount && !(lossNote || '').trim()) {
        wx.showToast({ title: '请至少填写一项消耗或报损说明', icon: 'none' });
        return;
      }

      // 🛡️ 防错机制：提交前二次核对数据，避免手滑填错斤数就直接交给店长审核——
      // 只有点击"确认提交"才继续往下走，"返回修改"原样留在当前表单，不清空已填内容
      const confirmed = await new Promise<boolean>((resolve) => {
        wx.showModal({
          title: '请核对物资产量与消耗',
          content: `大米: ${riceCount || 0} 斤\n面粉: ${flourCount || 0} 斤\n食用油: ${oilCount || 0} 斤\n蔬菜: ${vegetableCount || 0} 斤\n\n确认无误并提交吗？`,
          confirmText: '确认提交',
          cancelText: '返回修改',
          success: (res) => resolve(!!res.confirm),
          fail: () => resolve(false)
        });
      });
      if (!confirmed) return;

      this.setData({ submitting: true });

      const note = (lossNote || '').trim();
      if (note) {
        const safe = await checkContentSafety(note);
        if (!safe) {
          this.setData({ submitting: false });
          return;
        }
      }

      try {
        const activeStore = getSelectedStore();
        const res: any = await wx.cloud.callFunction({
          name: 'manageVolunteerSubmission',
          data: {
            action: 'submit',
            type: 'material',
            riceCount,
            flourCount,
            oilCount,
            vegetableCount,
            lossNote: note,
            riceStatus,
            oilStatus,
            storeId: (activeStore && activeStore.storeId) || '',
            storeName: (activeStore && activeStore.storeName) || ''
          }
        });
        const result = res.result;
        if (!result || !result.success) {
          wx.showToast({ title: (result && result.error) || '提交失败', icon: 'none' });
          return;
        }

        // 🏛️ 与 daily-menu-modal 同理：以服务端 result.autoApproved 为准决定提示语
        wx.showToast({
          title: result.autoApproved ? (result.message || '管理者数据已自动采纳并更新账本') : '已提交，待店长确认',
          icon: 'success'
        });
        this.triggerEvent('submitted', { autoApproved: !!result.autoApproved }, {});
        this.triggerEvent('close', {}, {});
      } catch (err) {
        console.error('[material-usage-modal onSubmit] 提交异常:', err);
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      } finally {
        this.setData({ submitting: false });
      }
    }
  }
});
