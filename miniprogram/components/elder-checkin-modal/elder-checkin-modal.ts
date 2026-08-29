// 👵 长辈代报餐与就餐签到——弹窗表单唯一实现，供首页金刚区（index.wxml）与
// 个人页【我的】义工现场服务工具（profile.wxml）共用。用法与
// daily-menu-modal/material-usage-modal 完全对称，见两者文件头部注释。
//
// 数据落点是 ledgerIngestionAdapter 云函数写入的独立 elder_checkin_logs
// 流水集合，不直接触碰 report_logs——把"代报人数体现到今日餐报"这件事交回
// 宿主页：本组件提交成功后只 triggerEvent('submitted', {mealType, proxyType,
// delta:1})，由宿主页把 delta 合并进当前表单内存态的 dineInSeniors/
// deliverySeniors 并重新走 recalcDiningStats()，效果等同于人工在表单里手动
// +1，不存在"后台异步字段与前端整份表单保存互相覆盖"的竞态（详见
// ledgerIngestionAdapter/index.js 头部注释）。
import { getSelectedStore } from '../../utils/storeManager';
import { elderCheckinManualAdapter } from '../../utils/inputPipeline';
import { callFunctionWithTimeout } from '../../utils/withTimeout';

interface ElderCandidate {
  elder_id: string;
  elder_name: string;
  elder_phone_masked: string;
  relationship: string;
}

type MealType = 'breakfast' | 'lunch' | 'dinner';
type ProxyType = 'VOLUNTEER_PROXY' | 'FAMILY_PROXY';

const MEAL_TYPE_OPTIONS: Array<{ value: MealType; label: string }> = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' }
];

const SERVICE_TYPE_OPTIONS = ['关爱陪伴', '送餐到家'];

interface ElderCheckinForm {
  phoneLast4: string;
  candidates: ElderCandidate[];
  selectedElderId: string;
  mealType: MealType;
  proxyType: ProxyType;
  serviceType: string;
  hours: string;
}

const BLANK_FORM: ElderCheckinForm = {
  phoneLast4: '',
  candidates: [],
  selectedElderId: '',
  mealType: 'lunch',
  proxyType: 'VOLUNTEER_PROXY',
  serviceType: '',
  hours: ''
};

Component({
  properties: {
    visible: {
      type: Boolean,
      value: false
    }
  },

  data: {
    searching: false,
    submitting: false,
    hasSearched: false,
    mealTypeOptions: MEAL_TYPE_OPTIONS,
    serviceTypeOptions: SERVICE_TYPE_OPTIONS,
    form: { ...BLANK_FORM } as ElderCheckinForm
  },

  methods: {
    stopPropagation() {},

    resetForm() {
      this.setData({ form: { ...BLANK_FORM }, hasSearched: false });
    },

    onClose() {
      if (this.data.submitting) return;
      this.triggerEvent('close', {}, {});
    },

    onPhoneLast4Input(e: any) {
      this.setData({ 'form.phoneLast4': e.detail.value, 'form.selectedElderId': '' });
    },

    async onSearchElder() {
      const phoneLast4 = (this.data.form.phoneLast4 || '').trim();
      if (!/^\d{4}$/.test(phoneLast4)) {
        wx.showToast({ title: '请输入长辈手机号后4位', icon: 'none' });
        return;
      }
      if (this.data.searching) return;

      this.setData({ searching: true });
      try {
        const activeStore = getSelectedStore();
        const res: any = await callFunctionWithTimeout({
          name: 'ledgerIngestionAdapter',
          data: {
            action: 'searchElder',
            storeId: (activeStore && activeStore.storeId) || '',
            phoneLast4
          }
        });
        const result = res.result;
        if (!result || !result.success) {
          wx.showToast({ title: (result && result.error) || '查询失败', icon: 'none' });
          this.setData({ 'form.candidates': [], hasSearched: true });
          return;
        }
        const candidates: ElderCandidate[] = (result.data && result.data.candidates) || [];
        this.setData({ 'form.candidates': candidates, 'form.selectedElderId': '', hasSearched: true });
        if (candidates.length === 0) {
          wx.showToast({ title: '未找到绑定的长辈，请先联系家属完成绑定', icon: 'none' });
        }
      } catch (err) {
        console.error('[elder-checkin-modal onSearchElder] 查询异常:', err);
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      } finally {
        this.setData({ searching: false });
      }
    },

    onSelectElder(e: any) {
      this.setData({ 'form.selectedElderId': e.currentTarget.dataset.id });
    },

    onSelectMealType(e: any) {
      this.setData({ 'form.mealType': e.currentTarget.dataset.value });
    },

    onSelectProxyType(e: any) {
      this.setData({ 'form.proxyType': e.currentTarget.dataset.value });
    },

    onSelectServiceType(e: any) {
      const value = e.currentTarget.dataset.value;
      // 再次点同一项 = 取消勾选，服务类项非必选
      this.setData({
        'form.serviceType': this.data.form.serviceType === value ? '' : value,
        'form.hours': this.data.form.serviceType === value ? '' : this.data.form.hours
      });
    },

    onHoursInput(e: any) {
      this.setData({ 'form.hours': e.detail.value });
    },

    async onSubmit() {
      if (this.data.submitting) return;

      const { selectedElderId, mealType, proxyType, serviceType, hours, candidates } = this.data.form;
      if (!selectedElderId) {
        wx.showToast({ title: '请先查询并勾选长辈', icon: 'none' });
        return;
      }
      if (serviceType && !(parseFloat(hours) > 0)) {
        wx.showToast({ title: '请填写服务时长（小时）', icon: 'none' });
        return;
      }

      const elder = candidates.find((c) => c.elder_id === selectedElderId);

      this.setData({ submitting: true });
      try {
        const activeStore = getSelectedStore();
        // 阶段二接入语音/OCR 时，只需新增 voiceAdapter/ocrElderAdapter 产出同样
        // 形状的 ElderCheckinPayload，这里的云调用点完全不用改（见 inputPipeline.ts）
        const payload = elderCheckinManualAdapter.normalize({
          selectedElderId,
          mealType,
          proxyType,
          serviceType,
          hours
        });
        const res: any = await callFunctionWithTimeout({
          name: 'ledgerIngestionAdapter',
          data: {
            action: 'checkin',
            storeId: (activeStore && activeStore.storeId) || '',
            ...payload
          }
        });
        const result = res.result;
        if (!result || !result.success) {
          wx.showToast({ title: (result && result.error) || '提交失败', icon: 'none' });
          return;
        }

        const creditedPoints = result.data && result.data.timebankCredited;
        wx.showToast({
          title: creditedPoints ? `签到成功，已记 ${creditedPoints.hours}小时工时` : '签到成功',
          icon: 'success'
        });
        this.triggerEvent('submitted', {
          mealType,
          proxyType,
          serviceType,
          delta: 1,
          elderName: (elder && elder.elder_name) || ''
        }, {});
        this.triggerEvent('close', {}, {});
      } catch (err) {
        console.error('[elder-checkin-modal onSubmit] 提交异常:', err);
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      } finally {
        this.setData({ submitting: false });
      }
    }
  }
});
