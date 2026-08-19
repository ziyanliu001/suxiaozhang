// 云函数：migrateLiveFactoryMembers（一次性迁移脚本，仅供开发者在云开发控制台
// "云函数 -> 测试"手动触发一次，写法与 backfillTenantId/backfillTenantBusinessType
// 同一约定）
//
// 用途：修复一个真实存在过的设计失误——createProductionSpace/manageWorkspaceInvite
// 早期把 live_factory 的成员记录（role: space_owner/space_admin/producer/promoter）
// 写进了 user_roles 集合。这个集合被雨花公益专区 ~50 个云函数用
// db.collection('user_roles').where({_openid}).limit(1)（不带角色过滤）解析
// "当前用户的雨花角色"，混入的 live_factory 记录会导致同时拥有雨花角色和产销
// 工坊角色的账号被随机命中到错误的记录，雨花侧权限判断静默错乱。
//
// 本函数把 user_roles 里所有 live_factory 角色值的记录搬到独立的 tenant_members
// 集合（字段形状不变），再从 user_roles 里删除——之后 createProductionSpace/
// manageWorkspaceInvite/verifyTenantAccess 均已改为直接读写 tenant_members，
// 不会再产生新的混入记录，本函数只处理历史遗留数据。
//
// 角色值本身就是可靠的筛选依据：space_owner/space_admin/producer/promoter 这
// 四个字符串在雨花角色体系（super_admin/store_manager/store_patriarch/finance/
// volunteer/platform_admin/store_family）里完全不存在，不会误伤雨花数据。
//
// 幂等：搬完即删，重复执行时 user_roles 里已经找不到匹配记录，天然收敛。
// ⚠️ 本函数不做权限校验（与 backfillTenantId 等既有运维脚本约定一致），仅供
// 开发者手动调用，切勿在小程序前端暴露调用入口。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const LIVE_FACTORY_ROLES = ['space_owner', 'space_admin', 'producer', 'promoter'];

exports.main = async () => {
  try {
    let migrated = 0;
    const batchSize = 100;
    const samples = []; // 抽样最多 10 条，便于人工核对迁移结果

    while (true) {
      const res = await db.collection('user_roles')
        .where({ role: _.in(LIVE_FACTORY_ROLES) })
        .limit(batchSize)
        .get();

      const docs = res.data || [];
      if (docs.length === 0) break;

      await Promise.all(docs.map(async (doc) => {
        const { _id, ...rest } = doc;
        await db.collection('tenant_members').add({ data: rest });
        await db.collection('user_roles').doc(_id).remove();
        if (samples.length < 10) {
          samples.push({ openid: doc._openid, tenantId: doc.tenantId || '', role: doc.role });
        }
      }));

      migrated += docs.length;
      if (docs.length < batchSize) break;
    }

    return {
      success: true,
      message: 'user_roles 中混入的 live_factory 成员记录已迁移至 tenant_members',
      migrated,
      samples
    };
  } catch (err) {
    console.error('[migrateLiveFactoryMembers] 迁移失败:', err);
    return { success: false, errMsg: err.message };
  }
};
