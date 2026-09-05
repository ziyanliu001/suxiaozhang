// 云函数：manageInventoryItem - 商业进销存「物料档案与基础库存」增删改查
//
// 🏛️ 业态边界（Phase 1: 数据模型与增删改查底层）：本功能只服务于商业专区
// （orgType !== 'yuhuazhai'），雨花斋专区保持极简阳光账本、不引入进销存复杂度——
// 这不只是前端不展示入口，本云函数自己在解析出目标门店后也会硬性拒绝
// orgType==='yuhuazhai' 的读写请求，做到服务端硬隔离，不依赖前端自觉，见
// resolveWriteTarget/resolveReadStoreScope 里的 orgType 校验。
//
// 权限模型（与 manageExpenseTemplate 完全一致的既有约定）：
// - 写（create/update/disable）：store_manager/finance/store_patriarch（限本店，
//   storeId 强制取自身份记录，不信任客户端传入值）或 super_admin（限本机构内
//   任意门店，校验目标门店 tenantId）。
// - 读（list）：任意已登录角色只读，仅做门店/机构范围收敛。
//
// 🔐 免费版数量配额（Phase 1 商业化卡点）：与 createStore.js 的门店数量校验
// 同一种思路（内联查 tenant_subscriptions + 常量表 + errorCode），但物料创建
// 并发量极低（单店同一时刻通常只有一个操作者在维护档案），不需要 CAS 原子
// 占用，简单 count() 校验即可——配额按单店计数（storeId 维度），不是按租户，
// 因为进销存本身是单店运营台账的业务语义，与 PLAN_STORE_LIMITS 那种跨店连锁
// 管理的租户维度配额不是同一回事，不能直接复用那份常量/逻辑。
// 只在这一个云函数里维护这份配额表，没有其他调用方会创建物料，不存在
// PLAN_STORE_LIMITS 那种"5+ 处拷贝"的重复风险。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTION = 'inventory_items';
const MAX_LIST_LIMIT = 200;

const VALID_CATEGORIES = ['grain_oil', 'fresh_produce', 'mushroom_dried', 'plant_protein', 'packaging'];
const VALID_UNITS = ['kg', 'bag', 'bucket', 'box', 'piece'];

// 🔐 免费版最多 30 种物料（按单店计数，只算 status:'active'，停用的物料不
// 占用免费额度）；专业版/旗舰版大幅放宽。用一个足够大的数字表示"近似无限"——
// 云数据库/JSON 不支持真正的 Infinity 字面量落库比较
const PLAN_INVENTORY_ITEM_LIMITS = { basic: 30, pro: 200, enterprise: 999999 };

// 🛡️ 服务端内容安全兜底：物料名称对外部（同店其他角色）可见，落库前查一遍
// msgSecCheck，API 抖动时降级放行——与 createStore/manageStoreProfile 同款
async function checkContentSafe(text) {
  if (!text) return true;
  try {
    const res = await cloud.callFunction({
      name: 'msgSecCheck',
      data: { text, contentType: 'report' }
    });
    return !res.result || res.result.safe !== false;
  } catch (err) {
    console.warn('[manageInventoryItem] 服务端内容安全检测调用失败，降级放行:', err);
    return true;
  }
}

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

// 写权限校验：店长/财务/大家长仅可管理本店；超管可管理本机构内任意门店。
// 🌸 解析出目标门店后强制校验 orgType !== 'yuhuazhai'——雨花斋门店一律拒绝写入
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

function sanitizeName(name) {
  return String(name || '').trim().slice(0, 40);
}

function sanitizeCode(itemCode) {
  return String(itemCode || '').trim().slice(0, 40);
}

// 非负数字校验，undefined/null/'' 视为"未提供"（区别于非法输入 0 或负数）
function sanitizeNonNegativeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseFloat(value);
  if (isNaN(n) || n < 0) return undefined; // undefined 表示非法输入，调用方需拒绝
  return Math.round(n * 100) / 100;
}

function sanitizeNonNegativeInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 0) return undefined;
  return n;
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
        const {
          storeId, itemCode, name, category, unit,
          conversionUnit, conversionRatio, costPrice, currentStock,
          safetyStockMin, safetyStockMax, shelfLifeDays, expiryAlertDays
        } = event;

        if (!VALID_CATEGORIES.includes(category)) {
          return { success: false, error: '请提供合法的物料分类' };
        }
        if (!VALID_UNITS.includes(unit)) {
          return { success: false, error: '请提供合法的计量单位' };
        }
        const safeName = sanitizeName(name);
        if (!safeName) {
          return { success: false, error: '请输入物料名称' };
        }
        if (!(await checkContentSafe(safeName))) {
          return { success: false, error: '物料名称包含违规信息，请修改后重新提交' };
        }

        const safeCostPrice = sanitizeNonNegativeNumber(costPrice);
        if (safeCostPrice === undefined) return { success: false, error: '进价格式不正确' };
        const safeCurrentStock = sanitizeNonNegativeNumber(currentStock);
        if (safeCurrentStock === undefined) return { success: false, error: '当前库存量格式不正确' };
        const safeSafetyMin = sanitizeNonNegativeNumber(safetyStockMin);
        if (safeSafetyMin === undefined) return { success: false, error: '安全库存下限格式不正确' };
        const safeSafetyMax = sanitizeNonNegativeNumber(safetyStockMax);
        if (safeSafetyMax === undefined) return { success: false, error: '安全库存上限格式不正确' };
        const safeShelfLifeDays = sanitizeNonNegativeInt(shelfLifeDays, null);
        if (safeShelfLifeDays === undefined) return { success: false, error: '保质期天数格式不正确' };
        const safeExpiryAlertDays = sanitizeNonNegativeInt(expiryAlertDays, 7);
        if (safeExpiryAlertDays === undefined) return { success: false, error: '临期预警阈值格式不正确' };
        const safeConversionRatio = sanitizeNonNegativeNumber(conversionRatio);
        if (safeConversionRatio === undefined) return { success: false, error: '单位换算比例格式不正确' };

        const target = await resolveWriteTarget(caller, storeId);
        if (!target.allowed) {
          return { success: false, error: target.error };
        }

        // 🔐 免费版数量配额：按单店计数，只算 status:'active'
        let planType = 'basic';
        try {
          const subRes = await db.collection('tenant_subscriptions')
            .where({ tenantId: target.tenantId })
            .orderBy('lastRenewedAt', 'desc')
            .limit(1)
            .get();
          const sub = subRes.data && subRes.data[0];
          if (sub) {
            const expireTime = sub.serviceExpireDate ? new Date(sub.serviceExpireDate).getTime() : NaN;
            const isExpired = !Number.isNaN(expireTime) && expireTime < Date.now();
            planType = isExpired ? 'basic' : (sub.planType || 'basic');
          }
        } catch (err) {
          console.warn('[manageInventoryItem] tenant_subscriptions 查询失败，按 basic 档处理:', err);
        }
        const itemLimit = PLAN_INVENTORY_ITEM_LIMITS[planType] || PLAN_INVENTORY_ITEM_LIMITS.basic;
        const activeCountRes = await db.collection(COLLECTION)
          .where({ storeId: target.storeId, status: 'active' })
          .count();
        if (activeCountRes.total >= itemLimit) {
          return {
            success: false,
            errorCode: 'INVENTORY_LIMIT_REACHED',
            error: `物料已达免费版上限(${activeCountRes.total}/${itemLimit})，请扩容或升级专业版`
          };
        }

        const createRes = await db.collection(COLLECTION).add({
          data: {
            tenantId: target.tenantId,
            storeId: target.storeId,
            itemCode: sanitizeCode(itemCode),
            name: safeName,
            category,
            unit,
            conversionUnit: String(conversionUnit || '').trim().slice(0, 20),
            conversionRatio: safeConversionRatio === null ? 1 : safeConversionRatio,
            costPrice: safeCostPrice === null ? 0 : safeCostPrice,
            currentStock: safeCurrentStock === null ? 0 : safeCurrentStock,
            safetyStockMin: safeSafetyMin,
            safetyStockMax: safeSafetyMax,
            shelfLifeDays: safeShelfLifeDays,
            expiryAlertDays: safeExpiryAlertDays,
            status: 'active',
            createdBy: OPENID,
            createdAt: db.serverDate(),
            updateTime: db.serverDate()
          }
        });

        return { success: true, id: createRes._id, message: '已添加物料' };
      }

      case 'update': {
        const {
          id, itemCode, name, category, unit,
          conversionUnit, conversionRatio, costPrice, currentStock,
          safetyStockMin, safetyStockMax, shelfLifeDays, expiryAlertDays
        } = event;
        if (!id) return { success: false, error: '缺少 id 参数' };

        const existingRes = await db.collection(COLLECTION).doc(id).get().catch(() => null);
        const existing = existingRes && existingRes.data;
        if (!existing) return { success: false, error: '记录不存在' };

        // 🛡️ storeId/tenantId 不可通过 update 篡改——权限校验直接用记录已有的
        // storeId 反查目标，与 manageExpenseTemplate 同一套写法
        const target = await resolveWriteTarget(caller, existing.storeId);
        if (!target.allowed) {
          return { success: false, error: target.error };
        }
        if ((caller.role === 'store_manager' || caller.role === 'finance' || caller.role === 'store_patriarch') && existing.storeId !== target.storeId) {
          return { success: false, error: '无权限：不能编辑其他门店的物料' };
        }
        if (!existing.tenantId || !target.tenantId || existing.tenantId !== target.tenantId) {
          return { success: false, error: '无权限：该记录不属于您所在的机构' };
        }

        const updateData = { updateTime: db.serverDate() };

        if (itemCode !== undefined) updateData.itemCode = sanitizeCode(itemCode);
        if (name !== undefined) {
          const safeName = sanitizeName(name);
          if (!safeName) return { success: false, error: '请输入物料名称' };
          if (!(await checkContentSafe(safeName))) {
            return { success: false, error: '物料名称包含违规信息，请修改后重新提交' };
          }
          updateData.name = safeName;
        }
        if (category !== undefined) {
          if (!VALID_CATEGORIES.includes(category)) return { success: false, error: '请提供合法的物料分类' };
          updateData.category = category;
        }
        if (unit !== undefined) {
          if (!VALID_UNITS.includes(unit)) return { success: false, error: '请提供合法的计量单位' };
          updateData.unit = unit;
        }
        if (conversionUnit !== undefined) updateData.conversionUnit = String(conversionUnit || '').trim().slice(0, 20);
        if (conversionRatio !== undefined) {
          const safe = sanitizeNonNegativeNumber(conversionRatio);
          if (safe === undefined) return { success: false, error: '单位换算比例格式不正确' };
          updateData.conversionRatio = safe === null ? 1 : safe;
        }
        if (costPrice !== undefined) {
          const safe = sanitizeNonNegativeNumber(costPrice);
          if (safe === undefined) return { success: false, error: '进价格式不正确' };
          updateData.costPrice = safe === null ? 0 : safe;
        }
        if (currentStock !== undefined) {
          const safe = sanitizeNonNegativeNumber(currentStock);
          if (safe === undefined) return { success: false, error: '当前库存量格式不正确' };
          updateData.currentStock = safe === null ? 0 : safe;
        }
        if (safetyStockMin !== undefined) {
          const safe = sanitizeNonNegativeNumber(safetyStockMin);
          if (safe === undefined) return { success: false, error: '安全库存下限格式不正确' };
          updateData.safetyStockMin = safe;
        }
        if (safetyStockMax !== undefined) {
          const safe = sanitizeNonNegativeNumber(safetyStockMax);
          if (safe === undefined) return { success: false, error: '安全库存上限格式不正确' };
          updateData.safetyStockMax = safe;
        }
        if (shelfLifeDays !== undefined) {
          const safe = sanitizeNonNegativeInt(shelfLifeDays, null);
          if (safe === undefined) return { success: false, error: '保质期天数格式不正确' };
          updateData.shelfLifeDays = safe;
        }
        if (expiryAlertDays !== undefined) {
          const safe = sanitizeNonNegativeInt(expiryAlertDays, 7);
          if (safe === undefined) return { success: false, error: '临期预警阈值格式不正确' };
          updateData.expiryAlertDays = safe;
        }

        await db.collection(COLLECTION).doc(id).update({ data: updateData });
        return { success: true, id, message: '已更新' };
      }

      // 🛡️ 软删除：与 stores/report_logs 一贯的软删除约定一致，停用后不再计入
      // 免费版配额（见 create 分支的 status:'active' 计数条件），也不再出现在
      // list 默认视图里，但历史记录不丢失
      case 'disable': {
        const { id } = event;
        if (!id) return { success: false, error: '缺少 id 参数' };

        const existingRes = await db.collection(COLLECTION).doc(id).get().catch(() => null);
        const existing = existingRes && existingRes.data;
        if (!existing) return { success: true, message: '记录不存在或已停用' };

        const target = await resolveWriteTarget(caller, existing.storeId);
        if (!target.allowed) {
          return { success: false, error: target.error };
        }
        if ((caller.role === 'store_manager' || caller.role === 'finance' || caller.role === 'store_patriarch') && existing.storeId !== target.storeId) {
          return { success: false, error: '无权限：不能停用其他门店的物料' };
        }
        if (!existing.tenantId || !target.tenantId || existing.tenantId !== target.tenantId) {
          return { success: false, error: '无权限：该记录不属于您所在的机构' };
        }

        await db.collection(COLLECTION).doc(id).update({
          data: { status: 'disabled', updateTime: db.serverDate() }
        });
        return { success: true, message: '已停用' };
      }

      case 'list': {
        const { storeId, status } = event;
        if (!caller) return { success: true, data: [] };

        const effectiveStoreId = storeId || caller.storeId;
        if (!effectiveStoreId) {
          return { success: true, data: [] };
        }

        // 🌸 雨花斋门店直接返回空列表 + 明确提示，不静默展示"暂无物料"制造误解
        const storeRes = await db.collection('stores').doc(effectiveStoreId).get().catch(() => null);
        const store = storeRes && storeRes.data;
        if (store && store.orgType === 'yuhuazhai') {
          return { success: false, error: '雨花公益专区不支持进销存功能' };
        }

        // 🛡️ 非超管只能查自己绑定门店；超管可查本机构任意门店（仍需 tenantId 收敛）
        const isSuperAdmin = caller.role === 'super_admin';
        if (!isSuperAdmin && effectiveStoreId !== caller.storeId) {
          return { success: false, error: '无权限：不能查看其他门店的进销存' };
        }
        if (isSuperAdmin && store && caller.tenantId && store.tenantId !== caller.tenantId) {
          return { success: false, error: '无权限：目标门店不属于您所在的机构' };
        }

        const where = { storeId: effectiveStoreId };
        if (status === 'disabled') {
          where.status = 'disabled';
        } else if (status !== 'all') {
          // 默认只看在用物料，不传 status 或传非法值都按这档处理
          where.status = 'active';
        }
        // status==='all' 时不加 status 条件，两档都返回

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
    console.error('[manageInventoryItem] 异常:', err);
    return { success: false, error: err.message || '操作失败' };
  }
};
