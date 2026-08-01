const cloud = require('wx-server-sdk');
const ExcelJS = require('exceljs');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

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

  console.log(`📊 [exportAccountExcel] 范围: ${startDateStr} ~ ${endDateStr}, 门店: ${shopName || '全部'}`);

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
    const wantsAllStores = !shopName || shopName === '全部门店';
    if (wantsAllStores && !isTenantWideAllowed && !userStoreId && !userStoreName) {
      return { success: false, errMsg: '您尚未绑定门店，无法导出' };
    }

    // 1. 查询数据
    let whereConditions = {
      dateString: _.gte(startDateStr).and(_.lte(endDateStr)),
      tenantId: tenantId,
      // 🛡️ 已作废（红字冲销）的记录不计入导出明细/合计
      isVoid: _.neq(true)
    };
    if (wantsAllStores && !isTenantWideAllowed) {
      // 🛡️ 非超管请求"全部门店"一律强制收敛为本人所在门店，禁止导出他店数据
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
    console.log(`📊 [exportAccountExcel] 查询到 ${records.length} 条记录`);

    if (records.length === 0) {
      return { success: false, errMsg: '该周期内无明细数据可导出' };
    }

    // 🌟 「先核对、再确认、后导出」安全闭环：previewOnly 模式下只查询、汇总、
    // 整理明细列表返回给前端做核对展示，完全不触碰下方 ExcelJS 工作簿构建/
    // 云存储上传，不产生任何文件——真正生成 xlsx 必须走用户点击「确认并导出」
    // 后不带 previewOnly 的第二次调用
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

    // 2. 构建 Excel 工作簿
    const workbook = new ExcelJS.Workbook();
    workbook.creator = '雨花斋爱心账本';
    workbook.created = new Date();

    const sheetName = `${periodLabel}收支明细`.substring(0, 31);
    const worksheet = workbook.addWorksheet(sheetName, {
      properties: { defaultColWidth: 12 }
    });

    // 标题行样式
    const headerStyle = {
      font: { bold: true, size: 12, color: { argb: 'FFFFFFFF' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9480E' } },
      alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
      border: {
        top: { style: 'thin', color: { argb: 'FFDEE2E6' } },
        left: { style: 'thin', color: { argb: 'FFDEE2E6' } },
        bottom: { style: 'thin', color: { argb: 'FFDEE2E6' } },
        right: { style: 'thin', color: { argb: 'FFDEE2E6' } }
      }
    };

    const cellStyle = {
      font: { size: 11 },
      alignment: { vertical: 'middle', wrapText: true },
      border: {
        top: { style: 'thin', color: { argb: 'FFDEE2E6' } },
        left: { style: 'thin', color: { argb: 'FFDEE2E6' } },
        bottom: { style: 'thin', color: { argb: 'FFDEE2E6' } },
        right: { style: 'thin', color: { argb: 'FFDEE2E6' } }
      }
    };

    const numberStyle = {
      ...cellStyle,
      alignment: { horizontal: 'right', vertical: 'middle' }
    };

    const incomeStyle = {
      ...numberStyle,
      font: { size: 11, color: { argb: 'FF2F9E44' } }
    };

    const expenseStyle = {
      ...numberStyle,
      font: { size: 11, color: { argb: 'FFE03131' } }
    };

    // 定义列
    worksheet.columns = [
      { header: '日期', key: 'date', width: 14 },
      { header: '门店名称', key: 'shopName', width: 18 },
      { header: '爱心收入(元)', key: 'income', width: 14 },
      { header: '日常食材(元)', key: 'dailyExpense', width: 14 },
      { header: '房租专项(元)', key: 'largeExpense', width: 14 },
      { header: '总支出(元)', key: 'totalExpense', width: 14 },
      { header: '净盈亏(元)', key: 'net', width: 14 },
      { header: '用餐人次', key: 'diners', width: 10 },
      { header: '到岗义工', key: 'volunteers', width: 10 },
      { header: '义工工时', key: 'volunteerHours', width: 10 },
      { header: '备注说明', key: 'remark', width: 30 }
    ];

    // 应用标题行样式
    const headerRow = worksheet.getRow(1);
    headerRow.height = 28;
    headerRow.eachCell((cell, colNumber) => {
      cell.style = headerStyle;
    });

    // 填充数据行
    let totalIncome = 0;
    let totalDaily = 0;
    let totalLarge = 0;
    let totalExpense = 0;
    let totalDiners = 0;
    let totalVolunteers = 0;
    let totalVolHours = 0;
    // 🌟 月度财务审计表：物资捐赠笔数——按每条记录 materials 数组的条目数累加，
    // 而不是"有物资捐赠的记录条数"，与门店财务公示海报（posterGenerator.ts
    // drawMeritPoster 物资赞助明细）同一个"逐笔"统计口径
    let totalMaterialsCount = 0;

    records.forEach(record => {
      const income = parseFloat(record.listDonationTotal || 0) + parseFloat(record.otherDonation || 0);
      const dailyExp = parseFloat(record.dailyExpenseTotal || 0);
      const largeExp = parseFloat(record.fixedExpenseTotal || 0);
      const totalExp = parseFloat(record.expenseAmount || 0);
      const net = income - totalExp;
      const diners = parseInt(record.diningCount || 0, 10);
      const vols = parseInt(record.volunteerCount || 0, 10);
      const volHours = parseFloat(record.volunteerHours || 0);

      totalIncome += income;
      totalDaily += dailyExp;
      totalLarge += largeExp;
      totalExpense += totalExp;
      totalDiners += diners;
      totalVolunteers += vols;
      totalVolHours += volHours;
      if (Array.isArray(record.materials)) {
        totalMaterialsCount += record.materials.length;
      }

      let remark = '';
      if (record.materials && Array.isArray(record.materials) && record.materials.length > 0) {
        remark = record.materials.map(m => `${m.item}${m.quantity || ''}${m.unit || ''}`).join('; ');
      } else if (record.remark) {
        remark = String(record.remark).replace(/[\r\n]/g, ' ');
      }

      const row = worksheet.addRow({
        date: record.dateString || '',
        shopName: record.shopName || '',
        income: Number(income.toFixed(2)),
        dailyExpense: Number(dailyExp.toFixed(2)),
        largeExpense: Number(largeExp.toFixed(2)),
        totalExpense: Number(totalExp.toFixed(2)),
        net: Number(net.toFixed(2)),
        diners: diners,
        volunteers: vols,
        volunteerHours: Number(volHours.toFixed(1)),
        remark: remark
      });

      row.height = 24;
      row.eachCell((cell, colNumber) => {
        if (colNumber === 3 || colNumber === 7) {
          cell.style = incomeStyle;
          cell.numFmt = '#,##0.00';
        } else if (colNumber >= 4 && colNumber <= 6) {
          cell.style = expenseStyle;
          cell.numFmt = '#,##0.00';
        } else if (colNumber === 8 || colNumber === 9 || colNumber === 10) {
          cell.style = numberStyle;
        } else {
          cell.style = cellStyle;
        }
      });
    });

    // 合计行
    const totalRow = worksheet.addRow({
      date: '合计',
      shopName: `${records.length} 条记录`,
      income: Number(totalIncome.toFixed(2)),
      dailyExpense: Number(totalDaily.toFixed(2)),
      largeExpense: Number(totalLarge.toFixed(2)),
      totalExpense: Number(totalExpense.toFixed(2)),
      net: Number((totalIncome - totalExpense).toFixed(2)),
      diners: totalDiners,
      volunteers: totalVolunteers,
      volunteerHours: Number(totalVolHours.toFixed(1)),
      remark: ''
    });

    const totalStyle = {
      font: { bold: true, size: 12, color: { argb: 'FFD9480E' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3BF' } },
      alignment: { horizontal: 'right', vertical: 'middle' },
      border: {
        top: { style: 'medium', color: { argb: 'FFD9480E' } },
        left: { style: 'thin', color: { argb: 'FFDEE2E6' } },
        bottom: { style: 'thin', color: { argb: 'FFDEE2E6' } },
        right: { style: 'thin', color: { argb: 'FFDEE2E6' } }
      }
    };

    totalRow.height = 28;
    totalRow.eachCell((cell, colNumber) => {
      cell.style = totalStyle;
      if (colNumber >= 3 && colNumber <= 7) {
        cell.numFmt = '#,##0.00';
      }
      if (colNumber === 1) {
        cell.style.alignment = { horizontal: 'left', vertical: 'middle' };
      }
    });

    // 冻结首行
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];

    // 3. 生成 Buffer
    const buffer = await workbook.xlsx.writeBuffer();

    // 4. 上传到云存储
    const safeStoreName = String(shopName || '全部门店').replace(/[\\/:*?"<>|]/g, '');
    const timestamp = Date.now();
    const cloudPath = `exports/${safeStoreName}_收支明细_${periodLabel}_${timestamp}.xlsx`;

    const uploadRes = await cloud.uploadFile({
      cloudPath: cloudPath,
      fileContent: buffer
    });

    console.log(`✅ [exportAccountExcel] 文件已上传: ${cloudPath}`);

    // 5. 获取临时下载 URL
    const tempUrlRes = await cloud.getTempFileURL({
      fileList: [uploadRes.fileID]
    });

    const fileList = tempUrlRes.fileList || [];
    const tempFileURL = fileList.length > 0 ? fileList[0].tempFileURL : '';

    // 🌟 标准财务公示文本：与 Excel 附件互补，供店长一键复制粘贴到理事会/捐赠机构的
    // 微信群或邮件正文，不强依赖对方能打开 xlsx 附件
    const netTotal = totalIncome - totalExpense;
    // 🐛 云函数容器时区固定为 UTC，new Date().toLocaleString() 不传 timeZone 会
    // 直接按 UTC 渲染，导致"生成时间"比北京时间少 8 小时——显式指定 Asia/Shanghai
    const nowStr = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).format(new Date());
    const auditText = [
      `【${safeStoreName} · ${periodLabel} 财务审计公示】`,
      `统计区间：${startDateStr} 至 ${endDateStr}`,
      '——————————',
      `总收入（爱心赞助）：¥${totalIncome.toFixed(2)}`,
      `总支出：¥${totalExpense.toFixed(2)}`,
      `净结余：¥${netTotal.toFixed(2)}`,
      `累计服务人次：${totalDiners} 人次`,
      `物资捐赠：${totalMaterialsCount} 笔`,
      '——————————',
      `数据来源：门店逐日提交的透明账本记录（共 ${records.length} 条），如有疑问欢迎联系门店核实。`,
      `生成时间：${nowStr}`
    ].join('\n');

    return {
      success: true,
      fileID: uploadRes.fileID,
      tempFileURL,
      fileName: `${safeStoreName}_收支明细_${periodLabel}.xlsx`,
      recordCount: records.length,
      auditText,
      auditSummary: {
        periodLabel,
        startDateStr,
        endDateStr,
        totalIncome: Number(totalIncome.toFixed(2)),
        totalExpense: Number(totalExpense.toFixed(2)),
        netTotal: Number(netTotal.toFixed(2)),
        totalDiners,
        materialsCount: totalMaterialsCount,
        recordCount: records.length
      }
    };

  } catch (err) {
    console.error('💥 [exportAccountExcel] 失败:', err);
    return { success: false, errMsg: err.message || '导出失败' };
  }
};
