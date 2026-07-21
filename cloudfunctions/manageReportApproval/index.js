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

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

// 职责分离版本的门店/机构归属校验：与 checkCanEdit 不同，这里【不】自动放行"提交人本人"，
// 核对确认/稽核封账/解封/作废这四个动作本质是"审批别人提交的东西"，提交人不能自证自批。
function isSameScope(caller, doc) {
  if (!caller) return false;
  if (caller.tenantId && doc.tenantId && caller.tenantId !== doc.tenantId) return false;
  if (caller.role === 'super_admin') return true;
  return !!((caller.storeId && doc.storeId && caller.storeId === doc.storeId)
    || (caller.storeName && doc.shopName && caller.storeName === doc.shopName));
}

const ACTION_RULES = {
  // 店长核对确认：PENDING(未确认) -> APPROVED
  confirm: {
    allowedRoles: ['store_manager', 'super_admin'],
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
        approveTime: new Date().toLocaleString()
      };
    }
  },
  // 财务稽核封账：APPROVED -> AUDITED_LOCKED
  financeAudit: {
    allowedRoles: ['finance', 'super_admin'],
    roleErrMsg: '无权限：仅财务与超级管理员可执行稽核封账',
    check(doc) {
      if (doc.approvalStatus === 'AUDITED_LOCKED') return '该账本已由财务完成稽核锁定，无法篡改';
      if (doc.approvalStatus !== 'APPROVED') return '请先等待店长完成首轮确认';
      if (doc.isVoid) return '该记录已作废，无法操作';
      return null;
    },
    apply() {
      const nowStr = new Date().toLocaleString();
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
    allowedRoles: ['finance', 'super_admin'],
    roleErrMsg: '无权限：仅财务与超级管理员可执行解封',
    requireReason: true,
    check(doc) {
      if (doc.approvalStatus !== 'AUDITED_LOCKED') return '该记录当前未处于封账锁定状态，无需解封';
      return null;
    },
    apply(_doc, reason) {
      const nowStr = new Date().toLocaleString();
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
    allowedRoles: ['store_manager', 'super_admin'],
    roleErrMsg: '无权限：仅店长与超级管理员可执行作废操作',
    check(doc) {
      if (doc.isVoid) return '该记录已作废，无需重复操作';
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
    allowedRoles: ['finance', 'super_admin'],
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

exports.main = async (event) => {
  const { action, docId, reason } = event;
  const { OPENID } = cloud.getWXContext();

  if (!OPENID) {
    return { success: false, errMsg: '无法获取用户身份' };
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

    const stateErr = rule.check(docData);
    if (stateErr) {
      return { success: false, errMsg: stateErr };
    }

    const rawPatch = rule.apply(docData, reason ? String(reason).trim() : '');
    // _nextReconciled 只是给下面的响应体用的普通布尔值，不是要写库的字段，拆出来单独处理
    const { _nextReconciled, ...patch } = rawPatch;
    const operatorRoleLabel = {
      store_manager: '店长',
      finance: '财务稽核员',
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
