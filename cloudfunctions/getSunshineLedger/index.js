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
    let storeName = '';
    try {
      const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
      const store = storeRes && storeRes.data;
      if (store) {
        storeName = store.storeName || '';
      }
    } catch (storeErr) {
      console.warn('[getSunshineLedger] 门店名称查询失败（不影响主流程）:', storeErr);
    }

    // 🛡️ 严格以 storeId 过滤 + 白名单 approvalStatus——不再按日期范围收窄，
    // 累计类指标需要覆盖本店全部历史已审核记录，月度指标从这份结果里再筛一次
    const recordRes = await db.collection('report_logs')
      .where(_.and([
        { storeId },
        { isVoid: _.neq(true) },
        { approvalStatus: _.in(['APPROVED', 'AUDITED_LOCKED']) }
      ]))
      .limit(QUERY_LIMIT)
      .get();

    const records = recordRes.data || [];

    let totalDiners = 0;
    let monthlyDiners = 0;
    let takeawayMeals = 0;
    let totalHours = 0;
    let volunteerCount = 0;
    const operatingDateSet = new Set();

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
    });

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
      periodLabel,
      yearMonth: `${targetYear}-${monthStr}`,
      auditedReportsCount: records.length,
      totalDiners,
      monthlyDiners,
      takeawayMeals,
      totalHours: Math.round(totalHours * 10) / 10,
      volunteerCount,
      operatingDays: operatingDateSet.size,
      ledgerPublicRate
    };
  } catch (err) {
    console.error('[getSunshineLedger] 查询异常:', err);
    return { success: false, error: err.message || '查询失败' };
  }
};
