// 云函数：getPhotoArchive
// 归集三张图片来源（支出凭证 report_logs.receiptImages / 每日食谱 daily_menus.images /
// 门店日志 activity_logs.images），组成统一的图片档案列表，供历史图册页与首页缩略图预览使用。
//
// 入参：
//   storeId     - 门店 ID；全国总览时留空（仅 super_admin 可用）
//   photoType   - 'all' | 'receipt' | 'menu' | 'log'，默认 'all'
//   month       - 'YYYY-MM' 格式，不传则取最近 3 个月
//   limit       - 返回照片总数上限，默认 60（首页预览只取 6，图册页取 60）
//   storeId     - 门店 ID
//
// 返回：
//   { success, photos: [{url, type, date, storeName, storeId}], total }
//
// 多租户安全边界：所有查询均先收敛 tenantId，再按 storeId 限制门店；
// super_admin 可全机构查询，其余角色强制收敛至自身绑定的门店。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const TENANT_WIDE_ROLES = ['super_admin'];

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { storeId, photoType = 'all', month, limit = 60 } = event || {};

  if (!OPENID) {
    return { success: false, error: '无法获取用户身份' };
  }

  try {
    // 1. 鉴权：从 user_roles 取角色和租户信息
    const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
    let userRole = 'volunteer';
    let tenantId = '';
    let userStoreId = '';
    let userStoreName = '';

    if (roleRes.data && roleRes.data.length > 0) {
      userRole = roleRes.data[0].role || 'volunteer';
      tenantId = roleRes.data[0].tenantId || '';
      userStoreId = roleRes.data[0].storeId || '';
      userStoreName = roleRes.data[0].storeName || '';
    }

    const isTenantWide = TENANT_WIDE_ROLES.includes(userRole) && !!tenantId;

    // 2. 计算日期范围
    // month 参数如 '2026-07'，解析为起止日期
    let startDate, endDate;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      startDate = `${month}-01`;
      const [y, m] = month.split('-').map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      endDate = `${month}-${String(lastDay).padStart(2, '0')}`;
    } else {
      // 默认取最近 3 个月
      const now = new Date();
      endDate = now.toISOString().slice(0, 10);
      const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      startDate = threeMonthsAgo.toISOString().slice(0, 10);
    }

    // 3. 确定查询的 storeId 边界
    const wantsAllStores = !storeId || storeId === 'national_overview' || storeId === 'ALL_STORES';
    const effectiveStoreId = (!isTenantWide && wantsAllStores) ? userStoreId : (wantsAllStores ? '' : storeId);

    // 4. 并行查询三张表，各自取所需字段
    const queryLimit = Math.min(Number(limit) || 60, 200);

    const queries = [];

    // 4a. report_logs -> receiptImages（支出凭证）
    if (photoType === 'all' || photoType === 'receipt') {
      let receiptWhere = { isVoid: _.neq(true) };
      if (tenantId) receiptWhere.tenantId = tenantId;
      if (effectiveStoreId) receiptWhere.storeId = effectiveStoreId;
      receiptWhere.dateString = _.gte(startDate).and(_.lte(endDate));

      queries.push(
        db.collection('report_logs')
          .where(receiptWhere)
          .orderBy('dateString', 'desc')
          .limit(queryLimit)
          .field({ _id: true, dateString: true, shopName: true, storeId: true, receiptImages: true, receiptImageList: true })
          .get()
          .then(res => ({ type: 'receipt', rows: res.data || [] }))
          .catch(() => ({ type: 'receipt', rows: [] }))
      );
    }

    // 4b. daily_menus -> images（每日食谱）
    if (photoType === 'all' || photoType === 'menu') {
      let menuWhere = {};
      if (tenantId) menuWhere.tenantId = tenantId;
      if (effectiveStoreId) menuWhere.storeId = effectiveStoreId;
      menuWhere.dateString = _.gte(startDate).and(_.lte(endDate));

      queries.push(
        db.collection('daily_menus')
          .where(menuWhere)
          .orderBy('dateString', 'desc')
          .limit(queryLimit)
          .field({ _id: true, dateString: true, storeName: true, storeId: true, images: true })
          .get()
          .then(res => ({ type: 'menu', rows: res.data || [] }))
          .catch(() => ({ type: 'menu', rows: [] }))
      );
    }

    // 4c. activity_logs -> images（门店日志）
    if (photoType === 'all' || photoType === 'log') {
      let logWhere = { approvalStatus: _.neq('PENDING') };
      if (tenantId) logWhere.tenantId = tenantId;
      if (effectiveStoreId) logWhere.storeId = effectiveStoreId;
      logWhere.eventTime = _.gte(startDate).and(_.lte(endDate));

      queries.push(
        db.collection('activity_logs')
          .where(logWhere)
          .orderBy('eventTime', 'desc')
          .limit(queryLimit)
          .field({ _id: true, eventTime: true, storeName: true, storeId: true, images: true })
          .get()
          .then(res => ({ type: 'log', rows: res.data || [] }))
          .catch(() => ({ type: 'log', rows: [] }))
      );
    }

    const results = await Promise.all(queries);

    // 5. 拉平：每张图片变成一条记录 {url, type, date, storeName, storeId}
    const photos = [];

    for (const { type, rows } of results) {
      for (const row of rows) {
        let imgs = [];
        if (type === 'receipt') {
          // receiptImages 优先，receiptImageList 兜底（两字段始终同步，取其一即可）
          const arr = Array.isArray(row.receiptImages) ? row.receiptImages
            : (Array.isArray(row.receiptImageList) ? row.receiptImageList : []);
          imgs = arr.filter(u => u && typeof u === 'string');
        } else {
          // daily_menus.images 是 [{url, thumbUrl, name}]
          // activity_logs.images 是 [{url, thumbUrl}]
          const arr = Array.isArray(row.images) ? row.images : [];
          imgs = arr
            .map(img => (img && typeof img === 'object' ? img.url : img))
            .filter(u => u && typeof u === 'string');
        }

        const date = type === 'log' ? (row.eventTime || '') : (row.dateString || '');
        const storeName = row.shopName || row.storeName || '';

        for (const url of imgs) {
          photos.push({ url, type, date, storeName, storeId: row.storeId || effectiveStoreId || '' });
        }
      }
    }

    // 6. 按日期倒序全局排序，截断到 limit
    photos.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
    const total = photos.length;
    const sliced = photos.slice(0, queryLimit);

    return { success: true, photos: sliced, total };
  } catch (err) {
    console.error('[getPhotoArchive] 异常:', err);
    return { success: false, error: err.message || '查询图片档案失败' };
  }
};
