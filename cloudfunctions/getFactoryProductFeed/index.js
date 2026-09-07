// 云函数：getFactoryProductFeed — 方向 B：「工坊好物·爱心预售」跨租户商品发现
//
// 🏛️ 补的是"发现"这一环，不是新开一个可见性口子：manageProduct.get/list 早就是
// "任意登录用户"可查（见该云函数 exports.main，只校验 OPENID 存在，不校验角色/
// 租户成员身份），本函数只是把"必须先知道 tenantId+productId 才能看到某个商品"
// 的既有可见范围，变成"能被发现"——单个商品原本就能被任意登录用户看到，这里
// 只是聚合展示，不是把原本私密的数据公开出来。
//
// 🔑 跨租户查询写法参考 cloudfunctions/getStoreList/index.js 的
// handleDiscoverByOrgType：products.where({status:'active'}) 不带 tenantId
// 过滤，这是本仓库已有的"跨租户发现"先例，不是本函数首创的新模式。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { pickCardTheme } = require('./lib/pickCardTheme');

const FEED_LIMIT = 60;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  try {
    const productsRes = await db.collection('products')
      .where({ status: 'active' })
      .orderBy('createdAt', 'desc')
      .limit(FEED_LIMIT)
      .get();
    const products = productsRes.data || [];
    if (products.length === 0) return { success: true, products: [] };

    const tenantIds = [...new Set(products.map((p) => p.tenantId).filter(Boolean))];
    const productIds = products.map((p) => p._id);

    // 🐛 tenants 文档 _id 是自动生成的，tenantId 只是业务字段（见
    // createProductionSpace 的 add() 写法），不能用 _.in(tenantIds) 去匹配 _id——
    // 这里按业务字段 tenantId 查，同一批同时查出多个租户文档
    const [tenantsRes, batchesRes] = await Promise.all([
      tenantIds.length > 0
        ? db.collection('tenants').where({ tenantId: _.in(tenantIds) }).field({ tenantId: true, tenantName: true }).get().catch(() => ({ data: [] }))
        : Promise.resolve({ data: [] }),
      db.collection('group_buy_batches')
        .where({ productId: _.in(productIds), status: 'collecting' })
        .get()
        .catch(() => ({ data: [] }))
    ]);

    const tenantNameMap = {};
    (tenantsRes.data || []).forEach((t) => { tenantNameMap[t.tenantId] = t.tenantName || '未命名工坊'; });

    // 每个 productId 最多留一条拼团批次：同一批扫描里保留 committedQuantity 更大
    // 的那条（更接近"快成团"，对买家更有参考价值），不需要复杂排序
    const now = Date.now();
    const batchByProductId = {};
    (batchesRes.data || []).forEach((b) => {
      // M3 的 group_buy_batches.status 不会自动过期流转（只在写入时判断，见
      // liveFactoryCore.updateGroupBuyProgress 注释），这里服务端再按 deadlineAt
      // 兜底过滤掉名义上还是 collecting、实际已经过了截止时间的批次
      if (b.deadlineAt && new Date(b.deadlineAt).getTime() <= now) return;
      const existing = batchByProductId[b.productId];
      if (!existing || (b.committedQuantity || 0) > (existing.committedQuantity || 0)) {
        batchByProductId[b.productId] = b;
      }
    });

    const feed = products.map((p) => {
      const batch = batchByProductId[p._id];
      const theme = pickCardTheme(p._id);
      return {
        productId: p._id,
        tenantId: p.tenantId,
        workshopName: tenantNameMap[p.tenantId] || '未命名工坊',
        name: p.name,
        priceYuan: ((p.price || 0) / 100).toFixed(2),
        dailyCapacityLimit: p.dailyCapacityLimit || 0,
        cardEmoji: theme.emoji,
        cardColor: theme.color,
        groupBuyBatch: batch
          ? {
            tierThresholds: batch.tierThresholds || [],
            committedQuantity: batch.committedQuantity || 0
          }
          : null
      };
    });

    return { success: true, products: feed };
  } catch (err) {
    console.error('[getFactoryProductFeed] 异常:', err);
    return { success: false, error: err.message || '加载失败' };
  }
};
