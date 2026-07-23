// 云函数：manageActivityLog - 义工工作与活动大事记增删改查
//
// 权限模型与 manageDailyMenu 一致：
// - 写（create/update/delete）：仅 store_manager（限本店）或 super_admin（限本机构）。
// - 读（get/list）：任意已登录角色只读；storeId==='ALL' 汇总列表仅 super_admin 可用。
//
// 与每日菜单的区别：同一天可发生多条大事记，因此 create 默认为纯新增（不做按日期 upsert），
// 按 eventTime 倒序做时间轴展示；分页同样支持 page/pageSize。
//
// 🔗 唯一例外：今日记账表单（index.ts publishRecipeAndActivityIfPresent）随餐报一并提交的
// "门店今日日志/大事记"，传 autoSyncFromReport:true 触发按 {storeId, eventTime, autoSynced:true}
// 查找-命中则更新/未命中则新建的 upsert 语义——同一天多次编辑/重新提交餐报时更新同一条自动
// 同步记录，而不是每次都新插入一条重复的大事记。这个 upsert 键专属于自动同步场景，完全不影响
// 义工/店长在「门店日志」独立发布页手动创建的记录（那些记录没有 autoSynced 标记，永远各自独立）。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COLLECTION = 'activity_logs';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
// 🖼️ 门店日志单条最多 18 张配图（微信标准双九宫格），与前端上传数量限制对齐。
// 如需调整请同步修改前端 onChooseImage 的上限（activity-log.ts 与 index.ts 两处）。
const MAX_IMAGES = 18;

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

async function resolveWriteTarget(caller, requestedStoreId) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  // 🏛️ 权限向下继承：大家长天然拥有店长的全套日常管理权限
  if (caller.role === 'store_manager' || caller.role === 'store_patriarch') {
    if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店，无法发布大事记' };
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

  return { allowed: false, error: '无权限：仅店长或超级管理员可发布/编辑/删除大事记' };
}

function normalizePage(page, pageSize) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(pageSize, 10) || DEFAULT_PAGE_SIZE));
  return { page: p, size };
}

function sanitizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images.slice(0, MAX_IMAGES).map(img => ({
    url: (img && img.url) || '',
    thumbUrl: (img && (img.thumbUrl || img.url)) || ''
  })).filter(img => img.url);
}

// 发布人展示标签：仅用角色身份（店长/超级管理员），不落库/不回传真实姓名等 PII
function resolvePublisherLabel(role) {
  if (role === 'super_admin') return '超级管理员';
  if (role === 'store_manager') return '店长';
  if (role === 'store_patriarch') return '大家长';
  return '管理员';
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
      case 'create':
      case 'update': {
        const { id, storeId, title, eventTime, content, images, autoSyncFromReport } = event;

        if (!title || !String(title).trim()) {
          return { success: false, error: '请填写标题' };
        }
        if (!eventTime || !/^\d{4}-\d{2}-\d{2}$/.test(eventTime)) {
          return { success: false, error: '请提供合法的发生时间 (YYYY-MM-DD)' };
        }
        const safeImages = sanitizeImages(images);

        const target = await resolveWriteTarget(caller, storeId);
        if (!target.allowed) {
          return { success: false, error: target.error };
        }

        // 🔗 餐报自动同步：按 {storeId, eventTime, autoSynced:true} 找到当天已存在的自动同步记录
        // 就地更新，找不到才新建——保证同一天多次编辑/重新提交餐报不会堆出多条重复大事记
        if (action === 'create' && autoSyncFromReport) {
          const existingAutoRes = await db.collection(COLLECTION).where({
            storeId: target.storeId,
            eventTime,
            autoSynced: true
          }).limit(1).get();
          const existingAuto = existingAutoRes.data && existingAutoRes.data[0];

          if (existingAuto) {
            await db.collection(COLLECTION).doc(existingAuto._id).update({
              data: {
                title: String(title).trim(),
                content: content || '',
                images: safeImages,
                updateTime: db.serverDate(),
                publisherLabel: resolvePublisherLabel(caller.role)
              }
            });
            return { success: true, id: existingAuto._id, message: '门店日志已更新' };
          }

          const createAutoRes = await db.collection(COLLECTION).add({
            data: {
              tenantId: target.tenantId,
              storeId: target.storeId,
              storeName: target.storeName,
              title: String(title).trim(),
              eventTime,
              content: content || '',
              images: safeImages,
              autoSynced: true,
              createdBy: OPENID,
              createdAt: db.serverDate(),
              updateTime: db.serverDate(),
              publisherLabel: resolvePublisherLabel(caller.role)
            }
          });
          return { success: true, id: createAutoRes._id, message: '门店日志已发布' };
        }

        if (action === 'update' && id) {
          const existingRes = await db.collection(COLLECTION).doc(id).get().catch(() => null);
          const existing = existingRes && existingRes.data;
          if (!existing) return { success: false, error: '记录不存在' };
          if (existing.tenantId && target.tenantId && existing.tenantId !== target.tenantId) {
            return { success: false, error: '无权限：该记录不属于您所在的机构' };
          }
          if ((caller.role === 'store_manager' || caller.role === 'store_patriarch') && existing.storeId !== target.storeId) {
            return { success: false, error: '无权限：不能编辑其他门店的大事记' };
          }

          await db.collection(COLLECTION).doc(id).update({
            data: {
              title: String(title).trim(),
              eventTime,
              content: content || '',
              images: safeImages,
              updateTime: db.serverDate(),
              publisherLabel: resolvePublisherLabel(caller.role)
            }
          });
          return { success: true, id, message: '大事记已更新' };
        }

        const createRes = await db.collection(COLLECTION).add({
          data: {
            tenantId: target.tenantId,
            storeId: target.storeId,
            storeName: target.storeName,
            title: String(title).trim(),
            eventTime,
            content: content || '',
            images: safeImages,
            createdBy: OPENID,
            createdAt: db.serverDate(),
            updateTime: db.serverDate(),
            publisherLabel: resolvePublisherLabel(caller.role)
          }
        });

        return { success: true, id: createRes._id, message: '大事记已发布' };
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
          return { success: false, error: '无权限：不能删除其他门店的大事记' };
        }
        if (existing.tenantId && target.tenantId && existing.tenantId !== target.tenantId) {
          return { success: false, error: '无权限：该记录不属于您所在的机构' };
        }

        await db.collection(COLLECTION).doc(id).remove();
        return { success: true, message: '大事记已删除' };
      }

      case 'get': {
        const { id } = event;
        if (!id) return { success: false, error: '缺少 id 参数' };

        const res = await db.collection(COLLECTION).doc(id).get().catch(() => null);
        const data = res && res.data;
        if (!data) return { success: true, data: null };

        if (caller && caller.tenantId && data.tenantId && caller.tenantId !== data.tenantId) {
          return { success: false, error: '无权限：该记录不属于您所在的机构' };
        }

        return { success: true, data };
      }

      case 'list': {
        const { storeId, page, pageSize, startDate, endDate } = event;
        const { page: p, size } = normalizePage(page, pageSize);
        const isSuperAdmin = caller && caller.role === 'super_admin';

        const where = {};

        if (storeId === 'ALL') {
          if (!isSuperAdmin) {
            if (caller && caller.storeId) {
              where.storeId = caller.storeId;
            } else {
              return { success: true, data: [], page: p, pageSize: size, total: 0, hasMore: false };
            }
          }
        } else if (storeId) {
          where.storeId = storeId;
        } else if (caller && caller.storeId) {
          where.storeId = caller.storeId;
        }

        if (caller && caller.tenantId) {
          where.tenantId = caller.tenantId;
        } else if (!where.storeId) {
          return { success: true, data: [], page: p, pageSize: size, total: 0, hasMore: false };
        }

        if (startDate && endDate) {
          where.eventTime = _.gte(startDate).and(_.lte(endDate));
        } else if (startDate) {
          where.eventTime = _.gte(startDate);
        } else if (endDate) {
          where.eventTime = _.lte(endDate);
        }

        const countRes = await db.collection(COLLECTION).where(where).count();
        const listRes = await db.collection(COLLECTION)
          .where(where)
          .orderBy('eventTime', 'desc')
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

      default:
        return { success: false, error: `不支持的 action: ${action}` };
    }
  } catch (err) {
    console.error('[manageActivityLog] 异常:', err);
    return { success: false, error: err.message || '操作失败' };
  }
};
