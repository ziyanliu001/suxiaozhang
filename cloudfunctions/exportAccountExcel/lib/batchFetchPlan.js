// 纯逻辑：分批拉取记录时"下一批拉多少条""是否已经过了安全截止时间"的判断，
// 不做任何 db I/O，便于单测；被 lib/batchQuery.js 复用。
//
// 🐛 存在的根因：微信云开发数据库单次 .get() 有硬性上限——无论 .limit() 传
// 多大，单次查询最多只返回 1000 条记录，超过部分被静默截断，不报错、不
// 警告。exportAccountExcel/index.js 与 lib/auditLedgerExcel.js 此前多处直接
// 写 .limit(5000)/.limit(3000)/.limit(2000) 单次查询，机构门店多、导出周期
// 长时实际上从未真正拿到超过 1000 条的数据——是一个长期存在但从未被发现的
// 静默数据丢失 bug（超出 1000 条的记录会凭空从"阳光台账"审计导出里消失，
// 不会有任何报错提示用户或财务人员）。
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
