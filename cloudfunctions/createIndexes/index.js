const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  try {
    const results = [];

    await db.collection('stores').createIndex({
      name: 'storeName_asc',
      keys: [{ storeName: 1 }],
      unique: false
    });
    results.push({ collection: 'stores', index: 'storeName_asc', status: 'success' });

    await db.collection('daily_reports').createIndex({
      name: 'storeId_date',
      keys: [{ storeId: 1 }, { reportDate: 1 }],
      unique: false
    });
    results.push({ collection: 'daily_reports', index: 'storeId_date', status: 'success' });

    await db.collection('daily_reports').createIndex({
      name: 'reportDate_asc',
      keys: [{ reportDate: 1 }],
      unique: false
    });
    results.push({ collection: 'daily_reports', index: 'reportDate_asc', status: 'success' });

    await db.collection('report_logs').createIndex({
      name: 'shopName_date',
      keys: [{ shopName: 1 }, { dateString: 1 }],
      unique: false
    });
    results.push({ collection: 'report_logs', index: 'shopName_date', status: 'success' });

    await db.collection('user_roles').createIndex({
      name: 'openid',
      keys: [{ _openid: 1 }],
      unique: false
    });
    results.push({ collection: 'user_roles', index: 'openid', status: 'success' });

    await db.collection('store_sponsor').createIndex({
      name: 'storeId',
      keys: [{ storeId: 1 }],
      unique: false
    });
    results.push({ collection: 'store_sponsor', index: 'storeId', status: 'success' });

    // 🏢 多租户改造：tenantId 复合索引，支撑按机构维度的高频查询
    await db.collection('stores').createIndex({
      name: 'tenantId',
      keys: [{ tenantId: 1 }],
      unique: false
    });
    results.push({ collection: 'stores', index: 'tenantId', status: 'success' });

    await db.collection('user_roles').createIndex({
      name: 'tenantId',
      keys: [{ tenantId: 1 }],
      unique: false
    });
    results.push({ collection: 'user_roles', index: 'tenantId', status: 'success' });

    await db.collection('report_logs').createIndex({
      name: 'tenantId_date',
      keys: [{ tenantId: 1 }, { dateString: 1 }],
      unique: false
    });
    results.push({ collection: 'report_logs', index: 'tenantId_date', status: 'success' });

    // 🛡️ report_logs.auditedBy 缺索引告警：profile.ts 的"已稽核"荣誉墙统计对 auditedBy
    // 做 exists(true) + count()，此前既没有单字段索引，查询也没带 tenantId，实际是对
    // report_logs 全表（跨所有机构）扫描。这里补两条索引：
    //   1）auditedBy 单字段索引：兜底所有直接按 auditedBy 过滤的查询
    //   2）tenantId + auditedBy 复合索引：查询代码已同步改为强制带 tenantId 前缀，
    //      真正命中的是这条复合索引，比单字段索引更能收窄扫描范围
    await db.collection('report_logs').createIndex({
      name: 'auditedBy_asc',
      keys: [{ auditedBy: 1 }],
      unique: false
    });
    results.push({ collection: 'report_logs', index: 'auditedBy_asc', status: 'success' });

    await db.collection('report_logs').createIndex({
      name: 'tenantId_auditedBy',
      keys: [{ tenantId: 1 }, { auditedBy: 1 }],
      unique: false
    });
    results.push({ collection: 'report_logs', index: 'tenantId_auditedBy', status: 'success' });

    await db.collection('tenant_subscriptions').createIndex({
      name: 'tenantId',
      keys: [{ tenantId: 1 }],
      unique: false
    });
    results.push({ collection: 'tenant_subscriptions', index: 'tenantId', status: 'success' });

    // 🍽️ 每日菜单 / 📌 活动大事记：门店+日期(时间) 复合索引，支撑分页列表查询
    await db.collection('daily_menus').createIndex({
      name: 'store_date',
      keys: [{ storeId: 1 }, { dateString: -1 }],
      unique: false
    });
    results.push({ collection: 'daily_menus', index: 'store_date', status: 'success' });

    await db.collection('activity_logs').createIndex({
      name: 'store_eventTime',
      keys: [{ storeId: 1 }, { eventTime: -1 }],
      unique: false
    });
    results.push({ collection: 'activity_logs', index: 'store_eventTime', status: 'success' });

    // 🧾 高频账目模板：门店+分类复合索引，支撑填报页快速拉取模板列表
    await db.collection('expense_item_templates').createIndex({
      name: 'store_category',
      keys: [{ storeId: 1 }, { category: 1 }],
      unique: false
    });
    results.push({ collection: 'expense_item_templates', index: 'store_category', status: 'success' });

    // 📢 首页跑马灯通知：机构+门店复合索引，支撑"当前视角严格互斥查询"
    await db.collection('notices').createIndex({
      name: 'tenant_store',
      keys: [{ tenantId: 1 }, { storeId: 1 }],
      unique: false
    });
    results.push({ collection: 'notices', index: 'tenant_store', status: 'success' });

    return {
      success: true,
      message: '索引创建完成',
      results
    };

  } catch (err) {
    console.error('索引创建失败:', err);
    return {
      success: false,
      errMsg: err.message,
      note: '部分索引可能已存在，这是正常情况。索引只需创建一次。'
    };
  }
};