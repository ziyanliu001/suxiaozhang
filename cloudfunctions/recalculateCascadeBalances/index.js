const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { storeId, shopName, modifiedDate } = event;
  const { OPENID } = cloud.getWXContext();

  // 兼容：优先使用 shopName，其次回退到 storeId
  const storeFilter = shopName || storeId;

  if (!storeFilter || !modifiedDate) {
    return { success: false, errMsg: '缺失必要的 shopName/storeId 或 modifiedDate 参数' };
  }

  // 🛡️ 权限校验：此前任何登录用户均可直接联动重算任意门店的资金流水，未做身份核验
  if (!OPENID) {
    return { success: false, errMsg: '无法获取用户身份' };
  }
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  const caller = roleRes.data && roleRes.data[0];
  const isAllowedRole = caller && ['super_admin', 'store_manager', 'finance'].includes(caller.role);
  const sameStore = caller && ((caller.storeId && caller.storeId === storeId) || (caller.storeName && caller.storeName === shopName));
  if (!isAllowedRole || (caller.role !== 'super_admin' && !sameStore)) {
    return { success: false, errMsg: '无权限重算该门店账目' };
  }

  // 🏢 多租户边界：本函数是"作废/单笔编辑后触发联动重算"的实际调用入口，此前查询
  // 完全没有 tenantId 过滤——只要另一机构恰好使用了相同的 shopName 字符串（常见的
  // 通用门店名，如"旗舰店"/"总店"），两个机构的流水链就会被当成同一条链混算，
  // 直接污染他机构的余额数据。现强制要求解析出调用者 tenantId，缺失则直接拒绝执行，
  // 不再静默退化为"仅按 shopName 全库匹配"。
  const callerTenantId = caller.tenantId || '';
  if (!callerTenantId) {
    return { success: false, errMsg: '无法确认调用者所属机构，出于数据隔离安全考虑已拒绝执行级联重算' };
  }
  if (caller.role === 'super_admin') {
    const storeDoc = await db.collection('stores').doc(storeId).get().catch(() => null);
    const targetTenantId = storeDoc && storeDoc.data && storeDoc.data.tenantId;
    if (targetTenantId && targetTenantId !== callerTenantId) {
      return { success: false, errMsg: '无权限重算其他机构的门店账目' };
    }
  }

  try {
    // 查询 report_logs 集合（非 daily_reports），使用 dateString 做 ISO 日期比较
    const listRes = await db.collection('report_logs')
      .where({
        shopName: storeFilter,
        tenantId: callerTenantId,
        dateString: _.gte(modifiedDate),
        // 🛡️ 已作废（红字冲销）的记录不应再参与流水链计算，否则"作废"不会真正从
        // 后续每日余额中扣除其收支影响，等于作废操作在资金层面从未生效
        isVoid: _.neq(true)
      })
      .orderBy('dateString', 'asc')
      .get();

    const records = listRes.data || [];
    if (records.length === 0) {
      return { success: true, updatedCount: 0 };
    }

    let lastCalculatedTodayBalance = null;
    const updatePromises = [];

    for (let i = 0; i < records.length; i++) {
      const item = records[i];
      let currentYesterdayBal = parseFloat(item.yesterdayBalance || 0);

      // 收入 = 列表捐款总额 + 其他支持金额
      let income = parseFloat(item.listDonationTotal || 0) + parseFloat(item.otherDonation || 0);

      // 支出 = 每日食材支出 + 固定大额支出
      let expense = parseFloat(item.dailyExpenseTotal || 0) + parseFloat(item.fixedExpenseTotal || 0);

      // 从第二天起，昨日余额 = 前一天的今日结余
      if (i > 0 && lastCalculatedTodayBalance !== null) {
        currentYesterdayBal = lastCalculatedTodayBalance;
      }

      const currentTodayBal = Math.round((currentYesterdayBal + income - expense) * 100) / 100;
      lastCalculatedTodayBalance = currentTodayBal;

      updatePromises.push(
        db.collection('report_logs').doc(item._id).update({
          data: {
            yesterdayBalance: currentYesterdayBal,
            todayBalance: currentTodayBal,
            lastCascadeCalculatedAt: db.serverDate()
          }
        })
      );
    }

    await Promise.all(updatePromises);

    return {
      success: true,
      updatedCount: records.length,
      message: `成功联动校正了 ${records.length} 天的账目数据`
    };

  } catch (err) {
    console.error('Cascade recalculation failed:', err);
    return { success: false, errMsg: err.message };
  }
};
