import { isCloudAvailable } from '../../utils/cloudGuard';
import { callFunctionWithTimeout } from '../../utils/withTimeout';

// 🌟 无数据兜底寄语：轮流展示几句语气温和、不带宗派色彩的通用善行寄语
// （与全站"去宗教化合规"口径一致，避免"因果""功德""轮回"这类特定信仰术语），
// 每次组件加载时随机挑一句，比恒定一句更不容易让人觉得是一段写死的占位符
const EMPTY_FALLBACK_MESSAGES = [
  '行善积德，福慧双增 · 愿一切善行皆得圆满',
  '一粥一饭，当思来处不易 · 感恩每一份爱心支持',
  '赠人玫瑰，手有余香 · 愿善意在这里持续流转'
];

// 🌸 阳善公开滚动墙：单店专属、全角色可见的公开只读展示组件。
//
// 数据源固定为 getSunshineLedger 云函数的 latestDonorsMonthly 字段——与
// sunshine-board（近7日）/ profile.ts 阳善纵向轮播（近3日）同一份公开只读
// 查询，只是读取窗口换成近 30 天（真实 30×24 小时，见 getSunshineLedger
// 头部注释），且已由服务端把善款(donationItems)与实物(materials)合并、按
// isAnonymous===false 过滤好，本组件不需要也不应该再自己做一次时间/匿名
// 过滤，直接展示服务端给的结果即可。
//
// 组件自己独立发起云调用（不依赖宿主页面已经拉取过的数据），这样任何页面
// 只要传入 storeId 就能直接使用，不需要额外接一遍 getSunshineLedger 调用链路。
Component({
  properties: {
    // 目标门店 ID：变更时自动重新拉取该店的阳善公开名单
    storeId: {
      type: String,
      value: ''
    },
    // 面板标题，允许宿主页面按场景定制文案（首页/个人页文案可能略有差异）。
    // 🌟 精简为短标签：单行紧凑布局下标题与内容区并排，"近30日阳善公开"这类
    // 说明性文字放进标题会顶宽左侧固定区、挤压右侧滚动内容的可用空间——
    // "近30天"这层时间范围信息本就隐含在数据来源里（getSunshineLedger
    // latestDonorsMonthly），不需要在寸土寸金的单行标签上重复强调
    title: {
      type: String,
      value: '✨ 最新善行'
    },
    // 🌟 无卡片模式：宿主页面把本组件嵌进自己的卡片容器（如首页顶部通知栏
    // 收纳，与阳光账本共用一张外壳）时，本组件不再需要自带的背景/边框/投影，
    // 否则会出现"卡中卡"的双层视觉。默认 false 保持组件独立使用时的原样式
    // （如 profile.wxml 的用法），不影响任何既有页面
    bare: {
      type: Boolean,
      value: false
    }
  },

  data: {
    loading: false,
    yangShanList: [] as Array<{ name: string; deedText: string; timeLabel: string; amount: number }>,
    // 🌟 空态兜底：list.length===0 时（含"从未有过阳善记录"与"近 30 天恰好
    // 没有"两种情况）自动切换为静态寄语，不再让整块组件从页面上消失——消失
    // 会让人误以为组件坏了/加载失败，一句寄语比空白更友好。emptyMessage 从
    // EMPTY_FALLBACK_MESSAGES 里随机挑一句，每次组件加载各自独立随机，
    // 不强求同一个页面上多个实例挑到同一句
    hasYangShanList: false,
    emptyMessage: EMPTY_FALLBACK_MESSAGES[0],
    // 🆕 点击某条善行弹出的轻量详情卡片：复用已有数据（name/deedText/
    // timeLabel/amount），不需要额外发起一次云调用去查"这条记录的更多信息"
    // ——服务端在 getSunshineLedger 阶段已经把能公开展示的信息给全了，
    // 详情卡片只是把同一份数据放大展示，不是导航去一个新页面
    showDetailModal: false,
    detailItem: null as null | { name: string; deedText: string; timeLabel: string; amount: number }
  },

  lifetimes: {
    attached() {
      this.setData({
        emptyMessage: EMPTY_FALLBACK_MESSAGES[Math.floor(Math.random() * EMPTY_FALLBACK_MESSAGES.length)]
      });
      if (this.properties.storeId) {
        this.fetchYangShanList();
      }
    }
  },

  observers: {
    storeId(newStoreId: string) {
      if (newStoreId) {
        this.fetchYangShanList();
      } else {
        // storeId 被清空（如宿主页面尚未解析出门店）时，清空展示，
        // 避免继续挂着上一个门店的名单造成数据串店的错觉
        this.setData({ yangShanList: [], hasYangShanList: false });
      }
    }
  },

  methods: {
    async fetchYangShanList() {
      const storeId = this.properties.storeId;
      if (!storeId || !isCloudAvailable()) return;

      this.setData({ loading: true });
      try {
        // 🐛（首页红色超时报错根因修复）getSunshineLedger/config.json 此前没有
        // timeout 字段，走平台默认 3s 执行上限——与 checkImageContent/
        // ocrExpenseReceipt 等云函数是完全同一类问题（见 -504003 根因排查），
        // 该云函数本身要串行查 report_logs/volunteer_duty_logs/user_roles 等
        // 多张表，冷启动下很容易超过 3s。现已给云函数配置补上 timeout:20，
        // 客户端等待上限同步从默认 8000ms 提到 25000ms，避免服务端窗口延长后
        // 客户端反而先一步判定"调用超时"
        const res: any = await callFunctionWithTimeout({
          name: 'getSunshineLedger',
          data: { storeId }
        }, 25000);
        const result = res.result;
        if (!result || !result.success) return;

        const yangShanList = Array.isArray(result.latestDonorsMonthly) ? result.latestDonorsMonthly : [];
        this.setData({
          yangShanList,
          hasYangShanList: yangShanList.length > 0
        });
      } catch (err) {
        // 🛡️ 静默降级：本组件是首页自动挂载即拉取的公开只读展示位，失败时
        // 直接沿用 hasYangShanList: false 的既有空态兜底文案（见 data 定义），
        // 不弹 toast/modal 打断用户，也不应该在控制台留一条刺眼的红色 error——
        // 网络波动导致的加载失败是预期内会发生的降级路径，不是真正需要开发者
        // 立即关注的异常，改用 console.warn 与"真正的异常"在控制台里区分开
        console.warn('[yangshan-wall] 加载阳善公开名单失败，已静默降级为空态兜底文案:', err);
      } finally {
        this.setData({ loading: false });
      }
    },

    // 🆕 点击某条善行：弹出轻量详情卡片（组件自身内部弹窗，不依赖宿主页面
    // 提供跳转目标）。donorIdx 与 WXML wx:for-index 对应，取当前展示的
    // yangShanList 里那一条的完整数据
    onTapDeedItem(e: any) {
      const index = e.currentTarget.dataset.index;
      const item = this.data.yangShanList[index];
      if (!item) return;
      this.setData({ showDetailModal: true, detailItem: item });
    },

    onCloseDeedDetail() {
      this.setData({ showDetailModal: false, detailItem: null });
    },

    // 弹窗卡片本身的点击不应该冒泡触发背景遮罩的关闭
    stopDeedDetailPropagation() {}
  }
});
