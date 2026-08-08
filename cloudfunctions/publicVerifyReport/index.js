// 云函数：publicVerifyReport
//
// 海报「扫码验真」页面（miniprogram/pages/public-verify）专用的公开只读查询。
//
// 🛡️ 与本项目其余云函数最大的不同：这里刻意【不做】任何 user_roles/OPENID 权限校验——
// 扫码进来的是社会公众/捐赠人，他们大概率从未打开过本机构任何业务，也不该被要求登录/
// 绑定门店身份。这是专门设计成"人人可查"的透明公示接口。
//
// 正因为完全公开，返回字段必须严格收窄，只给"验证这张海报没有造假"所需的最小信息：
// - 不透传 _openid / createdBy / auditedBy 之外的任何内部账号标识
// - 捐赠人姓名统一走 maskName 脱敏后再吐给客户端（与海报生成 posterGenerator.ts 的
//   既有隐私处理口径保持一致，不能公开页面反而比海报本身泄露更多信息）
// - storeId 由调用方（扫码解析出的 scene 参数）指定要查询"哪一家门店"；本函数本身
//   不做门店归属校验（本来就是给陌生人看的），但会严格校验参数格式，避免被当成
//   任意查询接口滥用
//
// 🏢 术语对齐：请求方在 URL/scene 里传的字段历史上叫 tenant_id，但在本项目真实数据模型里，
// 一张餐报（report_logs）是按 storeId + dateString 唯一定位的，tenantId 只是门店所属机构，
// 同一机构下可能有多家门店同一天各自都有报告——所以这里的查询键实际使用 storeId，
// 而不是字面意义上的 tenantId（同样的术语澄清在 manageNotice/getStoreList 等云函数里
// 已经反复出现过，此处保持一致）。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function maskName(name) {
  if (!name) return '';
  const str = String(name).trim();
  if (str.length <= 1) return str + '*';
  if (str.length === 2) return str.charAt(0) + '*';
  return str.charAt(0) + '*' + str.charAt(str.length - 1);
}

// 与 miniprogram/pages/index/index.ts 里"充足/一般/告急"三档展示口径保持一致，
// 该字段本身就是 stapleRiceStatus/stapleOilStatus 两个枚举值（sufficient/normal/urgent）
function stapleStatusLabel(status) {
  if (status === 'urgent') return '告急';
  if (status === 'sufficient') return '充足';
  return '一般';
}

exports.main = async (event) => {
  const { storeId, date } = event;

  if (!storeId || !String(storeId).trim()) {
    return { success: false, error: '缺少门店标识，无法查询' };
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { success: false, error: '日期格式不正确' };
  }

  try {
    const reportRes = await db.collection('report_logs')
      .where({ storeId, dateString: date, isVoid: _.neq(true) })
      .orderBy('updateTime', 'desc')
      .limit(1)
      .get();

    const report = reportRes.data && reportRes.data[0];
    if (!report) {
      return { success: true, found: false };
    }

    // 平台级公开统计（爱心站点数 + 已审核账本数），与主查询并行，失败不影响主流程
    const [platformStoreRes, platformReportRes] = await Promise.all([
      db.collection('stores').count().catch(() => ({ total: 0 })),
      db.collection('report_logs')
        .where({ approvalStatus: _.in(['APPROVED', 'AUDITED_LOCKED']), isVoid: _.neq(true) })
        .count()
        .catch(() => ({ total: 0 }))
    ]);

    // 🏛️ 护持家长/日常店长姓名：与海报落款同一份数据来源（stores 文档缓存字段），
    // 体现雨花斋人文双署名文化；查询失败不影响主流程（验真的核心是账目）
    let patriarch = '';
    let manager = '';
    let orgType = 'dining';
    try {
      const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
      const store = storeRes && storeRes.data;
      if (store) {
        patriarch = store.patriarch || '';
        manager = store.manager || '';
        orgType = store.orgType || 'dining';
      }
    } catch (storeErr) {
      console.warn('[publicVerifyReport] 门店姓名查询失败（不影响主流程）:', storeErr);
    }

    // 门店日志/大事记：同店同日取最新一条，与 activity-log 页面口径一致；
    // 查询失败不影响主流程（验真的核心是账目，日志只是锦上添花）
    let activityItem = null;
    try {
      const activityRes = await db.collection('activity_logs')
        .where({ storeId, eventTime: date })
        .orderBy('updateTime', 'desc')
        .limit(1)
        .get();
      activityItem = (activityRes.data && activityRes.data[0]) || null;
    } catch (activityErr) {
      console.warn('[publicVerifyReport] 门店日志查询失败（不影响主流程）:', activityErr);
    }

    const donationItems = Array.isArray(report.donationItems)
      ? report.donationItems.map((d) => ({
          name: maskName(d && d.name),
          amount: (d && d.amount) || 0
        }))
      : [];

    const receiptImages = Array.isArray(report.receiptImages)
      ? report.receiptImages.filter((url) => !!url)
      : [];

    // 🌟 爱心物资透明墙：与海报生成 posterGenerator.ts drawMeritPoster 同一份口径，
    // 捐赠人姓名同样脱敏，只暴露"验真"所需的物资流向，不暴露任何账号身份信息
    const materials = Array.isArray(report.materials)
      ? report.materials.map((m) => ({
          donor: maskName((m && m.donor) || '匿名爱心人士'),
          item: (m && m.item) || '',
          quantity: (m && m.quantity) || '',
          unit: (m && m.unit) || ''
        }))
      : [];

    return {
      success: true,
      found: true,
      platformStats: {
        storeCount: platformStoreRes.total || 0,
        auditedReportCount: platformReportRes.total || 0
      },
      data: {
        storeName: report.shopName || '',
        patriarch,
        manager,
        orgType,
        dateString: report.dateString || date,
        approvalStatus: report.approvalStatus || 'PENDING_APPROVAL',
        auditedBy: report.auditedBy || '',
        auditTime: report.auditTime || '',
        yesterdayBalance: report.yesterdayBalance || 0,
        otherDonation: report.otherDonation || 0,
        listDonationTotal: report.listDonationTotal || 0,
        expenseAmount: report.expenseAmount || 0,
        todayBalance: report.todayBalance || 0,
        expenses: report.expenses || '',
        receiptImages,
        donationItems,
        materials,
        stapleRiceStatusLabel: stapleStatusLabel(report.stapleRiceStatus),
        stapleOilStatusLabel: stapleStatusLabel(report.stapleOilStatus),
        dineInSeniors: parseFloat(report.dineInSeniors) || 0,
        deliverySeniors: parseFloat(report.deliverySeniors) || 0,
        dineInVolunteers: parseFloat(report.dineInVolunteers) || 0,
        deliveryVolunteers: parseFloat(report.deliveryVolunteers) || 0,
        takeawayCount: parseFloat(report.takeawayCount) || 0,
        listeningSeniors: parseFloat(report.listeningSeniors) || 0,
        totalDineCount: parseFloat(report.totalDineCount || report.diningCount) || 0,
        totalVolunteers: parseFloat(report.totalVolunteers || report.volunteerCount) || 0,
        volunteerHours: parseFloat(report.volunteerHours) || 0,
        activity: activityItem
          ? {
              title: activityItem.title || '',
              content: activityItem.content || '',
              images: Array.isArray(activityItem.images) ? activityItem.images : []
            }
          : null
      }
    };
  } catch (err) {
    console.error('[publicVerifyReport] 异常:', err);
    return { success: false, error: '查询失败，请稍后重试' };
  }
};
