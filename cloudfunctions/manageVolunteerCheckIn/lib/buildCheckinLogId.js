// 纯逻辑：打卡记录确定性 _id 拼装，供 index.js 的 handleCheckin 做原子防重复
// 打卡使用。同一个 {机构, 门店, 义工, 日期, 班次} 五元组在业务语义上本就应该
// 只存在一条生效记录——用这五元组拼出的确定性 _id，让数据库自身的主键唯一
// 约束来承担真正的并发互斥，而不是依赖"先查询判断是否已打卡、再插入"这种
// 存在竞态窗口（TOCTOU）的判断：两个几乎同时到达的相同班次打卡请求都可能在
// 查询这一步看到"尚未打卡"，但只有一个能在 db.collection().add() 这一步拿到
// 这个确定性 _id，另一个会撞主键冲突而失败，从数据库层面真正做到互斥。
//
// 与本仓库其余云函数已有的同类手法保持一致（各云函数独立部署，无共享模块
// 机制，是既定做法）：liveFactoryCore 的 settle_${tenantId}_${orderId}、
// manageDailyMenu 的 purchase_plan_${storeId}_${dateString}。
'use strict';

function buildCheckinLogId(tenantId, storeId, openid, dateString, shiftKey) {
  return `checkin_${tenantId}_${storeId}_${openid}_${dateString}_${shiftKey}`;
}

module.exports = { buildCheckinLogId };
