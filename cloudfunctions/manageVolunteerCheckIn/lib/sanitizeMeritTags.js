// 纯逻辑：修心积善打卡·微善标签白名单校验，不做 db I/O，便于单测；也不依赖
// wx-server-sdk。拆成独立文件与 index.js 共用，是本仓库 wxPayCore/
// getSettlementSummary 等云函数已有的既定写法（index.js 通过 require('./lib/xxx')
// 引入，不在两处各写一份）。
//
// MERIT_TAGS 必须与 miniprogram/components/volunteer-merit-dialog/
// volunteer-merit-dialog.ts 的 MERIT_TAG_OPTIONS 的 value 一一对应，两处
// 独立部署、无共享模块机制，改动需手动同步（见 CLAUDE.md 第 7.3 节字典表）。
'use strict';

const MERIT_TAGS = ['almsgiving', 'kindwords', 'thrift', 'cleaning'];

function sanitizeMeritTags(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((t) => MERIT_TAGS.includes(t));
}

module.exports = { MERIT_TAGS, sanitizeMeritTags };
