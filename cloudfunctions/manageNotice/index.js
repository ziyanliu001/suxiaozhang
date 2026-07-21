// 云函数：manageNotice - 首页跑马灯通知增删改查
//
// 权限模型与 manageActivityLog/manageDailyMenu 一致：
// - 写（create/update/delete）：
//   - store_manager/finance：只能发布/编辑/删除自己门店的通知，storeId 强制取
//     caller.storeId，不允许留空——店级员工不能发"机构总览级"公告。
//   - super_admin：可管理本机构任意门店的通知，也可以把 storeId 留空发布
//     "机构总览级"公告（适用于本机构所有门店，仅在"全国总览"视角下展示）。
// - 读（list）：任意已登录角色只读，严格按"当前视角"互斥查询：
//   - storeId 传 'national_overview'/'ALL_STORES'：只返回该机构 storeId=''
//     的总览级通知，不掺任何具体门店的。
//   - storeId 传具体门店 ID：只返回该店 storeId=该店 的通知，不掺总览级的。
//   两者严格互斥，不做"总览+门店"叠加展示。
//
// 🏢 多租户边界：tenantId 永远取调用者自己的机构，从不信任前端传入值；
// "全国总览"这里不是跨机构的平台级广播，只是"本机构的总览层级"，与
// getStoreList/createStore 的机构隔离模式保持一致。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COLLECTION = 'notices';
const MAX_LIST_LIMIT = 20;
const OVERVIEW_SENTINELS = ['national_overview', 'ALL_STORES'];

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

// 写权限校验：店长/财务限本店（storeId 强制取自身份记录）；超管可管理本机构
// 任意门店，或留空 storeId 发机构总览级公告
async function resolveWriteTarget(caller, requestedStoreId) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  if (caller.role === 'store_manager' || caller.role === 'finance') {
    if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店，无法发布通知' };
    return { allowed: true, storeId: caller.storeId, storeName: caller.storeName || '', tenantId: caller.tenantId || '' };
  }

  if (caller.role === 'super_admin') {
    if (!requestedStoreId || OVERVIEW_SENTINELS.includes(requestedStoreId)) {
      // 留空 = 机构总览级公告
      return { allowed: true, storeId: '', storeName: '', tenantId: caller.tenantId || '' };
    }
    const storeRes = await db.collection('stores').doc(requestedStoreId).get().catch(() => null);
    const store = storeRes && storeRes.data;
    if (!store) return { allowed: false, error: '目标门店不存在' };
    if (caller.tenantId && store.tenantId && caller.tenantId !== store.tenantId) {
      return { allowed: false, error: '无权限：目标门店不属于您所在的机构' };
    }
    return { allowed: true, storeId: requestedStoreId, storeName: store.storeName || '', tenantId: caller.tenantId || store.tenantId || '' };
  }

  return { allowed: false, error: '无权限：仅店长、财务或超级管理员可管理通知' };
}

function resolvePublisherLabel(role) {
  if (role === 'super_admin') return '超级管理员';
  if (role === 'finance') return '财务';
  if (role === 'store_manager') return '店长';
  return '管理员';
}

function todayStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
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
        const { id, storeId, tag, title, content, isActive, effectiveDate, expireDate } = event;

        if (!title || !String(title).trim()) {
          return { success: false, error: '请填写通知标题' };
        }
        if (!content || !String(content).trim()) {
          return { success: false, error: '请填写通知内容' };
        }

        const target = await resolveWriteTarget(caller, storeId);
        if (!target.allowed) {
          return { success: false, error: target.error };
        }

        const data = {
          tag: tag || '',
          title: String(title).trim(),
          content: String(content).trim(),
          is_active: isActive !== false,
          effectiveDate: effectiveDate || '',
          expireDate: expireDate || '',
          updateTime: db.serverDate(),
          publisherLabel: resolvePublisherLabel(caller.role)
        };

        if (action === 'update' && id) {
          const existingRes = await db.collection(COLLECTION).doc(id).get().catch(() => null);
          const existing = existingRes && existingRes.data;
          if (!existing) return { success: false, error: '记录不存在' };
          if (existing.tenantId && target.tenantId && existing.tenantId !== target.tenantId) {
            return { success: false, error: '无权限：该记录不属于您所在的机构' };
          }
          if ((caller.role === 'store_manager' || caller.role === 'finance') && existing.storeId !== target.storeId) {
            return { success: false, error: '无权限：不能编辑其他门店的通知' };
          }

          await db.collection(COLLECTION).doc(id).update({ data });
          return { success: true, id, message: '通知已更新' };
        }

        const createRes = await db.collection(COLLECTION).add({
          data: {
            tenantId: target.tenantId,
            storeId: target.storeId,
            storeName: target.storeName,
            createdBy: OPENID,
            createdAt: db.serverDate(),
            ...data
          }
        });

        return { success: true, id: createRes._id, message: '通知已发布' };
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
        if ((caller.role === 'store_manager' || caller.role === 'finance') && existing.storeId !== target.storeId) {
          return { success: false, error: '无权限：不能删除其他门店的通知' };
        }
        if (existing.tenantId && target.tenantId && existing.tenantId !== target.tenantId) {
          return { success: false, error: '无权限：该记录不属于您所在的机构' };
        }

        await db.collection(COLLECTION).doc(id).remove();
        return { success: true, message: '通知已删除' };
      }

      case 'list': {
        const { storeId } = event;
        if (!caller || !caller.tenantId) {
          // 🛡️ 既无法确定身份也无法确定机构：拒绝返回未隔离的全量数据，宁可空列表
          return { success: true, data: [] };
        }

        // 🐛 首页跑马灯不可见根因：超管默认视角（尚未手动切换门店）下 currentStoreId
        // 是空字符串，不是 'national_overview'/'ALL_STORES' 这两个哨兵值——之前空字符串
        // 落到 else 分支直接返回空列表，导致超管一进首页跑马灯就是空的。空字符串本身就
        // 代表"无门店筛选条件"，语义上等同于总览，这里统一按总览级处理。
        const where = { tenantId: caller.tenantId, is_active: true };
        if (!storeId || OVERVIEW_SENTINELS.includes(storeId)) {
          where.storeId = '';
        } else {
          where.storeId = storeId;
        }

        const today = todayStr();
        // 有效期过滤：effectiveDate 为空或 <= 今天；expireDate 为空或 >= 今天
        where.effectiveDate = _.or([_.eq(''), _.lte(today)]);
        where.expireDate = _.or([_.eq(''), _.gte(today)]);

        const listRes = await db.collection(COLLECTION)
          .where(where)
          .orderBy('createdAt', 'desc')
          .limit(MAX_LIST_LIMIT)
          .get();

        return { success: true, data: listRes.data || [] };
      }

      default:
        return { success: false, error: `不支持的 action: ${action}` };
    }
  } catch (err) {
    console.error('[manageNotice] 异常:', err);
    return { success: false, error: err.message || '操作失败' };
  }
};
