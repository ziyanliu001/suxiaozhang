// 云函数：clearMealReports - 批量清理餐报数据
// 提供两种预案：A-清空所有记录，B-仅删除无效脏数据

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { mode = 'dirty' } = event; // mode: 'all' | 'dirty'
  const wxContext = cloud.getWXContext();
  const requestOpenid = wxContext.OPENID;

  try {
    // ========================================
    // 预案 A：直接清空该集合下的所有记录（重置数据库）
    // ========================================
    // 注意：此操作将删除 report_logs 集合中该用户的所有记录，不可逆！
    // 代码示例（已注释，需谨慎启用）：
    /*
    if (mode === 'all') {
      // 使用 where 条件删除指定用户的全部记录
      const deleteAllResult = await db.collection('report_logs')
        .where({
          _openid: requestOpenid
        })
        .remove();
      
      console.log(`[clearMealReports-预案A] 已清空用户 ${requestOpenid} 的所有记录，共删除 ${deleteAllResult.stats.removed} 条`);
      
      return {
        success: true,
        mode: 'all',
        removedCount: deleteAllResult.stats.removed,
        message: `已清空所有餐报记录，共删除 ${deleteAllResult.stats.removed} 条`
      };
    }
    */

    // ========================================
    // 预案 B：仅批量删除今日收入、今日支出、结余全部为 0 的无效脏数据
    // ========================================
    if (mode === 'dirty' || mode === 'all') {
      const dirtyRecords = await db.collection('report_logs')
        .where({
          _openid: requestOpenid
        })
        .get();

      if (!dirtyRecords.data || dirtyRecords.data.length === 0) {
        return {
          success: true,
          mode: mode,
          removedCount: 0,
          message: '没有符合条件的无效数据需要清理'
        };
      }

      let removedCount = 0;
      for (const record of dirtyRecords.data) {
        try {
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

      console.log(`[clearMealReports-预案B] 已清理用户 ${requestOpenid} 的无效脏数据，共删除 ${removedCount} 条`);

      return {
        success: true,
        mode: mode,
        removedCount: removedCount,
        message: `成功清空 ${removedCount} 条本人提交的无效记录（所有金额均为 0 且无物资无赞助名单）`
      };
    }

    return {
      success: false,
      error: '未知的清理模式'
    };
  } catch (err) {
    console.error('[clearMealReports] 清理失败:', err);
    return {
      success: false,
      error: err.message || '清理失败'
    };
  }
};