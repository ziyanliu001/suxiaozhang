// 云函数：manageVolunteerSubmission - 义工现场服务工具（菜单人数 / 物资消耗）提交
//
// 🛡️ 为什么不直接写 report_logs：report_logs 是门店每日资金台账，参与
// cascadeRecalculator/updateAndRecalculateCascade/recalculateCascadeBalances 等
// 跨天结转链路（按 storeId+tenantId+dateString 无条件扫描，不看 approvalStatus），
// 且 dataService.ts 有"每店每天一条"的去重保护。义工只填报人数/菜单/物资消耗这类
// 原始信息，不含前日结余、支出等财务字段——直接插入 report_logs 会在结转链路里
// 插入一个"零收支幽灵日"，还可能撞上店长同一天正式提交的报告触发去重拦截。
// 因此单独开一张轻量集合，不参与任何财务结转，店长后续人工参考、自行汇总进
// 正式报告，不会被任何云函数自动合并进 report_logs。
//
// action：
// - submit：volunteer/store_manager/store_patriarch/super_admin 均可提交一条
//   type='menu'（今日菜单与人数）或 type='material'（物资消耗与报损）记录，
//   自动绑定当前门店。不放行家人/其他未识别角色。
//   🛡️ 历史上这里曾只放行 caller.role === 'volunteer'，挡住了两类合法场景：
//   超管用"视角切换预览"看义工视图时客户端显示 isVolunteer=true 但服务端
//   caller.role 是真实的 super_admin；以及店长/家长本人想用这套轻量表单
//   临时登记，不想走完整正式报告流程。
//   🏛️ 店长/家长本人提交免二次审核：caller.role（这里查出来的登录者真实
//   角色，不是 event 里任何客户端字段）是 store_manager/store_patriarch 时，
//   status 直接落 'approved' 并复用 approve 动作同一套入库逻辑（安全边界见
//   下方 approve 小节），省掉"自己审自己"这道多余流程；其余角色仍是 'pending'。
// - myList：义工查看自己提交过的全部记录（按 _openid，不区分门店）。
// - listPending：店长/家长/超管查看本店待处理的义工投稿——权限模型与
//   manageActivityLog 的 resolveReviewStoreId 一致。
// - approve：采纳一条投稿，status 置为 'approved'。
//   🛡️ "自动入库"的安全边界（务必先读文件头部这段再改动 approve 逻辑）：
//   - type='menu' 只在 report_logs 里"当天已存在的文档"上做字段级 UPDATE
//     （diningCount 仅在店长还没填时才自动带入、reportText 追加一行摘要），
//     绝不新建 report_logs 文档——cascadeRecalculator/updateAndRecalculateCascade
//     等结转函数按 storeId+dateString 无条件扫描全部文档，新增一条不含
//     yesterdayBalance/expenseAmount 的"裸文档"会在结转链路里插入"零收支幽灵日"；
//     dataService.ts 对"同店同日"还有去重拦截，贸然新增可能把店长后续的正式
//     提交挡在外面。今天还没有正式报告时，approve 仍然成功，只是不做入库合并，
//     响应里如实告知义工/店长这一点。
//   - type='material' 追加写入独立的 material_logs 集合（新集合，此前不存在，
//     没有任何库存基线可供"扣减"——这里只是流水式记录消耗，不是真正的库存
//     扣减，避免打着"扣库存"的旗号却没有库存系统支撑）。
// - reject：驳回一条投稿，必须携带 rejectReason，status 置为 'rejected'。
// - deleteMine：义工自己删除一条已被驳回（不改了不重提了）或还在待审核中
//   （提交手滑了，店长还没处理，先撤回）的记录。服务端强制校验"必须是本人
//   提交 + 当前状态仍是 rejected/pending"，避免误删/越权删除别人的记录，
//   或删掉已经被店长采纳入库的 approved 记录。
// - revokeMine：撤回一条自己提交、已经采纳入库（approved）的记录——把它当初
//   合并进 report_logs（type='menu'）/ 追加进 material_logs（type='material'）
//   的贡献反向冲减掉，再删除这条记录本身。menu 类型只有在 report_logs 当天
//   的早/午/晚/合计人数仍与这条记录写入时完全一致（没被别的记录后续覆盖）
//   才会执行，否则拒绝撤回并报错，避免冲掉别人刚采纳的数据（见 revertMenuFromReportLogs）。
// - statsSummary：全店餐饮/物资统计——不新建 store_daily_stats 汇总表，即时查询
//   volunteer_submissions（今日已采纳的分餐人数）+ material_logs（本月已入库的
//   物资消耗），店长/家长/超管/义工均可查看本店范围（超管需传 storeId）。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COLLECTION = 'volunteer_submissions';
const MAX_NOTE_LENGTH = 300;
const MAX_LIST_LIMIT = 50;

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

function isCollectionNotExistError(err) {
  return !!err && (err.errCode === -502005 || /database collection not exists/i.test(String(err.errMsg || err.message || '')));
}

function todayStr() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// 🐛 云函数容器时区固定为 UTC，getFullYear()/getHours() 等本地时间取值器在这里
// 取到的就是 UTC 时间，导致提交时间字符串比北京时间少 8 小时——用手动加 8 小时
// 偏移量后再取"UTC 字段"的方式换算成北京时间挂钟数字，不引入额外依赖
function formatCreateTime(createTime) {
  const d = createTime instanceof Date ? createTime : new Date(createTime);
  if (isNaN(d.getTime())) return '';
  const cst = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${cst.getUTCFullYear()}-${pad(cst.getUTCMonth() + 1)}-${pad(cst.getUTCDate())} ${pad(cst.getUTCHours())}:${pad(cst.getUTCMinutes())}`;
}

// 与 manageActivityLog 的 resolveReviewStoreId 同一套口径：店长/家长强制取自己
// 绑定的门店，超管使用前端传入的具体门店 ID
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

  return { allowed: false, error: '无权限：仅店长、家长或超级管理员可查看' };
}

async function handleSubmit(event, OPENID) {
  if (!OPENID) return { success: false, error: '未登录，无法提交' };

  const type = event.type;
  if (type !== 'menu' && type !== 'material') {
    return { success: false, error: '提交类型不合法' };
  }

  const caller = await resolveCaller(OPENID);
  // 🛡️ 曾经"仅义工可用"（caller.role !== 'volunteer' 直接拒绝）在真实场景里挡住了
  // 两类合法使用者：① 超管用"视角切换预览"看义工视图时，客户端 isVolunteer 显示
  // true 但服务端 caller.role 是真实的 super_admin，之前会被这里拒绝；② 店长/家长
  // 本人有时也需要用这套轻量表单临时登记（不想为一条菜单人数走完整的正式报告
  // 流程）。放宽为"任一合法门店角色"都能提交，仍然不放行家人/其他未识别角色。
  const ALLOWED_SUBMIT_ROLES = ['volunteer', 'store_manager', 'store_patriarch', 'super_admin'];
  if (!caller || !ALLOWED_SUBMIT_ROLES.includes(caller.role)) {
    return { success: false, error: '无权限提交' };
  }

  const storeId = event.storeId || caller.storeId || '';
  const storeName = event.storeName || caller.storeName || '';
  if (!storeId) return { success: false, error: '未识别到您所在的门店，请先在首页选择门店' };

  let tenantId = caller.tenantId || '';
  if (!tenantId && storeId) {
    const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
    tenantId = (storeRes && storeRes.data && storeRes.data.tenantId) || '';
  }

  // 🏛️ 管理者（店长/家长/超管）本人填报免二次审核：本来就是有权确认这笔数据
  // 的人，自己填的没有再走一遍"提交给自己审核"的意义——直接采纳入库，省掉
  // 多余步骤。必须以这里刚查出来的 caller.role（登录者的真实角色）为准，绝
  // 不能信 event 里任何客户端传来的角色/审批标记：否则任何登录用户都能在
  // 请求体里伪造一个 autoApprove 标记，绕过审核直接把数据写进正式台账
  const AUTO_APPROVE_ROLES = ['store_manager', 'store_patriarch', 'super_admin'];
  const autoApprove = AUTO_APPROVE_ROLES.includes(caller.role);

  const doc = {
    _openid: OPENID,
    nickName: caller.nickName || '',
    // 提交人的真实角色——不是所有提交都真的来自义工了，保留下来供店长审核时
    // 参考（比如看到是自己或同事店长提交的，通常可以更放心地一键采纳）
    submitterRole: caller.role,
    type,
    storeId,
    storeName,
    tenantId,
    dateString: (event.dateString && /^\d{4}-\d{2}-\d{2}$/.test(event.dateString)) ? event.dateString : todayStr(),
    status: autoApprove ? 'approved' : 'pending',
    createTime: db.serverDate()
  };
  if (autoApprove) {
    doc.approvedBy = OPENID;
    doc.approveTime = db.serverDate();
  }

  if (type === 'menu') {
    doc.mealStatus = event.mealStatus === 'closed' ? 'closed' : 'open';
    doc.breakfastCount = Math.max(0, parseInt(event.breakfastCount, 10) || 0);
    doc.lunchCount = Math.max(0, parseInt(event.lunchCount, 10) || 0);
    doc.dinnerCount = Math.max(0, parseInt(event.dinnerCount, 10) || 0);
    // 总人数取三餐之和，提交时算好存进文档，不需要每次读取时再现算一遍
    doc.totalCount = doc.breakfastCount + doc.lunchCount + doc.dinnerCount;
    doc.menuNote = String(event.menuNote || '').trim().slice(0, MAX_NOTE_LENGTH);
  } else {
    doc.riceCount = Math.max(0, parseFloat(event.riceCount) || 0);
    doc.flourCount = Math.max(0, parseFloat(event.flourCount) || 0);
    doc.oilCount = Math.max(0, parseFloat(event.oilCount) || 0);
    doc.vegetableCount = Math.max(0, parseFloat(event.vegetableCount) || 0);
    doc.lossNote = String(event.lossNote || '').trim().slice(0, MAX_NOTE_LENGTH);
  }

  let addRes;
  try {
    addRes = await db.collection(COLLECTION).add({ data: doc });
  } catch (err) {
    // .add() 通常会在集合不存在时自动建表，这里兜底：万一没有，显式建一次再重试
    if (!isCollectionNotExistError(err)) throw err;
    await db.createCollection(COLLECTION).catch(() => {});
    addRes = await db.collection(COLLECTION).add({ data: doc });
  }

  if (!autoApprove) {
    return { success: true };
  }

  // 复用 handleApprove 里同一套"只更新当天已存在的 report_logs 文档/追加
  // material_logs 流水"的安全边界（见文件头部注释），不重复一份逻辑
  doc._id = addRes._id;
  let message = '已直接确认并归档入库';
  if (type === 'menu') {
    const mergeResult = await mergeMenuIntoReportLogs(doc);
    if (!mergeResult.merged) {
      message = '已直接确认，今日尚无正式餐报，人数与菜单需在提交今日报告时手动核对补录';
    }
  } else {
    await writeMaterialLog(doc, OPENID);
  }

  return { success: true, autoApproved: true, message };
}

function mapItem(item) {
  return {
    _id: item._id,
    type: item.type,
    dateString: item.dateString || '',
    status: item.status || 'pending',
    createTimeStr: formatCreateTime(item.createTime),
    mealStatus: item.mealStatus,
    breakfastCount: item.breakfastCount,
    lunchCount: item.lunchCount,
    dinnerCount: item.dinnerCount,
    totalCount: item.totalCount,
    menuNote: item.menuNote || '',
    riceCount: item.riceCount,
    flourCount: item.flourCount,
    oilCount: item.oilCount,
    vegetableCount: item.vegetableCount,
    lossNote: item.lossNote || '',
    rejectReason: item.rejectReason || ''
  };
}

async function handleMyList(event, OPENID) {
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

  return { success: true, data: { list: rows.map(mapItem) } };
}

async function handleListPending(event, OPENID) {
  const caller = await resolveCaller(OPENID);
  const target = await resolveReviewStoreId(caller, event.storeId);
  if (!target.allowed) return { success: false, error: target.error };

  let rows;
  try {
    const res = await db.collection(COLLECTION)
      .where({ storeId: target.storeId, status: 'pending' })
      .orderBy('createTime', 'desc')
      .limit(MAX_LIST_LIMIT)
      .get();
    rows = res.data || [];
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    rows = [];
  }

  return { success: true, data: { list: rows.map((item) => Object.assign(mapItem(item), { nickName: item.nickName || '' })) } };
}

// 只更新 report_logs 里"当天已存在的文档"，绝不新建——见文件头部安全边界说明
async function mergeMenuIntoReportLogs(doc) {
  const existingRes = await db.collection('report_logs')
    .where({ storeId: doc.storeId, dateString: doc.dateString })
    .limit(1)
    .get();
  const existing = existingRes.data && existingRes.data[0];

  if (!existing) {
    return { merged: false };
  }

  const updateData = {};
  // 人数只在店长还没填过（0/空）时才自动带入，避免覆盖店长已核实过的数字
  if (!existing.diningCount) {
    updateData.diningCount = doc.totalCount || 0;
  }

  // 🌟 早/午/晚分餐人数：report_logs 里从来没有这几个字段，纯新增补充字段，
  // 不会被 cascadeRecalculator 等结转函数读取/依赖（那些函数只认
  // yesterdayBalance/todayBalance/expenseAmount），可以安全直接写入，不需要
  // "已存在才不覆盖"这层保护——每次采纳都用最新一次义工投稿的分餐数字覆盖即可
  updateData.breakfastCount = doc.breakfastCount || 0;
  updateData.lunchCount = doc.lunchCount || 0;
  updateData.dinnerCount = doc.dinnerCount || 0;
  updateData.totalCount = doc.totalCount || 0;

  const summaryLine = `[义工登记] 早:${doc.breakfastCount || 0} 午:${doc.lunchCount || 0} 晚:${doc.dinnerCount || 0}` +
    (doc.menuNote ? ` 备注:${doc.menuNote}` : '');
  updateData.reportText = existing.reportText ? `${existing.reportText}\n${summaryLine}` : summaryLine;

  await db.collection('report_logs').doc(existing._id).update({ data: updateData });
  return { merged: true };
}

// mergeMenuIntoReportLogs 的镜像操作：撤回一条已采纳的菜单登记时，把它当初
// 写进 report_logs 的贡献冲减回去。🛡️ 早/午/晚/合计人数是"覆盖式合并"（每次
// 采纳都用最新数字直接覆盖，不是累加），所以只有当 report_logs 当天这几个字段
// 现在的值仍然和这条记录当初写入的值完全一致时，才能安全清零——如果期间又有
// 别的投稿被采纳、把这几个字段覆盖成了别人的数字，贸然清零会把别人刚采纳的数据
// 一起冲掉，这种情况下拒绝撤回，返回明确原因，让人工去 report_logs 核对
async function revertMenuFromReportLogs(doc) {
  const existingRes = await db.collection('report_logs')
    .where({ storeId: doc.storeId, dateString: doc.dateString })
    .limit(1)
    .get();
  const existing = existingRes.data && existingRes.data[0];

  if (!existing) {
    // 当天没有正式报告可合并，采纳时就没写进 report_logs，本来就没有账本可冲减
    return { reverted: true };
  }

  const stillMatches = (existing.breakfastCount || 0) === (doc.breakfastCount || 0)
    && (existing.lunchCount || 0) === (doc.lunchCount || 0)
    && (existing.dinnerCount || 0) === (doc.dinnerCount || 0)
    && (existing.totalCount || 0) === (doc.totalCount || 0);
  if (!stillMatches) {
    return { reverted: false, error: '门店当天账本已被其他记录覆盖，无法安全撤回，请联系财务人工核对' };
  }

  const updateData = { breakfastCount: 0, lunchCount: 0, dinnerCount: 0, totalCount: 0 };
  // diningCount 当初只在店长还没填过时才会被这条记录带入，只有它仍等于这条
  // 记录写入的值时才一并清零，避免误清掉店长后来自己手动核实填写的人数
  if (existing.diningCount === doc.totalCount) {
    updateData.diningCount = 0;
  }

  const summaryLine = `[义工登记] 早:${doc.breakfastCount || 0} 午:${doc.lunchCount || 0} 晚:${doc.dinnerCount || 0}` +
    (doc.menuNote ? ` 备注:${doc.menuNote}` : '');
  if (existing.reportText) {
    const lines = existing.reportText.split('\n');
    if (lines[lines.length - 1] === summaryLine) {
      lines.pop();
      updateData.reportText = lines.join('\n');
    }
  }

  await db.collection('report_logs').doc(existing._id).update({ data: updateData });
  return { reverted: true };
}

// material_logs 是全新的流水记录集合，不存在任何库存基线，这里只追加一条
// "消耗了多少"的记录，不做也不能做真正的库存扣减
async function writeMaterialLog(doc, OPENID) {
  const materialDoc = {
    storeId: doc.storeId,
    storeName: doc.storeName,
    tenantId: doc.tenantId,
    dateString: doc.dateString,
    riceCount: doc.riceCount || 0,
    flourCount: doc.flourCount || 0,
    oilCount: doc.oilCount || 0,
    vegetableCount: doc.vegetableCount || 0,
    lossNote: doc.lossNote || '',
    sourceSubmissionId: doc._id,
    submittedBy: doc._openid,
    submittedByName: doc.nickName || '',
    approvedBy: OPENID,
    createTime: db.serverDate()
  };

  try {
    await db.collection('material_logs').add({ data: materialDoc });
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    await db.createCollection('material_logs').catch(() => {});
    await db.collection('material_logs').add({ data: materialDoc });
  }
}

async function handleApprove(event, OPENID) {
  const id = event.id;
  if (!id) return { success: false, error: '缺少 id 参数' };

  const caller = await resolveCaller(OPENID);
  const docRes = await db.collection(COLLECTION).doc(id).get().catch(() => null);
  const doc = docRes && docRes.data;
  if (!doc) return { success: false, error: '该条记录不存在' };
  if (doc.status !== 'pending') return { success: false, error: '该条记录已被处理，请勿重复操作' };

  const target = await resolveReviewStoreId(caller, doc.storeId);
  if (!target.allowed || target.storeId !== doc.storeId) {
    return { success: false, error: '无权限：仅可处理本店的投稿' };
  }

  let message = '已成功采纳并同步入库';
  if (doc.type === 'menu') {
    const mergeResult = await mergeMenuIntoReportLogs(doc);
    if (!mergeResult.merged) {
      message = '已采纳，今日尚无正式餐报，人数与菜单需在店长提交今日报告时手动核对补录';
    }
  } else {
    await writeMaterialLog(doc, OPENID);
    message = '已成功采纳并归档至物资消耗记录';
  }

  await db.collection(COLLECTION).doc(id).update({
    data: { status: 'approved', approvedBy: OPENID, approveTime: db.serverDate() }
  });

  return { success: true, message };
}

async function handleReject(event, OPENID) {
  const id = event.id;
  const rejectReason = String(event.rejectReason || '').trim();
  if (!id) return { success: false, error: '缺少 id 参数' };
  if (!rejectReason) return { success: false, error: '请填写驳回原因' };
  if (rejectReason.length > MAX_NOTE_LENGTH) {
    return { success: false, error: `驳回原因过长，请控制在 ${MAX_NOTE_LENGTH} 字以内` };
  }

  const caller = await resolveCaller(OPENID);
  const docRes = await db.collection(COLLECTION).doc(id).get().catch(() => null);
  const doc = docRes && docRes.data;
  if (!doc) return { success: false, error: '该条记录不存在' };
  if (doc.status !== 'pending') return { success: false, error: '该条记录已被处理，请勿重复操作' };

  const target = await resolveReviewStoreId(caller, doc.storeId);
  if (!target.allowed || target.storeId !== doc.storeId) {
    return { success: false, error: '无权限：仅可处理本店的投稿' };
  }

  await db.collection(COLLECTION).doc(id).update({
    data: { status: 'rejected', rejectReason, rejectedBy: OPENID, rejectTime: db.serverDate() }
  });

  return { success: true };
}

async function handleDeleteMine(event, OPENID) {
  if (!OPENID) return { success: false, error: '未登录，无法操作' };

  const id = event.id;
  if (!id) return { success: false, error: '缺少 id 参数' };

  const docRes = await db.collection(COLLECTION).doc(id).get().catch(() => null);
  const doc = docRes && docRes.data;
  if (!doc) return { success: false, error: '该条记录不存在或已被删除' };
  if (doc._openid !== OPENID) return { success: false, error: '无权限：只能删除自己提交的记录' };
  if (doc.status !== 'rejected' && doc.status !== 'pending') {
    return { success: false, error: '只能删除已驳回或待审核的记录' };
  }

  await db.collection(COLLECTION).doc(id).remove();
  return { success: true };
}

// 撤回一条已采纳入库的记录：与 handleDeleteMine 分开单独成一个动作，因为这里
// 除了删记录本身，还要先把它当初写进 report_logs/material_logs 的贡献反向
// 冲减掉——风险和校验逻辑都比"删一条还没生效的 pending/rejected 草稿"重得多，
// 混在一个函数里会让两种截然不同的操作互相牵连，拆开更安全也更好读
async function handleRevokeMine(event, OPENID) {
  if (!OPENID) return { success: false, error: '未登录，无法操作' };

  const id = event.id;
  if (!id) return { success: false, error: '缺少 id 参数' };

  const docRes = await db.collection(COLLECTION).doc(id).get().catch(() => null);
  const doc = docRes && docRes.data;
  if (!doc) return { success: false, error: '该条记录不存在或已被删除' };
  if (doc._openid !== OPENID) return { success: false, error: '无权限：只能撤回自己提交的记录' };
  if (doc.status !== 'approved') return { success: false, error: '只能撤回已采纳入库的记录' };

  if (doc.type === 'menu') {
    const revertResult = await revertMenuFromReportLogs(doc);
    if (!revertResult.reverted) {
      return { success: false, error: revertResult.error || '撤回失败，请稍后重试' };
    }
  } else {
    const logRes = await db.collection('material_logs').where({ sourceSubmissionId: id }).limit(1).get().catch(() => null);
    const logDoc = logRes && logRes.data && logRes.data[0];
    if (logDoc) {
      await db.collection('material_logs').doc(logDoc._id).remove();
    }
  }

  await db.collection(COLLECTION).doc(id).remove();
  return { success: true };
}

// 与 resolveReviewStoreId 的区别：这里额外放行 volunteer 角色（只读，看的是本店
// 汇总数字，不含任何个人隐私/财务明细），店长/家长/超管仍走同一套门店范围收敛
async function resolveReadStoreId(caller, requestedStoreId) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  if (caller.role === 'store_manager' || caller.role === 'store_patriarch' || caller.role === 'volunteer') {
    if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店' };
    return { allowed: true, storeId: caller.storeId };
  }

  if (caller.role === 'super_admin') {
    if (!requestedStoreId) return { allowed: false, error: '请指定目标门店' };
    return { allowed: true, storeId: requestedStoreId };
  }

  return { allowed: false, error: '无权限：仅店长、家长、超级管理员或义工可查看本店统计' };
}

function emptyMealTotals() {
  return { breakfastCount: 0, lunchCount: 0, dinnerCount: 0, totalCount: 0 };
}

function emptyMaterialTotals() {
  return { riceCount: 0, flourCount: 0, oilCount: 0, vegetableCount: 0 };
}

async function handleStatsSummary(event, OPENID) {
  const caller = await resolveCaller(OPENID);
  const target = await resolveReadStoreId(caller, event.storeId);
  if (!target.allowed) return { success: false, error: target.error };

  const today = todayStr();
  const monthPrefix = today.slice(0, 7);

  // 今日三餐人数：只统计已采纳（approved）的义工投稿——待审核/已驳回的数字
  // 还没经过店长确认，不该计入店里的正式统计
  let mealTotals = emptyMealTotals();
  try {
    const res = await db.collection(COLLECTION)
      .where({ storeId: target.storeId, type: 'menu', status: 'approved', dateString: today })
      .get();
    mealTotals = (res.data || []).reduce((acc, item) => {
      acc.breakfastCount += item.breakfastCount || 0;
      acc.lunchCount += item.lunchCount || 0;
      acc.dinnerCount += item.dinnerCount || 0;
      return acc;
    }, emptyMealTotals());
    mealTotals.totalCount = mealTotals.breakfastCount + mealTotals.lunchCount + mealTotals.dinnerCount;
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
  }

  // 米/面/油/菜消耗：material_logs 只在 approve 时才会写入，天然就是"已入库"的量，
  // 不需要再额外过滤状态
  let todayMaterialTotals = emptyMaterialTotals();
  let monthMaterialTotals = emptyMaterialTotals();
  try {
    const res = await db.collection('material_logs')
      .where({
        storeId: target.storeId,
        dateString: _.gte(`${monthPrefix}-01`).and(_.lte(`${monthPrefix}-31`))
      })
      .get();
    const rows = res.data || [];
    monthMaterialTotals = rows.reduce((acc, item) => {
      acc.riceCount += item.riceCount || 0;
      acc.flourCount += item.flourCount || 0;
      acc.oilCount += item.oilCount || 0;
      acc.vegetableCount += item.vegetableCount || 0;
      return acc;
    }, emptyMaterialTotals());
    todayMaterialTotals = rows
      .filter((item) => item.dateString === today)
      .reduce((acc, item) => {
        acc.riceCount += item.riceCount || 0;
        acc.flourCount += item.flourCount || 0;
        acc.oilCount += item.oilCount || 0;
        acc.vegetableCount += item.vegetableCount || 0;
        return acc;
      }, emptyMaterialTotals());
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
  }

  return {
    success: true,
    data: { today, mealTotals, todayMaterialTotals, monthMaterialTotals }
  };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event.action;

  switch (action) {
    case 'submit':
      return handleSubmit(event, OPENID);
    case 'myList':
      return handleMyList(event, OPENID);
    case 'listPending':
      return handleListPending(event, OPENID);
    case 'approve':
      return handleApprove(event, OPENID);
    case 'reject':
      return handleReject(event, OPENID);
    case 'deleteMine':
      return handleDeleteMine(event, OPENID);
    case 'revokeMine':
      return handleRevokeMine(event, OPENID);
    case 'statsSummary':
      return handleStatsSummary(event, OPENID);
    default:
      return { success: false, error: '未知操作' };
  }
};
