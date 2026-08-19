// 云函数：backfillTenantBusinessType（一次性迁移脚本，仅供开发者在云开发控制台
// "云函数 -> 测试"手动触发一次，写法与 backfillTenantId 同一约定）
//
// 用途：多租户业务类型改造上线前，为存量 tenants 记录补齐 Step 1 新增的三个字段：
//   businessType: 'charity_canteen'（所有存量租户在改造前只可能是雨花公益/门店记账场景）
//   entityType:   'charity'
//   paymentMode:  'none'
//
// 🛡️ 只补默认值，不推断：三个字段缺一律按上面的默认值回填，绝不根据 tenantId/
// orgType 做任何"猜测式"分类（历史教训见 stores.orgType 那次误标 bug，本次严格
// 只做"缺失字段兜底"，不做跨字段推断）。live_factory 租户由 createProductionSpace
// 在创建时直接写入正确字段，永远不会落入本函数的"缺失"判定，不会被误改。
//
// 幂等：已带 businessType 字段的记录会被跳过，可安全重复执行。
// ⚠️ 本函数不做权限校验（与 backfillTenantId / createIndexes 等既有运维脚本约定
// 一致），仅供开发者手动调用，切勿在小程序前端暴露调用入口。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DEFAULTS = {
  businessType: 'charity_canteen',
  entityType: 'charity',
  paymentMode: 'none'
};

exports.main = async () => {
  try {
    let updated = 0;
    const batchSize = 100;
    const samples = []; // before/after 抽样，便于人工核对迁移结果

    while (true) {
      const res = await db.collection('tenants')
        .where({ businessType: _.exists(false) })
        .limit(batchSize)
        .get();

      const docs = res.data || [];
      if (docs.length === 0) break;

      await Promise.all(docs.map((doc) => {
        if (samples.length < 10) {
          samples.push({ tenantId: doc.tenantId || doc._id, before: {}, after: DEFAULTS });
        }
        return db.collection('tenants').doc(doc._id).update({ data: DEFAULTS });
      }));

      updated += docs.length;
      if (docs.length < batchSize) break;
    }

    return {
      success: true,
      message: '存量租户 businessType/entityType/paymentMode 回填完成',
      updated,
      samples
    };
  } catch (err) {
    console.error('[backfillTenantBusinessType] 迁移失败:', err);
    return { success: false, errMsg: err.message };
  }
};
