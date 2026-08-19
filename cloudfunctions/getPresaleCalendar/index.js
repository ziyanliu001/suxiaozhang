// 云函数：getPresaleCalendar — Module D：预售日历，消费者查看各批次「现做现发」排期与余量
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

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

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  const tenantId = String(event.tenantId || '');
  const productId = String(event.productId || '');
  // rangeDays：默认展示未来 14 天余量，前端可按需传入更长区间，不做无上限查询
  const rangeDays = Math.min(Math.max(Number(event.rangeDays) || 14, 1), 60);
  if (!tenantId || !productId) return { success: false, error: '参数缺失: tenantId/productId' };

  const productRes = await db.collection('products').doc(productId).get().catch(() => null);
  const product = productRes && productRes.data;
  if (!product || product.tenantId !== tenantId || product.status !== 'active') {
    return { success: false, error: '商品不存在或已下架' };
  }

  const earliestDate = addDays(new Date(), product.leadTimeDays || 0);
  const dateList = [];
  for (let i = 0; i < rangeDays; i++) dateList.push(toDateStr(addDays(earliestDate, i)));

  const countersRes = await db.collection('production_capacity_counters').where({
    tenantId, productId, batchDate: _.in(dateList)
  }).get();
  const reservedMap = {};
  (countersRes.data || []).forEach((c) => { reservedMap[c.batchDate] = c.reserved || 0; });

  const calendar = dateList.map((batchDate) => {
    const reserved = reservedMap[batchDate] || 0;
    const remaining = Math.max(product.dailyCapacityLimit - reserved, 0);
    return { batchDate, remaining, soldOut: remaining <= 0 };
  });

  return { success: true, productId, productName: product.name, dailyCapacityLimit: product.dailyCapacityLimit, calendar };
};
