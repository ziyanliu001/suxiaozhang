// 云函数：getVolunteerGlobalPass — 义工全局通行证/荣誉统计
//
// 🐛 2026-08 修复：本函数此前一直读取 volunteer_logs 集合，但全仓库 grep
// 确认从未有任何云函数/前端代码写入过这张集合——它是一张有读无写的死集合，
// 意味着这个接口过去返回的荣誉数据实际上一直是空的（totalHours/totalTimes
// 恒为 0）。改为读取两张真正有数据的集合：
//   - volunteer_duty_logs（到岗打卡工时，manageVolunteerCheckIn 写入）
//   - volunteer_timebank_logs（工时→时间银行积分，ledgerIngestionAdapter/
//     manageVolunteerSubmission 类场景写入，阶段一新增）
// 二者字段形状不同（前者是 hours + storeId/storeName，后者是 hours+points），
// 分别累加后合并，honorTitle 分档口径不变，新增 totalPoints 返回字段。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const DUTY_COLLECTION = 'volunteer_duty_logs';
const TIMEBANK_COLLECTION = 'volunteer_timebank_logs';
// 与 leaderboard/networkSummary 等既有扫描口径一致的防御式上限
const BATCH_SIZE = 100;
const BATCH_CAP = 5000;

function isCollectionNotExistError(err) {
  return !!err && (err.errCode === -502005 || /database collection not exists/i.test(String(err.errMsg || err.message || '')));
}

async function fetchAll(collection, where) {
  const all = [];
  let skip = 0;
  while (skip < BATCH_CAP) {
    let res;
    try {
      res = await db.collection(collection).where(where).skip(skip).limit(BATCH_SIZE).get();
    } catch (err) {
      if (!isCollectionNotExistError(err)) throw err;
      return all;
    }
    const rows = res.data || [];
    all.push(...rows);
    if (rows.length < BATCH_SIZE) break;
    skip += BATCH_SIZE;
  }
  return all;
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  try {
    // active 打卡记录才计入工时——已撤回（revoked）的不算
    const dutyLogs = await fetchAll(DUTY_COLLECTION, { _openid: openid, status: 'active' });
    const timebankLogs = await fetchAll(TIMEBANK_COLLECTION, { volunteer_openid: openid });

    let totalHours = 0;
    let totalTimes = dutyLogs.length + timebankLogs.length;
    let totalPoints = 0;
    const servedStoresSet = new Set();

    dutyLogs.forEach((log) => {
      totalHours += Number(log.hours || 0);
      if (log.storeName) servedStoresSet.add(log.storeName);
      if (log.storeId) servedStoresSet.add(log.storeId);
    });

    timebankLogs.forEach((log) => {
      totalHours += Number(log.hours || 0);
      totalPoints += Number(log.points || 0);
      if (log.storeName) servedStoresSet.add(log.storeName);
      if (log.storeId) servedStoresSet.add(log.storeId);
    });

    let honorTitle = '爱心义工';
    if (totalHours >= 100) {
      honorTitle = '金牌义工';
    } else if (totalHours >= 30) {
      honorTitle = '资深义工';
    }

    return {
      success: true,
      data: {
        totalHours: parseFloat(totalHours.toFixed(2)),
        totalPoints: parseFloat(totalPoints.toFixed(2)),
        totalTimes: totalTimes,
        servedStoresCount: servedStoresSet.size,
        servedStoresList: Array.from(servedStoresSet),
        honorTitle: honorTitle
      }
    };

  } catch (err) {
    return { success: false, errMsg: err.message };
  }
};
