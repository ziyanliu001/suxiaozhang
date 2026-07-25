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

// 🛡️ 单次查询上限：本店按日累计的审核通过记录，理论上限是"运营天数"，1000 条约等于
// 2.7 年的每日记录；超过这个规模的门店（存续更久）累计类指标会低估，但公开只读接口
// 不适合为极端场景无限拉取全表，与 getStatisticsData 等同类云函数的 limit 口径一致
const QUERY_LIMIT = 2000;

exports.main = async (event) => {
  const { storeId } = event;

  if (!storeId || !String(storeId).trim()) {
    return { success: false, error: '缺少门店标识，无法查询' };
  }

  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const monthStartStr = `${year}-${month}-01`;
    const monthEndStr = `${year}-${month}-${String(now.getDate()).padStart(2, '0')}`;
    const periodLabel = `${year}年${month}月`;

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

    return {
      success: true,
      storeId,
      storeName,
      periodLabel,
      auditedReportsCount: records.length,
      totalDiners,
      monthlyDiners,
      takeawayMeals,
      totalHours: Math.round(totalHours * 10) / 10,
      volunteerCount,
      operatingDays: operatingDateSet.size
    };
  } catch (err) {
    console.error('[getSunshineLedger] 查询异常:', err);
    return { success: false, error: err.message || '查询失败' };
  }
};
