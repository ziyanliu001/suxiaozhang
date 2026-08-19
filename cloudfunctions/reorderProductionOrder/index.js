// 云函数：reorderProductionOrder — Module D：历史订单一键复购
// 薄包装层：校验历史订单归属，取出 productId/quantity 后转发给 createProductionOrder
// 复用其完整的排产/支付逻辑，不重复实现下单业务规则。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: '无法获取用户身份' };

  const tenantId = String(event.tenantId || '');
  const previousOrderId = String(event.previousOrderId || '');
  if (!tenantId || !previousOrderId) return { success: false, error: '参数缺失: tenantId/previousOrderId' };

  const prevRes = await db.collection('production_orders').doc(previousOrderId).get().catch(() => null);
  const prev = prevRes && prevRes.data;
  if (!prev || prev.tenantId !== tenantId || prev.buyerOpenId !== OPENID) {
    return { success: false, error: '未找到可复购的历史订单' };
  }

  const res = await cloud.callFunction({
    name: 'createProductionOrder',
    data: {
      tenantId,
      productId: prev.productId,
      quantity: prev.quantity,
      promoterOpenId: prev.promoterOpenId || ''
    }
  });
  return res.result;
};
