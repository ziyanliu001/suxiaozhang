const cloud = require('wx-server-sdk');
const ExcelJS = require('exceljs');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { shopName, tabType, selectedYear, selectedMonth, startDate, endDate } = event;

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
    // 1. 查询数据
    let whereConditions = {
      dateString: _.gte(startDateStr).and(_.lte(endDateStr))
    };
    if (shopName && shopName !== '全部门店') {
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

    return {
      success: true,
      fileID: uploadRes.fileID,
      tempFileURL,
      fileName: `${safeStoreName}_收支明细_${periodLabel}.xlsx`,
      recordCount: records.length
    };

  } catch (err) {
    console.error('💥 [exportAccountExcel] 失败:', err);
    return { success: false, errMsg: err.message || '导出失败' };
  }
};
