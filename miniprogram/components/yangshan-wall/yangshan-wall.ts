import { isCloudAvailable } from '../../utils/cloudGuard';

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
    }
  },

  data: {
    loading: false,
    yangShanList: [] as Array<{ name: string; deedText: string; timeLabel: string; amount: number }>,
    // 🌟 空态兜底：list.length===0 时（含"从未有过阳善记录"与"近 30 天恰好
    // 没有"两种情况）自动切换为静态寄语，不再让整块组件从页面上消失——消失
    // 会让人误以为组件坏了/加载失败，一句寄语比空白更友好
    hasYangShanList: false
  },

  lifetimes: {
    attached() {
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
        const res: any = await wx.cloud.callFunction({
          name: 'getSunshineLedger',
          data: { storeId }
        });
        const result = res.result;
        if (!result || !result.success) return;

        const yangShanList = Array.isArray(result.latestDonorsMonthly) ? result.latestDonorsMonthly : [];
        this.setData({
          yangShanList,
          hasYangShanList: yangShanList.length > 0
        });
      } catch (err) {
        console.error('[yangshan-wall] 加载阳善公开名单失败:', err);
      } finally {
        this.setData({ loading: false });
      }
    }
  }
});
