// 🏛️（2026-08-31 Open-Core 架构拆分）本文件只保留路由分发职责：解析请求
// 参数、解析调用者身份/权限、收敛查询范围、执行查询、处理 previewOnly 预览，
// 再根据 isNationalExport 动态调度到具体的导出实现——
//   - false（默认）：Core 拟开源的单店导出，见 lib/exportSingleStoreExcel.js
//   - true：Enterprise 商业专有的多店合并导出，见 lib/exportNationalExcel.js
// 真正的 Excel 工作簿构建/样式/上传逻辑不在本文件维护，避免"路由该走哪条
// 分支"与"这条分支具体怎么导出"两件事混在同一个文件里，物理拆库时只需要
// 把 lib/exportNationalExcel.js 连同本文件里"isNationalExport 商业化鉴权"
// 这几行移出去即可。
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { buildSingleStoreExport } = require('./lib/exportSingleStoreExcel');
const { buildNationalExport, isAdvancedPlanActive } = require('./lib/exportNationalExcel');

exports.main = async (event, context) => {
  const { shopName, storeId, tabType, selectedYear, selectedMonth, startDate, endDate, previewOnly, isNationalExport } = event;
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

  console.log(`📊 [exportAccountExcel] 范围: ${startDateStr} ~ ${endDateStr}, 门店: ${shopName || '全部'}(storeId=${storeId || '无'}), isNationalExport: ${!!isNationalExport}`);

  try {
    // 🏢 多租户边界：导出功能涉及完整财务明细，必须先收敛到调用者所属机构，
    // "全部门店"仅指本机构下的全部门店，绝不允许导出他机构数据
    // 🛡️ 此前 tenantId 解析失败（游客/未分配角色账号）时会直接跳过过滤条件，
    // 导致该账号可导出全平台所有机构的收支明细——现在改为直接拒绝，宁可导出失败也不泄露。
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

    // 🛡️ hq_finance/regional_finance（总部/大区财务）与 super_admin 一样，在 statistics
    // 页面拥有跨店查看权限（canViewAllStoresDropdown），导出功能作为该页面的延伸操作，
    // 口径保持一致
    const isTenantWideAllowed = ['super_admin', 'hq_finance', 'regional_finance'].includes(userRole);

    // 🆕 机构级合并导出（isNationalExport）同样只对租户级角色开放——与
    // pages/statistics/statistics.wxml 顶部横幅"数据导出"按钮的 isAdmin
    // 权限口径一致，非租户级角色请求这个模式直接拒绝，不静默降级成单店导出
    // （降级会让调用方以为拿到的就是全机构数据，造成误解）
    if (isNationalExport && !isTenantWideAllowed) {
      return { success: false, errMsg: '仅机构超管/总部财务可发起多店合并导出' };
    }

    // 🏛️（2026-08-31 商业化权益中心）多店合并导出商业化鉴权：与
    // getNationalDashboard 的 subscriptionQuota.features.canExportNationalExcel
    // 同一份判断口径——免费版机构即使角色满足上面的 isTenantWideAllowed，
    // 这里仍然拒绝，服务端强鉴权，不依赖前端体验层拦截（体验层见
    // statistics.ts onOpenNationalExcelExportModal）。isAdvancedPlanActive 是
    // Enterprise 专有的商业化判断，来自 lib/exportNationalExcel.js——Core 单店
    // 导出路径完全不会触发这段逻辑
    if (isNationalExport) {
      const hasAdvancedPlan = await isAdvancedPlanActive(db, tenantId);
      if (!hasAdvancedPlan) {
        return { success: false, errMsg: '该功能为专业版/旗舰版专享，请前往个人中心升级机构套餐', requiresUpgrade: true };
      }
    }

    // 🐛 与下方 whereConditions 的收敛逻辑保持一致：非租户级角色现在无论传
    // 什么 shopName（含"全部门店"）都会被强制收敛到自己绑定的门店，这条
    // 早退校验也不应该只在客户端传"全部门店"时才检查——否则一个没绑定门店
    // 的账号传一个具体门店名会静默查出空结果，而不是收到明确的报错提示
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
    // 🐛 根因修复（跨门店越权导出）：此前只在客户端传"全部门店"/空值时才会把
    // 非租户级角色强制收敛回自己的门店——一旦客户端显式传了同一机构内另一家
    // 真实门店的 shopName，会原样进入下面 else if 分支被采信，只受 tenantId
    // 隔离，同一机构内非超管/非总部财务角色可以越权导出别的门店的完整财务
    // 明细。现在改为：只要不是 isTenantWideAllowed（super_admin/hq_finance/
    // regional_finance），无论客户端传的是"全部门店"还是任何具体门店名，
    // 一律强制收敛到自己绑定的门店，服务端不信任客户端传入的 shopName 参数
    if (!isTenantWideAllowed) {
      if (userStoreId) {
        whereConditions.storeId = userStoreId;
      } else {
        whereConditions.shopName = userStoreName;
      }
    } else if (isNationalExport) {
      // 🆕 机构合并导出：无条件按全机构口径查询，即使客户端仍带着某个具体
      // shopName（例如用户在切到"合并导出"之前恰好停留在某个单店 Tab），
      // 也不能让这个残留参数意外把合并导出收窄成单店导出
    } else if (storeId) {
      // 🐛 补齐 storeId 精确匹配：此前租户级角色（super_admin/hq_finance/
      // regional_finance）浏览单店导出时只认 shopName 字符串精确匹配，与
      // pages/statistics/statistics.ts loadStatistics() 早已改用的
      // "storeId 精确匹配优先、shopName 兜底"双保险口径不一致——门店曾改名/
      // 历史录入差异导致 shopName 对不上时，屏幕统计与导出表格可能不一致，
      // 甚至导出查到 0 条。storeId 是稳定主键，客户端传了就优先信任它
      whereConditions.storeId = storeId;
    } else if (shopName && shopName !== '全部门店') {
      whereConditions.shopName = shopName;
    }

    const MAX_LIMIT = isNationalExport ? 5000 : 1000;
    const recordRes = await db.collection('report_logs')
      .where(whereConditions)
      .orderBy('dateString', 'asc')
      .limit(MAX_LIMIT)
      .get();

    const records = recordRes.data || [];
    console.log(`📊 [exportAccountExcel] 查询到 ${records.length} 条记录`);

    if (records.length === 0) {
      return { success: false, errMsg: '该周期内无明细数据可导出' };
    }

    // 🌟 「先核对、再确认、后导出」安全闭环：previewOnly 模式下只查询、汇总、
    // 整理明细列表返回给前端做核对展示，完全不触碰 ExcelJS 工作簿构建/云存储
    // 上传，不产生任何文件——真正生成 xlsx 必须走用户点击「确认并导出」后不带
    // previewOnly 的第二次调用。预览逻辑对单店/合并两条路径完全一致（都只是
    // "预览这批已经查出来的 records"），不需要按 isNationalExport 分流
    if (previewOnly) {
      let previewIncome = 0;
      let previewExpense = 0;
      let previewDiners = 0;
      let previewMaterialsCount = 0;
      // 🌟「先核对、再确认、后导出」预览摘要新增两项，供财务一眼判断这批数据是否
      // 值得放心导出：已审核小票数（有凭证图片佐证的记录）、异常标记数（有支出
      // 但完全没上传凭证——与 cloudfunctions/getRiskAlerts 的 missing_receipt
      // 判定同一条口径，不重复实现红字冲销/余额链路那套需要跨记录比对的逻辑，
      // 那类异常已作废记录本就被上面 isVoid 过滤掉、不会出现在待导出明细里）
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

    // 2. 路由分发：Core 单店导出 vs Enterprise 多店合并导出
    if (isNationalExport) {
      return await buildNationalExport(cloud, db, { tenantId, records, periodLabel, startDateStr, endDateStr });
    }
    // 🏛️（2026-09-03 审计级台账）单店审计级三工作表导出需要 db 做二次查询
    // （user_roles 经办人昵称、material_logs 物资消耗、daily_menus 当日菜谱），
    // 以及 storeId/tenantId 做查询范围收敛——都是本函数已经解析好的调用者上下文，
    // 直接透传，不在 lib 层重新解析身份（避免绕过上面已经做过的租户/角色收敛）
    return await buildSingleStoreExport(cloud, {
      db, records, periodLabel, startDateStr, endDateStr, shopName,
      storeId: whereConditions.storeId || storeId || '',
      tenantId
    });

  } catch (err) {
    console.error('💥 [exportAccountExcel] 失败:', err);
    return { success: false, errMsg: err.message || '导出失败' };
  }
};
