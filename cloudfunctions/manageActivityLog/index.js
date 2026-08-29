// 云函数：manageActivityLog - 义工工作与活动大事记增删改查
//
// 权限模型与 manageDailyMenu 一致：
// - 写（update/delete）：仅 store_manager（限本店）或 super_admin（限本机构）。
// - 写（create）：store_manager/super_admin 直接发布（立即公开）；volunteer 也可以
//   create，但只能新增、不能 update/delete 任何记录（含自己提交的），且新记录带
//   approvalStatus: 'PENDING'，需经店长/超管在 approvePending 确认后才会出现在
//   面向所有人的 list 里——义工不是"没有发布权限"，而是"发布的东西要先过一道确认"。
// - 读（get/list）：任意已登录角色只读，但 list 默认过滤掉 approvalStatus==='PENDING'
//   的记录（不让未确认的义工投稿提前出现在门店日志公开列表/家人监督视图里）；
//   listPending/approvePending/rejectPending 三个动作专供 store_manager/store_patriarch/
//   super_admin 审核待确认的义工投稿。storeId==='ALL' 汇总列表仅 super_admin 可用。
//
// 与每日菜单的区别：同一天可发生多条大事记，因此 create 默认为纯新增（不做按日期 upsert），
// 按 eventTime 倒序做时间轴展示；分页同样支持 page/pageSize。
//
// 🔗 唯一例外：今日记账表单（index.ts publishRecipeAndActivityIfPresent）随餐报一并提交的
// "门店今日日志/大事记"，传 autoSyncFromReport:true 触发按 {storeId, eventTime, autoSynced:true}
// 查找-命中则更新/未命中则新建的 upsert 语义——同一天多次编辑/重新提交餐报时更新同一条自动
// 同步记录，而不是每次都新插入一条重复的大事记。这个 upsert 键专属于自动同步场景（只有店长/
// 超管能提交餐报，不涉及 volunteer 分支），完全不影响义工/店长在「门店日志」独立发布页
// 手动创建的记录（那些记录没有 autoSynced 标记，永远各自独立）。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COLLECTION = 'activity_logs';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

// 🛡️ 服务端内容安全兜底：门店日志/护持动态对外公开展示，此前只在前端提交前
// 查一次 msgSecCheck，绕过前端直接调云函数即可跳过审核。降级口径同 manageNotice。
async function checkContentSafe(text) {
  if (!text) return true;
  try {
    const res = await cloud.callFunction({
      name: 'msgSecCheck',
      data: { text, contentType: 'report' }
    });
    return !res.result || res.result.safe !== false;
  } catch (err) {
    console.warn('[manageActivityLog] 服务端内容安全检测调用失败，降级放行:', err);
    return true;
  }
}
// 🖼️ 门店日志单条最多 18 张配图（微信标准双九宫格），与前端上传数量限制对齐。
// 如需调整请同步修改前端 onChooseImage 的上限（activity-log.ts 与 index.ts 两处）。
const MAX_IMAGES = 18;

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

async function resolveWriteTarget(caller, requestedStoreId, opts) {
  opts = opts || {};
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

  // 🌟 义工现场护持动态：仅在 opts.allowVolunteerCreate 显式打开时才放行（只用于
  // 纯新增场景），且强制取自己绑定的门店——不能像 super_admin 那样指定任意门店，
  // 也不能走这条分支去 update/delete 任何记录（那两个 action 调用本函数时不会
  // 传 allowVolunteerCreate，volunteer 会落到下面的兜底拒绝）
  if (caller.role === 'volunteer' && opts.allowVolunteerCreate) {
    if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店，无法提交护持动态' };
    return {
      allowed: true,
      storeId: caller.storeId,
      storeName: caller.storeName || '',
      tenantId: caller.tenantId || '',
      isVolunteerSubmission: true
    };
  }

  return { allowed: false, error: '无权限：仅店长或超级管理员可发布/编辑/删除大事记' };
}

// 待确认队列（listPending/approvePending/rejectPending）共用的门店范围收敛：
// 与 submitFeedback 云函数 resolveManageStoreId 同一套口径——店长/家长强制取
// 自己绑定的门店，超管使用前端传入的具体门店 ID
async function resolveReviewStoreId(caller, requestedStoreId) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  if (caller.role === 'store_manager' || caller.role === 'store_patriarch') {
    if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店' };
    return { allowed: true, storeId: caller.storeId };
  }

  if (caller.role === 'super_admin') {
    if (!requestedStoreId) return { allowed: false, error: '请指定目标门店' };
    return { allowed: true, storeId: requestedStoreId };
  }

  return { allowed: false, error: '无权限：仅店长、家长或超级管理员可审核待确认动态' };
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

// 🏷️ 分类 Tag：[日常运营][设备维护][爱心捐款/物资][重要访客][异常提醒]，与前端
// activity-log.ts 的 CATEGORY_OPTIONS 同一份白名单。非法值/未选一律落空字符串
// （前端展示层显示"未分类"灰色标签，不是报错）
const CATEGORY_VALUES = ['daily', 'maintenance', 'donation', 'visitor', 'incident'];

function sanitizeCategory(category) {
  return CATEGORY_VALUES.includes(category) ? category : '';
}

// 发布人展示标签：仅用角色身份，不落库/不回传真实姓名等 PII
function resolvePublisherLabel(role) {
  if (role === 'super_admin') return '超级管理员';
  if (role === 'store_manager') return '店长';
  if (role === 'store_patriarch') return '大家长';
  if (role === 'volunteer') return '义工';
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
        const { id, storeId, title, eventTime, content, images, category, autoSyncFromReport } = event;

        if (!title || !String(title).trim()) {
          return { success: false, error: '请填写标题' };
        }
        if (!eventTime || !/^\d{4}-\d{2}-\d{2}$/.test(eventTime)) {
          return { success: false, error: '请提供合法的发生时间 (YYYY-MM-DD)' };
        }
        if (!(await checkContentSafe(String(title).trim())) || !(await checkContentSafe(content))) {
          return { success: false, error: '内容包含违规信息，请修改后重新提交' };
        }
        const safeImages = sanitizeImages(images);
        // 🏷️ 分类仅对手动发布的门店日志/护持动态生效，餐报自动同步（autoSyncFromReport）
        // 那条记录不经过分类选择表单，不落这个字段
        const safeCategory = sanitizeCategory(category);

        // ✏️ 编辑已有记录：先看是不是作者本人发布的——本人编辑/删除自己发布的
        // 记录不需要 store_manager/patriarch/super_admin 身份，也不受门店/机构
        // 边界限制（本来就是自己发的，不存在"越权改别人门店记录"的问题），与
        // manageVolunteerSubmission 的 deleteMine/revokeMine 同一套"自己的东西
        // 自己能改"口径——义工也能编辑自己发布过的护持动态（即便已审核通过、
        // 公开展示）。不是本人才继续走下面 resolveWriteTarget 的店铺级权限校验，
        // 这段必须在 resolveWriteTarget 之前判断：resolveWriteTarget 对 update
        // 从不放行 volunteer（allowVolunteerCreate 只在纯 create 时为 true），
        // 放在后面会让义工在走到本人判断之前就已经被拒绝
        if (action === 'update' && id) {
          const existingRes = await db.collection(COLLECTION).doc(id).get().catch(() => null);
          const existing = existingRes && existingRes.data;
          if (!existing) return { success: false, error: '记录不存在' };

          const isOwner = !!existing.createdBy && !!OPENID && existing.createdBy === OPENID;
          if (!isOwner) {
            const target = await resolveWriteTarget(caller, storeId, { allowVolunteerCreate: false });
            if (!target.allowed) {
              return { success: false, error: target.error };
            }
            if (existing.tenantId && target.tenantId && existing.tenantId !== target.tenantId) {
              return { success: false, error: '无权限：该记录不属于您所在的机构' };
            }
            if ((caller.role === 'store_manager' || caller.role === 'store_patriarch') && existing.storeId !== target.storeId) {
              return { success: false, error: '无权限：不能编辑其他门店的大事记' };
            }
          }

          await db.collection(COLLECTION).doc(id).update({
            data: {
              title: String(title).trim(),
              eventTime,
              content: content || '',
              images: safeImages,
              category: safeCategory,
              updateTime: db.serverDate(),
              publisherLabel: resolvePublisherLabel(caller.role)
            }
          });
          return { success: true, id, message: '大事记已更新' };
        }

        // 只有纯新增（create）且不是餐报自动同步场景才允许义工走通——delete
        // 和 autoSyncFromReport 都不传这个 opt，volunteer 会在 resolveWriteTarget 里
        // 被兜底拒绝，不会误伤"义工能不能编辑别人记录"这条权限边界
        const target = await resolveWriteTarget(caller, storeId, {
          allowVolunteerCreate: action === 'create' && !autoSyncFromReport
        });
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

        // 🌟 义工提交的记录先落 PENDING，不直接进公开列表；店长/超管发布的记录
        // 明确落 APPROVED，与旧数据（没有 approvalStatus 字段）在 list 的
        // _.neq('PENDING') 过滤下表现一致（都会被列出）
        const createRes = await db.collection(COLLECTION).add({
          data: {
            tenantId: target.tenantId,
            storeId: target.storeId,
            storeName: target.storeName,
            title: String(title).trim(),
            eventTime,
            content: content || '',
            images: safeImages,
            category: safeCategory,
            createdBy: OPENID,
            createdAt: db.serverDate(),
            updateTime: db.serverDate(),
            publisherLabel: resolvePublisherLabel(caller.role),
            approvalStatus: target.isVolunteerSubmission ? 'PENDING' : 'APPROVED'
          }
        });

        return {
          success: true,
          id: createRes._id,
          message: target.isVolunteerSubmission
            ? '护持动态已提交，等待店长确认后将在门店日志公开展示'
            : '大事记已发布'
        };
      }

      case 'delete': {
        const { id } = event;
        if (!id) return { success: false, error: '缺少 id 参数' };

        const existingRes = await db.collection(COLLECTION).doc(id).get().catch(() => null);
        const existing = existingRes && existingRes.data;
        if (!existing) return { success: true, message: '记录不存在或已删除' };

        // 🌟 作者本人删除自己发布的记录：与上面 update 分支同一套"自己的东西
        // 自己能删"口径，见该处注释
        const isOwner = !!existing.createdBy && !!OPENID && existing.createdBy === OPENID;
        if (!isOwner) {
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
        }

        await db.collection(COLLECTION).doc(id).remove();
        return { success: true, message: '大事记已删除' };
      }

      // 📌 置顶/取消置顶：与 update/delete 不同，这是店长/超管的管理强化能力，
      // 不下放给记录本人（volunteer 哪怕是自己发布的动态也不能置顶）——resolveWriteTarget
      // 默认不传 allowVolunteerCreate，volunteer 会在这里被兜底拒绝
      case 'togglePin': {
        const { id, pinned } = event;
        if (!id) return { success: false, error: '缺少 id 参数' };

        const existingRes = await db.collection(COLLECTION).doc(id).get().catch(() => null);
        const existing = existingRes && existingRes.data;
        if (!existing) return { success: false, error: '记录不存在' };

        const target = await resolveWriteTarget(caller, existing.storeId);
        if (!target.allowed) {
          return { success: false, error: target.error };
        }
        if ((caller.role === 'store_manager' || caller.role === 'store_patriarch') && existing.storeId !== target.storeId) {
          return { success: false, error: '无权限：不能操作其他门店的大事记' };
        }
        if (existing.tenantId && target.tenantId && existing.tenantId !== target.tenantId) {
          return { success: false, error: '无权限：该记录不属于您所在的机构' };
        }

        await db.collection(COLLECTION).doc(id).update({
          data: { isPinned: !!pinned }
        });
        return { success: true, message: pinned ? '已置顶' : '已取消置顶' };
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
        const { storeId, page, pageSize, startDate, endDate, pinFirst } = event;
        const { page: p, size } = normalizePage(page, pageSize);
        const isSuperAdmin = caller && caller.role === 'super_admin';

        const where = {};

        // 🛡️ 门店隔离：此前非超管传入任意非 'ALL' 的 storeId（哪怕是伪造的其他门店 ID）
        // 都会被原样信任写进查询条件——'ALL' 分支专门做了越权收敛，但只要不精确等于
        // 这个字面量哨兵值，校验就被绕过了，等同于任何店长/义工都能读到同机构下其他
        // 门店的完整日志。改为：非超管无论客户端传了什么，一律强制收敛为自己绑定的
        // 门店；只有 super_admin 才能查看指定门店之外的范围（含不传 storeId 时的
        // 全机构汇总视角）
        if (!isSuperAdmin) {
          if (caller && caller.storeId) {
            where.storeId = caller.storeId;
          } else {
            return { success: true, data: [], page: p, pageSize: size, total: 0, hasMore: false };
          }
        } else if (storeId && storeId !== 'ALL') {
          where.storeId = storeId;
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

        // 🌟 公开列表默认过滤掉待确认的义工投稿（approvalStatus === 'PENDING'）——
        // 老数据从没写过这个字段，_.neq('PENDING') 对"字段不存在"同样成立，
        // 不会把发布时间早于本次改动的历史记录误过滤掉
        where.approvalStatus = _.neq('PENDING');

        const countRes = await db.collection(COLLECTION).where(where).count();
        // 📌 pinFirst 仅供"历史动态"时光轴显式请求置顶优先排序；今日大事记
        // （loadTodayActivity 按 pageSize:1 取"最新一条"）不传这个参数，排序行为
        // 与改动前完全一致，不会因为某条更早的记录被置顶而错误地顶替成"今日记录"
        let listQuery = db.collection(COLLECTION).where(where);
        if (pinFirst) {
          listQuery = listQuery.orderBy('isPinned', 'desc');
        }
        const listRes = await listQuery
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

      // ⏳ 待确认的义工投稿：仅 store_manager/store_patriarch/super_admin 可查看，
      // 门店范围收敛口径与 submitFeedback 云函数一致（见 resolveReviewStoreId）
      case 'listPending': {
        const { storeId } = event;
        const target = await resolveReviewStoreId(caller, storeId);
        if (!target.allowed) return { success: false, error: target.error };

        const listRes = await db.collection(COLLECTION)
          .where({ storeId: target.storeId, approvalStatus: 'PENDING' })
          .orderBy('createdAt', 'desc')
          .limit(MAX_PAGE_SIZE)
          .get();

        return { success: true, data: listRes.data || [] };
      }

      case 'approvePending': {
        const { id } = event;
        if (!id) return { success: false, error: '缺少 id 参数' };

        const existingRes = await db.collection(COLLECTION).doc(id).get().catch(() => null);
        const existing = existingRes && existingRes.data;
        if (!existing) return { success: false, error: '记录不存在' };

        const target = await resolveReviewStoreId(caller, existing.storeId);
        if (!target.allowed || target.storeId !== existing.storeId) {
          return { success: false, error: '无权限：仅可确认本店的待确认动态' };
        }

        await db.collection(COLLECTION).doc(id).update({
          data: {
            approvalStatus: 'APPROVED',
            approvedBy: OPENID,
            approvedAt: db.serverDate()
          }
        });
        return { success: true, message: '已确认，门店日志公开列表将展示这条动态' };
      }

      // 驳回：直接删除该条待确认记录（没有专门的"已驳回"状态可供义工再单独查看，
      // 与义工意见箱的"标记为已处理"不同——门店日志的驳回等同于"这条不采用"）
      case 'rejectPending': {
        const { id } = event;
        if (!id) return { success: false, error: '缺少 id 参数' };

        const existingRes = await db.collection(COLLECTION).doc(id).get().catch(() => null);
        const existing = existingRes && existingRes.data;
        if (!existing) return { success: true, message: '记录不存在或已处理' };

        const target = await resolveReviewStoreId(caller, existing.storeId);
        if (!target.allowed || target.storeId !== existing.storeId) {
          return { success: false, error: '无权限：仅可驳回本店的待确认动态' };
        }

        await db.collection(COLLECTION).doc(id).remove();
        return { success: true, message: '已驳回' };
      }

      default:
        return { success: false, error: `不支持的 action: ${action}` };
    }
  } catch (err) {
    console.error('[manageActivityLog] 异常:', err);
    return { success: false, error: err.message || '操作失败' };
  }
};
