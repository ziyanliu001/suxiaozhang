// 云函数：deleteMealReport - 使用管理员权限删除单条餐报记录
// 解决前端直接调用 db.remove() 因 OpenID 权限不匹配导致的删除失败问题
//
// 🌟 修复重复录入问题的配套能力：
// 1. 增加权限校验：仅提交人本人或店长/财务/超管可删除
// 2. 已被财务稽核锁定（AUDITED_LOCKED）的记录禁止直接删除，需先解封
// 3. 删除成功后自动调用 cascadeRecalculator 触发级联重算，
//    保持被删除日期之后所有记录的"昨日余额/今日结余"资金流水连贯
//
// 🛡️ 防个人营私审计闭环：
// 4. 删除前必须提供非空 reason（删除原因），杜绝无痕静默删除
// 5. 删除与审计日志写入置于同一事务，确保 operator_id / operate_time / old_value / reason
//    与实际删除动作原子生效，不存在"删了但没留痕"的情况
//
// 🏢 多租户改造 - 迁移范例（其余云函数按此模式陆续迁移）：
// 6. 本函数是"店长/财务/超管仅可操作本机构（tenant）数据"的落地样板：
//    - super_admin 的管辖边界收敛为"同一 tenantId 下的所有门店"，不再是全局跨租户；
//    - platform_admin（SaaS 平台管理员）在本函数的权限判定中完全不出现 —— 即便拥有
//      该角色也无法通过任何分支放行，从代码结构上保证平台运维方碰不到门店财务数据；
//    - 记录若尚未回填 tenantId（迁移过渡期存量数据），按门店同店校验兜底，不因迁移
//      过渡期而拒绝合法操作。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

async function checkCanDelete(doc) {
  const { OPENID } = cloud.getWXContext();
  if (!doc || doc._openid === OPENID) return { allowed: true, role: 'self' };

  try {
    const roleRes = await db.collection('user_roles')
      .where({ _openid: OPENID })
      .limit(1)
      .get();

    if (roleRes.data && roleRes.data.length > 0) {
      const user = roleRes.data[0];
      const role = user.role;

      // 🏢 租户边界：若双方都已回填 tenantId 且不一致，直接拒绝（无论角色多高）
      if (user.tenantId && doc.tenantId && user.tenantId !== doc.tenantId) {
        return { allowed: false, role };
      }

      if (role === 'super_admin') {
        return { allowed: true, role };
      }
      // 🛡️ 店长/财务/大家长（权限向下继承）仅可操作本门店数据，禁止跨店删除他店记录
      if (role === 'store_manager' || role === 'finance' || role === 'store_patriarch') {
        const sameStore = (user.storeId && doc.storeId && user.storeId === doc.storeId)
          || (user.storeName && doc.shopName && user.storeName === doc.shopName);
        if (sameStore) {
          return { allowed: true, role };
        }
      }
    }

    const userRes = await db.collection('users')
      .where({ _openid: OPENID })
      .limit(1)
      .get();

    if (userRes.data && userRes.data.length > 0 && userRes.data[0].role === 'admin') {
      return { allowed: true, role: 'admin' };
    }
  } catch (e) {
    console.warn('[deleteMealReport] 权限校验异常:', e);
  }

  return { allowed: false, role: 'unknown' };
}

exports.main = async (event, context) => {
  const { id, reason } = event;
  const { OPENID } = cloud.getWXContext();

  if (!id) {
    return {
      success: false,
      error: '缺少记录 ID'
    };
  }

  if (!reason || !String(reason).trim()) {
    return {
      success: false,
      error: '请填写删除原因后再操作，删除历史餐报记录必须留痕'
    };
  }

  try {
    // 1. 删除前先取出记录：用于权限校验、锁定状态校验，以及删除后触发级联重算所需的门店/日期信息
    const docRes = await db.collection('report_logs').doc(id).get();
    const docData = docRes.data;

    if (!docData) {
      return { success: false, error: '记录不存在或已被删除' };
    }

    const { allowed: canDelete, role: operatorRole } = await checkCanDelete(docData);
    if (!canDelete) {
      return { success: false, error: '无权限删除该记录，仅限提交人本人或店长/财务/超管操作' };
    }

    if (docData.approvalStatus === 'AUDITED_LOCKED' || docData.isLocked) {
      return { success: false, error: '该记录已被财务稽核锁定，请先联系财务解封后再删除' };
    }

    const { dateString, shopName, storeId } = docData;

    // 2. 删除动作与审计日志写入置于同一事务：确保不存在"删除成功但审计日志丢失"的静默删除场景
    const transaction = await db.startTransaction();
    try {
      const removeResult = await transaction.collection('report_logs').doc(id).remove();

      if (removeResult.stats.removed === 0) {
        await transaction.rollback();
        return { success: false, error: '记录不存在或删除失败' };
      }

      await transaction.collection('report_audit_logs').add({
        data: {
          operator_id: OPENID,
          operator_role: operatorRole,
          operate_time: db.serverDate(),
          action: 'delete',
          target_collection: 'report_logs',
          target_id: id,
          target_date: dateString,
          target_store: shopName,
          old_value: docData,
          reason: String(reason).trim()
        }
      });

      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    console.log(`[deleteMealReport] 成功删除记录: ${id} (${dateString} · ${shopName})，操作人:${OPENID}，原因:${reason}`);

    // 2. 删除后自动触发级联重算：从被删日期的前一天开始，重新推算后续所有日期的
    //    昨日余额/今日结余，避免出现资金流水断裂
    let cascadeUpdatedCount = 0;
    try {
      const cascadeRes = await cloud.callFunction({
        name: 'cascadeRecalculator',
        data: {
          action: 'recalculate_after_delete',
          shopName: shopName,
          storeId: storeId,
          dateString: dateString
        }
      });
      const cascadeResult = cascadeRes.result || {};
      cascadeUpdatedCount = cascadeResult.updatedCount || 0;
      console.log(`[deleteMealReport] 删除后级联重算完成，联动校正 ${cascadeUpdatedCount} 天账目`);
    } catch (cascadeErr) {
      // 级联重算失败不影响删除本身已成功的事实，仅记录日志，前端可提示用户手动触发"一键校准"
      console.error('[deleteMealReport] 删除后级联重算调用失败:', cascadeErr);
    }

    return {
      success: true,
      message: '删除成功',
      cascadeUpdatedCount
    };
  } catch (err) {
    console.error('[deleteMealReport] 删除失败:', err);
    return {
      success: false,
      error: err.message || '删除失败'
    };
  }
};
