// 🏛️（2026-08-31 Open-Core 架构拆分）Core 拟开源组件：单店收支明细 Excel
// 导出。这是"单店透明记账"能力的一部分——一个完全没有接入任何 Enterprise
// 模块（无 SaaS 订阅、无全国大屏）的自托管单店部署，也应该能正常使用本模块
// 完成日常的收支明细导出，不依赖 tenant_subscriptions/订阅套餐等任何商业概念。
//
// 🛡️ 依赖方向：本文件不 require 任何 Enterprise 模块（../lib/exportNationalExcel
// 等），只提供被动导出的可复用能力（addRecordsSheet/uploadWorkbookAndRespond）
// 供 Enterprise 侧的 exportNationalExcel.js 反向依赖——Enterprise 可以依赖
// Core，Core 绝不能依赖 Enterprise，这是 Open-Core 拆分的基本方向约束。
const ExcelJS = require('exceljs');
const { HEADER_STYLE, CELL_STYLE, NUMBER_STYLE, INCOME_STYLE, EXPENSE_STYLE, TOTAL_STYLE } = require('./excelStyles');

// 🌟 单店/单 Sheet 收支明细构建：供默认单店导出与多店合并导出（每店一个
// Sheet）共用同一套列定义/样式/合计行逻辑，不重复维护两份容易走样的构建
// 代码。返回该 Sheet 的合计数字，供调用方汇总
function addRecordsSheet(workbook, sheetName, records) {
  const worksheet = workbook.addWorksheet(sheetName.substring(0, 31), {
    properties: { defaultColWidth: 12 }
  });

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

  const headerRow = worksheet.getRow(1);
  headerRow.height = 28;
  headerRow.eachCell((cell) => {
    cell.style = HEADER_STYLE;
  });

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
        cell.style = INCOME_STYLE;
        cell.numFmt = '#,##0.00';
      } else if (colNumber >= 4 && colNumber <= 6) {
        cell.style = EXPENSE_STYLE;
        cell.numFmt = '#,##0.00';
      } else if (colNumber === 8 || colNumber === 9 || colNumber === 10) {
        cell.style = NUMBER_STYLE;
      } else {
        cell.style = CELL_STYLE;
      }
    });
  });

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

  totalRow.height = 28;
  totalRow.eachCell((cell, colNumber) => {
    cell.style = { ...TOTAL_STYLE };
    if (colNumber >= 3 && colNumber <= 7) {
      cell.numFmt = '#,##0.00';
    }
    if (colNumber === 1) {
      cell.style = { ...TOTAL_STYLE, alignment: { horizontal: 'left', vertical: 'middle' } };
    }
  });

  worksheet.views = [{ state: 'frozen', ySplit: 1 }];

  return {
    recordCount: records.length,
    totalIncome, totalDaily, totalLarge, totalExpense,
    totalDiners, totalVolunteers, totalVolHours, totalMaterialsCount
  };
}

// 🌟 工作簿收尾：生成 Buffer → 上传云存储 → 取临时下载链接 → 拼财务公示
// 文本 → 组装最终响应体。单店导出（Core）与多店合并导出（Enterprise）的
// 收尾动作完全一致，只是 fileLabel/是否附带存证核验码这一行不同——收口成
// 一个函数，Enterprise 侧的 exportNationalExcel.js 直接复用（依赖方向：
// Enterprise → Core，不反过来）
async function uploadWorkbookAndRespond(cloud, workbook, opts) {
  const {
    fileLabel, safeStoreName, periodLabel, startDateStr, endDateStr,
    totalIncome, totalExpense, totalDiners, totalMaterialsCount, recordCount,
    isNationalExport, verificationCode
  } = opts;

  const buffer = await workbook.xlsx.writeBuffer();

  const timestamp = Date.now();
  const cloudPath = `exports/${safeStoreName}_${fileLabel}_${periodLabel}_${timestamp}.xlsx`;

  const uploadRes = await cloud.uploadFile({
    cloudPath: cloudPath,
    fileContent: buffer
  });

  console.log(`✅ [exportAccountExcel] 文件已上传: ${cloudPath}`);

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
  const auditTextLines = [
    `【${safeStoreName} · ${periodLabel} 财务审计公示】`,
    `统计区间：${startDateStr} 至 ${endDateStr}`,
    '——————————',
    `总收入（爱心赞助）：¥${totalIncome.toFixed(2)}`,
    `总支出：¥${totalExpense.toFixed(2)}`,
    `净结余：¥${netTotal.toFixed(2)}`,
    `累计服务人次：${totalDiners} 人次`,
    `物资捐赠：${totalMaterialsCount} 笔`,
    '——————————',
    `数据来源：门店逐日提交的透明账本记录（共 ${recordCount} 条），如有疑问欢迎联系门店核实。`,
    `生成时间：${nowStr}`
  ];
  if (isNationalExport) {
    auditTextLines.splice(1, 0, `存证核验码：${verificationCode}`);
  }
  const auditText = auditTextLines.join('\n');

  return {
    success: true,
    fileID: uploadRes.fileID,
    tempFileURL,
    fileName: `${safeStoreName}_${fileLabel}_${periodLabel}.xlsx`,
    recordCount,
    auditText,
    isNationalExport: !!isNationalExport,
    verificationCode: isNationalExport ? verificationCode : undefined,
    auditSummary: {
      periodLabel,
      startDateStr,
      endDateStr,
      totalIncome: Number(totalIncome.toFixed(2)),
      totalExpense: Number(totalExpense.toFixed(2)),
      netTotal: Number(netTotal.toFixed(2)),
      totalDiners,
      materialsCount: totalMaterialsCount,
      recordCount
    }
  };
}

// Core 单店导出主流程：给定已经查询好、且已经过权限收敛的 records，构建
// 单 Sheet 工作簿并完成上传，返回最终响应体
async function buildSingleStoreExport(cloud, { records, periodLabel, startDateStr, endDateStr, shopName }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '雨花斋爱心账本';
  workbook.created = new Date();

  const sheetName = `${periodLabel}收支明细`;
  const totals = addRecordsSheet(workbook, sheetName, records);
  const safeStoreName = String(shopName || '全部门店').replace(/[\\/:*?"<>|]/g, '');

  return uploadWorkbookAndRespond(cloud, workbook, {
    fileLabel: '收支明细',
    safeStoreName,
    periodLabel,
    startDateStr,
    endDateStr,
    totalIncome: totals.totalIncome,
    totalExpense: totals.totalExpense,
    totalDiners: totals.totalDiners,
    totalMaterialsCount: totals.totalMaterialsCount,
    recordCount: records.length,
    isNationalExport: false
  });
}

module.exports = { addRecordsSheet, uploadWorkbookAndRespond, buildSingleStoreExport };
