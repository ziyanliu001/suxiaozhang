// 🏛️（2026-08-31 Open-Core 第三阶段构建产物）本文件是 suxiaozhang-core
// 开源包专用的 exportAccountExcel/index.js 替身——由 scripts/build-open-core.js
// 在打包时用它整体覆盖仓库原文件，不是运行时按 isNationalExport 分支判断
// 的同一份代码。原文件（miniprogram-1 完整版仓库）仍然保留 isNationalExport
// 合并导出分支，本文件只是它去掉 Enterprise 分支后的纯净单店版本，两份文件
// 分别维护——原文件若修改了单店导出以外的公共逻辑（如查询范围收敛、
// previewOnly 预览），需要同步手动把改动搬到这里（各云函数独立部署、
// 无共享模块机制是本仓库一贯的约束，见 CLAUDE.md）。
//
// 与完整版的差异：
//   - 不再接受/处理 isNationalExport 参数，不 require Enterprise 专有的
//     lib/exportNationalExcel.js（该文件在 Core 包里根本不存在）；
//   - 不再有 isAdvancedPlanActive 订阅套餐鉴权（Core 部署没有
//     tenant_subscriptions 概念，单店导出对所有角色一视同仁）；
//   - 保留同机构内 super_admin/hq_finance/regional_finance 跨店查询范围
//     （这仍是"同一租户内部"的治理需求，不是 SaaS 订阅门禁，属于 Core）。
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { buildSingleStoreExport } = require('./lib/exportSingleStoreExcel');

exports.main = async (event, context) => {
  const { shopName, tabType, selectedYear, selectedMonth, startDate, endDate, previewOnly } = event;
  const { OPENID } = cloud.getWXContext();

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
  const todayStr = `${currentYear}-${currentMonth}-${String(now.getDate()).padStart(2, '0')}`;

  let startDateStr = startDate || '';
  let endDateStr = endDate || '';
  let periodLabel = '';

  if (tabType === 'month') {
    const year = selectedYear || currentYear;
    const month = selectedMonth || currentMonth;
    startDateStr = `${year}-${month}-01`;
    const lastDay = new Date(year, parseInt(month, 10), 0).getDate();
    endDateStr = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;
    periodLabel = `${year}年${month}月`;
  } else if (tabType === 'year') {
    const year = selectedYear || currentYear;
    startDateStr = `${year}-01-01`;
    endDateStr = `${year}-12-31`;
    periodLabel = `${year}年度`;
  } else if (tabType === 'week') {
    const dayOfWeek = now.getDay() || 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - dayOfWeek + 1);
    startDateStr = monday.toISOString().split('T')[0];
    endDateStr = todayStr;
    periodLabel = '本周';
  } else if (tabType === 'custom') {
    if (!startDateStr || !endDateStr) {
      return { success: false, errMsg: '自定义模式必须传入 startDate 和 endDate' };
    }
    periodLabel = `${startDateStr}_${endDateStr}`;
  } else {
    startDateStr = todayStr;
    endDateStr = todayStr;
    periodLabel = '今日';
  }

  console.log(`📊 [exportAccountExcel:core] 范围: ${startDateStr} ~ ${endDateStr}, 门店: ${shopName || '全部'}`);

  try {
    // 🏢 多租户边界：导出功能涉及完整财务明细，必须先收敛到调用者所属机构，
    // "全部门店"仅指本机构下的全部门店，绝不允许导出他机构数据
    let tenantId = '';
    let userRole = '';
    let userStoreId = '';
    let userStoreName = '';
    if (OPENID) {
      const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
      if (roleRes.data && roleRes.data.length > 0) {
        tenantId = roleRes.data[0].tenantId || '';
        userRole = roleRes.data[0].role || '';
        userStoreId = roleRes.data[0].storeId || '';
        userStoreName = roleRes.data[0].storeName || '';
      }
    }

    if (!tenantId) {
      return { success: false, errMsg: '无法确认您所属的机构，暂不支持导出' };
    }

    // 🛡️ hq_finance/regional_finance（总部/大区财务）与 super_admin 一样，
    // 拥有本机构内跨店查看权限——这是"同一租户内部治理"，不是跨机构 SaaS
    // 订阅能力，Core 保留
    const isTenantWideAllowed = ['super_admin', 'hq_finance', 'regional_finance'].includes(userRole);

    if (!isTenantWideAllowed && !userStoreId && !userStoreName) {
      return { success: false, errMsg: '您尚未绑定门店，无法导出' };
    }

    // 1. 查询数据
    let whereConditions = {
      dateString: _.gte(startDateStr).and(_.lte(endDateStr)),
      tenantId: tenantId,
      // 🛡️ 已作废（红字冲销）的记录不计入导出明细/合计
      isVoid: _.neq(true)
    };
    if (!isTenantWideAllowed) {
      if (userStoreId) {
        whereConditions.storeId = userStoreId;
      } else {
        whereConditions.shopName = userStoreName;
      }
    } else if (shopName && shopName !== '全部门店') {
      whereConditions.shopName = shopName;
    }

    const MAX_LIMIT = 1000;
    const recordRes = await db.collection('report_logs')
      .where(whereConditions)
      .orderBy('dateString', 'asc')
      .limit(MAX_LIMIT)
      .get();

    const records = recordRes.data || [];
    console.log(`📊 [exportAccountExcel:core] 查询到 ${records.length} 条记录`);

    if (records.length === 0) {
      return { success: false, errMsg: '该周期内无明细数据可导出' };
    }

    // 🌟 「先核对、再确认、后导出」安全闭环：previewOnly 模式下只查询、汇总、
    // 整理明细列表返回给前端做核对展示，不产生任何文件
    if (previewOnly) {
      let previewIncome = 0;
      let previewExpense = 0;
      let previewDiners = 0;
      let previewMaterialsCount = 0;
      let previewAuditedReceiptCount = 0;
      let previewAnomalyCount = 0;

      const previewRecords = records.map(record => {
        const income = parseFloat(record.listDonationTotal || 0) + parseFloat(record.otherDonation || 0);
        const expense = parseFloat(record.expenseAmount || 0);
        const diningCount = parseInt(record.diningCount || 0, 10);
        const receiptCount = (record.receiptImages && record.receiptImages.length) ||
          (record.receiptImageList && record.receiptImageList.length) || 0;

        previewIncome += income;
        previewExpense += expense;
        previewDiners += diningCount;
        if (Array.isArray(record.materials)) {
          previewMaterialsCount += record.materials.length;
        }
        if (receiptCount > 0) {
          previewAuditedReceiptCount++;
        }
        if (expense > 0 && receiptCount === 0) {
          previewAnomalyCount++;
        }

        return {
          date: record.dateString || '',
          shopName: record.shopName || '',
          income: Number(income.toFixed(2)),
          expense: Number(expense.toFixed(2)),
          net: Number((income - expense).toFixed(2)),
          diningCount,
          hasReceipt: receiptCount > 0,
          receiptCount
        };
      });

      return {
        success: true,
        previewOnly: true,
        periodLabel,
        startDateStr,
        endDateStr,
        recordCount: records.length,
        records: previewRecords,
        summary: {
          periodLabel,
          startDateStr,
          endDateStr,
          totalIncome: Number(previewIncome.toFixed(2)),
          totalExpense: Number(previewExpense.toFixed(2)),
          netTotal: Number((previewIncome - previewExpense).toFixed(2)),
          totalDiners: previewDiners,
          materialsCount: previewMaterialsCount,
          recordCount: records.length,
          auditedReceiptCount: previewAuditedReceiptCount,
          anomalyCount: previewAnomalyCount
        }
      };
    }

    // 2. Core 只有单店导出这一条路径
    return await buildSingleStoreExport(cloud, { records, periodLabel, startDateStr, endDateStr, shopName });

  } catch (err) {
    console.error('💥 [exportAccountExcel:core] 失败:', err);
    return { success: false, errMsg: err.message || '导出失败' };
  }
};
