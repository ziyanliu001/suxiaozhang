// 🌾 登记物资消耗与报损——弹窗表单唯一实现，供首页金刚区（index.wxml）与个人页
// 【我的】义工现场服务工具（profile.wxml）共用。用法与 daily-menu-modal 完全对称，
// 见该组件文件头部注释
import { getSelectedStore } from '../../utils/storeManager';
import { checkContentSafety } from '../../utils/contentSafety';
import { callFunctionWithTimeout } from '../../utils/withTimeout';
import { isCloudAvailable } from '../../utils/cloudGuard';
import { playOcrSuccess } from '../../utils/audioService';

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
    },
    // 🆕 宿主页面当前已知的最新大米/食用油库存状态（如首页 stapleRiceStatus/
    // stapleOilStatus，来自 fetchLatestMaterialStatus）。resetForm() 打开一张
    // 全新登记表单时用它做初始高亮，而不是硬编码猜一个默认值——避免义工没
    // 意识去重新点选胶囊、就直接提交，把真实的"告急"状态静默覆盖回默认的
    // "充足"。宿主页面若拿不到当前状态（如个人页），保持不传，退回原默认值
    currentRiceStatus: {
      type: String,
      value: ''
    },
    currentOilStatus: {
      type: String,
      value: ''
    }
  },

  data: {
    submitting: false,
    // 🆕（2026-08-31 AI 拍照识票）拍照识别进行中——与 submitting 分开维护，
    // 识别期间禁用"拍照智能识票"按钮本身，不影响用户同时手动填写其它字段
    scanningReceipt: false,
    form: { ...BLANK_FORM } as MaterialUsageForm
  },

  methods: {
    stopPropagation() {},

    resetForm() {
      // 🆕 用宿主页面传入的当前实际库存状态做初始高亮（见 properties 注释）；
      // 未传值（如个人页场景）时退回原有硬编码默认值，行为不变
      const riceStatus = (this.data.currentRiceStatus as StockStatus) || BLANK_FORM.riceStatus;
      const oilStatus = (this.data.currentOilStatus as StockStatus) || BLANK_FORM.oilStatus;
      this.setData({ form: { ...BLANK_FORM, riceStatus, oilStatus } });
      // 🆕 清空上一次可能残留的 OCR 溯源信息——组件实例跨多次打开复用，不清空
      // 会导致这一次明明是纯手工填写，提交时却把上一次拍照识别的 ocrMetadata
      // 也一并带上，误导审核方以为这批数据是拍照自动识别的
      (this as any)._ocrSourceFileId = '';
      (this as any)._ocrParsedItemCount = 0;
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
      (this as any)._ocrSourceFileId = '';
      (this as any)._ocrParsedItemCount = 0;
    },

    // 🌱（2026-08-31 AI 拍照识票）「拍照智能识票」：拍一张采买小票，自动识别
    // 大米/面粉/食用油/蔬菜的重量并回填对应输入框，消除长者/义工手动换算
    // 斤两、逐项誊抄的录入壁垒。复用既有 ocrExpenseReceipt 云函数（本次已
    // 扩展支持食材重量提取，见该云函数头部注释），不新建一套 OCR 云函数——
    // 与 pages/index/index.ts 的 onScanReceiptPhoto（financial 用途，批量
    // 多张、聚焦金额）是同一个 OCR 引擎的两种不同前端消费方式，各自独立
    // 维护交互流程，互不影响
    async onScanMaterialReceipt() {
      if (this.data.scanningReceipt || this.data.submitting) return;
      if (!isCloudAvailable()) {
        wx.showToast({ title: '云服务暂不可用，无法使用拍照识别', icon: 'none' });
        return;
      }

      let tempFilePath = '';
      try {
        const chooseRes = await wx.chooseMedia({
          count: 1,
          mediaType: ['image'],
          sourceType: ['album', 'camera'],
          sizeType: ['compressed']
        });
        if (!chooseRes.tempFiles || chooseRes.tempFiles.length === 0) return;
        tempFilePath = chooseRes.tempFiles[0].tempFilePath;
      } catch (err) {
        // 用户取消选图，静默返回，不提示错误
        return;
      }

      this.setData({ scanningReceipt: true });
      wx.showLoading({ title: '图片合规核验中...', mask: true });

      try {
        // 🛡️ 与首页拍照识票同一套合规校验：上传前先过内容安全检测，
        // 不合规直接拦截，不进入 OCR
        const fs = wx.getFileSystemManager();
        const base64Data = fs.readFileSync(tempFilePath, 'base64') as string;
        const checkRes = await callFunctionWithTimeout({
          name: 'checkImageContent',
          data: { imgBuffer: base64Data, contentType: 'image/jpeg' }
        });
        const checkResult = checkRes.result as any;
        if (checkResult && checkResult.isSafe === false) {
          wx.hideLoading();
          wx.showModal({
            title: '⚠️ 违规内容拦截',
            content: '系统检测到您选择的图片包含不合规、敏感或非法广告内容，已被全量阻断，请重新拍摄上传真实合规小票！',
            showCancel: false,
            confirmColor: '#D32F2F'
          });
          return;
        }

        wx.showLoading({ title: 'AI 识别中...', mask: true });
        const uploadRes = await wx.cloud.uploadFile({
          cloudPath: `receipts/material_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`,
          filePath: tempFilePath
        });

        const ocrRes = await callFunctionWithTimeout({
          name: 'ocrExpenseReceipt',
          data: { fileID: uploadRes.fileID }
        });
        const result = ocrRes.result as any;
        wx.hideLoading();

        const ingredients = result && result.ingredients;
        const hasAnyWeight = !!ingredients && (ingredients.riceKg > 0 || ingredients.flourKg > 0 || ingredients.oilKg > 0 || ingredients.veggieKg > 0);
        if (!hasAnyWeight) {
          wx.showModal({
            title: '未识别到食材重量',
            content: '照片里没有认出标注了斤/kg重量的大米、面粉、食用油或蔬菜品类，请手动填写，或换一张能同时看清品名与重量数字的照片重试。',
            showCancel: false
          });
          return;
        }

        // 云函数返回的是标准公斤（riceKg 等），表单单位是斤——斤=公斤×2
        const toJin = (kg: number): string => (kg > 0 ? String(Math.round(kg * 2 * 10) / 10) : '');
        const patch: Record<string, string> = {};
        const filledLabels: string[] = [];
        if (ingredients.riceKg > 0) { patch['form.riceCount'] = toJin(ingredients.riceKg); filledLabels.push('大米'); }
        if (ingredients.flourKg > 0) { patch['form.flourCount'] = toJin(ingredients.flourKg); filledLabels.push('面粉'); }
        if (ingredients.oilKg > 0) { patch['form.oilCount'] = toJin(ingredients.oilKg); filledLabels.push('食用油'); }
        if (ingredients.veggieKg > 0) { patch['form.vegetableCount'] = toJin(ingredients.veggieKg); filledLabels.push('蔬菜'); }

        this.setData(patch);
        (this as any)._ocrSourceFileId = uploadRes.fileID;
        (this as any)._ocrParsedItemCount = Array.isArray(result.parsedItems) ? result.parsedItems.length : 0;

        // 🌟 长者友好：醒目 Toast + 较长展示时长，明确告知"哪几项被自动填了"，
        // 支持在下方输入框里手动微调，不强制信任 OCR 结果
        wx.showToast({ title: `已自动填入${filledLabels.join('/')}重量，请核对`, icon: 'none', duration: 3500 });

        // 🔊 后厨语音与音效无感反馈：双手沾着食材/正在称重时不方便看手机，
        // 一声清脆确认音 + 轻震动示意"识别完成"。summaryText 摘要文案与上面
        // Toast 同源拼装，见 audioService.playOcrSuccess 头部注释——当前只
        // 记录日志、不做真正的语音播报（小程序没有内置任意文本 TTS 能力）
        const summaryParts = filledLabels.map((label) => {
          const fieldMap: Record<string, string> = { 大米: 'form.riceCount', 面粉: 'form.flourCount', 食用油: 'form.oilCount', 蔬菜: 'form.vegetableCount' };
          const field = fieldMap[label];
          return field && patch[field] ? `${label}${patch[field]}斤` : label;
        });
        playOcrSuccess(`已识别${summaryParts.join('、')}`);
      } catch (err) {
        console.error('[material-usage-modal onScanMaterialReceipt] 识别失败:', err);
        wx.showToast({ title: '识别失败，请手动填写', icon: 'none' });
      } finally {
        wx.hideLoading();
        this.setData({ scanningReceipt: false });
      }
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
        // 🆕（2026-08-31 AI 拍照识票）本次填报若经过拍照识别自动回填过任意一项
        // （_ocrSourceFileId 非空），随提交一并记下 ocrMetadata 溯源信息；纯手工
        // 填写时这三个字段本就是空/0，不携带这个字段，与 dataService.ts
        // saveReport() 的 report_logs.ocrMetadata 未提供时落 null 同一口径
        const ocrSourceFileId = (this as any)._ocrSourceFileId || '';
        const ocrMetadata = ocrSourceFileId ? {
          sourceImageUrl: ocrSourceFileId,
          parsedItemCount: (this as any)._ocrParsedItemCount || 0,
          isAutoFilled: true
        } : undefined;

        const res: any = await callFunctionWithTimeout({
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
            storeName: (activeStore && activeStore.storeName) || '',
            ...(ocrMetadata ? { ocrMetadata } : {})
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
        (this as any)._ocrSourceFileId = '';
        (this as any)._ocrParsedItemCount = 0;
      } catch (err) {
        console.error('[material-usage-modal onSubmit] 提交异常:', err);
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      } finally {
        this.setData({ submitting: false });
      }
    }
  }
});
