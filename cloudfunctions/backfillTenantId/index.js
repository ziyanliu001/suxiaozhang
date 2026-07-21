// 云函数：backfillTenantId（一次性迁移脚本，仅供开发者在云开发控制台"云函数 -> 测试"手动触发一次）
//
// 用途：多租户改造上线前，为存量数据补齐 tenantId：
// 1. 若不存在默认租户，则创建一个"默认机构（历史数据迁移）"作为存量数据的归属租户；
// 2. 为尚未打上 tenantId 的 stores / user_roles / report_logs 记录补上该默认租户 ID。
//
// 幂等：已带 tenantId 的记录会被跳过，可安全重复执行。
// ⚠️ 本函数不做权限校验（与 createIndexes / cleanDevData 等既有运维脚本约定一致），
// 仅供开发者通过云开发控制台手动调用，切勿在小程序前端暴露调用入口。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DEFAULT_TENANT_NAME = '默认机构（历史数据迁移）';

async function ensureDefaultTenant() {
  const existing = await db.collection('tenants').where({ name: DEFAULT_TENANT_NAME }).limit(1).get();
  if (existing.data && existing.data.length > 0) {
    return existing.data[0]._id;
  }

  const created = await db.collection('tenants').add({
    data: {
      name: DEFAULT_TENANT_NAME,
      contactName: '',
      contactPhone: '',
      status: 'active',
      createdAt: db.serverDate(),
      createdBy: 'system_backfill'
    }
  });
  return created._id;
}

async function backfillCollection(collectionName, tenantId) {
  let updated = 0;
  const batchSize = 100;

  while (true) {
    const res = await db.collection(collectionName)
      .where({ tenantId: _.exists(false) })
      .limit(batchSize)
      .get();

    const docs = res.data || [];
    if (docs.length === 0) break;

    await Promise.all(docs.map(doc =>
      db.collection(collectionName).doc(doc._id).update({ data: { tenantId } })
    ));

    updated += docs.length;
    if (docs.length < batchSize) break;
  }

  return updated;
}

exports.main = async () => {
  try {
    const tenantId = await ensureDefaultTenant();

    const [storesUpdated, userRolesUpdated, reportLogsUpdated] = await Promise.all([
      backfillCollection('stores', tenantId),
      backfillCollection('user_roles', tenantId),
      backfillCollection('report_logs', tenantId)
    ]);

    return {
      success: true,
      tenantId,
      message: '存量数据 tenantId 回填完成',
      updated: { stores: storesUpdated, user_roles: userRolesUpdated, report_logs: reportLogsUpdated }
    };
  } catch (err) {
    console.error('[backfillTenantId] 迁移失败:', err);
    return { success: false, errMsg: err.message };
  }
};
