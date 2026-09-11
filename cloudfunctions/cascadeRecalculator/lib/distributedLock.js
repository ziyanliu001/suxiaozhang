'use strict';

// 🔒（2026-09-12 门店级级联重算并发安全加固）纯逻辑部分：锁 ID 生成、
// 锁是否已过期的判定、重试退避延迟计算——都不依赖 wx-server-sdk，可以
// 直接单测。真正的 CAS 读写（db.collection('system_locks') 的 add/where/
// update）留在 index.js，与本仓库既有的 index.js + lib/*.js 拆分写法一致
// （见 manageVolunteerCheckIn/getSettlementSummary 等云函数）。
//
// 🛡️ 设计取舍：wx 云开发数据库没有原生的"分布式锁"API，这里复用本仓库
// 已经在 liveFactoryCore（buildSettlement/reverseSettlement）验证过的
// "确定性 _id + add() 主键唯一性天然去重"手法——用 add() 显式指定 _id
// 抢锁：谁先把这条 _id 文档 add() 成功，谁就是持锁者，后来者 add() 必然
// 因为主键冲突而报错，这是数据库层面保证的原子性，不依赖应用层"先查后写"
// 的竞态窗口。TTL 过期后允许"偷锁"（通过 where({_id, expiresAt: lt(now)})
// 的条件更新，同样是原子 CAS，不是"先查过期再无条件覆盖"）。

const crypto = require('crypto');

const DEFAULT_TTL_MS = 30000; // 30s，覆盖单次级联重算的正常耗时，防止云函数异常退出/超时后死锁
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 200;
const MAX_BACKOFF_EXPONENT = 4; // 封顶 2^4=16 倍，避免极端情况下退避时间无限膨胀

/**
 * 由 tenantId + 门店标识（storeId 或 shopName）生成确定性锁文档 _id。
 * 用 md5 哈希而不是直接拼接原始字符串，是因为 shopName 可能含有 wx 云
 * 数据库 _id 不允许出现的特殊字符（如 "/"），哈希后必然是安全的十六进制串。
 * @param {string} tenantId
 * @param {string} storeFilter
 * @returns {string}
 */
function buildLockId(tenantId, storeFilter) {
  const raw = `${tenantId || ''}|${storeFilter || ''}`;
  return 'cascade_recalc_' + crypto.createHash('md5').update(raw).digest('hex');
}

/**
 * 判定一把已存在的锁文档是否已经过期（过期即可以被新的请求"偷"过来）。
 * 缺少 expiresAt 字段/文档不存在一律视为"已过期"，不会因为一条脏数据/
 * 早期版本遗留字段就永久锁死这个门店的级联重算能力。
 * @param {{expiresAt?: number}|null|undefined} lockDoc
 * @param {number} now
 * @returns {boolean}
 */
function isLockExpired(lockDoc, now) {
  if (!lockDoc || typeof lockDoc.expiresAt !== 'number') return true;
  return lockDoc.expiresAt <= now;
}

/**
 * 抢锁失败后，第 attempt 次重试前应该等待多久（毫秒）。指数退避 + 随机抖动，
 * 抖动是为了避免多个并发请求恰好在完全相同的时间点扎堆重试、重复踩踏。
 * @param {number} attempt 从 0 开始计数的重试序号
 * @param {number} [baseMs]
 * @returns {number}
 */
function computeBackoffDelayMs(attempt, baseMs) {
  const base = typeof baseMs === 'number' && baseMs > 0 ? baseMs : DEFAULT_BACKOFF_BASE_MS;
  const exponent = Math.min(Math.max(attempt, 0), MAX_BACKOFF_EXPONENT);
  const jitter = Math.floor(Math.random() * base);
  return base * Math.pow(2, exponent) + jitter;
}

module.exports = {
  DEFAULT_TTL_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_BACKOFF_BASE_MS,
  buildLockId,
  isLockExpired,
  computeBackoffDelayMs
};
