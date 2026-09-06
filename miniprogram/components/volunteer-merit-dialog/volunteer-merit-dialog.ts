// 🌸 义工修心积善打卡·微善标签弹窗：到岗服务打卡成功后唤起的轻量补充记录，
// 纯精神修持与文化激励用途，不阻塞打卡本身（可直接"稍后再说"跳过）、不与
// 资金/订阅套餐/任何形式的商业积分挂钩，见 CLAUDE.md 第 7 节合规基线。
//
// 弹窗骨架参照 components/elder-checkin-modal 的 Component 生命周期/
// triggerEvent('submitted'/'close') 惯例；多选 chip 的 toggle 逻辑照抄
// pages/index/index.ts 里 reservedMeals 的 onToggleReservedMeal()。
// 各组件 styleIsolation 默认 isolated，样式各自维护一份，不共享样式实体。
//
// 落库走 cloudfunctions/manageVolunteerCheckIn 的 updateMeritTags action——
// 打卡记录本身已经在 handleCheckin 落地，这里只是补写 meritTags 字段，
// 与打卡是两次独立调用，标签选择失败/跳过都不影响打卡本身已经成功的事实。
//
// 两段式界面：selectedTags 提交成功后 submitted 翻转为 true，切到"已记录 +
// 生成今日善行日签"的确认态，而不是提交完立刻关闭——用户可能想顺手生成
// 一张海报分享。生成海报需要 Canvas 节点，本组件自身不持有 #posterCanvas
// （那个节点在宿主页面 index.wxml 里，供其余三张海报共用），所以生成动作
// 只 triggerEvent('generateposter', ...) 把已选标签的完整信息（value 无法
// 直接画到画布上，需要连同 label/emoji 一起交给宿主）抛给宿主页面，由宿主
// 调用 utils/posterGenerator.ts 的 drawMeritTagPoster()——与本组件不持有
// currentPlatformMode、只关闭自身弹窗 + 抛事件交给宿主处理，是同一种组件
// 职责边界设计（见 store-picker.ts 的 onSwitchWorkspace 同类写法）
import { callFunctionWithTimeout } from '../../utils/withTimeout';

interface MeritTagOption {
  value: string;
  label: string;
  emoji: string;
}

// 🐛 排查"标签点击无高亮反馈"：wxml 侧渲染用的 tagOptions 补一个预先算好的
// selected 布尔字段，不再在模板表达式里对 data 现算 selectedTags.includes(...)
// ——本仓库其它地方（index.wxml 的 reservedMeals.includes(...)）证明这类写法
// 基础库版本层面是支持的，静态审查也没找到确凿的 bug，但"在 JS 侧预先算好
// 布尔字段、wx:for 直接读字段"本就是社区公认更稳妥的写法，排除模板表达式
// 求值这条路径上的任何疑点，改动本身也是纯粹的健壮性加固，不会有副作用
interface MeritTagOptionView extends MeritTagOption {
  selected: boolean;
}

// 四个 value 必须与 cloudfunctions/manageVolunteerCheckIn/index.js 的
// MERIT_TAGS 白名单一一对应，两处独立部署、无共享模块机制，需手动同步
const MERIT_TAG_OPTIONS: MeritTagOption[] = [
  { value: 'almsgiving', label: '行堂布施', emoji: '🤲' },
  { value: 'kindwords', label: '和颜柔语', emoji: '😊' },
  { value: 'thrift', label: '惜福护物', emoji: '🍚' },
  { value: 'cleaning', label: '清扫庄严', emoji: '🧹' }
];

// 每次都用 .map() 产出全新数组（不是原地改某一项的 selected 属性）——保证
// wx:for 的差异对比一定能感知到变化，不依赖"引用不变但属性变了"这种更容易
// 被忽略的更新方式
function computeTagOptions(selectedTags: string[]): MeritTagOptionView[] {
  return MERIT_TAG_OPTIONS.map((o) => ({ ...o, selected: selectedTags.includes(o.value) }));
}

Component({
  properties: {
    visible: {
      type: Boolean,
      value: false
    },
    // 本次打卡在 volunteer_duty_logs 的云端 _id——为空说明这次打卡云端同步
    // 失败（见 manageVolunteerCheckIn 头部注释"尽力而为"降级），此时仍允许
    // 用户选标签，提交时如实提示"暂无法同步"，不假装成功
    logId: {
      type: String,
      value: ''
    }
  },

  data: {
    tagOptions: computeTagOptions([]) as MeritTagOptionView[],
    selectedTags: [] as string[],
    submitting: false,
    // 提交成功后翻转为 true，切换到"已记录 + 生成日签"确认态
    submitted: false,
    submittedTagObjects: [] as MeritTagOption[]
  },

  methods: {
    stopPropagation() {},

    resetForm() {
      this.setData({
        selectedTags: [],
        tagOptions: computeTagOptions([]),
        submitted: false,
        submittedTagObjects: []
      });
    },

    onToggleTag(e: any) {
      const value = e.currentTarget.dataset.value;
      if (!value) return;
      const current: string[] = this.data.selectedTags || [];
      const next = current.includes(value) ? current.filter((t: string) => t !== value) : [...current, value];
      this.setData({ selectedTags: next, tagOptions: computeTagOptions(next) });
    },

    onSkip() {
      if (this.data.submitting) return;
      this.resetForm();
      this.triggerEvent('close', {}, {});
    },

    // 提交成功后的确认态没有单独的"跳过"，直接复用 onClose——语义上此时
    // 用户已经记录成功，点击的只是"完成/关闭弹窗"，不再是"放弃填写"
    onClose() {
      if (this.data.submitting) return;
      this.resetForm();
      this.triggerEvent('close', {}, {});
    },

    async onSubmit() {
      if (this.data.submitting) return;

      const selectedTags: string[] = this.data.selectedTags || [];
      if (selectedTags.length === 0) {
        // 一个标签都没选等同于"跳过"，不发起一次空数组的云调用
        this.onSkip();
        return;
      }

      if (!this.data.logId) {
        wx.showToast({ title: '本次打卡暂未同步至云端，标签无法保存', icon: 'none' });
        this.resetForm();
        this.triggerEvent('close', {}, {});
        return;
      }

      this.setData({ submitting: true });
      try {
        const res: any = await callFunctionWithTimeout({
          name: 'manageVolunteerCheckIn',
          data: { action: 'updateMeritTags', logId: this.data.logId, meritTags: selectedTags }
        });
        const result = res.result;
        if (!result || !result.success) {
          wx.showToast({ title: (result && result.error) || '记录失败，请重试', icon: 'none' });
          return;
        }
        wx.showToast({ title: '已记录今日善行 🌸', icon: 'success' });
        const submittedTagObjects = MERIT_TAG_OPTIONS.filter((o) => selectedTags.includes(o.value));
        this.triggerEvent('submitted', { meritTags: selectedTags }, {});
        // 🐛 不在这里 triggerEvent('close')：切到确认态，让用户可以选择顺手
        // 生成一张日签海报，真正的关闭交给确认态里的"完成"按钮
        this.setData({ submitted: true, submittedTagObjects });
      } catch (err) {
        console.error('[volunteer-merit-dialog onSubmit] 提交异常:', err);
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      } finally {
        this.setData({ submitting: false });
      }
    },

    onGeneratePoster() {
      this.triggerEvent('generateposter', { tags: this.data.submittedTagObjects }, {});
    }
  }
});
