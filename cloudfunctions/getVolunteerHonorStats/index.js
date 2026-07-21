// 云函数：getVolunteerHonorStats
//
// 「志愿者爱心荣誉卡」的数据来源：只统计"本人亲手提交过的账目"，不编造/估算数据。
//
// report_logs 是前端直接调用 db.collection('report_logs').add()（见 dataService.ts）
// 写入的，微信云开发会自动给每条记录打上创建者的真实 _openid，且不可被客户端伪造——
// 本函数据此按 _openid 查询，天然就是"该志愿者亲手提交的报告"，比任何前端估算都可靠。
//
// 服务天数（serviceDays）不在本函数里算：那是义工到岗打卡的本地统计（my_checkin_days），
// 与"提交账目"是两件不同的事，由调用页面（journey.ts）自己从本地存储读取即可，
// 不需要为此新增服务端查询。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { success: false, error: '无法获取用户身份' };
  }

  try {
    let reportCount = 0;
    let diningCount = 0;
    let skip = 0;
    const batchLimit = 100;

    while (true) {
      const batch = await db.collection('report_logs')
        .where({ _openid: OPENID, isVoid: _.neq(true) })
        .field({ diningCount: true, diners: true })
        .skip(skip)
        .limit(batchLimit)
        .get();

      if (!batch.data || batch.data.length === 0) break;

      batch.data.forEach((item) => {
        reportCount++;
        diningCount += parseInt(item.diningCount || item.diners || 0, 10);
      });

      if (batch.data.length < batchLimit) break;
      skip += batchLimit;
      if (skip >= 2000) break; // 防御性上限，避免极端账号无限翻页
    }

    return { success: true, reportCount, diningCount };
  } catch (err) {
    console.error('[getVolunteerHonorStats] 异常:', err);
    return { success: false, error: err.message || '荣誉数据查询失败' };
  }
};
