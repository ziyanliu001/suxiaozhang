// 云函数：recalculateLedger
// 统一的"一键校准全线结余流水"入口：
// - storeId 为具体门店 ID：仅重算该门店（本店店长/财务/超管可调用）。
// - storeId === 'all'：重算调用者所属机构（tenant）下的每一家门店，各自独立按日期
//   链式重算昨日余额/今日结余（不跨门店混算，每家门店都是一条独立的流水链）。
//   仅超级管理员可调用全国范围校准。
//
// 🛡️ 权限：服务端强校验角色与门店归属，不信任前端隐藏/禁用按钮传来的 storeId。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DEFAULT_TENANT_ID = 'yuhuazhai_national';

async function resolveCallerTenantId(caller) {
  if (caller.tenantId) return caller.tenantId;
  await db.collection('user_roles').doc(caller._id).update({
    data: { tenantId: DEFAULT_TENANT_ID }
  }).catch(err => console.warn('[recalculateLedger] tenantId 自愈回写失败:', err));
  return DEFAULT_TENANT_ID;
}

// 单个门店的链式滚雪球重算
// 🛡️ 紧急安全加固：
// 1. 仅允许写入 yesterdayBalance / todayBalance / calculatedTodayBalance / calibratedAt
//    这四个计算字段，代码里没有、也绝不允许出现任何写 storeId / storeName / _openid 等
//    元数据字段的语句 —— 校准逻辑的唯一职责是重新计算数字，不改变记录归属。
// 2. 整条门店的重算链路包裹在单个事务内：只要中途任意一条 update 失败，立即整体
//    rollback，绝不会出现"链上一部分记录已改、一部分还是旧值"的半途污染状态。
async function recalibrateOneStore(storeId) {
  if (!storeId || storeId === 'all') {
    throw new Error('recalibrateOneStore 拒绝执行：storeId 不能为空或 "all"（必须是具体门店）');
  }

  const reportRes = await db.collection('report_logs')
    .where({ storeId, isVoid: _.neq(true) })
    .orderBy('dateString', 'asc')
    .get();

  const list = reportRes.data || [];
  if (list.length < 2) {
    return { updatedCount: 0, skipped: true };
  }

  const transaction = await db.startTransaction();
  try {
    let lastDayBalance = parseFloat(list[0].todayBalance || list[0].calculatedTodayBalance || '0');
    let updatedCount = 0;

    for (let i = 1; i < list.length; i++) {
      const currentItem = list[i];
      const otherDonation = parseFloat(currentItem.otherDonation || '0');
      const listDonationTotal = parseFloat(currentItem.listDonationTotal || '0');
      const expenseAmount = parseFloat(currentItem.expenseAmount || '0');
      const inAmt = otherDonation + listDonationTotal;

      const newYesterdayBalance = parseFloat(lastDayBalance.toFixed(2));
      const newTodayBalance = parseFloat((newYesterdayBalance + inAmt - expenseAmount).toFixed(2));

      // 🛡️ 事务内串行更新：仅这四个计算字段，绝不出现在此白名单之外的任何写字段
      await transaction.collection('report_logs').doc(currentItem._id).update({
        data: {
          yesterdayBalance: newYesterdayBalance,
          todayBalance: newTodayBalance,
          calculatedTodayBalance: newTodayBalance.toFixed(2),
          calibratedAt: db.serverDate()
        }
      });

      lastDayBalance = newTodayBalance;
      updatedCount++;
    }

    await transaction.commit();
    return { updatedCount, skipped: false };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { storeId } = event;

  if (!OPENID) {
    return { success: false, errMsg: '未获取到用户身份' };
  }
  if (!storeId) {
    return { success: false, errMsg: '缺少 storeId 参数' };
  }

  try {
    const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
    const caller = roleRes.data && roleRes.data[0];

    if (!caller || !['store_manager', 'finance', 'super_admin'].includes(caller.role)) {
      return { success: false, errMsg: '无权限：仅店长/财务/超级管理员可执行结余流水校准' };
    }

    if (storeId === 'all') {
      if (caller.role !== 'super_admin') {
        return { success: false, errMsg: '无权限：仅超级管理员可执行全国范围的结余流水校准' };
      }

      const tenantId = await resolveCallerTenantId(caller);

      const stores = [];
      const pageSize = 100;
      let page = 0;
      while (true) {
        const storesRes = await db.collection('stores')
          .where({ tenantId })
          .skip(page * pageSize)
          .limit(pageSize)
          .get();
        const batch = storesRes.data || [];
        stores.push(...batch);
        if (batch.length < pageSize) break;
        page++;
      }

      if (stores.length === 0) {
        return { success: true, storesProcessed: 0, storesSkipped: 0, totalRecordsUpdated: 0, message: '未找到可校准的门店' };
      }

      let storesProcessed = 0;
      let storesSkipped = 0;
      let totalRecordsUpdated = 0;

      // 门店间串行处理，避免同一时间对数据库产生过大的写入并发压力
      for (const store of stores) {
        try {
          const result = await recalibrateOneStore(store._id);
          if (result.skipped) {
            storesSkipped++;
          } else {
            storesProcessed++;
            totalRecordsUpdated += result.updatedCount;
          }
        } catch (storeErr) {
          console.error(`[recalculateLedger] 门店 ${store._id} 校准失败:`, storeErr);
          storesSkipped++;
        }
      }

      return {
        success: true,
        storesProcessed,
        storesSkipped,
        totalRecordsUpdated,
        message: `已校准 ${storesProcessed} 家门店，共更新 ${totalRecordsUpdated} 条记录`
      };
    }

    // 单店校准：店长/财务仅可校准本店，超管不限
    if (caller.role !== 'super_admin' && caller.storeId && caller.storeId !== storeId) {
      return { success: false, errMsg: '无权限：不能校准其他门店的结余流水' };
    }

    const result = await recalibrateOneStore(storeId);
    if (result.skipped) {
      return { success: true, updatedCount: 0, message: '无需校准（记录不足2条）' };
    }

    return {
      success: true,
      updatedCount: result.updatedCount,
      message: `已成功校准 ${result.updatedCount} 条记录`
    };
  } catch (err) {
    console.error('[recalculateLedger] 异常:', err);
    return { success: false, errMsg: err.message || '校准失败' };
  }
};
