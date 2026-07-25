const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 🛡️ 资金流水防篡改：与 cascadeRecalculator 共用同一套 HMAC 校验规则
const HMAC_SECRET = process.env.LEDGER_HMAC_SECRET || 'yuhua_ledger_default_secret_please_override_in_cloud_env';

function computeChecksum(item) {
  const yb = (parseFloat(item.yesterdayBalance || 0)).toFixed(2);
  const income = (parseFloat(item.listDonationTotal || 0) + parseFloat(item.otherDonation || 0)).toFixed(2);
  const expense = (parseFloat(item.dailyExpenseTotal || 0) + parseFloat(item.fixedExpenseTotal || 0)).toFixed(2);
  const tb = (parseFloat(item.todayBalance || 0)).toFixed(2);
  const dateString = item.dateString || '';
  const storeId = item.storeId || item.shopName || '';
  const payload = `${dateString}|${storeId}|${yb}|${income}|${expense}|${tb}`;
  return crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
}

function round2(num) {
  return Math.round((parseFloat(num || 0) + Number.EPSILON) * 100) / 100;
}

function calculateIncome(doc) {
  return round2(parseFloat(doc.listDonationTotal || 0) + parseFloat(doc.otherDonation || 0));
}

function calculateExpense(doc) {
  return round2(parseFloat(doc.dailyExpenseTotal || 0) + parseFloat(doc.fixedExpenseTotal || 0));
}

async function checkCanEdit(doc) {
  const { OPENID } = cloud.getWXContext();
  if (!doc) return { allowed: false, role: 'unknown' };

  if (doc._openid === OPENID) {
    // 🛡️ 职责分离延伸到编辑动作：本人提交的记录一旦经店长核对确认（APPROVED），
    // 就不能再由提交人自己修改——哪怕提交人自己也持有 store_manager/finance/
    // store_patriarch/super_admin 等角色，这条限制同样适用，保护的是"对自己
    // 提交的记录"这件事本身，不是角色高低。AUDITED_LOCKED 由下面 main() 里已有的
    // 统一锁定校验兜底覆盖所有角色（含他人编辑），这里不用重复判断
    if (doc.approvalStatus === 'APPROVED') {
      return { allowed: false, role: 'self_after_approval' };
    }
    return { allowed: true, role: 'self' };
  }

  try {
    const roleRes = await db.collection('user_roles')
      .where({ _openid: OPENID })
      .limit(1)
      .get();

    if (roleRes.data && roleRes.data.length > 0) {
      const user = roleRes.data[0];

      // 🏢 租户边界：若双方都已回填 tenantId 且不一致，直接拒绝（无论角色多高）
      if (user.tenantId && doc.tenantId && user.tenantId !== doc.tenantId) {
        return { allowed: false, role: user.role };
      }

      if (user.role === 'super_admin') {
        return { allowed: true, role: 'super_admin' };
      }
      // 🛡️ 店长/财务/大家长（权限向下继承）仅可编辑本门店数据，禁止跨店修改他店记录
      if (user.role === 'store_manager' || user.role === 'finance' || user.role === 'store_patriarch') {
        const sameStore = (user.storeId && doc.storeId && user.storeId === doc.storeId)
          || (user.storeName && doc.shopName && user.storeName === doc.shopName);
        if (sameStore) {
          return { allowed: true, role: user.role };
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
    console.warn('[updateAndRecalculateCascade] 权限校验异常:', e);
  }

  return { allowed: false, role: 'unknown' };
}

exports.main = async (event, context) => {
  console.log('📥 [updateAndRecalculateCascade] 收到请求参数:', JSON.stringify(event));

  const {
    docId, shopName, storeId, reportDate, yesterdayBalance,
    income, listDonationTotal, otherDonation, expense,
    diningPeople, volunteers, receiptImageList, receiptImages,
    donationItems, materials, stapleRiceStatus, stapleOilStatus,
    modifyReason,
    // 🍱 用餐/义工细分统计（堂食/送餐/打包），见下方 hasBreakdown 分支说明
    dineInSeniors, deliverySeniors, dineInVolunteers, deliveryVolunteers, takeawayCount
  } = event;
  const targetShop = shopName || storeId || '';
  const strReportDate = String(reportDate || '').trim();
  // 凭证图片以前端提交的最终数组为准（无论走 receiptImages 还是 receiptImageList 字段传入），
  // 两个字段必须同步落库，否则历史列表优先展示的 receiptImages 会保留旧图，造成"删除后又恢复"的假象
  const finalReceiptImages = Array.isArray(receiptImages)
    ? receiptImages
    : (Array.isArray(receiptImageList) ? receiptImageList : []);

  if (!docId || !strReportDate || !targetShop) {
    return { success: false, errMsg: '核心参数缺失: docId / reportDate / shopName' };
  }

  if (!modifyReason || !String(modifyReason).trim()) {
    return { success: false, errMsg: '请填写修改原因后再保存，修改历史餐报记录必须留痕' };
  }

  const { OPENID } = cloud.getWXContext();

  try {
    const numYesterdayBal = round2(yesterdayBalance);
    // 🐛 修复：旧逻辑将 otherDonation 硬编码为 0，编辑一次记录就会把"现场赞助/其他支持金额"永久清零。
    // 现在爱心支持明细（listDonationTotal）与现场赞助/其他支持金额（otherDonation）在编辑弹窗中分别可编辑，
    // 两者之和才是当日总收入。若前端未拆分传入（旧调用方），则退回用 income 作为总收入、otherDonation 为 0。
    const hasSplitDonation = listDonationTotal !== undefined || otherDonation !== undefined;
    const numListDonation = hasSplitDonation ? round2(listDonationTotal) : round2(income);
    const numOtherDonation = hasSplitDonation ? round2(otherDonation) : 0;
    const numIncome = round2(numListDonation + numOtherDonation);
    const numExpense = round2(expense);
    const newTodayBal = round2(numYesterdayBal + numIncome - numExpense);
    const netIncrease = round2(numIncome - numExpense);

    // 🍱 用餐/义工细分统计：只有前端本次真的传了细分字段（新样式记录，或本次编辑
    // 首次填写细分统计）才由服务端按细分重新算出权威的用餐总数/志愿者总人次；
    // 老记录/本次编辑压根没碰细分区域时，不能强行按 0 覆盖，必须原样沿用前端传来的
    // diningPeople/volunteers（即编辑弹窗里仍保留可编辑的历史汇总值）
    const hasBreakdown = [dineInSeniors, deliverySeniors, dineInVolunteers, deliveryVolunteers, takeawayCount]
      .some((v) => v !== undefined && v !== null && v !== '');
    const numDineInSeniors = round2(dineInSeniors);
    const numDeliverySeniors = round2(deliverySeniors);
    const numDineInVolunteers = round2(dineInVolunteers);
    const numDeliveryVolunteers = round2(deliveryVolunteers);
    const numTakeaway = round2(takeawayCount);
    const computedTotalDineCount = round2(numDineInSeniors + numDeliverySeniors + numTakeaway + numDineInVolunteers);
    const computedTotalVolunteers = round2(numDeliveryVolunteers + numDineInVolunteers);
    const finalDiningPeople = hasBreakdown ? computedTotalDineCount : Number(diningPeople || 0);
    const finalVolunteers = hasBreakdown ? computedTotalVolunteers : Number(volunteers || 0);

    // 1. 取出原记录做权限校验
    const logRes = await db.collection('report_logs').doc(docId).get();
    const logData = logRes.data;
    if (!logData) {
      return { success: false, errMsg: '记录不存在' };
    }

    const { allowed: canEdit, role: operatorRole } = await checkCanEdit(logData);
    if (!canEdit) {
      const errMsg = operatorRole === 'self_after_approval'
        ? '该记录已由店长完成核对确认，提交人不能再自行修改，如有问题请联系店长/家长处理'
        : '无权限修改该记录';
      return { success: false, errMsg };
    }

    // 🛡️ 状态机闭环：财务稽核封账（AUDITED_LOCKED）后任何角色都不能再修改金额，
    // 必须先由财务走"解封"流程。此前本函数（真正承载"编辑历史餐报并联动重算"的
    // 主入口）完全没有校验锁定状态，封账形同虚设——只要绕过 UI 层的按钮禁用直接
    // 调用云函数，已封账的记录金额仍可被随意改动且级联污染后续所有日期的余额。
    if (logData.approvalStatus === 'AUDITED_LOCKED' || logData.isLocked) {
      return { success: false, errMsg: '该记录已被财务稽核锁定，请先联系财务解封后再修改' };
    }

    console.log(`📊 [Step 1] 更新起始记录: Date=${strReportDate}, NewBalance=${newTodayBal}`);

    // 1.5 提前拉取目标日期及之后的所有记录，在做任何写入之前先校验级联范围是否安全。
    // 🛡️ 防跨机构串联：级联范围必须收敛到同一机构。此前仅在 logData.tenantId 存在时
    // 才添加过滤条件，一旦被编辑记录恰好尚未回填 tenantId（迁移过渡期常见），查询会
    // 退化为"仅按 shopName 全库匹配"，不同机构使用同名门店字符串时会被误连成同一条链。
    // 现在优先用记录自身的 tenantId，缺失时退回操作人自己的 tenantId，两者都拿不到才
    // 允许不过滤（操作人自身也无 tenantId 的历史孤儿账号，维持迁移前的兼容行为）。
    const operatorRoleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
    const operatorRole2 = operatorRoleRes.data && operatorRoleRes.data[0];
    const cascadeTenantId = logData.tenantId || (operatorRole2 && operatorRole2.tenantId) || '';
    const cascadeWhere = {
      shopName: targetShop,
      dateString: _.gte(strReportDate),
      // 🛡️ 已作废（红字冲销）的记录不应再参与流水链计算
      isVoid: _.neq(true)
    };
    if (cascadeTenantId) {
      cascadeWhere.tenantId = cascadeTenantId;
    }
    const precheckListRes = await db.collection('report_logs')
      .where(cascadeWhere)
      .orderBy('dateString', 'asc')
      .get();
    const precheckRecords = precheckListRes.data || [];

    // 🛡️ 状态机闭环：链上（从第 2 条起，第 1 条是本次即将编辑的记录本身）若存在已财务
    // 封账的记录，绝不能被静默覆写，否则封账形同虚设。在动笔改任何数据之前就中止，
    // 避免出现"起始记录已改、但级联被挡下"的半途污染状态。
    const lockedInChain = precheckRecords.slice(1).filter(item => item.approvalStatus === 'AUDITED_LOCKED' || item.isLocked);
    if (lockedInChain.length > 0) {
      return {
        success: false,
        errMsg: `联动范围内存在 ${lockedInChain.length} 条已财务封账的记录（最早为 ${lockedInChain[0].dateString}），为保证封账数据不可篡改，已中止本次修改，请先联系财务解封后再操作`
      };
    }

    // 2. 更新被编辑的单条记录（把简化后的收入/支出归入主要字段），
    //    与审计日志写入置于同一事务，确保 old_value / reason 与修改动作原子生效
    const transaction = await db.startTransaction();
    try {
      await transaction.collection('report_logs').doc(docId).update({
        data: {
          yesterdayBalance: numYesterdayBal,
          listDonationTotal: numListDonation,
          otherDonation: numOtherDonation,
          dailyExpenseTotal: numExpense,
          fixedExpenseTotal: 0,
          expenseAmount: numExpense,
          todayBalance: newTodayBal,
          netIncrease: netIncrease,
          diningPeople: finalDiningPeople,
          volunteers: finalVolunteers,
          diningCount: finalDiningPeople,
          volunteerCount: finalVolunteers,
          totalDineCount: finalDiningPeople,
          totalVolunteers: finalVolunteers,
          dineInSeniors: hasBreakdown ? numDineInSeniors : (logData.dineInSeniors || 0),
          deliverySeniors: hasBreakdown ? numDeliverySeniors : (logData.deliverySeniors || 0),
          dineInVolunteers: hasBreakdown ? numDineInVolunteers : (logData.dineInVolunteers || 0),
          deliveryVolunteers: hasBreakdown ? numDeliveryVolunteers : (logData.deliveryVolunteers || 0),
          takeawayCount: hasBreakdown ? numTakeaway : (logData.takeawayCount || 0),
          receiptImages: finalReceiptImages,
          receiptImageList: finalReceiptImages,
          donationItems: Array.isArray(donationItems) ? donationItems : [],
          materials: Array.isArray(materials) ? materials : [],
          stapleRiceStatus: stapleRiceStatus || 'normal',
          stapleOilStatus: stapleOilStatus || 'sufficient',
          modifyReason: modifyReason,
          updateTime: db.serverDate(),
          _checksum: computeChecksum({
            dateString: strReportDate,
            storeId: targetShop,
            yesterdayBalance: numYesterdayBal,
            listDonationTotal: numListDonation,
            otherDonation: numOtherDonation,
            dailyExpenseTotal: numExpense,
            fixedExpenseTotal: 0,
            todayBalance: newTodayBal
          })
        }
      });

      await transaction.collection('report_audit_logs').add({
        data: {
          operator_id: OPENID,
          operator_role: operatorRole,
          operate_time: db.serverDate(),
          action: 'update',
          target_collection: 'report_logs',
          target_id: docId,
          target_date: strReportDate,
          target_store: targetShop,
          old_value: logData,
          reason: String(modifyReason).trim()
        }
      });

      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    // 3. 复用 1.5 步预检时拉取的记录列表进行级联（该列表是事务提交*前*拉取的快照，
    //    records[0] 即刚编辑的起始记录，其金额此时仍是旧值——链式计算的锚点必须用
    //    刚刚在事务里写入的 newTodayBal，而不是这份快照里的旧 todayBalance）
    const records = precheckRecords;
    console.log(`📦 [Step 2] 查找到 >= ${strReportDate} 的记录共 ${records.length} 条`);

    if (records.length === 0) {
      return { success: true, updatedCount: 1, message: '已更新当前记录' };
    }

    let runningTodayBal = newTodayBal;
    let updatedCount = 0;
    const updatePromises = [];

    for (let i = 1; i < records.length; i++) {
      const item = records[i];
      const itemIncome = calculateIncome(item);
      const itemExpense = calculateExpense(item);

      const currentYesterday = runningTodayBal;
      const currentTodayBal = round2(currentYesterday + itemIncome - itemExpense);
      const currentNetInc = round2(itemIncome - itemExpense);

      runningTodayBal = currentTodayBal;

      const cascadeChecksum = computeChecksum({
        ...item,
        yesterdayBalance: currentYesterday,
        todayBalance: currentTodayBal
      });

      updatePromises.push(
        db.collection('report_logs').doc(item._id).update({
          data: {
            yesterdayBalance: currentYesterday,
            todayBalance: currentTodayBal,
            netIncrease: currentNetInc,
            _checksum: cascadeChecksum,
            lastCascadeCalculatedAt: db.serverDate()
          }
        })
      );

      updatedCount++;
      console.log(`✏️ [Step 3] 校正 [${item.dateString}]: 昨日(${currentYesterday}) -> 今日结余(${currentTodayBal})`);
    }

    if (updatePromises.length > 0) {
      await Promise.all(updatePromises);
    }

    return {
      success: true,
      updatedCount: updatedCount + 1,
      message: `成功联动校正了包含 ${strReportDate} 在内的 ${updatedCount + 1} 天账目`
    };

  } catch (err) {
    console.error('💥 [updateAndRecalculateCascade] 异常:', err);

    let userFriendlyMsg = err.message || '未知错误';
    if (err.errCode === -502005 || (err.message && err.message.includes('DATABASE_COLLECTION_NOT_EXIST'))) {
      userFriendlyMsg = '数据库缺失 [report_logs] 集合，请前往微信云开发控制台创建该集合！';
    } else if (err.errCode === -502002 || (err.message && err.message.includes('DOCUMENT_NOT_FOUND'))) {
      userFriendlyMsg = '未找到要更新的记录，请确认数据是否已被删除';
    } else if (err.errCode === -502001 || (err.message && err.message.includes('PERMISSION_DENIED'))) {
      userFriendlyMsg = '权限不足，请联系管理员授权';
    }

    return {
      success: false,
      errMsg: userFriendlyMsg,
      stack: err.stack
    };
  }
};
