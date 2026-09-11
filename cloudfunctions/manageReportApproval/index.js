// 云函数：manageReportApproval - 餐报审批状态机唯一服务端入口
//
// 🛡️ 背景：此前"店长核对确认(APPROVED)/财务稽核封账(AUDITED_LOCKED)/解封(UNLOCK)/
// 作废(isVoid)"这四个状态流转，全部由小程序端直接调用 `wx.cloud.database()
// .collection('report_logs').doc(id).update(...)` 完成，没有经过任何云函数。
// 这意味着真正的权限判定只停留在客户端 JS（this.data.isManagerRole / isFinanceRole /
// isSuperAdmin），而客户端角色标记是可以被绕过/伪造的（例如直接在开发者工具里对同一个
// 小程序会话调用 wx.cloud.database() API），实际生效的唯一防线是数据库集合的安全规则
// （通常是"仅创建者可读写"一类的宽松规则）——也就是说，提交这条记录的义工本人理论上
// 可以直接把自己提交的记录改成 approvalStatus: 'AUDITED_LOCKED'，绕开店长核对与财务
// 稽核两道关卡；而 onUnlockRecord 甚至连客户端角色判断都没有。
//
// 本函数把这四个状态流转收拢到服务端，做到：
// - 角色互斥：提交人本人不能自我核对确认/自我稽核封账/自我解封（职责分离）；
// - 租户/门店边界：与本项目其余云函数一致的 tenantId/storeId 校验；
// - 状态机闭环：任何一步都严格校验"当前状态是否允许该操作"，不允许跳跃或逆流转；
// - 审计留痕：每次状态变更都在同一事务内写入 report_audit_logs。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
// 🛡️（2026-09-11 巡检漫游审计日志·方向3）与 manageStoreProfile/lib/、
// getPatriarchDashboard/lib/ 下的同名文件是三处独立维护的镜像，见该文件
// 头部注释
const { buildAuditLogEntry, isRoamingConsumed } = require('./lib/buildAuditLogEntry');
// 🐛🛡️（2026-09-11 过期校验 drift 修复）此前本文件的 resolveCaller 是
// 2026-09-10 那轮真实故障修复"之前"的旧版本拷贝——完全没有 isGrantStillValid
// 过期校验，一条已经超过 2 小时有效期的巡检授权在这里仍会被判定为有效，
// 是一个真实存在过的越权窗口。现在改为直接复用 manageStoreProfile/lib/
// resolveCaller.js 的同一份镜像（含过期校验 + storeId 直接匹配，不再需要
// 反查 stores.tenantId 这一步），配套单测见 lib/resolveCaller.test.js——
// 与 manageStoreProfile/lib/resolveCaller.test.js 逐条对应的同一份回归矩阵
const { resolveEffectiveCaller } = require('./lib/resolveCaller');

// 🐛 云函数容器时区固定为 UTC，new Date().toLocaleString() 不传 timeZone 会
// 直接按 UTC 渲染，导致 approveTime/auditTime 等落库的审批时间字符串比北京
// 时间少 8 小时
function formatBeijingTimeString(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(date instanceof Date ? date : new Date(date));
}

// 🛡️（2026-09-09 方案三：authorizedTenants 轻量租户漫游，见
// docs/architecture/02_user_roles_single_document_invariant.md）
// opts 完全可选，不传（或命中不了任何授权）时返回值与改造前逐字节一致，
// 全仓库其余调用点（未传 opts 的那些）100% 向后兼容。opts.targetStoreId
// 命中某条 authorizedTenants 授权时，返回的"有效身份"把 tenantId/role/
// storeId 原地替换成该条授权里的值——下游代码（本文件的 getMeritStats
// 角色分支、manageStoreProfile 的 resolveReadTarget/resolveWriteTarget）
// 不需要感知"这是不是漫游身份"，只要把替换后的 caller 当成一个真实绑定了
// 该门店的对应角色来用即可，不必逐一改造下游的权限判断代码。决策逻辑
// 全部在 lib/resolveCaller.js，这里只负责把数据库查出来的 own 文档喂给它
async function resolveCaller(OPENID, opts) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  const own = (roleRes.data && roleRes.data[0]) || null;
  const targetStoreId = opts && (opts.targetStoreId || opts.storeId);
  const effectiveCaller = resolveEffectiveCaller(own, targetStoreId);

  // 🛡️（2026-09-11 巡检漫游审计日志）只在真的发生了漫游身份替换时才写一条
  // 留痕；写入失败不阻断真正的审批业务操作，最大努力记录
  if (isRoamingConsumed(own, effectiveCaller)) {
    // 🐛（2026-09-11 根因修复）targetStoreName 不能从 effectiveCaller.storeName
    // 读——它仍是调用者自己的本来名称（platform_admin 是"全国总览"），见
    // lib/buildAuditLogEntry.js 头部注释与配套回归单测。这里额外查一次真实
    // 门店名称
    const targetStoreNameRes = await db.collection('stores').doc(targetStoreId).field({ storeName: true }).get().catch(() => null);
    const targetStoreName = (targetStoreNameRes && targetStoreNameRes.data && targetStoreNameRes.data.storeName) || '';
    const logEntry = buildAuditLogEntry({
      operatorOpenId: OPENID,
      own,
      effectiveCaller,
      targetStoreId,
      targetStoreName,
      cloudFunctionName: 'manageReportApproval',
      action: opts && opts.action
    });
    if (logEntry) {
      await db.collection('tenant_authorization_audit_logs').add({
        data: { ...logEntry, createTime: db.serverDate() }
      }).catch((err) => console.warn('[manageReportApproval] 巡检审计日志写入失败:', err));
    }
  }

  return effectiveCaller;
}

// 🏛️ 家长风控锁：门店是否绑定了家长/督导——绑定了才需要走"店长发起、家长/超管确认"
// 的挂起流程；未绑定家长的门店，行为与升级前完全一致（店长直接生效）
async function hasBoundPatriarch(storeId) {
  if (!storeId) return false;
  const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
  const store = storeRes && storeRes.data;
  return !!(store && store.patriarchOpenId);
}

// 职责分离版本的门店/机构归属校验：与 checkCanEdit 不同，这里【不】自动放行"提交人本人"，
// 核对确认/稽核封账/解封/作废这四个动作本质是"审批别人提交的东西"，提交人不能自证自批。
//
// 🛡️ 多租户越权修复：super_admin 的越权兜底权限严格收敛到"caller 与 doc 的 tenantId
// 都存在且相等"，不能只要角色是 super_admin 就无条件放行。此前的写法在 caller.tenantId
// 或 doc.tenantId 任一侧缺失时（早期通过 setupSuperAdmin 引导创建的账号可能没有
// tenantId，见 createStore.js resolveCallerTenantId 同类场景；或历史存量记录尚未
// 回填 tenantId）会直接跳过租户比对、无条件放行，等于一个尚未回填 tenantId 的
// super_admin 账号可以绕开租户边界审批任意机构的 report_logs 记录。与
// deleteMealReport 头部注释里"多租户改造迁移样板"（super_admin 管辖收敛为同一
// tenantId 下所有门店，不是全局跨租户）同一套安全口径对齐；tenantId 尚未回填时
// 宁可拒绝也不放行，与本仓库一贯的 fail-closed 原则一致。
function isSameScope(caller, doc) {
  if (!caller) return false;
  if (caller.tenantId && doc.tenantId && caller.tenantId !== doc.tenantId) return false;
  if (caller.role === 'super_admin' && caller.tenantId && doc.tenantId && caller.tenantId === doc.tenantId) return true;
  return !!((caller.storeId && doc.storeId && caller.storeId === doc.storeId)
    || (caller.storeName && doc.shopName && caller.storeName === doc.shopName));
}

const ACTION_RULES = {
  // 店长核对确认：PENDING(未确认) -> APPROVED
  confirm: {
    // 🏛️ 权限向下继承：大家长天然拥有店长的全套日常管理权限
    allowedRoles: ['store_manager', 'store_patriarch', 'super_admin'],
    roleErrMsg: '无权限：仅店长与超级管理员可执行核对确认',
    check(doc) {
      if (doc.approvalStatus === 'APPROVED') return '店长已完成该餐报的核对确认';
      if (doc.approvalStatus === 'AUDITED_LOCKED') return '该账本已封账，无法操作';
      if (doc.isVoid) return '该记录已作废，无法操作';
      return null;
    },
    apply() {
      return {
        isManagerConfirmed: true,
        managerConfirmedAt: db.serverDate(),
        approvalStatus: 'APPROVED',
        approveTime: formatBeijingTimeString(new Date())
      };
    }
  },
  // 财务稽核封账：APPROVED -> AUDITED_LOCKED
  financeAudit: {
    // 🏛️ 权限向下继承：大家长天然拥有财务的全套日常管理权限
    allowedRoles: ['finance', 'store_patriarch', 'super_admin'],
    roleErrMsg: '无权限：仅财务与超级管理员可执行稽核封账',
    check(doc) {
      if (doc.approvalStatus === 'AUDITED_LOCKED') return '该账本已由财务完成稽核锁定，无法篡改';
      if (doc.approvalStatus !== 'APPROVED') return '请先等待店长完成首轮确认';
      if (doc.isVoid) return '该记录已作废，无法操作';
      return null;
    },
    apply() {
      const nowStr = formatBeijingTimeString(new Date());
      return {
        isFinanceAudited: true,
        financeAuditedAt: db.serverDate(),
        isLocked: true,
        approvalStatus: 'AUDITED_LOCKED',
        auditTime: nowStr,
        auditLogs: db.command.push({ action: 'AUDIT_LOCK', timestamp: nowStr })
      };
    }
  },
  // 财务解封：AUDITED_LOCKED -> APPROVED（必须填写理由）
  unlock: {
    // 🏛️ 权限向下继承：大家长天然拥有财务的全套日常管理权限
    allowedRoles: ['finance', 'store_patriarch', 'super_admin'],
    roleErrMsg: '无权限：仅财务与超级管理员可执行解封',
    requireReason: true,
    check(doc) {
      if (doc.approvalStatus !== 'AUDITED_LOCKED') return '该记录当前未处于封账锁定状态，无需解封';
      return null;
    },
    apply(_doc, reason) {
      const nowStr = formatBeijingTimeString(new Date());
      return {
        isLocked: false,
        approvalStatus: 'APPROVED',
        isFinanceAudited: false,
        auditLogs: db.command.push({ action: 'UNLOCK', timestamp: nowStr, reason })
      };
    }
  },
  // 作废（红字冲销）：任何未锁定/未作废状态 -> isVoid=true
  void: {
    // 🏛️ 权限向下继承：大家长天然拥有店长的全套日常管理权限
    allowedRoles: ['store_manager', 'store_patriarch', 'super_admin'],
    roleErrMsg: '无权限：仅店长与超级管理员可执行作废操作',
    check(doc) {
      if (doc.isVoid) return '该记录已作废，无需重复操作';
      if (doc.voidPending) return '该记录已提交过作废申请，正在等待家长/超管确认，请勿重复提交';
      if (doc.approvalStatus === 'AUDITED_LOCKED') return '该账本已封账锁定，无法作废，请先解封';
      return null;
    },
    apply() {
      return {
        isVoid: true,
        voidedAt: db.serverDate()
      };
    }
  },
  // 财务对单：标记小票凭证已与账目金额核对一致，不涉及金额/状态变更，可反复切换
  reconcile: {
    // 🏛️ 权限向下继承：大家长天然拥有财务的全套日常管理权限
    allowedRoles: ['finance', 'store_patriarch', 'super_admin'],
    roleErrMsg: '无权限：仅财务与超级管理员可标记对单',
    check() {
      return null;
    },
    apply(doc) {
      const next = !doc.financeReconciled;
      return {
        financeReconciled: next,
        financeReconciledAt: next ? db.serverDate() : null,
        _nextReconciled: next
      };
    }
  }
};

// 🏛️ 待家长/超管确认的作废请求：审批（真正生效）或驳回（仅清除挂起标记）。
// 与 ACTION_RULES 状态机分开处理——这两个动作操作的是 voidPending 挂起标记，
// 不是 approvalStatus 状态机本身
async function handlePendingVoidDecision(action, docId, OPENID) {
  const caller = await resolveCaller(OPENID);
  if (!caller || (caller.role !== 'store_patriarch' && caller.role !== 'super_admin')) {
    return { success: false, errMsg: '无权限：仅家长或超级管理员可确认作废申请' };
  }

  const docRes = await db.collection('report_logs').doc(docId).get().catch(() => null);
  const docData = docRes && docRes.data;
  if (!docData) {
    return { success: false, errMsg: '记录不存在' };
  }
  if (!isSameScope(caller, docData)) {
    return { success: false, errMsg: '无权限：不能审批其他门店/机构的记录' };
  }
  if (!docData.voidPending) {
    return { success: false, errMsg: '该记录当前没有待确认的作废申请' };
  }

  if (action === 'rejectPendingVoid') {
    await db.collection('report_logs').doc(docId).update({
      data: { voidPending: false, voidRequestedBy: db.command.remove(), voidRequestedAt: db.command.remove() }
    });
    return { success: true, message: '已驳回作废申请，记录保持原状' };
  }

  // approvePendingVoid：真正执行原 void 规则的效果，并清掉挂起标记
  const transaction = await db.startTransaction();
  try {
    await transaction.collection('report_logs').doc(docId).update({
      data: {
        isVoid: true,
        voidedAt: db.serverDate(),
        voidPending: false,
        voidApprovedBy: OPENID,
        updateTime: db.serverDate()
      }
    });
    await transaction.collection('report_audit_logs').add({
      data: {
        operator_id: OPENID,
        operator_role: caller.role,
        operate_time: db.serverDate(),
        action: 'approval_void_confirmed',
        target_collection: 'report_logs',
        target_id: docId,
        target_date: docData.dateString,
        target_store: docData.shopName,
        old_value: { approvalStatus: docData.approvalStatus, isLocked: docData.isLocked, isVoid: docData.isVoid, voidPending: docData.voidPending },
        reason: ''
      }
    });
    await transaction.commit();
  } catch (txErr) {
    await transaction.rollback();
    throw txErr;
  }

  let cascadeUpdatedCount = 0;
  let cascadeWarning = '';
  if (docData.approvalStatus === 'APPROVED') {
    try {
      const cascadeRes = await cloud.callFunction({
        name: 'cascadeRecalculator',
        data: {
          action: 'recalculate_after_delete',
          shopName: docData.shopName,
          storeId: docData.storeId,
          dateString: docData.dateString
        }
      });
      const cascadeResult = cascadeRes.result || {};
      if (!cascadeResult.success) {
        cascadeWarning = '作废已成功，但后续日期的结余流水自动重算未完成，请手动执行【一键校准】';
      } else {
        cascadeUpdatedCount = cascadeResult.updatedCount || 0;
      }
    } catch (cascadeErr) {
      console.error('[manageReportApproval] 确认作废后级联重算调用失败:', cascadeErr);
      cascadeWarning = '作废已成功，但后续日期的结余流水自动重算未完成，请手动执行【一键校准】';
    }
  }

  return { success: true, message: '已确认作废', cascadeUpdatedCount, cascadeWarning };
}

exports.main = async (event) => {
  const { action, docId, reason } = event;
  const { OPENID } = cloud.getWXContext();

  if (!OPENID) {
    return { success: false, errMsg: '无法获取用户身份' };
  }

  if (action === 'approvePendingVoid' || action === 'rejectPendingVoid') {
    if (!docId) return { success: false, errMsg: '缺少 docId 参数' };
    try {
      return await handlePendingVoidDecision(action, docId, OPENID);
    } catch (err) {
      console.error('[manageReportApproval] 确认/驳回作废申请异常:', err);
      return { success: false, errMsg: err.message || '操作失败' };
    }
  }

  // 🛡️ 根因修复（-502003 database permission denied）：profile.ts 的"荣誉墙"
  // 统计（登记餐报数/已稽核账本数）此前由前端 wx.cloud.database() 直查
  // report_logs——该集合的安全规则只认"是否是文档所有者"，财务/店长查询店内
  // 其他人提交的记录必然被拒绝，与角色是否有权限无关，只是此前查询失败被内层
  // try/catch 吞掉、静默归零，没有报错弹出来。改为服务端聚合，角色也不再信任
  // 客户端传入的 role 参数，一律以 resolveCaller 反查的真实角色为准。
  if (action === 'getMeritStats') {
    const { storeId } = event;
    if (!storeId) return { success: false, errMsg: '缺少 storeId 参数' };
    try {
      // 🛡️ 传 targetStoreId：命中 authorizedTenants 授权时，resolveCaller 会把
      // 下面这个 caller 对象原地换成"对这家门店而言的有效身份"（见该函数头部
      // 注释），下面的 super_admin/else 分支完全不用改——漫游后 caller.role
      // 变成被授权的角色（如 store_patriarch），caller.storeId 变成 storeId，
      // 自然落进 else 分支的 `caller.storeId === storeId` 判断里
      const caller = await resolveCaller(OPENID, { targetStoreId: storeId, action: 'getMeritStats' });
      if (!caller) return { success: false, errMsg: '无法确认您的角色信息' };

      // 门店/机构边界：与 manageFinanceLock 的 checkRangeStatus 同一套校验口径——
      // 非超管一律要求 caller.storeId 与目标 storeId 严格相等；super_admin 允许
      // 查看本机构内任意门店，但必须验证目标门店确实属于自己的 tenantId
      if (caller.role === 'super_admin') {
        const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
        const store = storeRes && storeRes.data;
        if (!store) return { success: false, errMsg: '目标门店不存在' };
        if (!caller.tenantId || !store.tenantId || caller.tenantId !== store.tenantId) {
          return { success: false, errMsg: '无权限：目标门店不属于您所在的机构' };
        }
      } else if (!caller.storeId || caller.storeId !== storeId) {
        return { success: false, errMsg: '无权限：只能查看本店统计' };
      }

      const tenantId = caller.tenantId || '';
      let submittedCount = 0;
      let auditedCount = 0;

      if (tenantId) {
        // 🏛️ 权限向下继承：大家长同样可能承担日常提交/稽核工作，统计口径一并覆盖，
        // 与 profile.ts 原有的角色分支完全一致，只是查询挪到了服务端
        if (['store_manager', 'store_patriarch', 'super_admin'].includes(caller.role)) {
          const subRes = await db.collection('report_logs').where({ tenantId, storeId, _openid: OPENID }).count();
          submittedCount = subRes.total || 0;
        }
        // 🐛 统计口径修正：原前端实现用 auditedBy:exists(true) 判断"已稽核"，但
        // financeAudit（本文件 ACTION_RULES，单条稽核）从未写过 auditedBy 字段，
        // 只有 manageFinanceLock 的批量封账才写，会漏计单条稽核的记录。改用
        // approvalStatus === 'AUDITED_LOCKED'，两条稽核路径都能正确覆盖，与
        // manageFinanceLock.checkRangeStatus/getStatisticsData 的稽核口径一致
        if (['finance', 'store_patriarch', 'super_admin'].includes(caller.role)) {
          const audRes = await db.collection('report_logs').where({ tenantId, storeId, approvalStatus: 'AUDITED_LOCKED' }).count();
          auditedCount = audRes.total || 0;
        }
      }

      return { success: true, submittedCount, auditedCount };
    } catch (err) {
      console.error('[manageReportApproval] getMeritStats 异常:', err);
      return { success: false, errMsg: err.message || '查询失败' };
    }
  }

  const rule = ACTION_RULES[action];
  if (!rule) {
    return { success: false, errMsg: `不支持的 action: ${action}` };
  }
  if (!docId) {
    return { success: false, errMsg: '缺少 docId 参数' };
  }
  if (rule.requireReason && (!reason || !String(reason).trim())) {
    return { success: false, errMsg: '请填写操作原因（存证备查）' };
  }

  try {
    const caller = await resolveCaller(OPENID);
    if (!caller || !rule.allowedRoles.includes(caller.role)) {
      return { success: false, errMsg: rule.roleErrMsg };
    }

    const docRes = await db.collection('report_logs').doc(docId).get().catch(() => null);
    const docData = docRes && docRes.data;
    if (!docData) {
      return { success: false, errMsg: '记录不存在' };
    }

    // 🛡️ 职责分离：审批类动作不因"提交人本人"而自动放行，必须落在调用者自己的
    // 门店/机构范围内，且角色在 ACTION_RULES.allowedRoles 名单内
    if (!isSameScope(caller, docData)) {
      return { success: false, errMsg: '无权限：不能审批其他门店/机构的记录' };
    }

    // 🛡️ 职责分离真正的强制执行点：此前本文件顶部注释一直声称"提交人本人不能自我核对
    // 确认/自我稽核封账/自我解封"，但主流程从未真正比对过 docData._openid 与调用者
    // OPENID——一个同时是提交人、又持有 store_manager/finance/store_patriarch 角色
    // 的账号，此前完全可以对自己提交的记录执行 confirm/financeAudit/unlock，等同于
    // 自我审批，注释描述的安全边界形同虚设。void/reconcile 不受影响（作废自己提交的
    // 错误记录、财务给自己提交的记录标记"小票已核对"均不涉及职责分离要保护的场景）
    const SELF_ACTION_BLOCKED_ACTIONS = ['confirm', 'financeAudit', 'unlock'];
    if (SELF_ACTION_BLOCKED_ACTIONS.includes(action) && docData._openid === OPENID) {
      return { success: false, errMsg: '职责分离：不能对自己提交的记录执行审批操作，请由同店其他店长/财务/家长处理' };
    }

    const stateErr = rule.check(docData);
    if (stateErr) {
      return { success: false, errMsg: stateErr };
    }

    // 🏛️ 家长风控锁：店长发起作废时，若本店已绑定家长/督导，不直接生效，改为挂起
    // 待确认；super_admin 发起或门店未绑定家长时，行为与升级前完全一致（直接生效）
    if (action === 'void' && caller.role === 'store_manager' && await hasBoundPatriarch(docData.storeId)) {
      await db.collection('report_logs').doc(docId).update({
        data: {
          voidPending: true,
          voidRequestedBy: OPENID,
          voidRequestedAt: db.serverDate()
        }
      });
      return { success: true, pending: true, errMsg: '', message: '已提交家长/超管审批，确认后生效' };
    }

    const rawPatch = rule.apply(docData, reason ? String(reason).trim() : '');
    // _nextReconciled 只是给下面的响应体用的普通布尔值，不是要写库的字段，拆出来单独处理
    const { _nextReconciled, ...patch } = rawPatch;
    const operatorRoleLabel = {
      store_manager: '店长',
      finance: '财务稽核员',
      store_patriarch: '大家长',
      super_admin: '超级管理员'
    }[caller.role] || caller.role;
    // 沿用各字段此前在直连写库时代已使用的命名，避免破坏既有展示逻辑
    const byFieldName = { reconcile: 'financeReconciledBy' }[action] || `${action}By`;

    const transaction = await db.startTransaction();
    try {
      await transaction.collection('report_logs').doc(docId).update({
        data: {
          ...patch,
          [byFieldName]: patch.financeReconciled === false ? '' : operatorRoleLabel,
          updateTime: db.serverDate()
        }
      });

      await transaction.collection('report_audit_logs').add({
        data: {
          operator_id: OPENID,
          operator_role: caller.role,
          operate_time: db.serverDate(),
          action: `approval_${action}`,
          target_collection: 'report_logs',
          target_id: docId,
          target_date: docData.dateString,
          target_store: docData.shopName,
          old_value: { approvalStatus: docData.approvalStatus, isLocked: docData.isLocked, isVoid: docData.isVoid },
          reason: reason ? String(reason).trim() : ''
        }
      });

      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    // 作废且原记录已通过店长核对（已计入正式流水链）时，触发级联重算，
    // 保证被排除的这一笔不再影响此后每一天的开账余额（与 deleteMealReport 的做法一致）
    let cascadeUpdatedCount = 0;
    let cascadeWarning = '';
    if (action === 'void' && docData.approvalStatus === 'APPROVED') {
      try {
        const cascadeRes = await cloud.callFunction({
          name: 'cascadeRecalculator',
          data: {
            action: 'recalculate_after_delete',
            shopName: docData.shopName,
            storeId: docData.storeId,
            dateString: docData.dateString
          }
        });
        const cascadeResult = cascadeRes.result || {};
        if (!cascadeResult.success) {
          cascadeWarning = '作废已成功，但后续日期的结余流水自动重算未完成，请手动执行【一键校准】';
        } else {
          cascadeUpdatedCount = cascadeResult.updatedCount || 0;
        }
      } catch (cascadeErr) {
        console.error('[manageReportApproval] 作废后级联重算调用失败:', cascadeErr);
        cascadeWarning = '作废已成功，但后续日期的结余流水自动重算未完成，请手动执行【一键校准】';
      }
    }

    return {
      success: true,
      action,
      cascadeUpdatedCount,
      cascadeWarning,
      financeReconciled: action === 'reconcile' ? _nextReconciled : undefined
    };
  } catch (err) {
    console.error('[manageReportApproval] 异常:', err);
    return { success: false, errMsg: err.message || '操作失败' };
  }
};
