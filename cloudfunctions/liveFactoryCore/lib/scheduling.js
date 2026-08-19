// 生产批次顺延调度：预售下单时把 quantity 分配到某个 batchDate。
//
// 🔑 与容量预占（tryReserveCapacity）解耦：assignProductionBatch 只负责"从哪天开始
// 试、试到哪天为止"这套纯日期推进逻辑，真正的原子占用通过注入的 reserveFn 完成——
// 这样可以脱离真实 db 环境对顺延算法做单元测试（见 scheduling.test.js），同时生产
// 环境下 reserveFn 走 CAS + 惰性建档，与 createStore.reserveStoreQuota 同一套并发
// 安全模式（见该文件 reserveStoreQuota 注释）。
'use strict';

const MAX_LOOKAHEAD_DAYS = 90; // 🛡️ 防御性上限：避免排期永远排不满时陷入无限日期推进

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

// SHIP_BUFFER_DAYS：生产批次日 → 预计发货日的固定备货/打包天数。当前所有素食
// 手作场景默认"当日成品次日发货"，与门店记账模块的 mealConfig 一样不做成按品类
// 可配置——真到有商家需要"当日直发"时再加字段，不提前造一个没人用的配置项
const SHIP_BUFFER_DAYS = 1;

/**
 * @param {Object} params
 * @param {number} params.dailyCapacityLimit  该 SKU 单日最大产能件数
 * @param {number} params.leadTimeDays        制作/备料前置天数
 * @param {number} params.quantity            本次下单件数
 * @param {Date}   params.orderCreateTime     下单时刻（用于推算最早可排日）
 * @param {(dateStr: string, quantity: number, limit: number) => Promise<boolean>} params.reserveFn
 *        对指定日期原子预占 quantity 份产能，成功返回 true，容量不足返回 false
 * @returns {Promise<{success: true, batchDate: string, estimatedShippingDate: string} | {success: false, error: string}>}
 */
async function assignProductionBatch({ dailyCapacityLimit, leadTimeDays, quantity, orderCreateTime, reserveFn }) {
  if (quantity <= 0) {
    return { success: false, error: '下单数量必须大于 0' };
  }
  // 单次下单量超过单日产能上限：任何一天都不可能满足，直接拒绝，不做跨日拆单
  // （拆单涉及"一笔订单对应多个批次/多次发货"，产品当前不支持，见 Step 2 说明）
  if (quantity > dailyCapacityLimit) {
    return { success: false, error: '单次下单数量超过该商品单日产能上限，请分批下单' };
  }

  let candidate = addDays(orderCreateTime, leadTimeDays);
  for (let i = 0; i < MAX_LOOKAHEAD_DAYS; i++) {
    const batchDate = toDateStr(candidate);
    const reserved = await reserveFn(batchDate, quantity, dailyCapacityLimit);
    if (reserved) {
      return {
        success: true,
        batchDate,
        estimatedShippingDate: toDateStr(addDays(candidate, SHIP_BUFFER_DAYS))
      };
    }
    candidate = addDays(candidate, 1);
  }
  return { success: false, error: '近期排期已满，请稍后再试或联系商家' };
}

/**
 * 生产环境用的 reserveFn：CAS 原子预占 + 惰性建档，模式与
 * createStore.reserveStoreQuota 完全一致（见该函数注释）。
 * @param {Object} db  云开发数据库实例（注入而非直接 require，便于测试替换）
 */
function makeDbReserveFn(db, tenantId, productId) {
  const _ = db.command;
  return async function reserveFn(batchDate, quantity, limit) {
    const casRes = await db.collection('production_capacity_counters').where({
      tenantId, productId, batchDate,
      reserved: _.lte(limit - quantity)
    }).update({ data: { reserved: _.inc(quantity) } });
    if (casRes.stats.updated === 1) return true;

    // 惰性建档：这个日期第一次被预占，文档还不存在。用 add() 建档，若与另一
    // 并发请求同时首次建档触发唯一索引冲突，捕获后回落到 CAS 重试（与
    // reserveStoreQuota 的"初始化竞态由重试收敛"完全同构）
    try {
      const existsRes = await db.collection('production_capacity_counters').where({ tenantId, productId, batchDate }).limit(1).get();
      if (!existsRes.data || existsRes.data.length === 0) {
        if (quantity <= limit) {
          await db.collection('production_capacity_counters').add({
            data: { tenantId, productId, batchDate, reserved: quantity, limit }
          });
          return true;
        }
        return false;
      }
    } catch (err) {
      // 并发建档冲突，忽略，走下面的重试
    }

    const retryRes = await db.collection('production_capacity_counters').where({
      tenantId, productId, batchDate,
      reserved: _.lte(limit - quantity)
    }).update({ data: { reserved: _.inc(quantity) } });
    return retryRes.stats.updated === 1;
  };
}

/**
 * 退款释放产能：把某批次已预占的 quantity 退回，不会减到负数
 * （极端情况下重复调用/数据修复场景的防御，正常链路每笔订单只释放一次）。
 */
function makeDbReleaseFn(db, tenantId, productId) {
  const _ = db.command;
  return async function releaseFn(batchDate, quantity) {
    await db.collection('production_capacity_counters').where({
      tenantId, productId, batchDate,
      reserved: _.gte(quantity)
    }).update({ data: { reserved: _.inc(-quantity) } });
  };
}

module.exports = { assignProductionBatch, makeDbReserveFn, makeDbReleaseFn, MAX_LOOKAHEAD_DAYS, SHIP_BUFFER_DAYS };
