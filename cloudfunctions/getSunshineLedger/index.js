// 云函数：getSunshineLedger
//
// 首页「☀️ 阳光账本」入口专用的公开只读汇总查询。
//
// 🛡️ 与本项目其余云函数最大的不同（与 publicVerifyReport 同一套设计哲学）：这里刻意
// 【不做】任何 user_roles/OPENID 权限校验——首页任何访客（含未登录/未绑定门店身份的
// 家人、义工、财务、店长、家长、超管）点开都应该能看到本店的公开透明数据，不需要
// 任何权限门槛。正因为完全公开，只接受调用方明确指定的单个 storeId（不支持"全部门店"
// 之类的跨店聚合参数），且所有查询条件都强制带上这个 storeId，避免这个无鉴权接口
// 被当成任意门店数据的批量抓取入口。
//
// 🛡️ 核心风控：查询条件严格限定 approvalStatus 为 'APPROVED' 或 'AUDITED_LOCKED'，
// 绝对排除 'PENDING'（含缺失该字段的历史/草稿记录，undefined 不在这两个值内，天然被
// 排除）——阳光账本展示的必须是"已经过店长核对确认/财务稽核"的生效数据，不能让
// 尚未审核的草稿金额被公众误当作已生效数据看待。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 🛡️ 单次查询上限：本店按日累计的审核通过记录，理论上限是"运营天数"，2000 条约等于
// 5.4 年的每日记录；超过这个规模的门店（存续更久）累计类指标会低估，但公开只读接口
// 不适合为极端场景无限拉取全表，与 getStatisticsData 等同类云函数的 limit 口径一致
const QUERY_LIMIT = 2000;

const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function daysInMonth(year, month) {
  // month: 1-12
  return new Date(year, month, 0).getDate();
}

function daysBetween(dateStr, todayStr) {
  if (!dateStr) return Infinity;
  const a = new Date(dateStr).getTime();
  const b = new Date(todayStr).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}

// 🌸 近7日阳善榜专用：精确到分钟/小时的相对时间（"2小时前"），比 daysBetween
// 那套按天粒度的 timeLabel（今天/昨天/N天前）更适合一个只滚动最近 7 天的短窗口
// 列表——7 天内的记录几乎全是"今天/昨天"，天粒度会让列表看起来像是同一时间
// 发生的，丢失了本该有的先后顺序感
function formatRelativeTime(createTime) {
  if (!createTime) return '';
  const d = createTime instanceof Date ? createTime : new Date(createTime);
  const ms = d.getTime();
  if (Number.isNaN(ms)) return '';
  const diffMs = Date.now() - ms;
  if (diffMs < 0) return '刚刚';
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}天前`;
}

exports.main = async (event) => {
  const { storeId, yearMonth } = event;

  if (!storeId || !String(storeId).trim()) {
    return { success: false, error: '缺少门店标识，无法查询' };
  }

  try {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    // 🛡️ yearMonth 参数校验：格式不对/缺失一律退回当前月，不因客户端传入脏数据
    // 就让查询条件失效或抛异常——公开接口的输入始终按"不可信"处理
    let targetYear = currentYear;
    let targetMonth = currentMonth;
    if (yearMonth && YEAR_MONTH_RE.test(String(yearMonth))) {
      const parts = String(yearMonth).split('-');
      targetYear = parseInt(parts[0], 10);
      targetMonth = parseInt(parts[1], 10);
    }
    const isCurrentMonth = targetYear === currentYear && targetMonth === currentMonth;

    const monthStr = String(targetMonth).padStart(2, '0');
    const monthStartStr = `${targetYear}-${monthStr}-01`;
    // 当月只统计到今天为止（避免"未来日期"污染），非当月（历史月份）统计完整一个月
    const monthEndStr = isCurrentMonth
      ? `${targetYear}-${monthStr}-${String(now.getDate()).padStart(2, '0')}`
      : `${targetYear}-${monthStr}-${String(daysInMonth(targetYear, targetMonth)).padStart(2, '0')}`;
    const periodLabel = `${targetYear}年${monthStr}月`;

    // 🏪 门店名称：与 publicVerifyReport 同一份数据来源，查询失败不影响主流程
    // 🆕 orgType 随门店文档一并取出（复用同一次 doc().get()，不新增查询）：供
    // 前端"阳光账本理念弹窗"按真实机构类型（雨花斋/助老食堂/其他）区分文案，
    // 不再靠 tenantId 前缀猜测——那套猜测口径无法区分同一租户下的不同业态门店
    let storeName = '';
    let orgType = '';
    try {
      const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
      const store = storeRes && storeRes.data;
      if (store) {
        storeName = store.storeName || '';
        orgType = store.orgType || '';
      }
    } catch (storeErr) {
      console.warn('[getSunshineLedger] 门店名称查询失败（不影响主流程）:', storeErr);
    }

    // 🛡️ 严格以 storeId 过滤 + 白名单 approvalStatus——不再按日期范围收窄，
    // 累计类指标需要覆盖本店全部历史已审核记录，月度指标从这份结果里再筛一次。
    // 🆕 orderBy dateString desc：供下方"最新爱心支持"善缘墙按时间倒序收集前
    // 20 条，此前没有排序，聚合类指标（求和/去重计数）不受影响，只是新增的
    // latestDonors 收集需要这份顺序保证
    const recordRes = await db.collection('report_logs')
      .where(_.and([
        { storeId },
        { isVoid: _.neq(true) },
        { approvalStatus: _.in(['APPROVED', 'AUDITED_LOCKED']) }
      ]))
      .orderBy('dateString', 'desc')
      .limit(QUERY_LIMIT)
      .get();

    const records = recordRes.data || [];

    let totalDiners = 0;
    let monthlyDiners = 0;
    let takeawayMeals = 0;
    let totalHours = 0;
    let volunteerCount = 0;
    const operatingDateSet = new Set();

    // 💖 发心分布（阳善 vs 积阴德）+ 最新爱心支持善缘墙：与 getNationalDashboard
    // 全国大屏同一套统计口径（yangCount/yinCount 按餐报份数计，donationItems
    // 按明细条目展开），只是把聚合范围从"全租户所有门店"收窄到本店，因为本卡片
    // 现在要迁到个人页给全员（含无租户级权限的家人/店长）公开展示，只能用本店
    // 自己已审核公开的数据，不能带出其他门店的信息
    const todayStr = now.toISOString().slice(0, 10);
    let yangCount = 0;
    let yinCount = 0;
    const latestDonors = [];

    // 🌸 近7日阳善榜：与 latestDonors（全历史，供个人页/首页现有的阳善公开滚动墙
    // 使用）是两份独立的收集结果，互不影响——严格限定 Date.now() - 7*86400*1000
    // 这一真实 7×24 小时窗口，不是"最近 7 条"或"最近 7 天里挑一部分"。
    // 优先用 createTime（记录提交时的服务器时间戳，dataService.ts 写入 report_logs
    // 时已带上）做精确到毫秒的窗口判断；老数据缺 createTime 字段时，退回按
    // dateString（日期，无时分）与 sevenDaysAgoStr 比较，仍然保证不早于 7 天前
    const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const sevenDaysAgoStr = new Date(sevenDaysAgoMs).toISOString().slice(0, 10);
    const latestDonorsWeekly = [];

    records.forEach((r) => {
      const dining = parseFloat(r.totalDineCount || r.diningCount) || 0;
      totalDiners += dining;
      if (r.dateString && r.dateString >= monthStartStr && r.dateString <= monthEndStr) {
        monthlyDiners += dining;
      }
      takeawayMeals += parseFloat(r.deliverySeniors) || 0;
      totalHours += parseFloat(r.volunteerHours) || 0;
      volunteerCount += parseFloat(r.totalVolunteers || r.volunteerCount) || 0;
      // 🛡️ 安全运营天数：按不重复的 dateString 计数，同一天多条记录（极少见，通常
      // 是覆盖更新前的历史脏数据）不重复计入天数
      if (r.dateString) {
        operatingDateSet.add(r.dateString);
      }

      const donationItems = Array.isArray(r.donationItems) ? r.donationItems : [];
      if (r.isAnonymous) {
        yinCount++;
      } else {
        yangCount++;
      }
      // 阳善（公开姓名）餐报才收进善缘墙；整份匿名报表(isAnonymous:true)统一跳过，
      // records 已按 dateString 降序取，先遇到的就是最新的
      if (!r.isAnonymous && donationItems.length > 0 && latestDonors.length < 20) {
        const dayDiff = r.dateString ? daysBetween(r.dateString, todayStr) : null;
        const timeLabel = dayDiff === null ? ''
          : dayDiff === 0 ? '今天'
          : dayDiff === 1 ? '昨天'
          : dayDiff < 7  ? dayDiff + '天前'
          : dayDiff < 30 ? Math.floor(dayDiff / 7) + '周前'
          : Math.floor(dayDiff / 30) + '个月前';
        donationItems.forEach((item) => {
          if (latestDonors.length >= 20) return;
          latestDonors.push({
            name: (item.name || '爱心人士').trim(),
            amount: parseFloat(item.amount) || 0,
            timeLabel
          });
        });
      }

      // 🌸 近7日阳善榜：独立的窗口判断与收集，不复用上面 latestDonors 的 20 条上限
      // 与天粒度 timeLabel——同一条 isAnonymous===false 的记录，只要落在 7 天窗口内，
      // 这里会再收一遍（用小时/分钟粒度的相对时间），两份列表用途不同，允许重复处理
      if (!r.isAnonymous && donationItems.length > 0 && latestDonorsWeekly.length < 30) {
        const recordMs = r.createTime ? new Date(r.createTime).getTime() : NaN;
        const inWeeklyWindow = !Number.isNaN(recordMs)
          ? recordMs >= sevenDaysAgoMs
          : !!(r.dateString && r.dateString >= sevenDaysAgoStr);
        if (inWeeklyWindow) {
          // createTime 缺失的老数据退回天粒度 timeLabel（今天/昨天/N天前），
          // 精度降级但不会显示错误的时间
          const weeklyTimeLabel = !Number.isNaN(recordMs)
            ? formatRelativeTime(r.createTime)
            : (() => {
                const dayDiff = r.dateString ? daysBetween(r.dateString, todayStr) : null;
                return dayDiff === null ? '' : dayDiff === 0 ? '今天' : dayDiff === 1 ? '昨天' : `${dayDiff}天前`;
              })();
          donationItems.forEach((item) => {
            if (latestDonorsWeekly.length >= 30) return;
            const amount = parseFloat(item.amount) || 0;
            latestDonorsWeekly.push({
              name: (item.name || '爱心人士').trim(),
              amount,
              // 善举说明：如实反映真实善款金额（"随喜 ¥50"），不虚构"份数"这类
              // 记录里并不存在的换算单位，避免误导公众对实际捐助内容的理解
              deedText: `随喜 ¥${amount}`,
              timeLabel: weeklyTimeLabel
            });
          });
        }
      }
    });

    const meritTotal = yangCount + yinCount;
    const yangRatioPct = meritTotal > 0 ? Math.round(yangCount / meritTotal * 1000) / 10 : 0;
    const yinRatioPct = meritTotal > 0 ? Math.round(yinCount / meritTotal * 1000) / 10 : 0;

    // ☀️ 第 8 项指标——账本公开率：本函数的查询条件本身就严格白名单只取
    // APPROVED/AUDITED_LOCKED（见文件头注释），也就是说只要有查到记录，
    // 这些记录 100% 都是已完成审核公示的，不存在"部分公开"的中间态，
    // 因此这里是按定义直接给定的常量展示值，不是从另一个分母算出来的比率——
    // 没有记录时展示为 null，由前端呈现"暂无数据"而不是误导性的 100%
    const ledgerPublicRate = records.length > 0 ? '100%' : null;

    return {
      success: true,
      storeId,
      storeName,
      orgType,
      periodLabel,
      yearMonth: `${targetYear}-${monthStr}`,
      auditedReportsCount: records.length,
      totalDiners,
      monthlyDiners,
      takeawayMeals,
      totalHours: Math.round(totalHours * 10) / 10,
      volunteerCount,
      operatingDays: operatingDateSet.size,
      ledgerPublicRate,
      yangRatioPct,
      yinRatioPct,
      latestDonors,
      latestDonorsWeekly
    };
  } catch (err) {
    console.error('[getSunshineLedger] 查询异常:', err);
    return { success: false, error: err.message || '查询失败' };
  }
};
