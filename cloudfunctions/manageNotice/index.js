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
//
// 🌟 公告模板（getTemplates/createTemplate）：与上面的 notices 是完全独立的
// notice_templates 集合，模板只是编辑弹窗"一键套用"的可复用文案，从不进入跑马灯。
// - getTemplates：isSystem:true（全域公共）∪ storeId=当前门店（本店私有），两者严格
//   按 tenantId 收敛，绝不返回其他门店的私有模板。
// - createTemplate：店长/财务权限口径与发布公告一致（storeId 强制取自己门店），
//   isSystem 仅 super_admin 可置为 true，其余角色一律强制 false。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COLLECTION = 'notices';
// 🌟 公告模板库：与 notices（已发布/正在展示的公告）是两个完全独立的集合——模板只是
// 编辑弹窗里"一键套用"用的可复用文案，本身从不出现在跑马灯里。isSystem:true 表示
// 全域公共模板（本机构内所有门店都能看到并套用，仅超级管理员可创建）；isSystem:false
// 则是某个具体门店的私有模板（storeId 恒等于该店店长/财务自己的 storeId）。
const TEMPLATE_COLLECTION = 'notice_templates';
const MAX_LIST_LIMIT = 20;
const OVERVIEW_SENTINELS = ['national_overview', 'ALL_STORES'];

// 🛡️ -502005 DATABASE_COLLECTION_NOT_EXIST：notices 集合可能在这套环境里还没
// 被写入过（新机构/新部署），与 submitFeedback/manageStoreInviteCode 同一套
// 自愈口径——list/listPaged 都是只读查询，命中时直接降级为空列表/count:0，
// 不需要 createCollection（读路径没有数据可写），也严禁把裸的 -502005 抛给
// 首页跑马灯，导致渲染被未处理的错误打断
function isCollectionNotExistError(err) {
  return !!err && (err.errCode === -502005 || /database collection not exists/i.test(String(err.errMsg || err.message || '')));
}

// 🛡️ 服务端内容安全兜底：公告/模板此前只在小程序前端提交前调用 msgSecCheck，
// 绕过前端直接调用本云函数即可完全跳过审核，把违规文案发布到跑马灯（面向全机构
// 所有用户展示，风险高于普通留言）。落库前在服务端强制再查一遍，API 抖动时按
// msgSecCheck 自身的降级口径放行，不因审核服务临时不可用而拦下正常公告。
async function checkContentSafe(text) {
  if (!text) return true;
  try {
    const res = await cloud.callFunction({
      name: 'msgSecCheck',
      data: { text, contentType: 'notice' }
    });
    return !res.result || res.result.safe !== false;
  } catch (err) {
    console.warn('[manageNotice] 服务端内容安全检测调用失败，降级放行:', err);
    return true;
  }
}

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

// 写权限校验：店长/财务限本店（storeId 强制取自身份记录）；超管可管理本机构
// 任意门店，或留空 storeId 发机构总览级公告
async function resolveWriteTarget(caller, requestedStoreId) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  // 🏛️ 权限向下继承：大家长天然拥有店长 + 财务的全套日常管理权限
  if (caller.role === 'store_manager' || caller.role === 'finance' || caller.role === 'store_patriarch') {
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
    // 🛡️ 多租户越权修复：两侧 tenantId 都必须存在且相等才放行，任一缺失时不再
    // 无条件放行。
    if (!caller.tenantId || !store.tenantId || caller.tenantId !== store.tenantId) {
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
  if (role === 'store_patriarch') return '大家长';
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
        if (!(await checkContentSafe(String(title).trim())) || !(await checkContentSafe(String(content).trim()))) {
          return { success: false, error: '内容包含违规信息，请修改后重新提交' };
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
          if (!existing.tenantId || !target.tenantId || existing.tenantId !== target.tenantId) {
            return { success: false, error: '无权限：该记录不属于您所在的机构' };
          }
          if ((caller.role === 'store_manager' || caller.role === 'finance' || caller.role === 'store_patriarch') && existing.storeId !== target.storeId) {
            return { success: false, error: '无权限：不能编辑其他门店的通知' };
          }

          await db.collection(COLLECTION).doc(id).update({ data });
          return { success: true, id, message: '通知已更新' };
        }

        const newDoc = {
          tenantId: target.tenantId,
          storeId: target.storeId,
          storeName: target.storeName,
          createdBy: OPENID,
          createdAt: db.serverDate(),
          ...data
        };
        let createRes;
        try {
          createRes = await db.collection(COLLECTION).add({ data: newDoc });
        } catch (err) {
          if (isCollectionNotExistError(err)) {
            // notices 集合尚不存在，自动创建后重试一次
            await db.createCollection(COLLECTION).catch(() => {});
            createRes = await db.collection(COLLECTION).add({ data: newDoc });
          } else {
            throw err;
          }
        }

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
        if ((caller.role === 'store_manager' || caller.role === 'finance' || caller.role === 'store_patriarch') && existing.storeId !== target.storeId) {
          return { success: false, error: '无权限：不能删除其他门店的通知' };
        }
        if (!existing.tenantId || !target.tenantId || existing.tenantId !== target.tenantId) {
          return { success: false, error: '无权限：该记录不属于您所在的机构' };
        }

        await db.collection(COLLECTION).doc(id).remove();
        return { success: true, message: '通知已删除' };
      }

      // 🌟 通知页"消息记录"分区分页拉取：与 list 共用完全相同的 tenantId/storeId
      // 严格互斥隔离条件，额外附加真分页（page/pageSize + hasMore）与按调用者自己的
      // lastNoticeReadAt 已读游标计算的 unread 标记 / 全局未读总数
      case 'listPaged': {
        const { storeId, page, pageSize } = event;
        if (!caller || !caller.tenantId) {
          return { success: true, data: [], hasMore: false, unreadCount: 0 };
        }

        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const size = Math.min(50, Math.max(1, parseInt(pageSize, 10) || 15));

        const where = { tenantId: caller.tenantId, is_active: true };
        if (!storeId || OVERVIEW_SENTINELS.includes(storeId)) {
          where.storeId = '';
        } else {
          where.storeId = storeId;
        }

        const today = todayStr();
        where.effectiveDate = _.or([_.eq(''), _.lte(today)]);
        where.expireDate = _.or([_.eq(''), _.gte(today)]);

        const readAt = caller.lastNoticeReadAt || null;
        // 未读总数：createdAt 晚于调用者自己的已读游标才算未读；从未标记过已读（游标缺失）
        // 时全部视为未读——与下面单条 data.unread 的判定口径保持一致
        const unreadWhere = readAt ? { ...where, createdAt: _.gt(readAt) } : where;

        let countRes, listRes, unreadRes;
        try {
          [countRes, listRes, unreadRes] = await Promise.all([
            db.collection(COLLECTION).where(where).count(),
            db.collection(COLLECTION).where(where).orderBy('createdAt', 'desc').skip((pageNum - 1) * size).limit(size).get(),
            db.collection(COLLECTION).where(unreadWhere).count()
          ]);
        } catch (err) {
          if (!isCollectionNotExistError(err)) throw err;
          return { success: true, data: [], hasMore: false, unreadCount: 0 };
        }

        const total = countRes.total || 0;
        const hasMore = pageNum * size < total;
        const readAtMs = readAt ? new Date(readAt).getTime() : 0;

        const data = (listRes.data || []).map((n) => ({
          ...n,
          unread: readAtMs ? (new Date(n.createdAt).getTime() > readAtMs) : true
        }));

        return { success: true, data, hasMore, unreadCount: unreadRes.total || 0 };
      }

      // 🌟 一键已读：只推进调用者自己的已读游标（lastNoticeReadAt），不修改任何公告本身，
      // 不影响其他用户各自的已读状态。挂在 user_roles 上而不是新建集合，避免"消息 x 用户"
      // 的行级已读表在门店规模变大后引入不必要的写放大
      case 'markAllRead': {
        if (!caller || !caller._id) {
          return { success: false, error: '无权限：未找到您的角色信息' };
        }
        const now = new Date();
        await db.collection('user_roles').doc(caller._id).update({
          data: { lastNoticeReadAt: now }
        });
        return { success: true, lastNoticeReadAt: now.getTime() };
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

        let listRes;
        try {
          listRes = await db.collection(COLLECTION)
            .where(where)
            .orderBy('createdAt', 'desc')
            .limit(MAX_LIST_LIMIT)
            .get();
        } catch (err) {
          if (!isCollectionNotExistError(err)) throw err;
          return { success: true, data: [] };
        }

        return { success: true, data: listRes.data || [] };
      }

      // 🌟 公告模板：拉取"当前视角可用"的模板列表 —— 全域公共模板（isSystem:true）
      // 加上当前门店自己的私有模板（storeId 等于当前门店），严禁掺入任何其他门店的
      // 私有模板。两个条件用 _.or 合并后，再用 _.and 叠加 tenantId 边界。
      case 'getTemplates': {
        const { storeId } = event;
        if (!caller || !caller.tenantId) {
          return { success: true, data: [] };
        }

        // 总览视角/未选定具体门店：只能看到公共模板，effectiveStoreId 留空——
        // 私有模板的 storeId 永远是具体门店 id，不会与空字符串匹配，不会误漏
        const effectiveStoreId = (!storeId || OVERVIEW_SENTINELS.includes(storeId)) ? '' : storeId;

        const where = _.and([
          { tenantId: caller.tenantId },
          _.or([
            { isSystem: true },
            { storeId: effectiveStoreId }
          ])
        ]);

        const listRes = await db.collection(TEMPLATE_COLLECTION)
          .where(where)
          .orderBy('createdAt', 'desc')
          .limit(MAX_LIST_LIMIT)
          .get();

        return { success: true, data: listRes.data || [] };
      }

      // 🌟 保存为模板：权限口径复用 resolveWriteTarget（与发布公告同一套店级/超管边界），
      // 唯独 isSystem 单独加一道闸——只有 super_admin 能把模板设为全域公共，
      // 其余角色即使传了 isSystem:true 也会被强制改回 false，绝不信任前端这个标志位。
      case 'createTemplate': {
        const { storeId, tag, title, content, isSystem } = event;

        if (!title || !String(title).trim()) {
          return { success: false, error: '请填写模板标题' };
        }
        if (!content || !String(content).trim()) {
          return { success: false, error: '请填写模板内容' };
        }
        if (!(await checkContentSafe(String(title).trim())) || !(await checkContentSafe(String(content).trim()))) {
          return { success: false, error: '内容包含违规信息，请修改后重新提交' };
        }

        const wantsSystem = !!isSystem;
        if (wantsSystem && (!caller || caller.role !== 'super_admin')) {
          return { success: false, error: '无权限：仅超级管理员可创建全域公共模板' };
        }

        const target = await resolveWriteTarget(caller, wantsSystem ? '' : storeId);
        if (!target.allowed) {
          return { success: false, error: target.error };
        }

        const finalIsSystem = wantsSystem && caller.role === 'super_admin';
        // 公共模板不挂具体门店；私有模板挂 target.storeId
        // （店长/财务恒为自己门店，超管为其当前选择的门店）
        const finalStoreId = finalIsSystem ? '' : target.storeId;
        const finalStoreName = finalIsSystem ? '' : target.storeName;

        const createRes = await db.collection(TEMPLATE_COLLECTION).add({
          data: {
            tenantId: target.tenantId,
            storeId: finalStoreId,
            storeName: finalStoreName,
            isSystem: finalIsSystem,
            tag: tag || '',
            title: String(title).trim(),
            content: String(content).trim(),
            createdBy: OPENID,
            createdAt: db.serverDate(),
            updateTime: db.serverDate(),
            publisherLabel: resolvePublisherLabel(caller.role)
          }
        });

        return {
          success: true,
          id: createRes._id,
          message: finalIsSystem ? '已保存为全域公共模板' : '已保存为本店模板'
        };
      }

      default:
        return { success: false, error: `不支持的 action: ${action}` };
    }
  } catch (err) {
    console.error('[manageNotice] 异常:', err);
    return { success: false, error: err.message || '操作失败' };
  }
};
