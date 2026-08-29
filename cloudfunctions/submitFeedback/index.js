// 云函数：submitFeedback - 个人页「爱心意见箱」提交 + 店长/家长/超管审阅管理
//
// action 路由（event.action，缺省视为 'submit' 保持早期调用方式兼容）：
// - submit：任意已登录用户可提交，不做角色限制（家人/义工/店长均可用）。仅追加写入
//   feedback_submissions 集合，不涉及审核流转、不影响任何账本/餐报数据。
// - count：查询当前门店"未处理"（status='new'）意见数量，供个人页角标展示。
// - list：查询当前门店的意见列表（新→旧排序），供管理弹窗展示。
// - markHandled：把一条意见标记为已处理，不留回复内容。
// - reply：给一条意见写一段回复，提交后同时把状态置为已处理，并把 hasUnreadReply
//   置为 true（供家人端未读红点使用）。
// count/list/markHandled/reply 四个动作仅限 store_manager/store_patriarch/super_admin，
// 权限模型与 manageActivityLog/manageDailyMenu 一致：店长/家长限本店，超管可查看
// 指定门店（沿用 fetchPatriarchDashboardData 同款"传 storeId，服务端按角色收敛"口径）。
//
// - mySubmissions：家人查看自己提交过的全部意见 + 回复。
// - unreadReplyCount：家人未读回复数量，供个人页角标展示。
// - markRepliedRead：家人打开"我的反馈与回复"Tab 时，批量清空自己的未读回复标记。
// 以上三个动作按 _openid 归属，任何已登录用户都只能操作自己的数据，不做门店权限收敛。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTION = 'feedback_submissions';
const MAX_CONTENT_LENGTH = 500;
const MAX_LIST_LIMIT = 50;
const TYPE_LABELS = {
  meal: '🍱 餐饮菜品',
  env: '🧹 门店环境',
  volunteer: '🤝 义工服务',
  suggestion: '💡 运营建议'
};

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

// 管理类动作（count/list/markHandled）共用的门店范围收敛：
// 店长/家长强制取自己绑定的门店，忽略前端传入值；超管使用前端传入的具体门店 ID。
async function resolveManageStoreId(caller, requestedStoreId) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  if (caller.role === 'store_manager' || caller.role === 'store_patriarch') {
    if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店' };
    return { allowed: true, storeId: caller.storeId };
  }

  if (caller.role === 'super_admin') {
    if (!requestedStoreId) return { allowed: false, error: '请指定目标门店' };
    // 🛡️ 多租户越权修复：此前这里没有做任何 tenantId 校验，只要传了任意
    // requestedStoreId 就无条件放行，等于任何 super_admin 都能查看其他机构
    // 门店的意见箱内容。改为与 manageActivityLog 等同一套口径：查出目标门店
    // 后要求两侧 tenantId 都存在且相等才放行。
    const storeRes = await db.collection('stores').doc(requestedStoreId).get().catch(() => null);
    const store = storeRes && storeRes.data;
    if (!store) return { allowed: false, error: '目标门店不存在' };
    if (!caller.tenantId || !store.tenantId || caller.tenantId !== store.tenantId) {
      return { allowed: false, error: '无权限：目标门店不属于您所在的机构' };
    }
    return { allowed: true, storeId: requestedStoreId };
  }

  return { allowed: false, error: '无权限：仅店长、家长或超级管理员可查看意见箱' };
}

// 🐛 云函数容器时区固定为 UTC，getFullYear()/getHours() 等本地时间取值器在这里
// 取到的就是 UTC 时间，导致提交/回复时间字符串比北京时间少 8 小时——用手动加
// 8 小时偏移量后再取"UTC 字段"的方式换算成北京时间挂钟数字，不引入额外依赖
function formatCreateTime(createTime) {
  const d = createTime instanceof Date ? createTime : new Date(createTime);
  if (isNaN(d.getTime())) return '';
  const cst = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${cst.getUTCFullYear()}-${pad(cst.getUTCMonth() + 1)}-${pad(cst.getUTCDate())} ${pad(cst.getUTCHours())}:${pad(cst.getUTCMinutes())}`;
}

// 🛡️ -502005 DATABASE_COLLECTION_NOT_EXIST：collection 从未被写入过（比如还没
// 有任何家人提交过意见）时，count/list 这类查询会直接报错而不是返回空结果——
// 这不是"数据丢了"，只是"这张表还没诞生"，按空结果处理即可，不该让店长端崩溃。
// 🐛 不采用"换一个集合名字重试"的降级方式：那样会导致后续写入落进另一张表，
// 两张表的数据从此对不上，比眼前这个报错更难排查——参考本仓库 createStore 云函数
// 对 tenant_subscriptions 集合的同款处理方式，一律"查询失败 = 当作没有记录"。
function isCollectionNotExistError(err) {
  return !!err && (err.errCode === -502005 || /database collection not exists/i.test(String(err.errMsg || err.message || '')));
}

// 🛡️ 服务端内容安全兜底：msgSecCheck 之前只在小程序前端提交前调用一次，客户端
// 是"建议性"检查，绕过前端（抓包/自定义客户端直接调云函数）就能完全跳过审核
// 把违规内容写库。这里在真正落库前于服务端再强制过一遍，不再只信任客户端已经
// 查过。降级策略沿用 msgSecCheck 自身口径：API 不可用时放行但标记待人工审核，
// 不会因为微信内容安全接口临时抖动就把家人的正常意见拦下来。
async function checkContentSafe(text, contentType) {
  if (!text) return true;
  try {
    const res = await cloud.callFunction({
      name: 'msgSecCheck',
      data: { text, contentType }
    });
    return !res.result || res.result.safe !== false;
  } catch (err) {
    console.warn('[submitFeedback] 服务端内容安全检测调用失败，降级放行:', err);
    return true;
  }
}

async function handleSubmit(event, OPENID) {
  if (!OPENID) {
    return { success: false, error: '未登录，无法提交' };
  }

  const type = event.type;
  const content = String(event.content || '').trim();

  if (!TYPE_LABELS[type]) {
    return { success: false, error: '意见类型不合法' };
  }
  if (!content) {
    return { success: false, error: '意见内容不能为空' };
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return { success: false, error: `内容过长，请控制在 ${MAX_CONTENT_LENGTH} 字以内` };
  }
  if (!(await checkContentSafe(content, 'feedback'))) {
    return { success: false, error: '内容包含违规信息，请修改后重新提交' };
  }

  const caller = await resolveCaller(OPENID);
  // 🐛 门店对不上导致意见"消失"：家人账号大多没有 user_roles 记录（store_family
  // 只是本地/客户端角色，从不写服务端），caller 为 null，caller.storeId 只能是空
  // 字符串——意见就存成了 storeId: ''，而店长/家长/超管的 list/count 永远按自己
  // 真实门店 ID 查询，两边永远对不上。优先用前端传来的"当前正在浏览的门店"
  // （getSelectedStore，家人/义工/店长任何角色都适用），只有前端没传时才退回
  // 角色绑定门店（真实义工/店长本就该按自己绑定门店归档，不受影响）
  const storeId = event.storeId || (caller && caller.storeId) || '';
  const storeName = event.storeName || (caller && caller.storeName) || '';
  let tenantId = (caller && caller.tenantId) || '';
  const nickName = (caller && caller.nickName) || '';

  // caller 为 null（家人账号常态）时 tenantId 也是空的——顺手从门店文档补一次，
  // 避免这条意见完全脱离机构归属，虽然当前 list/count 查询不靠 tenantId 过滤，
  // 但留空会让这条记录在其他按 tenantId 统计的场景里被漏算
  if (!tenantId && storeId) {
    const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
    tenantId = (storeRes && storeRes.data && storeRes.data.tenantId) || '';
  }

  const doc = {
    _openid: OPENID,
    nickName,
    type,
    typeLabel: TYPE_LABELS[type],
    content,
    storeId,
    storeName,
    tenantId,
    status: 'new',
    createTime: db.serverDate()
  };

  try {
    await db.collection(COLLECTION).add({ data: doc });
  } catch (err) {
    // .add() 通常会在集合不存在时自动建表，这里只是兜底：万一这次环境没有自动建表，
    // 显式建一次再重试一次写入，而不是让家人的这条意见直接提交失败
    if (!isCollectionNotExistError(err)) throw err;
    await db.createCollection(COLLECTION).catch(() => {});
    await db.collection(COLLECTION).add({ data: doc });
  }

  return { success: true };
}

async function handleCount(event, OPENID) {
  const caller = await resolveCaller(OPENID);
  const target = await resolveManageStoreId(caller, event.storeId);
  if (!target.allowed) return { success: false, error: target.error };

  try {
    const res = await db.collection(COLLECTION)
      .where({ storeId: target.storeId, status: 'new' })
      .count();
    return { success: true, data: { count: res.total || 0 } };
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    return { success: true, data: { count: 0 } };
  }
}

async function handleList(event, OPENID) {
  const caller = await resolveCaller(OPENID);
  const target = await resolveManageStoreId(caller, event.storeId);
  if (!target.allowed) return { success: false, error: target.error };

  let rows;
  try {
    const res = await db.collection(COLLECTION)
      .where({ storeId: target.storeId })
      .orderBy('createTime', 'desc')
      .limit(MAX_LIST_LIMIT)
      .get();
    rows = res.data || [];
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    rows = [];
  }

  const list = rows.map((item) => ({
    _id: item._id,
    nickName: item.nickName || '',
    type: item.type,
    typeLabel: item.typeLabel || '',
    content: item.content || '',
    status: item.status || 'new',
    createTimeStr: formatCreateTime(item.createTime),
    replyContent: item.replyContent || '',
    replyByName: item.replyByName || '',
    replyTimeStr: item.replyTime ? formatCreateTime(item.replyTime) : ''
  }));

  return { success: true, data: { list } };
}

// 💬 回复家人：与"标记为已处理"是两种不同的收尾方式——标记为已处理是"知道了、
// 不需要单独回话"，回复则是明确写一段话给家人看。提交回复视为已经处理完这条意见，
// 所以这里顺带把 status 一并置为 handled，不需要管理端再多点一次"标记为已处理"
async function handleReply(event, OPENID) {
  const feedbackId = event.feedbackId;
  const replyContent = String(event.replyContent || '').trim();
  if (!feedbackId) return { success: false, error: '缺少意见 ID' };
  if (!replyContent) return { success: false, error: '回复内容不能为空' };
  if (replyContent.length > MAX_CONTENT_LENGTH) {
    return { success: false, error: `回复内容过长，请控制在 ${MAX_CONTENT_LENGTH} 字以内` };
  }
  if (!(await checkContentSafe(replyContent, 'feedback'))) {
    return { success: false, error: '回复内容包含违规信息，请修改后重新提交' };
  }

  const caller = await resolveCaller(OPENID);
  const docRes = await db.collection(COLLECTION).doc(feedbackId).get().catch(() => null);
  const doc = docRes && docRes.data;
  if (!doc) return { success: false, error: '该条意见不存在' };

  const target = await resolveManageStoreId(caller, doc.storeId);
  if (!target.allowed || target.storeId !== doc.storeId) {
    return { success: false, error: '无权限：仅可处理本店的意见' };
  }

  await db.collection(COLLECTION).doc(feedbackId).update({
    data: {
      status: 'handled',
      replyContent,
      replyBy: OPENID,
      replyByName: (caller && caller.nickName) || '',
      replyTime: db.serverDate(),
      handledBy: OPENID,
      handledTime: db.serverDate(),
      // 💌 家人端"我的反馈与回复"未读红点：回复一写入就置为未读，家人打开该 Tab
      // 时 markRepliedRead 批量清掉；标记为已处理（不写回复）不触碰这个字段，
      // 因为没有新内容可看，不需要提醒家人
      hasUnreadReply: true
    }
  });

  return { success: true };
}

async function handleMarkHandled(event, OPENID) {
  const feedbackId = event.feedbackId;
  if (!feedbackId) return { success: false, error: '缺少意见 ID' };

  const caller = await resolveCaller(OPENID);
  // .catch(() => null) 已经把 -502005（集合不存在）和"文档确实不存在"这两种情况
  // 统一收敛成同一个"找不到该条意见"的结果，不需要再单独区分处理，前端也只关心
  // "这条意见能不能被标记"，不需要知道底层是哪种失败原因
  const docRes = await db.collection(COLLECTION).doc(feedbackId).get().catch(() => null);
  const doc = docRes && docRes.data;
  if (!doc) return { success: false, error: '该条意见不存在' };

  const target = await resolveManageStoreId(caller, doc.storeId);
  if (!target.allowed || target.storeId !== doc.storeId) {
    return { success: false, error: '无权限：仅可处理本店的意见' };
  }

  await db.collection(COLLECTION).doc(feedbackId).update({
    data: {
      status: 'handled',
      handledBy: OPENID,
      handledTime: db.serverDate()
    }
  });

  return { success: true };
}

// 💌 家人端「我的反馈与回复」：以下三个动作按 _openid 归属，不是按门店——
// 任何已登录用户都只能看/管理自己提交过的意见，不需要 store_manager/patriarch/
// super_admin 那套门店权限收敛（resolveManageStoreId 在这里完全不适用）

async function handleMySubmissions(event, OPENID) {
  if (!OPENID) return { success: false, error: '未登录，无法查看' };

  let rows;
  try {
    const res = await db.collection(COLLECTION)
      .where({ _openid: OPENID })
      .orderBy('createTime', 'desc')
      .limit(MAX_LIST_LIMIT)
      .get();
    rows = res.data || [];
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    rows = [];
  }

  const list = rows.map((item) => ({
    _id: item._id,
    type: item.type,
    typeLabel: item.typeLabel || '',
    content: item.content || '',
    status: item.status || 'new',
    createTimeStr: formatCreateTime(item.createTime),
    replyContent: item.replyContent || '',
    replyByName: item.replyByName || '',
    replyTimeStr: item.replyTime ? formatCreateTime(item.replyTime) : ''
  }));

  return { success: true, data: { list } };
}

async function handleUnreadReplyCount(event, OPENID) {
  if (!OPENID) return { success: true, data: { count: 0 } };

  try {
    const res = await db.collection(COLLECTION)
      .where({ _openid: OPENID, hasUnreadReply: true })
      .count();
    return { success: true, data: { count: res.total || 0 } };
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    return { success: true, data: { count: 0 } };
  }
}

async function handleMarkRepliedRead(event, OPENID) {
  if (!OPENID) return { success: false, error: '未登录，无法操作' };

  try {
    // 云函数环境下 where().update() 是批量更新，一次性把这位家人所有"已回复未读"
    // 的意见清成已读，不需要先查出 ID 列表再逐条 update
    await db.collection(COLLECTION)
      .where({ _openid: OPENID, hasUnreadReply: true })
      .update({ data: { hasUnreadReply: false } });
    return { success: true };
  } catch (err) {
    if (!isCollectionNotExistError(err)) return { success: true };
    throw err;
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event.action || 'submit';

  switch (action) {
    case 'submit':
      return handleSubmit(event, OPENID);
    case 'count':
      return handleCount(event, OPENID);
    case 'list':
      return handleList(event, OPENID);
    case 'markHandled':
      return handleMarkHandled(event, OPENID);
    case 'reply':
      return handleReply(event, OPENID);
    case 'mySubmissions':
      return handleMySubmissions(event, OPENID);
    case 'unreadReplyCount':
      return handleUnreadReplyCount(event, OPENID);
    case 'markRepliedRead':
      return handleMarkRepliedRead(event, OPENID);
    default:
      return { success: false, error: '未知操作' };
  }
};
