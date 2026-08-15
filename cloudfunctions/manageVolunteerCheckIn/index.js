// 云函数：manageVolunteerCheckIn
// 护持岗位班次打卡的云端台账：volunteer_duty_logs 集合
//
// 此前"到岗服务打卡"功能纯本地 storage 实现（my_checkin_logs），没有任何云端记录，
// 天然缺一份可供后厨查询"今日留店用餐人数/餐别"、也缺服务端兜底的工时上限校验——
// 本云函数补上这两块：
// - action==='checkin'：写入一条打卡记录，服务端按 {tenantId, storeId, _openid, dateString}
//   重新核算当日累计工时，防止客户端被绕过后超过单日 12h 上限；同工种当天去重。
//   reservedMeals（留店用餐细分餐别）随打卡记录一并落地，即是后厨据此备餐的数据来源。
// - action==='revoke'：撤销一条打卡记录，仅限当天且当日 report_logs 尚未被财务稽核
//   封账（approvalStatus !== 'AUDITED_LOCKED'）时允许，与项目其余"数据回滚类"操作
//   同一套封账拦截口径。
// - action==='leaderboard'：爱心护持榜（本月/年度/总贡献三档），按 {tenantId, storeId}
//   聚合各义工的打卡工时排名，姓名统一脱敏后下发，附带调用者本人的排名与距上一名差距。
//
// 🛡️ 客户端本地 storage（my_checkin_logs）仍保留作为离线兜底与即时 UI 展示的主数据源，
// 本云函数是"尽力而为"的云端同步——调用失败不阻断本地打卡流程，只是那一笔暂时没有
// 云端记录（不影响用户体验，但后厨预留量统计会缺这一条，属于已知的降级行为）。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COLLECTION = 'volunteer_duty_logs';
const DAILY_HOURS_CAP = 12.0;
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner'];

// 🐛 云函数容器时区固定为 UTC，与 processRoleAudit/submitFeedback 同一套换算，
// 避免"今日"日期字符串比北京时间晚半天导致工时统计错日归集
function todayStr() {
  const cst = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return cst.toISOString().slice(0, 10);
}

async function resolveCaller(OPENID) {
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

function sanitizeReservedMeals(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((m) => MEAL_TYPES.includes(m));
}

async function handleCheckin(event, OPENID) {
  const caller = await resolveCaller(OPENID);
  if (!caller) return { success: false, error: '无权限：未找到您的角色信息' };

  const storeId = event.storeId || caller.storeId || '';
  const storeName = event.storeName || caller.storeName || '';
  if (!storeId) return { success: false, error: '未识别到您所在的门店，请先在首页选择门店' };

  let tenantId = caller.tenantId || '';
  if (!tenantId) {
    const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
    tenantId = (storeRes && storeRes.data && storeRes.data.tenantId) || '';
  }

  const shiftKey = event.shiftKey;
  const requestedHours = Math.max(0, parseFloat(event.hours) || 0);
  if (!shiftKey || requestedHours <= 0) {
    return { success: false, error: '参数不完整' };
  }

  const dateString = todayStr();

  // 🛡️ 服务端重新核算当日累计工时与同工种去重：不信任客户端传入的"今日已录入工时"，
  // 直接以 {tenantId, storeId, _openid, dateString, status:'active'} 为准现查一遍
  const existingRes = await db.collection(COLLECTION)
    .where({ tenantId, storeId, _openid: OPENID, dateString, status: 'active' })
    .get();
  const existingLogs = existingRes.data || [];

  if (existingLogs.some((l) => l.shiftKey === shiftKey)) {
    return { success: false, error: '您今日已完成该班次打卡，请勿重复提交' };
  }

  const accumulatedHours = existingLogs.reduce((sum, l) => sum + (parseFloat(l.hours) || 0), 0);
  const remaining = parseFloat((DAILY_HOURS_CAP - accumulatedHours).toFixed(1));
  if (remaining <= 0) {
    return { success: false, error: `今日已护持 ${accumulatedHours} 小时，已达单日护持工时上限（${DAILY_HOURS_CAP}h），请核对班次` };
  }

  const wasTruncated = requestedHours > remaining;
  const addHours = wasTruncated ? remaining : requestedHours;
  const reservedMeals = sanitizeReservedMeals(event.reservedMeals);

  const doc = {
    _openid: OPENID,
    tenantId,
    storeId,
    storeName,
    dateString,
    shiftKey,
    shiftName: event.shiftName || '',
    hours: addHours,
    // 🍚 留店用餐：willEatLunch 是"是否留店用餐"总开关，reservedMeals 是具体细分到
    // 早/午/晚的子集——同一份数据，后厨可直接按 {tenantId, storeId, dateString} 聚合
    // reservedMeals 出"今日各餐别留餐人数"，这份 volunteer_duty_logs 本身即是后厨预留量数据源
    willEatLunch: !!event.willEatLunch,
    reservedMeals,
    status: 'active',
    createTime: db.serverDate()
  };

  const addRes = await db.collection(COLLECTION).add({ data: doc });

  return { success: true, logId: addRes._id, hours: addHours, wasTruncated };
}

async function handleRevoke(event, OPENID) {
  const { logId } = event;
  if (!logId) return { success: false, error: '缺少 logId 参数' };

  const logRes = await db.collection(COLLECTION).doc(logId).get().catch(() => null);
  const log = logRes && logRes.data;
  if (!log) return { success: false, error: '打卡记录不存在（可能仅存在于本地，未成功同步至云端）' };
  if (log._openid !== OPENID) return { success: false, error: '无权限：只能撤销本人的打卡记录' };
  if (log.status !== 'active') return { success: false, error: '该记录已撤销' };

  // 🛡️ 仅限当天：跨天的打卡记录一律不可撤销，避免历史工时统计被事后篡改
  if (log.dateString !== todayStr()) {
    return { success: false, error: '仅可撤销当天的打卡记录' };
  }

  // 🔒 封账拦截：若当日门店账本已被财务稽核封账（report_logs.approvalStatus ===
  // 'AUDITED_LOCKED'），禁止撤销打卡——与项目其余"数据回滚类"操作同一套判定口径，
  // 防止已封账日期的工时/留餐统计事后被改动
  const reportRes = await db.collection('report_logs')
    .where({ storeId: log.storeId, dateString: log.dateString })
    .limit(1)
    .get();
  const report = reportRes.data && reportRes.data[0];
  if (report && report.approvalStatus === 'AUDITED_LOCKED') {
    return { success: false, error: '今日账本已封账，无法撤销打卡记录' };
  }

  await db.collection(COLLECTION).doc(logId).update({
    data: { status: 'revoked', revokedAt: db.serverDate() }
  });

  return { success: true };
}

// 云函数独立部署运行，无法直接 import miniprogram/utils/privacy.ts 的 maskName——
// 这里内联一份同口径的实现，与前端展示脱敏规则保持一致（3+ 字取首尾字，2 字取首字）
function maskName(name) {
  if (!name) return '';
  const str = String(name).trim();
  if (str.length <= 1) return str + '*';
  if (str.length === 2) return str.charAt(0) + '*';
  return str.charAt(0) + '*' + str.charAt(str.length - 1);
}

const LEADERBOARD_TOP_N = 20;

// ❤️ 爱心护持榜：[本月榜]/[年度榜]/[总贡献榜] 三档，按 {tenantId, storeId, status:'active'}
// 现查 volunteer_duty_logs（范围内额外加 dateString 区间），手工按 _openid 聚合工时——
// 与本项目其余统计云函数（getVolunteerHonorStats 等）同一套"批量拉取 + reduce"风格，
// 不引入本项目基本不用的 aggregate() 管道 API
async function handleLeaderboard(event, OPENID) {
  const caller = await resolveCaller(OPENID);
  if (!caller) return { success: false, error: '无权限：未找到您的角色信息' };

  const storeId = event.storeId || caller.storeId || '';
  if (!storeId) return { success: false, error: '未识别到您所在的门店' };

  let tenantId = caller.tenantId || '';
  if (!tenantId) {
    const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
    tenantId = (storeRes && storeRes.data && storeRes.data.tenantId) || '';
  }

  const range = ['month', 'year', 'total'].includes(event.range) ? event.range : 'month';
  const where = { tenantId, storeId, status: 'active' };

  const today = todayStr();
  if (range === 'month') {
    const monthPrefix = today.slice(0, 7);
    where.dateString = _.gte(`${monthPrefix}-01`).and(_.lte(`${monthPrefix}-31`));
  } else if (range === 'year') {
    const yearPrefix = today.slice(0, 4);
    where.dateString = _.gte(`${yearPrefix}-01-01`).and(_.lte(`${yearPrefix}-12-31`));
  }
  // total：不加日期过滤，统计全部历史记录

  const hoursByOpenid = new Map();
  let skip = 0;
  const batchLimit = 100;
  while (true) {
    const batch = await db.collection(COLLECTION)
      .where(where)
      .field({ _openid: true, hours: true })
      .skip(skip)
      .limit(batchLimit)
      .get();

    if (!batch.data || batch.data.length === 0) break;

    batch.data.forEach((item) => {
      const openid = item._openid;
      const prev = hoursByOpenid.get(openid) || 0;
      hoursByOpenid.set(openid, prev + (parseFloat(item.hours) || 0));
    });

    if (batch.data.length < batchLimit) break;
    skip += batchLimit;
    if (skip >= 5000) break; // 防御性上限，避免极端门店/长年历史无限翻页
  }

  const ranked = Array.from(hoursByOpenid.entries())
    .map(([openid, hours]) => ({ openid, hours: parseFloat(hours.toFixed(1)) }))
    .sort((a, b) => b.hours - a.hours);

  // 批量解析昵称/真实姓名：openid 列表通常是几十到上百量级（单店义工规模），
  // 一次 in() 查询 + limit 覆盖足够，不需要再分批
  const openidList = ranked.slice(0, Math.max(LEADERBOARD_TOP_N, 100)).map((r) => r.openid);
  const nameMap = new Map();
  if (openidList.length > 0) {
    const nameRes = await db.collection('user_roles')
      .where({ _openid: _.in(openidList) })
      .field({ _openid: true, realName: true, nickName: true })
      .limit(100)
      .get();
    (nameRes.data || []).forEach((u) => {
      nameMap.set(u._openid, u.realName || u.nickName || '');
    });
  }

  const top = ranked.slice(0, LEADERBOARD_TOP_N).map((r, idx) => ({
    rank: idx + 1,
    // 🛡️ 隐私脱敏：榜单一律只下发脱敏后的姓名，真实姓名/openid 都不回传给客户端
    displayName: maskName(nameMap.get(r.openid) || '') || '匿名义工',
    hours: r.hours,
    isSelf: r.openid === OPENID
  }));

  const selfIndex = ranked.findIndex((r) => r.openid === OPENID);
  const selfRank = selfIndex >= 0 ? selfIndex + 1 : 0;
  const selfHours = selfIndex >= 0 ? ranked[selfIndex].hours : 0;
  // 距上一名还差多少工时：本就是第一名或未上榜时为 0（未上榜没有"上一名"的参照意义）
  const gapToNext = (selfIndex > 0) ? parseFloat((ranked[selfIndex - 1].hours - selfHours).toFixed(1)) : 0;

  return {
    success: true,
    range,
    list: top,
    totalRanked: ranked.length,
    selfRank,
    selfHours,
    gapToNext
  };
}

// 📊 查询当日门店所有志愿者的累计打卡工时（供大家长/店长预填"服务总工时"字段）
// 管理岗位专属：store_patriarch / store_manager / finance / super_admin 可调用
const MGMT_ROLES = ['store_patriarch', 'store_manager', 'finance', 'super_admin'];

async function handleQueryStoreHours(event, OPENID) {
  const caller = await resolveCaller(OPENID);
  if (!caller) return { success: false, error: '无权限：未找到您的角色信息' };
  if (!MGMT_ROLES.includes(caller.role)) {
    return { success: false, error: '无管理权限' };
  }

  const storeId = event.storeId || caller.storeId || '';
  if (!storeId) return { success: false, error: '未指定门店' };

  let tenantId = caller.tenantId || '';
  if (!tenantId) {
    const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
    tenantId = (storeRes && storeRes.data && storeRes.data.tenantId) || '';
  }

  const dateString = event.dateString || todayStr();

  // 拉取当日所有 active 打卡记录（单店单日通常不超 200 条，单批次足够覆盖）
  const res = await db.collection(COLLECTION)
    .where({ tenantId, storeId, dateString, status: 'active' })
    .field({ _openid: true, hours: true, reservedMeals: true })
    .limit(200)
    .get();

  const logs = res.data || [];

  // 🛡️ 防呆：单笔工时超过 12h 视为忘记签退的挂单记录，按默认 4h 结算
  const HANGUP_CAP = 12.0;
  const DEFAULT_HANGUP_HOURS = 4.0;
  const totalHours = parseFloat(
    logs
      .reduce((sum, l) => {
        const h = parseFloat(l.hours) || 0;
        return sum + (h > HANGUP_CAP ? DEFAULT_HANGUP_HOURS : h);
      }, 0)
      .toFixed(1)
  );
  const uniqueVolunteers = new Set(logs.map((l) => l._openid)).size;

  // 🍚 后厨预留量统计：按餐别聚合"今日留店用餐"人数——同一人当天可能打了多个
  // 班次的卡，每个班次各自都带一份 reservedMeals，这里按 _openid 去重后再计入
  // 对应餐别的 Set，避免同一人被重复计数（与 uniqueVolunteers 同一套去重口径）
  const mealVolunteerSets = { breakfast: new Set(), lunch: new Set(), dinner: new Set() };
  logs.forEach((l) => {
    const meals = Array.isArray(l.reservedMeals) ? l.reservedMeals : [];
    meals.forEach((m) => {
      if (mealVolunteerSets[m]) mealVolunteerSets[m].add(l._openid);
    });
  });
  const mealCounts = {
    breakfast: mealVolunteerSets.breakfast.size,
    lunch: mealVolunteerSets.lunch.size,
    dinner: mealVolunteerSets.dinner.size
  };

  return { success: true, totalHours, checkInCount: logs.length, uniqueVolunteers, mealCounts, dateString };
}

exports.main = async (event, context) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();

  if (!OPENID) {
    return { success: false, error: '无法获取用户身份' };
  }

  try {
    if (action === 'checkin') return await handleCheckin(event, OPENID);
    if (action === 'revoke') return await handleRevoke(event, OPENID);
    if (action === 'leaderboard') return await handleLeaderboard(event, OPENID);
    if (action === 'queryStoreHours') return await handleQueryStoreHours(event, OPENID);
    return { success: false, error: '无效操作' };
  } catch (err) {
    console.error('[manageVolunteerCheckIn] 异常:', err);
    return { success: false, error: err.message || '操作失败' };
  }
};
