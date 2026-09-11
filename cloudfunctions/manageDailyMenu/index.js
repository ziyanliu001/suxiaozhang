// 云函数：manageDailyMenu - 每日菜单增删改查
//
// 权限模型：
// - 写（create/update/delete）：仅 store_manager（限本店，storeId 强制取自身份记录，
//   不信任客户端传入值）或 super_admin（限本机构内任意门店，校验目标门店 tenantId）。
// - 读（getByDate/list）：任意已登录角色只读；storeId==='ALL' 的汇总列表仅 super_admin
//   可用，其余角色一律退回查看自己所在门店，绝不放行未授权的跨店/跨机构宽查询。
//
// 分页：list 支持 page/pageSize（默认 20，上限 50），避免上百家门店规模下一次性拉全量。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
// 🍚（2026-09-10 智能备餐与食材用量预测·一期原型）纯计算逻辑拆到
// lib/predictMealDemand.js（不依赖 wx-server-sdk，配套单测见同目录
// *.test.js），这里只负责查 report_logs 拿历史开餐人次喂给它
const { predictMealDemand } = require('./lib/predictMealDemand');
// 🛒（2026-09-11 后厨采购清单云端持久化·方向2）与 predictMealDemand 同一处
// 既定写法：纯逻辑（生成/勾选/微调/服务端字段白名单清洗）拆到
// lib/buildPurchasePlan.js，这里只负责数据库读写与权限校验
const {
  togglePurchaseTaskStatus,
  updatePurchaseTaskWeight,
  sanitizePurchasePlanTasks,
  buildPurchasePlanId
} = require('./lib/buildPurchasePlan');
// 🛡️（2026-09-11 巡检漫游补齐）与 manageStoreProfile/getPatriarchDashboard/
// manageReportApproval 同一套 authorizedTenants 轻量租户漫游机制——原先本
// 云函数的 resolveCaller 只是极简的按 OPENID 查 user_roles，不支持
// platform_admin 巡检漫游，导致采购清单等新能力没有审计巡检通道可用。
// 见 lib/resolveCaller.js、lib/buildAuditLogEntry.js 头部注释。
const { resolveEffectiveCaller } = require('./lib/resolveCaller');
const { buildAuditLogEntry, isRoamingConsumed } = require('./lib/buildAuditLogEntry');

const COLLECTION = 'daily_menus';
// 🛒 后厨采购清单：一家门店一天一份，_id 用 buildPurchasePlanId 拼出的
// 确定性主键，不是 daily_menus 的子字段——采购清单是"全天一份"的概念，
// 与 daily_menus 按 mealType（早/午/晚）拆成多份文档的粒度不一致，硬塞
// 进 daily_menus 会引入"这份清单到底属于哪一餐"的伪问题
const PURCHASE_PLAN_COLLECTION = 'daily_purchase_plans';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
// 🍚 预测查询历史数据时往前多看一段缓冲期（远大于 predictMealDemand 自己的
// 14 天回溯窗口）——万一目标门店最近 14 天恰好有几天漏报，退化分支还能
// 从更早的记录里凑出一个"好过没有"的简单平均，而不是直接判定 insufficientData
const PREDICTION_HISTORY_LOOKUP_DAYS = 60;

// 🛡️ 服务端内容安全兜底：菜谱文字对外公开展示，此前只在前端提交前查一次
// msgSecCheck，绕过前端直接调云函数即可跳过审核。降级口径同 manageNotice。
async function checkContentSafe(text) {
  if (!text) return true;
  try {
    const res = await cloud.callFunction({
      name: 'msgSecCheck',
      data: { text, contentType: 'report' }
    });
    return !res.result || res.result.safe !== false;
  } catch (err) {
    console.warn('[manageDailyMenu] 服务端内容安全检测调用失败，降级放行:', err);
    return true;
  }
}
// 🖼️ 今日食谱单条最多 9 张配图（微信标准九宫格），与前端上传数量限制对齐。
// 注：曾一度收紧为 1 张以控制上百家门店规模下的云存储成本，现按产品需求恢复为 9，
// 相应的存储成本增长是已知且接受的权衡，如需再次收紧请同步调整前端 onChooseImage 的上限。
const MAX_IMAGES = 9;

// 🍱 餐别：本项目最初每店每日仅发一次午餐，daily_menus 存量记录完全没有 mealType
// 字段。现支持早/午/晚餐独立发布，查重键从 {storeId, dateString} 扩为 {storeId,
// dateString, mealType}——但查 lunch 时必须把"字段缺失"也当作 lunch 兼容，否则这次
// 改动上线的瞬间，所有存量午餐记录会因为查不出 mealType==='lunch' 而"凭空消失"。
// breakfast/dinner 没有历史包袱，精确匹配即可。
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner'];
const DEFAULT_MEAL_TYPE = 'lunch';

function normalizeMealType(mealType) {
  return MEAL_TYPES.includes(mealType) ? mealType : DEFAULT_MEAL_TYPE;
}

// 供 create 查重、getByDate、list 可选过滤三处共用同一份"缺失字段按 lunch 兼容"逻辑
function buildMealTypeCondition(mealType) {
  const safe = normalizeMealType(mealType);
  if (safe === DEFAULT_MEAL_TYPE) {
    return _.eq(DEFAULT_MEAL_TYPE).or(_.exists(false));
  }
  return safe;
}

// 🛡️（2026-09-11 巡检漫游补齐）与 manageStoreProfile 同款签名：opts.targetStoreId
// 命中调用者 authorizedTenants 里某条有效授权时，返回的身份把
// tenantId/role/storeId 替换成该条授权的值；未命中/未传时原样返回调用者
// 本来的身份，行为与改造前逐字节一致。只在真的发生了漫游身份替换时才写
// 一条审计日志，未漫游的高频路径（本店角色访问自己门店）零额外开销。
async function resolveCaller(OPENID, opts) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  const own = (roleRes.data && roleRes.data[0]) || null;
  const targetStoreId = opts && (opts.targetStoreId || opts.storeId);
  const effectiveCaller = resolveEffectiveCaller(own, targetStoreId);

  if (isRoamingConsumed(own, effectiveCaller)) {
    const storeRes = await db.collection('stores').doc(targetStoreId).field({ storeName: true }).get().catch(() => null);
    const targetStoreName = (storeRes && storeRes.data && storeRes.data.storeName) || '';
    const logEntry = buildAuditLogEntry({
      operatorOpenId: OPENID,
      own,
      effectiveCaller,
      targetStoreId,
      targetStoreName,
      cloudFunctionName: 'manageDailyMenu',
      action: opts && opts.action
    });
    if (logEntry) {
      await db.collection('tenant_authorization_audit_logs').add({
        data: { ...logEntry, createTime: db.serverDate() }
      }).catch((err) => console.warn('[manageDailyMenu] 巡检审计日志写入失败:', err));
    }
  }

  return effectiveCaller;
}

// 写权限校验：店长仅可管理本店；超管可管理本机构内任意门店
async function resolveWriteTarget(caller, requestedStoreId) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  // 🏛️ 权限向下继承：大家长天然拥有店长的全套日常管理权限
  if (caller.role === 'store_manager' || caller.role === 'store_patriarch') {
    if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店，无法发布菜单' };
    return { allowed: true, storeId: caller.storeId, storeName: caller.storeName || '', tenantId: caller.tenantId || '' };
  }

  if (caller.role === 'super_admin') {
    if (!requestedStoreId) return { allowed: false, error: '请指定目标门店' };
    const storeRes = await db.collection('stores').doc(requestedStoreId).get().catch(() => null);
    const store = storeRes && storeRes.data;
    if (!store) return { allowed: false, error: '目标门店不存在' };
    // 🛡️ 多租户越权修复：两侧 tenantId 都必须存在且相等才放行，任一缺失时不再
    // 无条件放行。
    if (!caller.tenantId || !store.tenantId || caller.tenantId !== store.tenantId) {
      return { allowed: false, error: '无权限：目标门店不属于您所在的机构' };
    }
    return { allowed: true, storeId: requestedStoreId, storeName: store.storeName || '', tenantId: caller.tenantId || store.tenantId || '' };
  }

  return { allowed: false, error: '无权限：仅店长或超级管理员可发布/编辑/删除菜单' };
}

// 🛒（2026-09-11 后厨采购清单）权限口径与 resolveWriteTarget（daily_menus
// 内容编辑）刻意不同：采购清单是门店内部的协同待办事项，不是需要"能编辑
// 菜单"这种更高权限才能碰的内容——任意已绑定本店的角色（义工/财务/店长/
// 大家长）都应该能查看和勾选，与 getMealPrediction 的权限口径保持一致
// （预测结果本身谁都能看，采购清单是它的下一步动作，理应延续同一条权限
// 边界，不应该比查看预测结果本身更严格）
async function resolvePurchasePlanTarget(caller, requestedStoreId) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  if (caller.role === 'super_admin') {
    if (!requestedStoreId) return { allowed: false, error: '请指定目标门店' };
    const storeRes = await db.collection('stores').doc(requestedStoreId).get().catch(() => null);
    const store = storeRes && storeRes.data;
    if (!store) return { allowed: false, error: '目标门店不存在' };
    if (!caller.tenantId || !store.tenantId || caller.tenantId !== store.tenantId) {
      return { allowed: false, error: '无权限：目标门店不属于您所在的机构' };
    }
    return { allowed: true, storeId: requestedStoreId, storeName: store.storeName || '', tenantId: caller.tenantId };
  }

  if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店，无法使用采买清单' };
  return { allowed: true, storeId: caller.storeId, storeName: caller.storeName || '', tenantId: caller.tenantId || '' };
}

// 🍚 从 'YYYY-MM-DD' 往前减 days 天，返回同格式字符串——用 Date.UTC 而不是
// 本地时区的 Date 方法，与 predictMealDemand.js 的日期算法口径保持一致，
// 避免云函数容器时区不是 UTC+8 时算出偏移一天的查询区间
function subtractDays(dateString, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  const [, y, mo, d] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d)) - days * 86400000;
  const dt = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function normalizePage(page, pageSize) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(pageSize, 10) || DEFAULT_PAGE_SIZE));
  return { page: p, size };
}

// 🍱 菜品名称最大长度：与前端编辑表单 dm-dish-name-input 的 maxlength 对齐
const MAX_DISH_NAME_LENGTH = 20;

function sanitizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images.slice(0, MAX_IMAGES).map(img => ({
    url: (img && img.url) || '',
    thumbUrl: (img && (img.thumbUrl || img.url)) || '',
    name: (img && typeof img.name === 'string') ? img.name.trim().slice(0, MAX_DISH_NAME_LENGTH) : ''
  })).filter(img => img.url);
}

// 发布人展示标签：仅用角色身份（店长/超级管理员），不落库/不回传真实姓名等 PII，
// 与本项目其余页面的脱敏展示口径保持一致
function resolvePublisherLabel(role) {
  if (role === 'super_admin') return '超级管理员';
  if (role === 'store_manager') return '店长';
  if (role === 'store_patriarch') return '大家长';
  return '管理员';
}

exports.main = async (event) => {
  const { action, storeId: eventStoreId } = event;
  const { OPENID } = cloud.getWXContext();

  if (!action) {
    return { success: false, error: '缺少 action 参数' };
  }

  try {
    // 🛡️ targetStoreId 取自 event.storeId——本云函数除 'delete'（只传 id，
    // 目标门店要先查文档才知道）外的其余 action 都以 storeId 作为目标门店
    // 参数名，传给 resolveCaller 后，只有调用者持有覆盖这家门店的有效巡检
    // 授权时才会触发漫游；未传/未命中时 caller 与改造前完全一致
    const caller = await resolveCaller(OPENID, { targetStoreId: eventStoreId, action });

    switch (action) {
      case 'create':
      case 'update': {
        const { id, storeId, dateString, menuText, images, mealType } = event;
        const safeMealType = normalizeMealType(mealType);

        if (!dateString || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
          return { success: false, error: '请提供合法的日期 (YYYY-MM-DD)' };
        }
        const safeImages = sanitizeImages(images);
        if ((!menuText || !String(menuText).trim()) && safeImages.length === 0) {
          return { success: false, error: '请至少填写菜谱文字或上传一张配图' };
        }

        const target = await resolveWriteTarget(caller, storeId);
        if (!target.allowed) {
          return { success: false, error: target.error };
        }
        if (!(await checkContentSafe(menuText))) {
          return { success: false, error: '内容包含违规信息，请修改后重新提交' };
        }

        if (action === 'update' && id) {
          const existingRes = await db.collection(COLLECTION).doc(id).get().catch(() => null);
          const existing = existingRes && existingRes.data;
          if (!existing) return { success: false, error: '记录不存在' };
          if (!existing.tenantId || !target.tenantId || existing.tenantId !== target.tenantId) {
            return { success: false, error: '无权限：该记录不属于您所在的机构' };
          }
          if ((caller.role === 'store_manager' || caller.role === 'store_patriarch') && existing.storeId !== target.storeId) {
            return { success: false, error: '无权限：不能编辑其他门店的菜单' };
          }

          await db.collection(COLLECTION).doc(id).update({
            data: {
              dateString,
              mealType: safeMealType,
              menuText: menuText || '',
              images: safeImages,
              updateTime: db.serverDate(),
              publisherLabel: resolvePublisherLabel(caller.role)
            }
          });
          return { success: true, id, message: '菜单已更新' };
        }

        // 新建：同店同日期同餐别已存在则视为覆盖更新，避免同一天同一餐重复出现多份菜单
        const dupRes = await db.collection(COLLECTION)
          .where({ storeId: target.storeId, dateString, mealType: buildMealTypeCondition(safeMealType) })
          .limit(1)
          .get();

        if (dupRes.data && dupRes.data.length > 0) {
          const dupId = dupRes.data[0]._id;
          await db.collection(COLLECTION).doc(dupId).update({
            data: {
              mealType: safeMealType,
              menuText: menuText || '',
              images: safeImages,
              updateTime: db.serverDate(),
              publisherLabel: resolvePublisherLabel(caller.role)
            }
          });
          return { success: true, id: dupId, message: '当日菜单已更新（原记录已覆盖）' };
        }

        const createRes = await db.collection(COLLECTION).add({
          data: {
            tenantId: target.tenantId,
            storeId: target.storeId,
            storeName: target.storeName,
            dateString,
            mealType: safeMealType,
            menuText: menuText || '',
            images: safeImages,
            createdBy: OPENID,
            createdAt: db.serverDate(),
            updateTime: db.serverDate(),
            publisherLabel: resolvePublisherLabel(caller.role)
          }
        });

        return { success: true, id: createRes._id, message: '菜单已发布' };
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
        if ((caller.role === 'store_manager' || caller.role === 'store_patriarch') && existing.storeId !== target.storeId) {
          return { success: false, error: '无权限：不能删除其他门店的菜单' };
        }
        if (!existing.tenantId || !target.tenantId || existing.tenantId !== target.tenantId) {
          return { success: false, error: '无权限：该记录不属于您所在的机构' };
        }

        await db.collection(COLLECTION).doc(id).remove();
        return { success: true, message: '菜单已删除' };
      }

      case 'getByDate': {
        const { storeId, dateString, mealType } = event;
        if (!storeId || !dateString) {
          return { success: false, error: '缺少 storeId 或 dateString 参数' };
        }

        // 不传 mealType 的旧调用点（如首页随手拍食谱）一直操作的就是"午餐"，
        // buildMealTypeCondition 缺省按 lunch 兼容，行为与改动前完全一致
        const where = { storeId, dateString, mealType: buildMealTypeCondition(mealType) };
        if (caller && caller.tenantId) {
          where.tenantId = caller.tenantId;
        }

        const res = await db.collection(COLLECTION).where(where).limit(1).get();
        return { success: true, data: (res.data && res.data[0]) || null };
      }

      case 'list': {
        const { storeId, page, pageSize, startDate, endDate, mealType } = event;
        const { page: p, size } = normalizePage(page, pageSize);
        const isSuperAdmin = caller && caller.role === 'super_admin';

        const where = {};

        if (storeId === 'ALL') {
          if (!isSuperAdmin) {
            // 🛡️ 非超管请求"全部门店"一律拒绝退回自身门店，不放行未授权宽查询
            if (caller && caller.storeId) {
              where.storeId = caller.storeId;
            } else {
              return { success: true, data: [], page: p, pageSize: size, total: 0, hasMore: false };
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
          return { success: true, data: [], page: p, pageSize: size, total: 0, hasMore: false };
        }

        if (startDate && endDate) {
          where.dateString = _.gte(startDate).and(_.lte(endDate));
        } else if (startDate) {
          where.dateString = _.gte(startDate);
        } else if (endDate) {
          where.dateString = _.lte(endDate);
        }

        // 🍱 餐别过滤为可选参数：不传时行为与改动前完全一致（不筛餐别，返回全部）
        if (mealType) {
          where.mealType = buildMealTypeCondition(mealType);
        }

        const countRes = await db.collection(COLLECTION).where(where).count();
        const listRes = await db.collection(COLLECTION)
          .where(where)
          .orderBy('dateString', 'desc')
          .skip((p - 1) * size)
          .limit(size)
          .get();

        return {
          success: true,
          data: listRes.data || [],
          page: p,
          pageSize: size,
          total: countRes.total,
          hasMore: p * size < countRes.total
        };
      }

      // 🍚（2026-09-10 智能备餐与食材用量预测·一期原型）只读预测，不落库、
      // 不改动任何 daily_menus/report_logs 记录——纯粹是"给我一个参考数字"。
      // ⚠️ 如实说明：这里放在 manageDailyMenu 是按需求指定的位置，但历史
      // 开餐人次实际查的是 report_logs 集合（daily_menus 本身不记录人次
      // 字段），见 lib/predictMealDemand.js 文件头注释
      case 'getMealPrediction': {
        const { storeId: requestedStoreId, targetDate, weatherFactor, isHoliday } = event;
        if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
          return { success: false, error: '请提供合法的目标日期 (YYYY-MM-DD)' };
        }
        if (!caller) {
          return { success: false, error: '无权限：未找到您的角色信息' };
        }

        let storeId;
        if (caller.role === 'super_admin') {
          // 🛡️ 超管可指定本机构任意门店；不传时退回自己绑定的门店（若有）
          storeId = requestedStoreId || caller.storeId;
          if (!storeId) return { success: false, error: '请指定要预测的门店' };
        } else {
          // 🛡️ 非超管一律只能查看自己绑定门店的预测，忽略/拒绝客户端传入的
          // 其它 storeId——与 list/getByDate 既有的读权限收敛口径一致
          if (!caller.storeId) return { success: false, error: '您尚未绑定门店，无法查看备餐预测' };
          storeId = caller.storeId;
        }

        const lookupStart = subtractDays(targetDate, PREDICTION_HISTORY_LOOKUP_DAYS);
        const historyRes = await db.collection('report_logs')
          .where({
            storeId,
            dateString: _.gte(lookupStart).and(_.lt(targetDate))
          })
          .field({ dateString: true, dineInSeniors: true, deliverySeniors: true })
          .orderBy('dateString', 'desc')
          .limit(100)
          .get();

        const prediction = predictMealDemand({
          historyRecords: historyRes.data || [],
          targetDate,
          weatherFactor,
          isHoliday: !!isHoliday
        });

        return { success: true, storeId, ...prediction };
      }

      // 🛒（2026-09-11 后厨采购清单云端持久化）只读查看当天的采购清单——
      // 不存在（还没人生成过）不是错误，是正常的空状态，success:true +
      // exists:false，前端据此决定是走"生成"还是"展示已有进度"分支
      case 'getPurchasePlan': {
        const { storeId: requestedStoreId, dateString } = event;
        if (!dateString || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
          return { success: false, error: '请提供合法的日期 (YYYY-MM-DD)' };
        }
        const target = await resolvePurchasePlanTarget(caller, requestedStoreId);
        if (!target.allowed) return { success: false, error: target.error };

        const planId = buildPurchasePlanId(target.storeId, dateString);
        const planRes = await db.collection(PURCHASE_PLAN_COLLECTION).doc(planId).get().catch(() => null);
        const plan = planRes && planRes.data;
        if (!plan) return { success: true, exists: false, tasks: [] };
        return {
          success: true,
          exists: true,
          tasks: plan.tasks || [],
          updateTime: plan.updateTime,
          updatedBy: plan.updatedBy || ''
        };
      }

      // 🛒 首次生成采购清单——用确定性 _id（buildPurchasePlanId）+ 数据库
      // 主键唯一性兜底防重复插入：与 liveFactoryCore 的 buildSettlement
      // 同一套手法。两个人/两台设备同时点"生成"时，第二次 .add() 会因为
      // 主键冲突失败，此时不覆盖已经创建成功的那份（可能已经被勾了几项），
      // 直接把已存在的那份读回去——绝不允许"生成清单"这个动作意外抹掉
      // 别人已经录入的进度
      case 'createPurchasePlan': {
        const { storeId: requestedStoreId, dateString, tasks } = event;
        if (!dateString || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
          return { success: false, error: '请提供合法的日期 (YYYY-MM-DD)' };
        }
        const target = await resolvePurchasePlanTarget(caller, requestedStoreId);
        if (!target.allowed) return { success: false, error: target.error };

        const safeTasks = sanitizePurchasePlanTasks(tasks);
        if (safeTasks.length === 0) {
          return { success: false, error: '没有合法的采买任务可保存' };
        }

        const planId = buildPurchasePlanId(target.storeId, dateString);
        try {
          await db.collection(PURCHASE_PLAN_COLLECTION).add({
            data: {
              _id: planId,
              tenantId: target.tenantId,
              storeId: target.storeId,
              storeName: target.storeName,
              dateString,
              tasks: safeTasks,
              source: 'ai_meal_prediction',
              createdBy: OPENID,
              createdAt: db.serverDate(),
              updatedBy: OPENID,
              updateTime: db.serverDate()
            }
          });
          return { success: true, exists: false, created: true, tasks: safeTasks };
        } catch (err) {
          const existingRes = await db.collection(PURCHASE_PLAN_COLLECTION).doc(planId).get().catch(() => null);
          if (existingRes && existingRes.data) {
            return { success: true, exists: true, created: false, tasks: existingRes.data.tasks || [] };
          }
          console.error('[manageDailyMenu] createPurchasePlan 异常:', err);
          return { success: false, error: '创建采买清单失败，请重试' };
        }
      }

      // 🛒 勾选/取消勾选一项采买任务——读改写非严格 CAS（没有加乐观锁版本号），
      // 如实标注这个边界：几个人同时、在毫秒级窗口内勾选*不同*任务时存在
      // 理论上的覆盖风险。这是给一份最多 4 条的门店采购清单设计的协同能力，
      // 不是高并发交易系统，用完整事务/乐观锁版本号是这个场景下的过度设计；
      // 真出现并发覆盖，后果也只是"某一次勾选状态被下一次读改写覆盖掉"，
      // 补勾一次即可恢复，不构成数据损坏或资金风险
      case 'togglePurchaseTask': {
        const { storeId: requestedStoreId, dateString, itemKey } = event;
        if (!dateString || !itemKey) return { success: false, error: '缺少 dateString 或 itemKey 参数' };
        const target = await resolvePurchasePlanTarget(caller, requestedStoreId);
        if (!target.allowed) return { success: false, error: target.error };

        const planId = buildPurchasePlanId(target.storeId, dateString);
        const planRes = await db.collection(PURCHASE_PLAN_COLLECTION).doc(planId).get().catch(() => null);
        const plan = planRes && planRes.data;
        if (!plan) return { success: false, error: '采买清单不存在，请先生成' };

        const nextTasks = togglePurchaseTaskStatus(plan.tasks || [], itemKey);
        await db.collection(PURCHASE_PLAN_COLLECTION).doc(planId).update({
          data: { tasks: nextTasks, updatedBy: OPENID, updateTime: db.serverDate() }
        });
        return { success: true, tasks: nextTasks };
      }

      // 🛒 义工弹窗微调某一项的预估重量，同上一条同一套读改写口径
      case 'updatePurchaseTaskWeight': {
        const { storeId: requestedStoreId, dateString, itemKey, estimatedWeight } = event;
        if (!dateString || !itemKey) return { success: false, error: '缺少 dateString 或 itemKey 参数' };
        const target = await resolvePurchasePlanTarget(caller, requestedStoreId);
        if (!target.allowed) return { success: false, error: target.error };

        const planId = buildPurchasePlanId(target.storeId, dateString);
        const planRes = await db.collection(PURCHASE_PLAN_COLLECTION).doc(planId).get().catch(() => null);
        const plan = planRes && planRes.data;
        if (!plan) return { success: false, error: '采买清单不存在，请先生成' };

        const nextTasks = updatePurchaseTaskWeight(plan.tasks || [], itemKey, estimatedWeight);
        await db.collection(PURCHASE_PLAN_COLLECTION).doc(planId).update({
          data: { tasks: nextTasks, updatedBy: OPENID, updateTime: db.serverDate() }
        });
        return { success: true, tasks: nextTasks };
      }

      default:
        return { success: false, error: `不支持的 action: ${action}` };
    }
  } catch (err) {
    console.error('[manageDailyMenu] 异常:', err);
    return { success: false, error: err.message || '操作失败' };
  }
};
