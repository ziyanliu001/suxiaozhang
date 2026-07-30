// 🍱 登记今日菜单与人数——弹窗表单唯一实现，供首页金刚区（index.wxml）与个人页
// 【我的】义工现场服务工具（profile.wxml）共用，避免同一套表单状态/提交/校验
// 逻辑在两个页面各写一份、后续改动两头都要同步却容易漏改一头。
//
// 使用方需要：
// - 传入 visible（控制显隐）与 isAutoApproveRole（当前登录者是否店长/家长/超管，
//   仅用于提交前的提示文案，真正的免审批判定始终以服务端 caller.role 为准）
// - 监听 close 事件，自己把 visible 对应的 data 字段置回 false
// - 打开前调用组件暴露的 resetForm()（全新登记）或 presetForm(item)（把一条已驳回
//   记录的原始数据带回来重新修改），见 profile.ts onOpenDailyMenuModal / onTapMyVolunteerSubmissionItem
import { getSelectedStore } from '../../utils/storeManager';
import { checkContentSafety } from '../../utils/contentSafety';

type MealStatus = 'open' | 'closed';

interface DailyMenuForm {
  mealStatus: MealStatus;
  breakfastCount: string;
  lunchCount: string;
  dinnerCount: string;
  menuNote: string;
}

const BLANK_FORM: DailyMenuForm = {
  mealStatus: 'open',
  breakfastCount: '',
  lunchCount: '',
  dinnerCount: '',
  menuNote: ''
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
    form: { ...BLANK_FORM } as DailyMenuForm
  },

  methods: {
    stopPropagation() {},

    resetForm() {
      this.setData({ form: { ...BLANK_FORM } });
    },

    // 把一条已驳回记录的原始数据带回表单，供"重新修改并提交"入口调用
    presetForm(item: {
      mealStatus?: string;
      breakfastCount?: number;
      lunchCount?: number;
      dinnerCount?: number;
      menuNote?: string;
    }) {
      const toStr = (v: number | undefined) => (v || v === 0) ? String(v) : '';
      this.setData({
        form: {
          mealStatus: item.mealStatus === 'closed' ? 'closed' : 'open',
          breakfastCount: toStr(item.breakfastCount),
          lunchCount: toStr(item.lunchCount),
          dinnerCount: toStr(item.dinnerCount),
          menuNote: item.menuNote || ''
        }
      });
    },

    onClose() {
      if (this.data.submitting) return;
      this.triggerEvent('close', {}, {});
    },

    onSelectMealStatus(e: any) {
      const status = e.currentTarget.dataset.status;
      this.setData({ 'form.mealStatus': status });
    },

    onBreakfastCountInput(e: any) {
      this.setData({ 'form.breakfastCount': e.detail.value });
    },

    onLunchCountInput(e: any) {
      this.setData({ 'form.lunchCount': e.detail.value });
    },

    onDinnerCountInput(e: any) {
      this.setData({ 'form.dinnerCount': e.detail.value });
    },

    onMenuNoteInput(e: any) {
      this.setData({ 'form.menuNote': e.detail.value });
    },

    async onSubmit() {
      if (this.data.submitting) return;

      const { mealStatus, breakfastCount, lunchCount, dinnerCount, menuNote } = this.data.form;
      if (mealStatus === 'open' && !breakfastCount && !lunchCount && !dinnerCount) {
        wx.showToast({ title: '请至少填写一餐人数', icon: 'none' });
        return;
      }

      // 🛡️ 防错机制：提交前二次核对数据，避免手滑填错人数就直接交给店长审核——
      // 只有点击"确认提交"才继续往下走，"返回修改"原样留在当前表单，不清空已填内容
      const confirmed = await new Promise<boolean>((resolve) => {
        wx.showModal({
          title: '请核对餐报数据',
          content: `早餐: ${breakfastCount || 0} 人\n午餐: ${lunchCount || 0} 人\n晚餐: ${dinnerCount || 0} 人\n\n确认无误并提交吗？`,
          confirmText: '确认提交',
          cancelText: '返回修改',
          success: (res) => resolve(!!res.confirm),
          fail: () => resolve(false)
        });
      });
      if (!confirmed) return;

      this.setData({ submitting: true });

      const note = (menuNote || '').trim();
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
            type: 'menu',
            mealStatus,
            breakfastCount,
            lunchCount,
            dinnerCount,
            menuNote: note,
            storeId: (activeStore && activeStore.storeId) || '',
            storeName: (activeStore && activeStore.storeName) || ''
          }
        });
        const result = res.result;
        if (!result || !result.success) {
          wx.showToast({ title: (result && result.error) || '提交失败', icon: 'none' });
          return;
        }

        // 🏛️ 店长/家长/超管本人填报免二次审核：服务端会按登录者的真实角色自动
        // 判断是否直接采纳入库，result.autoApproved 如实反映服务端的处理结果，
        // 据此决定提示语，不在前端自行猜测
        wx.showToast({
          title: result.autoApproved ? (result.message || '管理者数据已自动采纳并更新账本') : '已提交，待店长确认',
          icon: 'success'
        });
        this.triggerEvent('submitted', { autoApproved: !!result.autoApproved }, {});
        this.triggerEvent('close', {}, {});
      } catch (err) {
        console.error('[daily-menu-modal onSubmit] 提交异常:', err);
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      } finally {
        this.setData({ submitting: false });
      }
    }
  }
});
