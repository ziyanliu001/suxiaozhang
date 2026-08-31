const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 🛡️（2026-08-31 Open-Core 安全收口）fail-closed：与 cloudfunctions/wxPayCore 的
// WXPAY_INTERNAL_TOKEN 同一条原则——未配置真实密钥时不再静默回退到一个源码里
// 明文写死的默认值，直接拒绝执行签名操作。完整说明见 stampReportChecksum 同名
// 常量处的注释
const HMAC_SECRET = process.env.LEDGER_HMAC_SECRET || '';
if (!HMAC_SECRET) {
  console.error('[cascadeRecalculator] 🚨 LEDGER_HMAC_SECRET 环境变量未配置，本云函数拒绝执行任何签名/校验操作（fail-closed）。请立即在云开发控制台为本云函数配置真实密钥。');
}

function computeChecksum(item) {
  if (!HMAC_SECRET) {
    throw new Error('LEDGER_HMAC_SECRET 未配置，出于资金流水防篡改安全考虑，已拒绝执行级联重算，请联系管理员在云开发控制台配置该环境变量');
  }
  const yb = (parseFloat(item.yesterdayBalance || 0)).toFixed(2);
  const income = (parseFloat(item.listDonationTotal || 0) + parseFloat(item.otherDonation || 0)).toFixed(2);
  const expense = (parseFloat(item.dailyExpenseTotal || 0) + parseFloat(item.fixedExpenseTotal || 0)).toFixed(2);
  const tb = (parseFloat(item.todayBalance || 0)).toFixed(2);
  const dateString = item.dateString || '';
  const storeId = item.storeId || item.shopName || '';
  const payload = `${dateString}|${storeId}|${yb}|${income}|${expense}|${tb}`;
  return crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
}

// 校验单条记录的存量 _checksum 是否与当前存储的字段一致；无 _checksum（历史遗留记录）视为跳过，不判定为篡改
function verifyChecksum(item) {
  if (!item._checksum) return { checked: false, valid: true };
  const expected = computeChecksum(item);
  return { checked: true, valid: expected === item._checksum };
}

function getPrevDayIsoString(dateString) {
  const d = new Date(dateString);
  d.setDate(d.getDate() - 1);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function cleanStoreName(name) {
  return String(name || '').replace(/[区市省店\s]/g, '').trim();
}

function calculateTodayBalance(yesterdayBalance, income, expense) {
  const numYb = parseFloat(yesterdayBalance || 0);
  const numIncome = parseFloat(income || 0);
  const numExpense = parseFloat(expense || 0);
  return Math.round((numYb + numIncome - numExpense) * 100) / 100;
}

function calculateTotalIncome(item) {
  return parseFloat(item.listDonationTotal || 0) + parseFloat(item.otherDonation || 0);
}

function calculateTotalExpense(item) {
  return parseFloat(item.dailyExpenseTotal || 0) + parseFloat(item.fixedExpenseTotal || 0);
}

// 🏢 多租户：解析调用者所属机构，用于将"全部门店"之类的宽查询收敛到本机构范围内
async function resolveCallerTenant() {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { tenantId: '', role: '' };

  try {
    const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
    if (roleRes.data && roleRes.data.length > 0) {
      return { tenantId: roleRes.data[0].tenantId || '', role: roleRes.data[0].role || '' };
    }
  } catch (e) {
    console.warn('[cascadeRecalculator] 租户解析异常:', e);
  }
  return { tenantId: '', role: '' };
}

async function cascadeUpdateRecords(storeFilter, startDate, initialTodayBalance = null, callerTenantId = '') {
  // 🛡️ 紧急安全修复：此前 storeFilter 为空/'all' 时会直接跳过 shopName 过滤条件，
  // 且 callerTenantId 缺失时 tenantId 过滤条件同样被跳过 —— 两者叠加会导致查询退化为
  // "全库所有门店、所有机构"的记录都被拉出来当成同一条流水链联动重算，串联污染全部门店的
  // 结余数据。级联重算的本质是"单一门店的时间线"，绝不允许跨店/跨机构混算，故改为强制要求
  // 必须提供具体门店与可解析的租户，任何一项缺失都直接中断，不再静默降级为"全表扫描"。
  if (!storeFilter || storeFilter === 'all') {
    throw new Error('级联重算必须指定具体门店，不支持跨门店批量联动（严禁将全部门店合并为同一条流水链）');
  }
  if (!callerTenantId) {
    throw new Error('无法确认调用者所属机构，出于数据隔离安全考虑已拒绝执行级联重算');
  }

  const queryWhere = {
    dateString: _.gte(startDate),
    shopName: storeFilter,
    tenantId: callerTenantId,
    // 🛡️ 已作废（红字冲销）的记录不应再参与流水链计算，否则"作废"不会真正从
    // 后续每日余额中扣除其收支影响，等于作废操作在资金层面从未生效
    isVoid: _.neq(true)
  };

  const listRes = await db.collection('report_logs')
    .where(queryWhere)
    .orderBy('dateString', 'asc')
    .get();

  const records = listRes.data || [];
  console.log(`🔍 [级联重算] 查找到参与重算的记录共 ${records.length} 条，起始日期: ${startDate}`);

  // 🛡️ 篡改检测：在重算前，对链上每条记录核对存量 HMAC 校验码，
  // 若有人绕过小程序直接改库改动了某条中间记录，此处会被发现并锁定告警
  const integrityAlerts = [];
  records.forEach(item => {
    const { checked, valid } = verifyChecksum(item);
    if (checked && !valid) {
      integrityAlerts.push({ _id: item._id, dateString: item.dateString, shopName: item.shopName });
    }
  });

  if (integrityAlerts.length > 0) {
    console.error(`🚨 [级联重算] 检测到 ${integrityAlerts.length} 条记录的资金流水校验码不一致，疑似被直接改库篡改:`, integrityAlerts);
    await Promise.all(integrityAlerts.map(alert =>
      db.collection('report_logs').doc(alert._id).update({
        data: {
          isLocked: true,
          integrityAlert: true,
          integrityAlertAt: db.serverDate()
        }
      }).catch(e => console.error('锁定篡改记录失败:', alert._id, e))
    ));
  }

  if (records.length <= 1) {
    return { updatedCount: 0, records: records, integrityAlerts };
  }

  // 🛡️ 状态机闭环：财务已稽核封账（AUDITED_LOCKED）的日期，其昨日余额/今日结余属于
  // "永久归档、任何人无法再修改"的既定事实。若链上（从第 2 条起，第 1 条是本次编辑
  // 的起点本身，允许被改）出现已封账记录，绝不能静默把它的余额覆写掉——否则封账等于
  // 形同虚设。直接中止整条级联，要求调用方先解封目标记录后再重新发起。
  const lockedInChain = records.slice(1).filter(item => item.approvalStatus === 'AUDITED_LOCKED' || item.isLocked);
  if (lockedInChain.length > 0) {
    const err = new Error(
      `联动范围内存在 ${lockedInChain.length} 条已财务封账的记录（最早为 ${lockedInChain[0].dateString}），` +
      '为保证封账数据不可篡改，已中止本次级联重算，请先联系财务解封后再操作'
    );
    err.lockedRecords = lockedInChain.map(i => ({ _id: i._id, dateString: i.dateString }));
    throw err;
  }

  let lastCalculatedTodayBalance = initialTodayBalance;
  const updatePromises = [];

  for (let i = 0; i < records.length; i++) {
    const item = records[i];

    if (i === 0) {
      if (lastCalculatedTodayBalance === null) {
        lastCalculatedTodayBalance = parseFloat(item.todayBalance || 0);
      }
      continue;
    }

    const currentYesterdayBal = lastCalculatedTodayBalance;
    const itemIncome = calculateTotalIncome(item);
    const itemExpense = calculateTotalExpense(item);
    const currentTodayBal = Math.round((currentYesterdayBal + itemIncome - itemExpense) * 100) / 100;
    lastCalculatedTodayBalance = currentTodayBal;

    const newChecksum = computeChecksum({
      ...item,
      yesterdayBalance: currentYesterdayBal,
      todayBalance: currentTodayBal
    });

    updatePromises.push(
      db.collection('report_logs').doc(item._id).update({
        data: {
          yesterdayBalance: currentYesterdayBal,
          todayBalance: currentTodayBal,
          _checksum: newChecksum,
          lastCascadeCalculatedAt: db.serverDate()
        }
      })
    );

    console.log(`✏️ [级联重算] 校正 [${item.dateString}]: 昨日 ${currentYesterdayBal} ➔ 收入 ${itemIncome} ➔ 支出 ${itemExpense} ➔ 结余 ${currentTodayBal}`);
  }

  if (updatePromises.length > 0) {
    await Promise.all(updatePromises);
  }

  return {
    updatedCount: updatePromises.length + (initialTodayBalance !== null ? 1 : 0),
    records: records,
    integrityAlerts
  };
}

exports.main = async (event, context) => {
  const { action, docId, updateData, storeId, shopName, modifiedDate, dateString } = event;

  const storeFilter = shopName || storeId;
  const targetDate = dateString || modifiedDate;

  if (!action || !targetDate) {
    return { success: false, errMsg: '缺失必要的 action 或 dateString/modifiedDate 参数' };
  }

  console.log(`🚀 [cascadeRecalculator] 接收到请求: action=${action}, storeFilter=${storeFilter}, targetDate=${targetDate}`);

  const { tenantId: callerTenantId } = await resolveCallerTenant();

  try {
    switch (action) {
      case 'update_and_recalculate': {
        if (!docId) {
          return { success: false, errMsg: 'update_and_recalculate 模式需要 docId 参数' };
        }

        // 🏢 多租户边界：目标记录若已回填 tenantId，必须与调用者一致，防止跨机构改动他人资金流水
        const targetDoc = await db.collection('report_logs').doc(docId).get().catch(() => null);
        if (targetDoc && targetDoc.data && callerTenantId && targetDoc.data.tenantId && targetDoc.data.tenantId !== callerTenantId) {
          return { success: false, errMsg: '无权限：目标记录不属于您所在的机构' };
        }

        let updatedTodayBal = null;

        if (updateData) {
          const numYesterdayBal = parseFloat(updateData.yesterdayBalance || 0);
          const numIncome = parseFloat(updateData.listDonationTotal || 0) + parseFloat(updateData.otherDonation || 0);
          const numExpense = parseFloat(updateData.dailyExpenseTotal || 0) + parseFloat(updateData.fixedExpenseTotal || 0);
          updatedTodayBal = calculateTodayBalance(numYesterdayBal, numIncome, numExpense);

          const updateFields = { ...updateData };
          updateFields.todayBalance = updatedTodayBal;
          updateFields.lastCascadeCalculatedAt = db.serverDate();
          updateFields._checksum = computeChecksum({
            ...updateData,
            dateString: targetDate,
            storeId: storeFilter,
            todayBalance: updatedTodayBal
          });

          await db.collection('report_logs').doc(docId).update({
            data: updateFields
          });

          console.log(`✅ [update_and_recalculate] Step 1 - 已更新起始记录 ${targetDate}, 今日结余: ${updatedTodayBal}`);
        }

        const result = await cascadeUpdateRecords(storeFilter, targetDate, updatedTodayBal, callerTenantId);

        return {
          success: true,
          updatedCount: result.updatedCount || 1,
          message: `成功联动校正了包含 ${targetDate} 在内的 ${result.updatedCount || 1} 天账目`,
          integrityAlerts: result.integrityAlerts || []
        };
      }

      case 'recalculate_only': {
        const result = await cascadeUpdateRecords(storeFilter, targetDate, null, callerTenantId);

        return {
          success: true,
          updatedCount: result.updatedCount,
          message: `成功联动校正了后续 ${result.updatedCount} 天的账目数据`,
          integrityAlerts: result.integrityAlerts || []
        };
      }

      case 'recalculate_after_delete': {
        const prevDate = getPrevDayIsoString(targetDate);
        console.log(`⚠️ [recalculate_after_delete] 删除日期 ${targetDate}，从 ${prevDate} 开始重算`);

        const result = await cascadeUpdateRecords(storeFilter, prevDate, null, callerTenantId);

        return {
          success: true,
          updatedCount: result.updatedCount,
          message: `删除 ${targetDate} 记录后，成功联动校正了后续 ${result.updatedCount} 天的账目数据`,
          integrityAlerts: result.integrityAlerts || []
        };
      }

      case 'verify_integrity': {
        // 🛡️ 独立的完整性巡检入口：不做任何重算，仅核对链上每条记录的 HMAC 校验码；
        // 允许"本机构全部门店"的巡检范围，但 tenantId 必须能解析出来，绝不允许巡检
        // 退化为无租户边界的全库扫描（该入口仍会对命中记录写入 isLocked，并非纯只读）
        if (!callerTenantId) {
          return { success: false, errMsg: '无法确认调用者所属机构，出于数据隔离安全考虑已拒绝执行巡检' };
        }
        const queryWhere = { dateString: _.gte(targetDate), tenantId: callerTenantId, isVoid: _.neq(true) };
        if (storeFilter && storeFilter !== 'all') {
          queryWhere.shopName = storeFilter;
        }
        const listRes = await db.collection('report_logs').where(queryWhere).orderBy('dateString', 'asc').get();
        const records = listRes.data || [];

        const integrityAlerts = [];
        records.forEach(item => {
          const { checked, valid } = verifyChecksum(item);
          if (checked && !valid) {
            integrityAlerts.push({ _id: item._id, dateString: item.dateString, shopName: item.shopName });
          }
        });

        if (integrityAlerts.length > 0) {
          await Promise.all(integrityAlerts.map(alert =>
            db.collection('report_logs').doc(alert._id).update({
              data: { isLocked: true, integrityAlert: true, integrityAlertAt: db.serverDate() }
            }).catch(e => console.error('锁定篡改记录失败:', alert._id, e))
          ));
        }

        return {
          success: true,
          checkedCount: records.length,
          integrityAlerts
        };
      }

      default:
        return { success: false, errMsg: `不支持的 action: ${action}` };
    }
  } catch (err) {
    console.error('❌ [cascadeRecalculator] 级联重算失败:', err);
    return { success: false, errMsg: err.message };
  }
};
