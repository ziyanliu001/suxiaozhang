// 云函数：getPhotoArchive
// 归集三张图片来源（支出凭证 report_logs.receiptImages / 每日食谱 daily_menus.images /
// 门店日志 activity_logs.images），组成统一的图片档案列表，供历史图册页与首页缩略图预览使用。
//
// action 分派：
//   - 未传 / 'list'：原有列表查询，返回 { success, photos, total }
//   - 'detail'：🆕（2026-09-13 图单联动）按单张照片反查其关联的原始台账文档，
//     返回该照片对应的报销品类/金额/经手人、或食谱菜品、或当日就餐/义工人次，
//     见入参/返回说明
//
// list 入参：
//   storeId     - 门店 ID；全国总览时留空（仅 super_admin 可用）
//   photoType   - 'all' | 'receipt' | 'menu' | 'log'，默认 'all'
//   month       - 'YYYY-MM' 格式的具体月份，优先级高于 range
//   range       - '1m' | '3m' | 'year' | 'all'，快捷时间范围，默认 '3m'
//                 （与旧版本"不传 month 则取最近 3 个月"的默认行为保持一致）
//   limit       - 返回照片总数上限，默认 60（首页预览只取 6，图册页取 60）
// list 返回：
//   { success, photos: [{url, type, date, storeName, storeId, id}], total }
//   id 是来源文档（report_logs/daily_menus/activity_logs）的 _id
//
// detail 入参：
//   type        - 'receipt' | 'menu' | 'log'，与 list 返回的 photo.type 一致
//   id          - 目标文档 _id（来自 list 返回的 photo.id）
//   storeId     - 目标文档所属门店 ID（来自 list 返回的 photo.storeId），用于
//                 巡检漫游身份解析 + 权限校验，不信任但仍需要用真实文档字段二次核验
//   photoUrl    - 本次查看的图片 url，仅 receipt 类型用于精确匹配
//                 fixedExpenseItems 里的具体专项条目
// detail 返回：
//   { success, detail } — detail 形状按 type 不同，见 lib/extractPhotoLedgerDetail.js
//
// 多租户安全边界：所有查询均先收敛 tenantId，再按 storeId 限制门店；
// super_admin 可全机构查询，其余角色强制收敛至自身绑定的门店。
//
// 🛡️（2026-09-13 巡检漫游支持）与 getStoreQRCode/manageStoreProfile/
// manageReportApproval 同一套 authorizedTenants 轻量租户漫游体系——此前本
// 云函数只做最基础的 user_roles 反查，platform_admin 巡检某家门店时会被
// 强制收敛回自己（不隶属任何门店）的空 storeId，图册永远查出 0 条，这与
// history.ts 图册模式"显式化门店归属"要支持巡检场景的前提矛盾。见
// lib/resolveCaller.js、lib/buildAuditLogEntry.js 头部注释。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { resolveEffectiveCaller } = require('./lib/resolveCaller');
const { buildAuditLogEntry, isRoamingConsumed } = require('./lib/buildAuditLogEntry');
const {
  extractReceiptLedgerDetail,
  extractMenuLedgerDetail,
  extractActivityLedgerDetail
} = require('./lib/extractPhotoLedgerDetail');

const TENANT_WIDE_ROLES = ['super_admin'];

// 🛡️（2026-09-13）与 getStoreQRCode 同款 resolveCaller：负责"按 OPENID 查
// user_roles 拿到 own 文档"这一步数据库 I/O + users 集合历史兼容兜底，决策
// 逻辑委托给 lib/resolveCaller.js 的 resolveEffectiveCaller()。云函数间无
// 共享模块机制，本函数体与 getStoreQRCode/index.js 的同名函数是独立维护的
// 镜像，改动一处记得同步另一处。
async function resolveCaller(OPENID, opts) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  let own = (roleRes.data && roleRes.data[0]) || null;

  if (!own) {
    const userRes = await db.collection('users').where({ _openid: OPENID }).limit(1).get().catch(() => null);
    const legacyUser = userRes && userRes.data && userRes.data[0];
    if (legacyUser) {
      own = {
        role: legacyUser.role === 'admin' ? 'super_admin' : 'volunteer',
        storeId: legacyUser.storeId || '',
        tenantId: ''
      };
    }
  }

  const targetStoreId = opts && (opts.targetStoreId || opts.storeId);
  const effectiveCaller = resolveEffectiveCaller(own, targetStoreId);

  if (isRoamingConsumed(own, effectiveCaller)) {
    const storeRes = await db.collection('stores').doc(targetStoreId).field({ storeName: true }).get().catch(() => null);
    const targetStoreName = (storeRes && storeRes.data && storeRes.data.storeName) || '';
    const logEntry = buildAuditLogEntry({
      operatorOpenId: OPENID,
      own,
      effectiveCaller,
      targetStoreId,
      targetStoreName,
      cloudFunctionName: 'getPhotoArchive',
      action: opts && opts.action
    });
    if (logEntry) {
      await db.collection('tenant_authorization_audit_logs').add({
        data: { ...logEntry, createTime: db.serverDate() }
      }).catch((err) => console.warn('[getPhotoArchive] 巡检审计日志写入失败:', err));
    }
  }

  return effectiveCaller;
}

// 🛡️ detail action 的权限收口：list 分支的 tenantId/storeId 是拼进查询
// where 条件里的，天然不会查出越权数据；detail 分支按 _id 直接 .doc().get()，
// 拿到文档后必须用文档自己的真实 tenantId/storeId 二次核验，不能只信
// resolveCaller 算出来的"应有权限"就放行——防止客户端拿一个自己确实有权限
// 的 storeId 参数、却传一个属于别的门店的文档 id 来诓骗过关
function verifyDocScope(doc, caller, isTenantWide) {
  if (!doc || !caller) return false;
  if (isTenantWide) return !!doc.tenantId && doc.tenantId === caller.tenantId;
  return !!caller.storeId && doc.storeId === caller.storeId;
}

async function handleList(OPENID, event) {
  const { storeId, photoType = 'all', month, range, limit = 60 } = event || {};

  const caller = await resolveCaller(OPENID, { targetStoreId: storeId, action: 'list' });
  const userRole = (caller && caller.role) || 'volunteer';
  const tenantId = (caller && caller.tenantId) || '';
  const userStoreId = (caller && caller.storeId) || '';

  const isTenantWide = TENANT_WIDE_ROLES.includes(userRole) && !!tenantId;

  // 2. 计算日期范围
  // month 参数如 '2026-07'，指定具体月份，优先级最高；否则按 range 快捷范围
  // 计算——startDate 为 null 时表示"不限下限"（range === 'all'），下面拼查询
  // 条件时据此跳过 gte(startDate)，而不是拿一个很早的哨兵日期硬凑下限
  let startDate = null;
  let endDate;
  const now = new Date();
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    startDate = `${month}-01`;
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    endDate = `${month}-${String(lastDay).padStart(2, '0')}`;
  } else {
    endDate = now.toISOString().slice(0, 10);
    switch (range) {
      case '1m':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        break;
      case 'year':
        startDate = `${now.getFullYear()}-01-01`;
        break;
      case 'all':
        startDate = null;
        break;
      case '3m':
      default:
        // 默认/显式 '3m'：最近 3 个月，与此前无 range 参数时的固定行为一致
        startDate = new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString().slice(0, 10);
        break;
    }
  }

  // 3. 确定查询的 storeId 边界
  // 🐛 根因修复（跨门店越权）：此前非租户级角色（store_manager/finance/
  // store_patriarch）只在客户端传"全部门店"哨兵值时才会被强制收敛回自己
  // 绑定的门店——一旦客户端显式传了另一家真实门店的 storeId（哪怕只是
  // 改一下请求参数，不需要任何特殊权限），就会原样采信，只受 tenantId
  // 隔离，同一机构内不同门店之间的凭证/食谱/日志图片可以互相越权拉取。
  // 现在收紧为：只有 isTenantWide（当前仅 super_admin）才允许自行指定/
  // 留空 storeId；其余任何角色一律强制收敛到 userStoreId（已经过
  // resolveCaller 的巡检漫游解析，命中授权时就是被授权的目标门店）——
  // 服务端不信任客户端传入的 storeId 参数，彻底关闭这条越权路径
  const wantsAllStores = !storeId || storeId === 'national_overview' || storeId === 'ALL_STORES';
  const effectiveStoreId = isTenantWide ? (wantsAllStores ? '' : storeId) : userStoreId;

  // 4. 并行查询三张表，各自取所需字段
  const queryLimit = Math.min(Number(limit) || 60, 200);
  // range === 'all' 时 startDate 为 null，只约束上限（不晚于今天），不设下限
  const dateCondition = startDate ? _.gte(startDate).and(_.lte(endDate)) : _.lte(endDate);

  const queries = [];

  // 4a. report_logs -> receiptImages（支出凭证）
  if (photoType === 'all' || photoType === 'receipt') {
    let receiptWhere = { isVoid: _.neq(true) };
    if (tenantId) receiptWhere.tenantId = tenantId;
    if (effectiveStoreId) receiptWhere.storeId = effectiveStoreId;
    receiptWhere.dateString = dateCondition;

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
    menuWhere.dateString = dateCondition;

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
    logWhere.eventTime = dateCondition;

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

      // 🆕 带上来源文档 _id：图册页长按详情弹窗据此发起 action:'detail'
      // 图单联动查询，也用于 receipt 类型跳转回账本模式查看关联流水
      for (const url of imgs) {
        photos.push({ url, type, date, storeName, storeId: row.storeId || effectiveStoreId || '', id: row._id });
      }
    }
  }

  // 6. 按日期倒序全局排序，截断到 limit
  photos.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
  const total = photos.length;
  const sliced = photos.slice(0, queryLimit);

  return { success: true, photos: sliced, total };
}

async function handleDetail(OPENID, event) {
  const { type, id, photoUrl, storeId } = event || {};
  if (!type || !id || !storeId) {
    return { success: false, error: '缺少必要参数' };
  }
  if (type !== 'receipt' && type !== 'menu' && type !== 'log') {
    return { success: false, error: '未知的图片类型' };
  }

  const caller = await resolveCaller(OPENID, { targetStoreId: storeId, action: 'detail' });
  if (!caller) return { success: false, error: '无法确认您的角色信息' };

  const isTenantWide = TENANT_WIDE_ROLES.includes(caller.role) && !!caller.tenantId;

  if (type === 'receipt') {
    const docRes = await db.collection('report_logs').doc(id)
      .field({ _id: true, dateString: true, expenseAmount: true, fixedExpenseItems: true, storeId: true, tenantId: true, _openid: true })
      .get().catch(() => null);
    const doc = docRes && docRes.data;
    if (!doc) return { success: false, error: '记录不存在' };
    if (!verifyDocScope(doc, caller, isTenantWide)) {
      return rejectDetail(caller);
    }

    let submitterRealName = '';
    if (doc._openid) {
      const submitterRes = await db.collection('user_roles')
        .where({ _openid: doc._openid })
        .limit(1)
        .field({ realName: true })
        .get().catch(() => null);
      submitterRealName = (submitterRes && submitterRes.data && submitterRes.data[0] && submitterRes.data[0].realName) || '';
    }

    return { success: true, detail: extractReceiptLedgerDetail(doc, photoUrl, submitterRealName) };
  }

  if (type === 'menu') {
    const docRes = await db.collection('daily_menus').doc(id)
      .field({ _id: true, menuText: true, storeId: true, tenantId: true })
      .get().catch(() => null);
    const doc = docRes && docRes.data;
    if (!doc) return { success: false, error: '记录不存在' };
    if (!verifyDocScope(doc, caller, isTenantWide)) {
      return rejectDetail(caller);
    }

    return { success: true, detail: extractMenuLedgerDetail(doc) };
  }

  // type === 'log'：activity_logs 本身不含就餐/义工人次，反查同店同日的
  // report_logs 取数，见 lib/extractPhotoLedgerDetail.js 头部注释
  const docRes = await db.collection('activity_logs').doc(id)
    .field({ _id: true, eventTime: true, storeId: true, tenantId: true })
    .get().catch(() => null);
  const doc = docRes && docRes.data;
  if (!doc) return { success: false, error: '记录不存在' };
  if (!verifyDocScope(doc, caller, isTenantWide)) {
    return rejectDetail(caller);
  }

  let sameDayReportLog = null;
  if (doc.eventTime) {
    const reportRes = await db.collection('report_logs')
      .where({ tenantId: doc.tenantId || '', storeId: doc.storeId || '', dateString: doc.eventTime })
      .limit(1)
      .field({ totalDineCount: true, diningCount: true, totalVolunteers: true, volunteerCount: true })
      .get().catch(() => null);
    sameDayReportLog = (reportRes && reportRes.data && reportRes.data[0]) || null;
  }

  return { success: true, detail: extractActivityLedgerDetail(sameDayReportLog) };
}

// 🛡️（2026-09-13）与 getStoreQRCode 的 NEEDS_INSPECTION_GRANT 同一套口径：
// platform_admin 未持有该门店有效巡检授权时，前端可以据此展示"申请巡检
// 授权并重试"而不是一句读不出下一步该做什么的"无权限"
function rejectDetail(caller) {
  const isPlatformAdmin = caller && caller.role === 'platform_admin';
  return {
    success: false,
    error: isPlatformAdmin ? '当前账号尚未获得该门店的巡检授权' : '无权限查看该记录',
    errorCode: isPlatformAdmin ? 'NEEDS_INSPECTION_GRANT' : undefined
  };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { success: false, error: '无法获取用户身份' };
  }

  try {
    if (event && event.action === 'detail') {
      return await handleDetail(OPENID, event);
    }
    return await handleList(OPENID, event);
  } catch (err) {
    console.error('[getPhotoArchive] 异常:', err);
    return { success: false, error: err.message || '查询图片档案失败' };
  }
};
