// 云函数：getSunshineLedger
//
// 首页「☀️ 阳光账本」入口专用的公开只读汇总查询。
//
// 🛡️ 与本项目其余云函数最大的不同（与 publicVerifyReport 同一套设计哲学）：这里刻意
// 【不做】任何 user_roles/OPENID 权限校验——首页任何访客（含未登录/未绑定门店身份的
// 家人、义工、财务、店长、家长、超管）点开都应该能看到本店的公开透明数据，不需要
// 任何权限门槛。正因为完全公开，只接受调用方明确指定的单个 storeId（不支持"全部门店"
// 之类的跨店聚合参数），避免这个无鉴权接口被当成任意门店数据的批量抓取入口。
//
// 🛡️ 核心风控：查询条件严格限定 approvalStatus 为 'APPROVED' 或 'AUDITED_LOCKED'，
// 绝对排除 'PENDING'（含缺失该字段的历史/草稿记录，undefined 不在这两个值内，天然被
// 排除）——阳光账本展示的必须是"已经过店长核对确认/财务稽核"的生效数据，不能让
// 尚未审核的草稿金额被公众误当作已生效数据看待。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const { storeId } = event;

  if (!storeId || !String(storeId).trim()) {
    return { success: false, error: '缺少门店标识，无法查询' };
  }

  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const startDateStr = `${year}-${month}-01`;
    const endDateStr = `${year}-${month}-${String(now.getDate()).padStart(2, '0')}`;
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

    const recordRes = await db.collection('report_logs')
      .where(_.and([
        { storeId },
        { dateString: _.gte(startDateStr).and(_.lte(endDateStr)) },
        { isVoid: _.neq(true) },
        // 🛡️ 核心风控：严格白名单，PENDING/草稿/未审核记录一律不计入
        { approvalStatus: _.in(['APPROVED', 'AUDITED_LOCKED']) }
      ]))
      .limit(1000)
      .get();

    const records = recordRes.data || [];

    let totalDining = 0;
    let totalDelivery = 0;
    let totalVolunteerHours = 0;

    records.forEach((r) => {
      totalDining += parseFloat(r.totalDineCount || r.diningCount) || 0;
      totalDelivery += parseFloat(r.deliverySeniors) || 0;
      totalVolunteerHours += parseFloat(r.volunteerHours) || 0;
    });

    return {
      success: true,
      storeId,
      storeName,
      periodLabel,
      recordCount: records.length,
      totalDining,
      totalDelivery,
      totalVolunteerHours: Math.round(totalVolunteerHours * 10) / 10
    };
  } catch (err) {
    console.error('[getSunshineLedger] 查询异常:', err);
    return { success: false, error: err.message || '查询失败' };
  }
};
