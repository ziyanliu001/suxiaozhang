// 云函数：dailyTenantSnapshotCron — 大数据量性能治理 Phase 1：日度餐报/物资
// 预聚合快照定时写入。
//
// 🛡️ 语义边界（重要）：本函数只负责"把昨天每家门店的核心指标预先算好、
// 写进 daily_tenant_snapshots"，**不**修改 getNationalDashboard 的读路径——
// 那是需要设计"历史快照 + 当天实时增量"混合查询模式的第二阶段，属于更大
// 范围的改动，本次不做，如实标注（见 docs/SCHEMA.md 8.2 节）。
//
// 🌟 幂等：确定性 _id（buildSnapshotId）+ set()（覆写而不是 add()），同一天
// 重复触发（如手动补跑排查数据）不会产生重复快照。
//
// 🌟 单店失败不影响其余：与 liveFactorySettlementCron 同一套"扫描容错"
// 原则——用 Promise.allSettled 分批处理，任一门店聚合/写入失败只记日志，
// 不阻断其余门店的快照生成。
//
// ⚠️ 运维提示：`stores` 集合规模（1000+ 门店）远小于 `report_logs`/
// `material_logs` 的记录规模，这里对 stores 做一次全量分页拉取是安全的
// （门店总数是"机构数量级"，不是"每日流水数量级"）；每家门店的
// report_logs/material_logs 查询都显式收窄到"这一天"，单次查询结果集
// 天然很小，不会触发 1000 条截断问题。真正的风险是"门店数量 × 每店 2~3 次
// 查询"的总耗时——本函数用 BATCH_CONCURRENCY 控制并发度，具体数值需要
// 结合实际门店规模在生产环境验证调优，本次先给一个保守的默认值。

'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { computeYesterdayDateString, convertJinToKg, buildDailySnapshot } = require('./lib/buildDailySnapshot');

const BATCH_CONCURRENCY = 20; // 同时处理的门店数量，避免瞬间打满数据库并发连接

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// 分页拉取全部门店（数量级是"机构规模"，不是"流水规模"，1000 条分页上限
// 在这里基本不会被触发；即便未来门店数远超 1000，这里的分页写法本身支持
// 继续往后翻，只是需要更长的总耗时，不存在正确性风险，只是性能需要留意）
async function fetchAllActiveStores() {
  const stores = [];
  const pageSize = 100;
  let skip = 0;
  while (true) {
    const batch = await db.collection('stores')
      .where({ status: _.neq('inactive') })
      .field({ _id: true, tenantId: true, storeName: true })
      .skip(skip)
      .limit(pageSize)
      .get();
    if (!batch.data || batch.data.length === 0) break;
    stores.push(...batch.data);
    if (batch.data.length < pageSize) break;
    skip += pageSize;
  }
  return stores;
}

// 单店当天的 report_logs 原始记录（按 dateString 精确匹配，结果集天然很小）
async function fetchStoreReportRecords(storeId, tenantId, dateString) {
  const res = await db.collection('report_logs')
    .where({ storeId, tenantId, dateString })
    .get()
    .catch(() => ({ data: [] }));
  return res.data || [];
}

// 单店当天的 material_logs 聚合总量（$match+$group，与 getNationalDashboard
// 的写法保持一致，见 lib/materialAggregateHelpers.js 头部注释）
async function fetchStoreMaterialTotals(storeId, tenantId, dateString) {
  try {
    const aggRes = await db.collection('material_logs')
      .aggregate()
      .match({ storeId, tenantId, dateString })
      .group({
        _id: null,
        totalRice: _.aggregate.sum('riceCount'),
        totalFlour: _.aggregate.sum('flourCount'),
        totalOil: _.aggregate.sum('oilCount'),
        totalVegetable: _.aggregate.sum('vegetableCount')
      })
      .end();
    const sums = (aggRes && aggRes.list && aggRes.list[0]) || {};
    return {
      riceKg: convertJinToKg(sums.totalRice),
      flourKg: convertJinToKg(sums.totalFlour),
      oilKg: convertJinToKg(sums.totalOil),
      veggieKg: convertJinToKg(sums.totalVegetable)
    };
  } catch (err) {
    // material_logs 集合可能尚未创建（该机构还没有任何一条物资消耗提交被采纳过）
    return { riceKg: 0, flourKg: 0, oilKg: 0, veggieKg: 0 };
  }
}

async function generateSnapshotForStore(store, dateString) {
  const storeId = store._id;
  const tenantId = store.tenantId || '';
  const storeName = store.storeName || '';

  const [reportRecords, materialTotals] = await Promise.all([
    fetchStoreReportRecords(storeId, tenantId, dateString),
    fetchStoreMaterialTotals(storeId, tenantId, dateString)
  ]);

  // 该门店这一天既没有生效餐报、也没有物资记录，不生成空快照——避免
  // daily_tenant_snapshots 里堆积大量"从未真正营业过的门店 × 全部历史日期"
  // 的空文档，未来查询这张表时也不用先过滤掉一堆全 0 记录
  const hasAnyData = reportRecords.length > 0 ||
    materialTotals.riceKg > 0 || materialTotals.flourKg > 0 ||
    materialTotals.oilKg > 0 || materialTotals.veggieKg > 0;
  if (!hasAnyData) return { skipped: true };

  const snapshot = buildDailySnapshot({
    tenantId, storeId, storeName, dateString, reportRecords, materialTotals
  });

  await db.collection('daily_tenant_snapshots').doc(snapshot._id).set({
    data: { ...snapshot, generatedAt: db.serverDate() }
  });

  return { skipped: false, storeId };
}

exports.main = async (event, context) => {
  // 支持手动指定 dateString 补跑某一天（排查数据/回填历史用），默认按
  // "昨天"处理——定时触发器每日凌晨运行时，"昨天"就是需要生成快照的目标
  // 业务日期
  const dateString = (event && event.dateString) || computeYesterdayDateString(Date.now());

  try {
    const stores = await fetchAllActiveStores();
    console.log(`🚀 [dailyTenantSnapshotCron] 目标日期 ${dateString}，共 ${stores.length} 家门店待处理`);

    let generatedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const failedStoreIds = [];

    for (const batch of chunk(stores, BATCH_CONCURRENCY)) {
      const results = await Promise.allSettled(batch.map((store) => generateSnapshotForStore(store, dateString)));
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          if (r.value && r.value.skipped) {
            skippedCount++;
          } else {
            generatedCount++;
          }
        } else {
          failedCount++;
          failedStoreIds.push(batch[idx]._id);
          console.error(`❌ [dailyTenantSnapshotCron] 门店 ${batch[idx]._id} 快照生成失败:`, r.reason);
        }
      });
    }

    console.log(`✅ [dailyTenantSnapshotCron] 完成：生成 ${generatedCount}，跳过（无数据）${skippedCount}，失败 ${failedCount}`);

    return {
      success: true,
      dateString,
      totalStores: stores.length,
      generatedCount,
      skippedCount,
      failedCount,
      failedStoreIds
    };
  } catch (err) {
    console.error('❌ [dailyTenantSnapshotCron] 整体执行异常:', err);
    return { success: false, error: err.message || '日度快照生成异常' };
  }
};
