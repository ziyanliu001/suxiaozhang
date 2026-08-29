// 云函数：manageStoreMilestone - 门店大事记/发展历程（按年份分组的精选里程碑）增删改查
//
// 权限模型与 manageActivityLog/manageDailyMenu 一致：
// - 写（create/update/delete）：仅 store_manager（限本店）或 super_admin（限本机构）。
// - 读（list）：任意已登录角色只读本店；super_admin 可传 storeId 查看本机构内任意门店。
//
// 🔗 与 activity_logs（门店日志/义工工作大事记）的区别：那是逐日运营流水（同一天可多条，
// 且日报提交会自动同步一条），这里是"成立仪式/重大捐赠/大型活动"这类精选里程碑，数量少、
// 按年份分组展示（pages/store-profile 的大事记时间轴），两者语义不同，故意用独立集合，
// 不复用 activity_logs 以免被日常运营噪音淹没。不接入家长风控锁——历史留痕类内容不属于
// "高风险操作"范畴，与 manageActivityLog 现有的直接写入口径一致。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTION = 'store_milestones';
const MAX_IMAGES = 9;

// 🛡️ 服务端内容安全兜底：大事记对外公开展示（门店发展历程时间轴），此前只在
// 前端提交前查一次 msgSecCheck，绕过前端直接调云函数即可跳过审核。降级口径
// 同 manageNotice。
async function checkContentSafe(text) {
  if (!text) return true;
  try {
    const res = await cloud.callFunction({
      name: 'msgSecCheck',
      data: { text, contentType: 'report' }
    });
    return !res.result || res.result.safe !== false;
  } catch (err) {
    console.warn('[manageStoreMilestone] 服务端内容安全检测调用失败，降级放行:', err);
    return true;
  }
}

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

// 只读权限：任意已登录角色只读本店；super_admin 可传 storeId 查看机构内任意门店
async function resolveReadTarget(caller, requestedStoreId) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  if (caller.role === 'super_admin' && requestedStoreId) {
    const storeRes = await db.collection('stores').doc(requestedStoreId).get().catch(() => null);
    const store = storeRes && storeRes.data;
    if (!store) return { allowed: false, error: '目标门店不存在' };
    if (caller.tenantId && store.tenantId && caller.tenantId !== store.tenantId) {
      return { allowed: false, error: '无权限：目标门店不属于您所在的机构' };
    }
    return { allowed: true, storeId: requestedStoreId };
  }

  if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店' };
  return { allowed: true, storeId: caller.storeId };
}

function sanitizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images.slice(0, MAX_IMAGES).map((img) => ({
    url: (img && img.url) || '',
    thumbUrl: (img && (img.thumbUrl || img.url)) || ''
  })).filter((img) => img.url);
}

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
        const { id, storeId, title, eventDate, content, images } = event;

        if (!title || !String(title).trim()) {
          return { success: false, error: '请填写标题' };
        }
        if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
          return { success: false, error: '请提供合法的发生日期 (YYYY-MM-DD)' };
        }
        if (!(await checkContentSafe(String(title).trim())) || !(await checkContentSafe(content))) {
          return { success: false, error: '内容包含违规信息，请修改后重新提交' };
        }
        const safeImages = sanitizeImages(images);
        const year = parseInt(eventDate.slice(0, 4), 10);

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
          if ((caller.role === 'store_manager' || caller.role === 'store_patriarch') && existing.storeId !== target.storeId) {
            return { success: false, error: '无权限：不能编辑其他门店的大事记' };
          }

          await db.collection(COLLECTION).doc(id).update({
            data: {
              title: String(title).trim(),
              eventDate,
              year,
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
            eventDate,
            year,
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

      case 'list': {
        const { storeId } = event;
        const target = await resolveReadTarget(caller, storeId);
        if (!target.allowed) return { success: false, error: target.error };

        const listRes = await db.collection(COLLECTION)
          .where({ storeId: target.storeId })
          .orderBy('eventDate', 'desc')
          .limit(200)
          .get();

        return { success: true, data: listRes.data || [] };
      }

      default:
        return { success: false, error: `不支持的 action: ${action}` };
    }
  } catch (err) {
    console.error('[manageStoreMilestone] 异常:', err);
    return { success: false, error: err.message || '操作失败' };
  }
};
