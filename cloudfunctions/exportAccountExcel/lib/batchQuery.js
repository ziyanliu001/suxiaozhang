// 分批拉取超过微信云数据库单次查询上限（1000 条）的记录：按 skip/limit 循环，
// 直到拿满 maxTotal 条或没有更多数据为止。见 batchFetchPlan.js 头部注释的
// 根因说明。deadline 达到时安全中断，返回目前已拿到的部分数据 +
// hitDeadline:true，供调用方决定是否提示"数据量过大，请缩短日期范围"，而不是
// 任由云函数在超时边缘被平台强制杀死、前端只收到一个无意义的网络错误。
'use strict';

const { nextBatchSize, isPastDeadline } = require('./batchFetchPlan');

/**
 * @param {object} collectionQuery - 已经 .where(...)（可再链 .orderBy() 等）
 *   但还没 .skip()/.limit() 的查询对象，即 db.collection(name).where(...)。
 *   必须带确定性排序（如 orderBy('dateString','asc')）——分批拉取依赖稳定
 *   排序才能保证跨批次不重复、不遗漏。
 * @param {object} opts
 * @param {number} opts.maxTotal - 最多拉取的记录数上限（业务侧的"最大导出规模"）
 * @param {number} [opts.deadline] - Date.now() 语义下的绝对截止时间戳；省略时不做超时检查
 * @returns {Promise<{ records: any[], hitCap: boolean, hitDeadline: boolean }>}
 */
async function fetchAllInBatches(collectionQuery, { maxTotal, deadline } = {}) {
  const records = [];
  let skip = 0;
  let hitDeadline = false;

  while (records.length < maxTotal) {
    if (isPastDeadline(deadline, Date.now())) {
      hitDeadline = true;
      break;
    }
    const batchSize = nextBatchSize(records.length, maxTotal);
    if (batchSize <= 0) break;

    const res = await collectionQuery.skip(skip).limit(batchSize).get();
    const batch = res.data || [];
    records.push(...batch);
    skip += batch.length;

    if (batch.length < batchSize) break; // 没有更多数据了，提前结束
  }

  return { records, hitCap: records.length >= maxTotal, hitDeadline };
}

module.exports = { fetchAllInBatches };
