// 云函数：manageInventoryTransaction - 商业进销存「出入库流水与库存变动」
//
// 🏛️ 与 manageInventoryItem 同一批 Phase 1/2 交付，权限模型/雨花斋硬隔离完全
// 一致（各云函数独立部署，无共享模块机制，两份拷贝需要手动同步维护）。
//
// 🔒 一致性保证：db.startTransaction()，与 createStore.js 建店事务同一种写法——
// 事务内先读物料当前 currentStock/costPrice 快照，算出这次变动后的结存量，
// 校验不为负后，同一个事务里原子完成"更新 inventory_items.currentStock（以及
// PURCHASE_IN 时的 costPrice 加权平均重算）+ 写入 inventory_logs 流水"两步，
// 不会出现"流水写成功了、库存却没跟着改"或反过来的半成品状态。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const ITEM_COLLECTION = 'inventory_items';
const LOG_COLLECTION = 'inventory_logs';
const MAX_LIST_LIMIT = 200;

const VALID_ACTION_TYPES = ['PURCHASE_IN', 'KITCHEN_OUT', 'STOCKTAKE_ADJUST', 'SPOILED_SCRAP'];

async function checkContentSafe(text) {
  if (!text) return true;
  try {
    const res = await cloud.callFunction({
      name: 'msgSecCheck',
      data: { text, contentType: 'report' }
    });
    return !res.result || res.result.safe !== false;
  } catch (err) {
    console.warn('[manageInventoryTransaction] 服务端内容安全检测调用失败，降级放行:', err);
    return true;
  }
}

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

// 写权限校验：与 manageInventoryItem.resolveWriteTarget 完全一致的拷贝——
// 店长/财务/大家长仅可操作本店，超管可操作本机构任意门店；雨花斋门店一律拒绝
async function resolveWriteTarget(caller, requestedStoreId) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  if (caller.role === 'store_manager' || caller.role === 'finance' || caller.role === 'store_patriarch') {
    if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店，无法管理进销存' };
    const storeRes = await db.collection('stores').doc(caller.storeId).get().catch(() => null);
    const store = storeRes && storeRes.data;
    if (!store) return { allowed: false, error: '门店不存在' };
    if (store.orgType === 'yuhuazhai') {
      return { allowed: false, error: '雨花公益专区不支持进销存功能' };
    }
    return { allowed: true, storeId: caller.storeId, tenantId: caller.tenantId || store.tenantId || '' };
  }

  if (caller.role === 'super_admin') {
    if (!requestedStoreId) return { allowed: false, error: '请指定目标门店' };
    const storeRes = await db.collection('stores').doc(requestedStoreId).get().catch(() => null);
    const store = storeRes && storeRes.data;
    if (!store) return { allowed: false, error: '目标门店不存在' };
    if (!caller.tenantId || !store.tenantId || caller.tenantId !== store.tenantId) {
      return { allowed: false, error: '无权限：目标门店不属于您所在的机构' };
    }
    if (store.orgType === 'yuhuazhai') {
      return { allowed: false, error: '雨花公益专区不支持进销存功能' };
    }
    return { allowed: true, storeId: requestedStoreId, tenantId: caller.tenantId || store.tenantId || '' };
  }

  return { allowed: false, error: '无权限：仅店长、财务、大家长或超级管理员可管理进销存' };
}

function sanitizePositiveNumber(value) {
  const n = parseFloat(value);
  if (isNaN(n) || n <= 0) return undefined;
  return Math.round(n * 100) / 100;
}

function sanitizeNonNegativeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseFloat(value);
  if (isNaN(n) || n < 0) return undefined;
  return Math.round(n * 100) / 100;
}

exports.main = async (event) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();

  if (!action) {
    return { success: false, error: '缺少 action 参数' };
  }

  try {
    const caller = await resolveCaller(OPENID);

    if (action === 'create') {
      const { itemId, storeId, actionType, quantity, actualStock, unitCost, remark } = event;

      if (!itemId) return { success: false, error: '缺少物料 id' };
      if (!VALID_ACTION_TYPES.includes(actionType)) {
        return { success: false, error: '请提供合法的变动类型' };
      }

      const isStocktake = actionType === 'STOCKTAKE_ADJUST';
      // 🌟 数量输入方式区分：盘点校准填"实际盘点到的库存量"（绝对值），其余
      // 三种填"本次数量"（正数，由 actionType 决定入库云函数存成正数还是负数）
      let inputQuantity;
      if (isStocktake) {
        inputQuantity = sanitizeNonNegativeNumber(actualStock);
        if (inputQuantity === null || inputQuantity === undefined) {
          return { success: false, error: '请输入本次实际盘点到的库存量' };
        }
      } else {
        inputQuantity = sanitizePositiveNumber(quantity);
        if (inputQuantity === undefined) {
          return { success: false, error: '请输入大于 0 的本次数量' };
        }
      }

      const safeUnitCost = sanitizeNonNegativeNumber(unitCost);
      if (safeUnitCost === undefined) return { success: false, error: '进价/成本格式不正确' };
      const safeRemark = String(remark || '').trim().slice(0, 200);
      if (safeRemark && !(await checkContentSafe(safeRemark))) {
        return { success: false, error: '备注包含违规信息，请修改后重新提交' };
      }

      const target = await resolveWriteTarget(caller, storeId);
      if (!target.allowed) {
        return { success: false, error: target.error };
      }

      const itemRes = await db.collection(ITEM_COLLECTION).doc(itemId).get().catch(() => null);
      const item = itemRes && itemRes.data;
      if (!item) return { success: false, error: '物料不存在' };
      if (item.storeId !== target.storeId) {
        return { success: false, error: '无权限：该物料不属于当前门店' };
      }

      const transaction = await db.startTransaction();
      try {
        // 🔒 事务内重新读一次最新快照——不能信任事务外已经查过的 item 对象，
        // 避免"查询之后、事务提交之前"这段窗口期被别的并发请求改动
        const txItemRes = await transaction.collection(ITEM_COLLECTION).doc(itemId).get();
        const txItem = txItemRes.data;
        if (!txItem) {
          await transaction.rollback();
          return { success: false, error: '物料不存在' };
        }

        const currentStock = parseFloat(txItem.currentStock) || 0;
        const currentCostPrice = parseFloat(txItem.costPrice) || 0;

        let changeQuantity;
        let balanceAfter;
        if (isStocktake) {
          balanceAfter = inputQuantity;
          changeQuantity = Math.round((balanceAfter - currentStock) * 100) / 100;
        } else {
          changeQuantity = actionType === 'PURCHASE_IN' ? inputQuantity : -inputQuantity;
          balanceAfter = Math.round((currentStock + changeQuantity) * 100) / 100;
        }

        // 🛡️ 库存不允许变成负数：物理上不存在负库存，出现说明前面某个环节
        // 记错了，直接拒绝这次操作，不静默钳制成 0、也不允许写入负值
        if (balanceAfter < 0) {
          await transaction.rollback();
          return { success: false, error: `库存不足，无法完成本次操作（当前 ${currentStock}，本次需要 ${-changeQuantity}）` };
        }

        // 💰 本次变动总金额：unitCost × 变动数量的绝对值——盘点校准如果实际
        // 数量与账面一致（changeQuantity===0，没有真正发生任何物料移动），
        // 金额也应该是 0，不能退回去按"本次盘点到的总量"乘进价算出一个虚高的
        // 金额（那不是"这次变动"的成本，是"这批物料的全部账面价值"）
        const totalAmount = (safeUnitCost || 0) * Math.abs(changeQuantity);

        const itemUpdateData = {
          currentStock: balanceAfter,
          updateTime: db.serverDate()
        };
        // 🌟 采购入库自动重算加权平均进价：新costPrice = (旧costPrice×旧库存 +
        // 本次unitCost×本次数量) / 新库存；新库存为 0（理论上不会发生，入库
        // 后库存只会增加）时兜底直接取本次 unitCost，避免除零
        if (actionType === 'PURCHASE_IN' && safeUnitCost !== null) {
          itemUpdateData.costPrice = balanceAfter > 0
            ? Math.round(((currentCostPrice * currentStock + safeUnitCost * inputQuantity) / balanceAfter) * 100) / 100
            : safeUnitCost;
        }

        await transaction.collection(ITEM_COLLECTION).doc(itemId).update({ data: itemUpdateData });

        const logCreateRes = await transaction.collection(LOG_COLLECTION).add({
          data: {
            tenantId: target.tenantId,
            storeId: target.storeId,
            itemId,
            itemCode: txItem.itemCode || '',
            itemName: txItem.name || '',
            actionType,
            changeQuantity,
            unitCost: safeUnitCost === null ? 0 : safeUnitCost,
            totalAmount: Math.round(totalAmount * 100) / 100,
            balanceAfter,
            remark: safeRemark,
            operatorOpenId: OPENID,
            operatorName: caller.realName || caller.nickName || '',
            createTime: db.serverDate()
          }
        });

        await transaction.commit();

        return { success: true, id: logCreateRes._id, balanceAfter, message: '已登记变动' };
      } catch (txErr) {
        await transaction.rollback();
        throw txErr;
      }
    }

    if (action === 'list') {
      const { itemId } = event;
      if (!itemId) return { success: false, error: '缺少物料 id' };
      if (!caller) return { success: true, data: [] };

      const itemRes = await db.collection(ITEM_COLLECTION).doc(itemId).get().catch(() => null);
      const item = itemRes && itemRes.data;
      if (!item) return { success: true, data: [] };

      const isSuperAdmin = caller.role === 'super_admin';
      if (!isSuperAdmin && item.storeId !== caller.storeId) {
        return { success: false, error: '无权限：不能查看其他门店的进销存台账' };
      }
      if (isSuperAdmin && caller.tenantId && item.tenantId !== caller.tenantId) {
        return { success: false, error: '无权限：目标门店不属于您所在的机构' };
      }

      const listRes = await db.collection(LOG_COLLECTION)
        .where({ itemId })
        .orderBy('createTime', 'desc')
        .limit(MAX_LIST_LIMIT)
        .get();

      return { success: true, data: listRes.data || [] };
    }

    return { success: false, error: `不支持的 action: ${action}` };
  } catch (err) {
    console.error('[manageInventoryTransaction] 异常:', err);
    return { success: false, error: err.message || '操作失败' };
  }
};
