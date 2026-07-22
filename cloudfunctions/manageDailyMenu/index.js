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

const COLLECTION = 'daily_menus';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
// 🖼️ 今日食谱单条最多 9 张配图（微信标准九宫格），与前端上传数量限制对齐。
// 注：曾一度收紧为 1 张以控制上百家门店规模下的云存储成本，现按产品需求恢复为 9，
// 相应的存储成本增长是已知且接受的权衡，如需再次收紧请同步调整前端 onChooseImage 的上限。
const MAX_IMAGES = 9;

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

// 写权限校验：店长仅可管理本店；超管可管理本机构内任意门店
async function resolveWriteTarget(caller, requestedStoreId) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  if (caller.role === 'store_manager') {
    if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店，无法发布菜单' };
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

  return { allowed: false, error: '无权限：仅店长或超级管理员可发布/编辑/删除菜单' };
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
        const { id, storeId, dateString, menuText, images } = event;

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

        if (action === 'update' && id) {
          const existingRes = await db.collection(COLLECTION).doc(id).get().catch(() => null);
          const existing = existingRes && existingRes.data;
          if (!existing) return { success: false, error: '记录不存在' };
          if (existing.tenantId && target.tenantId && existing.tenantId !== target.tenantId) {
            return { success: false, error: '无权限：该记录不属于您所在的机构' };
          }
          if (caller.role === 'store_manager' && existing.storeId !== target.storeId) {
            return { success: false, error: '无权限：不能编辑其他门店的菜单' };
          }

          await db.collection(COLLECTION).doc(id).update({
            data: {
              dateString,
              menuText: menuText || '',
              images: safeImages,
              updateTime: db.serverDate(),
              publisherLabel: resolvePublisherLabel(caller.role)
            }
          });
          return { success: true, id, message: '菜单已更新' };
        }

        // 新建：同店同日期已存在则视为覆盖更新，避免同一天重复出现多份菜单
        const dupRes = await db.collection(COLLECTION)
          .where({ storeId: target.storeId, dateString })
          .limit(1)
          .get();

        if (dupRes.data && dupRes.data.length > 0) {
          const dupId = dupRes.data[0]._id;
          await db.collection(COLLECTION).doc(dupId).update({
            data: {
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
        if (caller.role === 'store_manager' && existing.storeId !== target.storeId) {
          return { success: false, error: '无权限：不能删除其他门店的菜单' };
        }
        if (existing.tenantId && target.tenantId && existing.tenantId !== target.tenantId) {
          return { success: false, error: '无权限：该记录不属于您所在的机构' };
        }

        await db.collection(COLLECTION).doc(id).remove();
        return { success: true, message: '菜单已删除' };
      }

      case 'getByDate': {
        const { storeId, dateString } = event;
        if (!storeId || !dateString) {
          return { success: false, error: '缺少 storeId 或 dateString 参数' };
        }

        const where = { storeId, dateString };
        if (caller && caller.tenantId) {
          where.tenantId = caller.tenantId;
        }

        const res = await db.collection(COLLECTION).where(where).limit(1).get();
        return { success: true, data: (res.data && res.data[0]) || null };
      }

      case 'list': {
        const { storeId, page, pageSize, startDate, endDate } = event;
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

      default:
        return { success: false, error: `不支持的 action: ${action}` };
    }
  } catch (err) {
    console.error('[manageDailyMenu] 异常:', err);
    return { success: false, error: err.message || '操作失败' };
  }
};
