// 云函数：manageExpenseTemplate - 门店「高频账目模板」增删改查
//
// 权限模型：
// - 写（create/update/delete）：store_manager/finance（限本店，storeId 强制取自身份记录，
//   不信任客户端传入值）或 super_admin（限本机构内任意门店，校验目标门店 tenantId）。
//   这三个角色的门店级写权限组合与 recalculateCascadeBalances/manageFinanceLock 一致。
// - 读（list）：任意已登录角色只读，仅做门店/机构范围收敛，不做角色限制——填报表单时
//   任何人都要能看到模板列表，只是增删改按钮在前端对非管理角色隐藏。
//
// 规模上限：同门店同 category 最多 30 条，避免列表无界增长；量级小，不引入分页/排序字段。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTION = 'expense_item_templates';
const MAX_ITEMS_PER_CATEGORY = 30;
const MAX_LIST_LIMIT = 60;
const VALID_CATEGORIES = ['daily', 'fixed'];

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

// 写权限校验：店长/财务仅可管理本店；超管可管理本机构内任意门店
async function resolveWriteTarget(caller, requestedStoreId) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  // 🏛️ 权限向下继承：大家长天然拥有店长 + 财务的全套日常管理权限
  if (caller.role === 'store_manager' || caller.role === 'finance' || caller.role === 'store_patriarch') {
    if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店，无法管理支出模板' };
    return { allowed: true, storeId: caller.storeId, storeName: caller.storeName || '', tenantId: caller.tenantId || '' };
  }

  if (caller.role === 'super_admin') {
    if (!requestedStoreId) return { allowed: false, error: '请指定目标门店' };
    const storeRes = await db.collection('stores').doc(requestedStoreId).get().catch(() => null);
    const store = storeRes && storeRes.data;
    if (!store) return { allowed: false, error: '目标门店不存在' };
    if (caller.tenantId && store.tenantId && caller.tenantId !== store.tenantId) {
      return { allowed: false, error: '无权限：目标门店不属于您所在的机构' };
    }
    return { allowed: true, storeId: requestedStoreId, storeName: store.storeName || '', tenantId: caller.tenantId || store.tenantId || '' };
  }

  return { allowed: false, error: '无权限：仅店长、财务或超级管理员可管理支出模板' };
}

function sanitizeItemName(itemName) {
  return String(itemName || '').trim().slice(0, 20);
}

function sanitizeAmount(defaultAmount) {
  if (defaultAmount === undefined || defaultAmount === null || defaultAmount === '') return null;
  const amount = parseFloat(defaultAmount);
  if (isNaN(amount) || amount < 0) return undefined; // undefined 表示非法输入，调用方需拒绝
  return Math.round(amount * 100) / 100;
}

exports.main = async (event) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();

  if (!action) {
    return { success: false, error: '缺少 action 参数' };
  }

  try {
    const caller = await resolveCaller(OPENID);

    switch (action) {
      case 'create': {
        const { storeId, category, itemName, defaultAmount } = event;

        if (!VALID_CATEGORIES.includes(category)) {
          return { success: false, error: '请提供合法的 category（daily/fixed）' };
        }
        const safeName = sanitizeItemName(itemName);
        if (!safeName) {
          return { success: false, error: '请输入项目名称' };
        }
        const safeAmount = sanitizeAmount(defaultAmount);
        if (safeAmount === undefined) {
          return { success: false, error: '默认金额格式不正确' };
        }

        const target = await resolveWriteTarget(caller, storeId);
        if (!target.allowed) {
          return { success: false, error: target.error };
        }

        const countRes = await db.collection(COLLECTION)
          .where({ storeId: target.storeId, category })
          .count();
        if (countRes.total >= MAX_ITEMS_PER_CATEGORY) {
          return { success: false, error: `每个分类最多维护 ${MAX_ITEMS_PER_CATEGORY} 条常用项目，请先删除不再需要的条目` };
        }

        const dupRes = await db.collection(COLLECTION)
          .where({ storeId: target.storeId, category, itemName: safeName })
          .limit(1)
          .get();
        if (dupRes.data && dupRes.data.length > 0) {
          return { success: false, error: '该分类下已存在同名项目' };
        }

        const createRes = await db.collection(COLLECTION).add({
          data: {
            tenantId: target.tenantId,
            storeId: target.storeId,
            storeName: target.storeName,
            category,
            itemName: safeName,
            defaultAmount: safeAmount,
            createdBy: OPENID,
            createdAt: db.serverDate(),
            updateTime: db.serverDate()
          }
        });

        return { success: true, id: createRes._id, message: '已添加常用项目' };
      }

      case 'update': {
        const { id, itemName, defaultAmount } = event;
        if (!id) return { success: false, error: '缺少 id 参数' };

        const existingRes = await db.collection(COLLECTION).doc(id).get().catch(() => null);
        const existing = existingRes && existingRes.data;
        if (!existing) return { success: false, error: '记录不存在' };

        const target = await resolveWriteTarget(caller, existing.storeId);
        if (!target.allowed) {
          return { success: false, error: target.error };
        }
        if ((caller.role === 'store_manager' || caller.role === 'finance' || caller.role === 'store_patriarch') && existing.storeId !== target.storeId) {
          return { success: false, error: '无权限：不能编辑其他门店的模板' };
        }
        if (existing.tenantId && target.tenantId && existing.tenantId !== target.tenantId) {
          return { success: false, error: '无权限：该记录不属于您所在的机构' };
        }

        const updateData = { updateTime: db.serverDate() };
        if (itemName !== undefined) {
          const safeName = sanitizeItemName(itemName);
          if (!safeName) return { success: false, error: '请输入项目名称' };
          updateData.itemName = safeName;
        }
        if (defaultAmount !== undefined) {
          const safeAmount = sanitizeAmount(defaultAmount);
          if (safeAmount === undefined) return { success: false, error: '默认金额格式不正确' };
          updateData.defaultAmount = safeAmount;
        }

        await db.collection(COLLECTION).doc(id).update({ data: updateData });
        return { success: true, id, message: '已更新' };
      }

      case 'delete': {
        const { id } = event;
        if (!id) return { success: false, error: '缺少 id 参数' };

        const existingRes = await db.collection(COLLECTION).doc(id).get().catch(() => null);
        const existing = existingRes && existingRes.data;
        if (!existing) return { success: true, message: '记录不存在或已删除' };

        const target = await resolveWriteTarget(caller, existing.storeId);
        if (!target.allowed) {
          return { success: false, error: target.error };
        }
        if ((caller.role === 'store_manager' || caller.role === 'finance' || caller.role === 'store_patriarch') && existing.storeId !== target.storeId) {
          return { success: false, error: '无权限：不能删除其他门店的模板' };
        }
        if (existing.tenantId && target.tenantId && existing.tenantId !== target.tenantId) {
          return { success: false, error: '无权限：该记录不属于您所在的机构' };
        }

        await db.collection(COLLECTION).doc(id).remove();
        return { success: true, message: '已删除' };
      }

      case 'list': {
        const { storeId, category } = event;
        const isSuperAdmin = caller && caller.role === 'super_admin';

        const where = {};

        if (storeId === 'ALL') {
          if (!isSuperAdmin) {
            if (caller && caller.storeId) {
              where.storeId = caller.storeId;
            } else {
              return { success: true, data: [] };
            }
          }
          // 超管查看 ALL：仅按 tenantId 收敛，不再限制 storeId
        } else if (storeId) {
          where.storeId = storeId;
        } else if (caller && caller.storeId) {
          where.storeId = caller.storeId;
        }

        if (caller && caller.tenantId) {
          where.tenantId = caller.tenantId;
        } else if (!where.storeId) {
          // 🛡️ 既无法确定门店也无法确定机构：拒绝返回未隔离的全量数据，宁可空列表
          return { success: true, data: [] };
        }

        if (category && VALID_CATEGORIES.includes(category)) {
          where.category = category;
        }

        const listRes = await db.collection(COLLECTION)
          .where(where)
          .orderBy('createdAt', 'asc')
          .limit(MAX_LIST_LIMIT)
          .get();

        return { success: true, data: listRes.data || [] };
      }

      default:
        return { success: false, error: `不支持的 action: ${action}` };
    }
  } catch (err) {
    console.error('[manageExpenseTemplate] 异常:', err);
    return { success: false, error: err.message || '操作失败' };
  }
};
