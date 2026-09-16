// 纯逻辑：分批拉取记录时"下一批拉多少条""是否已经过了安全截止时间"的判断，
// 不做任何 db I/O，便于单测；被 lib/batchQuery.js 复用。
//
// 🏛️ 与 exportAccountExcel/lib/batchFetchPlan.js 内容完全一致——本仓库云函数
// 间无共享模块（各自独立部署），是既定做法（见本函数其余文件头部注释）。
//
// 🐛 存在的根因：微信云开发数据库单次 .get() 有硬性上限——无论 .limit() 传
// 多大，单次查询最多只返回 1000 条记录，超过部分被静默截断，不报错、不
// 警告。index.js 此前直接写 .limit(2000) 单次查询 production_orders/
// order_settlements，租户订单较多时实际上从未真正拿到超过 1000 条的数据——
// 是一个长期存在但从未被发现的静默数据丢失 bug。
'use strict';

const SINGLE_QUERY_MAX = 1000;

// 计算下一批要拉取的 limit：不超过单次查询硬上限，也不超过距离 maxTotal
// 还差多少条；已经拉满 maxTotal 时返回 0（调用方据此停止循环）
function nextBatchSize(fetchedCount, maxTotal) {
  return Math.max(0, Math.min(SINGLE_QUERY_MAX, maxTotal - fetchedCount));
}

// deadline 是 Date.now() 语义下的绝对截止时间戳（毫秒）；未传时视为永不超时
// （调用方自行决定是否需要超时保护）
function isPastDeadline(deadline, now) {
  return typeof deadline === 'number' && now >= deadline;
}

module.exports = { SINGLE_QUERY_MAX, nextBatchSize, isPastDeadline };
