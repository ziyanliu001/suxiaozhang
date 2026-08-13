import { isCloudAvailable } from '../../utils/cloudGuard';

// 🌸 阳善公开滚动墙：单店专属、全角色可见的公开只读展示组件。
//
// 数据源固定为 getSunshineLedger 云函数——与首页「☀️ 阳光账本」入口同一套
// 公开只读查询，不做任何 user_roles/OPENID 权限校验，只按 storeId 硬性收窄
// （不支持"全部门店"聚合参数），服务端已只挑 isAnonymous===false 的报表明细
// 收进 latestDonors，本组件不需要也不应该再自己做一次 isAnonymous 过滤。
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
    // 面板标题，允许宿主页面按场景定制文案（首页/个人页文案可能略有差异）
    title: {
      type: String,
      value: '✨ 最新爱心支持（阳善公开）'
    }
  },

  data: {
    loading: false,
    donors: [] as Array<{ name: string; amount: number; timeLabel: string }>
  },

  lifetimes: {
    attached() {
      if (this.properties.storeId) {
        this.fetchDonors();
      }
    }
  },

  observers: {
    storeId(newStoreId: string) {
      if (newStoreId) {
        this.fetchDonors();
      } else {
        // storeId 被清空（如宿主页面尚未解析出门店）时，清空展示，
        // 避免继续挂着上一个门店的名单造成数据串店的错觉
        this.setData({ donors: [] });
      }
    }
  },

  methods: {
    async fetchDonors() {
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

        this.setData({
          donors: Array.isArray(result.latestDonors) ? result.latestDonors.slice(0, 8) : []
        });
      } catch (err) {
        console.error('[yangshan-wall] 加载阳善公开名单失败:', err);
      } finally {
        this.setData({ loading: false });
      }
    }
  }
});
