// 云函数：clearMealReports - 清理本人提交的无效（全零）餐报草稿脏数据
//
// 🛡️ 此前文件头注释声称"提供两种预案：A-清空所有记录，B-仅删除无效脏数据"，但预案 A
// 的实现代码整段被注释掉，且 `if (mode === 'dirty' || mode === 'all')` 让两种 mode
// 实际走的是同一段"仅删全零记录"逻辑——调用方若真的传 mode:'all' 期望清空全部数据，
// 得到的却是"什么都没删"的静默行为差异。经确认小程序端（dataService.ts）固定只传
// mode:'dirty'，'all' 从未被真正使用，因此直接去掉这个名不副实的参数分支，只保留
// 实际生效的"清理全零无效草稿"能力，避免误导后来的维护者。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const requestOpenid = wxContext.OPENID;

  if (!requestOpenid) {
    return { success: false, error: '无法获取用户身份' };
  }

  try {
    const dirtyRecords = await db.collection('report_logs')
      .where({ _openid: requestOpenid })
      .get();

    if (!dirtyRecords.data || dirtyRecords.data.length === 0) {
      return { success: true, removedCount: 0, message: '没有符合条件的无效数据需要清理' };
    }

    let removedCount = 0;
    for (const record of dirtyRecords.data) {
      try {
        // 🛡️ 状态机闭环：即使金额全零，已财务封账的记录也不应被静默删除，
        // 与其它写路径（updateReportLog/deleteMealReport 等）保持一致的锁定校验
        if (record.approvalStatus === 'AUDITED_LOCKED' || record.isLocked) {
          continue;
        }

        const yesterdayBalance = parseFloat(record.yesterdayBalance) || 0;
        const otherDonation = parseFloat(record.otherDonation) || 0;
        const listDonationTotal = parseFloat(record.listDonationTotal) || 0;
        const expenseAmount = parseFloat(record.expenseAmount) || 0;
        const todayBalance = parseFloat(record.todayBalance) || 0;
        const diningCount = parseFloat(record.diningCount) || 0;
        const volunteerCount = parseFloat(record.volunteerCount) || 0;
        const volunteerHours = parseFloat(record.volunteerHours) || 0;
        const hasMaterials = record.materials && record.materials.length > 0;
        const hasItems = record.items && record.items.length > 0;
        const hasDonationItems = record.donationItems && record.donationItems.length > 0;

        const isEmpty =
          yesterdayBalance === 0 &&
          otherDonation === 0 &&
          listDonationTotal === 0 &&
          expenseAmount === 0 &&
          todayBalance === 0 &&
          diningCount === 0 &&
          volunteerCount === 0 &&
          volunteerHours === 0 &&
          !hasMaterials &&
          !hasItems &&
          !hasDonationItems;

        if (isEmpty) {
          await db.collection('report_logs').doc(record._id).remove();
          removedCount++;
        }
      } catch (e) {
        console.error(`[clearMealReports] 删除单条记录失败: ${record._id}`, e);
      }
    }

    console.log(`[clearMealReports] 已清理用户 ${requestOpenid} 的无效脏数据，共删除 ${removedCount} 条`);

    return {
      success: true,
      removedCount,
      message: `成功清空 ${removedCount} 条本人提交的无效记录（所有金额均为 0 且无物资无赞助名单）`
    };
  } catch (err) {
    console.error('[clearMealReports] 清理失败:', err);
    return { success: false, error: err.message || '清理失败' };
  }
};
