import { isCloudAvailable } from '../../utils/cloudGuard';
import { callFunctionWithTimeout } from '../../utils/withTimeout';

// 🌸 近7日阳善榜：门店卡片专属、公开只读的短窗口滚动展示组件。
//
// 数据源固定为 getSunshineLedger 云函数——与 yangshan-wall（首页「☀️ 阳光账本」
// 入口的全历史阳善公开滚动墙）同一份公开只读查询，不做任何 user_roles/OPENID
// 权限校验，只按 storeId 硬性收窄。区别在于本组件只读云函数新增的
// latestDonorsWeekly 字段——服务端已经把"近 7×24 小时（Date.now()-7*86400*1000）
// 窗口内 + isAnonymous===false（阳善公开）"这两条过滤规则做完，本组件不需要也
// 不应该再自己做一次时间/匿名过滤，直接展示服务端给的结果即可。
//
// 组件自己独立发起云调用（不依赖宿主页面已经拉取过的数据），这样任何门店卡片
// 只要传入 storeId 就能直接使用。
Component({
  properties: {
    // 目标门店 ID：变更时自动重新拉取该店的近 7 日阳善榜
    storeId: {
      type: String,
      value: ''
    }
  },

  data: {
    loading: false,
    entries: [] as Array<{ name: string; deedText: string; timeLabel: string; amount: number }>
  },

  lifetimes: {
    attached() {
      if (this.properties.storeId) {
        this.fetchWeeklyBoard();
      }
    }
  },

  observers: {
    storeId(newStoreId: string) {
      if (newStoreId) {
        this.fetchWeeklyBoard();
      } else {
        // storeId 被清空（如宿主列表尚未解析出门店）时，清空展示，
        // 避免继续挂着上一家门店的榜单造成数据串店的错觉
        this.setData({ entries: [] });
      }
    }
  },

  methods: {
    async fetchWeeklyBoard() {
      const storeId = this.properties.storeId;
      if (!storeId || !isCloudAvailable()) return;

      this.setData({ loading: true });
      try {
        // 🐛 同 yangshan-wall 组件：getSunshineLedger 云函数已补上 timeout:20
        // （此前没配置字段走平台默认 3s，是"调用超时"的真实根因），客户端
        // 等待上限同步提到 25000ms，两边超时预算对齐
        const res: any = await callFunctionWithTimeout({
          name: 'getSunshineLedger',
          data: { storeId }
        }, 25000);
        const result = res?.result;
        if (!result?.success) return;

        this.setData({
          entries: Array.isArray(result.latestDonorsWeekly) ? result.latestDonorsWeekly : []
        });
      } catch (err) {
        // 🛡️ 静默降级：与 yangshan-wall 同一套处理——公开只读展示位失败时
        // 沿用既有空态展示，不打断用户，不留刺眼的控制台红色 error
        console.warn('[sunshine-board] 加载近7日阳善榜失败，已静默降级:', err);
      } finally {
        this.setData({ loading: false });
      }
    }
  }
});
