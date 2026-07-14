// 云函数：deleteMealReport - 使用管理员权限删除单条餐报记录
// 解决前端直接调用 db.remove() 因 OpenID 权限不匹配导致的删除失败问题

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event, context) => {
  const { id } = event;

  if (!id) {
    return {
      success: false,
      error: '缺少记录 ID'
    };
  }

  try {
    const removeResult = await db.collection('report_logs').doc(id).remove();

    if (removeResult.stats.removed === 0) {
      return {
        success: false,
        error: '记录不存在或删除失败'
      };
    }

    console.log(`[deleteMealReport] 成功删除记录: ${id}`);

    return {
      success: true,
      message: '删除成功'
    };
  } catch (err) {
    console.error('[deleteMealReport] 删除失败:', err);
    return {
      success: false,
      error: err.message || '删除失败'
    };
  }
};