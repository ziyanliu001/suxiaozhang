// 🏛️（2026-08-31 Open-Core 架构拆分）Enterprise 商业专有模块：机构多店合并
// 阳光台账导出（跨店遍历、总览 Sheet 聚合、存证核验码生成），对应
// utils/enterpriseSpi.ts 里的 IBatchExportService 契约。这是"审计增值服务"
// 付费层能力，一个只跑 Core 的单店部署不需要、也不应该加载本文件。
//
// 🛡️ 依赖方向：本文件依赖 Core 的 exportSingleStoreExcel.js（复用
// addRecordsSheet/uploadWorkbookAndRespond），符合"Enterprise 可以依赖
// Core，Core 绝不能依赖 Enterprise"的 Open-Core 拆分方向约束。
const ExcelJS = require('exceljs');
const crypto = require('crypto');
const { HEADER_STYLE, CELL_STYLE, NUMBER_STYLE, INCOME_STYLE, EXPENSE_STYLE, TOTAL_STYLE } = require('./excelStyles');
const { addRecordsSheet, uploadWorkbookAndRespond } = require('./exportSingleStoreExcel');

// 🏛️（2026-08-31 商业化权益中心）机构多店合并导出是"审计增值服务"付费层
// 能力，与 cloudfunctions/getNationalDashboard 的 subscriptionQuota.features.
// canExportNationalExcel 判断口径必须一致——各云函数独立部署，无共享模块
// 机制，这是本仓库一贯做法（同一份 tenant_subscriptions 查询/宽限期逻辑，
// 在 checkTenantPermission/getNationalDashboard/本文件各自维护一份拷贝）
const SUBSCRIPTION_GRACE_PERIOD_DAYS = 7;

// 判断该机构当前是否为未到期的 pro/enterprise 档——只做"是/否"判断，不需要
// 像 checkTenantPermission 那样返回完整的展示字段（storeLimit/expireDateText
// 等），这里只服务于 isNationalExport 的服务端硬校验
async function isAdvancedPlanActive(db, tenantId) {
  try {
    const subRes = await db.collection('tenant_subscriptions')
      .where({ tenantId })
      .orderBy('lastRenewedAt', 'desc')
      .limit(1)
      .get();
    const sub = subRes.data && subRes.data[0];
    if (!sub) return false;
    const expireTime = sub.serviceExpireDate ? new Date(sub.serviceExpireDate).getTime() : NaN;
    const rawExpired = !Number.isNaN(expireTime) && expireTime < Date.now();
    const graceDeadline = rawExpired ? expireTime + SUBSCRIPTION_GRACE_PERIOD_DAYS * 24 * 3600 * 1000 : null;
    const isInGracePeriod = rawExpired && graceDeadline !== null && graceDeadline >= Date.now();
    const isExpired = rawExpired && !isInGracePeriod;
    if (isExpired) return false;
    return sub.planType === 'pro' || sub.planType === 'enterprise';
  } catch (err) {
    // tenant_subscriptions 集合可能尚未创建（该机构从未触发过任何订阅写入），
    // 视为未开通高级套餐
    return false;
  }
}

// 🌟 存证核验签名：对本次导出的机构合计摘要（不含逐条明细，逐条明细的
// 防篡改由 report_logs._checksum 各自负责，见 stampReportChecksum）计算
// 一次 SHA-256 摘要，截取前 16 位十六进制作为人工可誊抄核对的"校验码"。
// 目的是给理事会/民政核对提供一个"文件有没有被中途替换/篡改"的锚点，不是
// 加密学意义上不可伪造的数字签名——收到者可以要求出具方重新生成同一批
// 摘要数据对应的校验码核对是否一致
function generateVerificationCode(payload) {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16).toUpperCase();
}

// 🆕 机构合并台账「总览」Sheet：一店一行 + 机构合计行，插在工作簿最前面
// （exceljs 按 addWorksheet 调用顺序排 Tab，先建总览 Sheet 就会排在第一个），
// 方便理事会/民政打开文件第一眼先看全局，再按需翻到具体门店的明细 Sheet
function addSummarySheet(workbook, storeTotalsList, grandTotal, meta) {
  const worksheet = workbook.addWorksheet('总览', { properties: { defaultColWidth: 14 } });

  worksheet.mergeCells('A1:H1');
  const titleCell = worksheet.getCell('A1');
  titleCell.value = `${meta.tenantName || '本机构'} · 多店合并阳光台账（${meta.periodLabel}）`;
  titleCell.font = { bold: true, size: 14, color: { argb: 'FFD9480E' } };
  titleCell.alignment = { horizontal: 'left', vertical: 'middle' };
  worksheet.getRow(1).height = 30;

  worksheet.addRow([`统计区间：${meta.startDateStr} 至 ${meta.endDateStr}`]);
  worksheet.addRow([`生成时间：${meta.generatedAt}`]);
  // 🆕 存证核验签名：见 generateVerificationCode 注释，供收件方核对这份台账
  // 与系统生成的原始摘要是否一致，防止文件在传阅过程中被篡改替换
  worksheet.addRow([`存证核验码：${meta.verificationCode}`]);
  worksheet.addRow([]);

  const theadRow = worksheet.addRow(['门店名称', '爱心收入(元)', '日常食材(元)', '房租专项(元)', '总支出(元)', '净盈亏(元)', '用餐人次', '记录数']);
  theadRow.height = 26;
  theadRow.eachCell((cell) => { cell.style = HEADER_STYLE; });

  storeTotalsList.forEach(s => {
    const row = worksheet.addRow([
      s.shopName,
      Number(s.totalIncome.toFixed(2)),
      Number(s.totalDaily.toFixed(2)),
      Number(s.totalLarge.toFixed(2)),
      Number(s.totalExpense.toFixed(2)),
      Number((s.totalIncome - s.totalExpense).toFixed(2)),
      s.totalDiners,
      s.recordCount
    ]);
    row.eachCell((cell, colNumber) => {
      if (colNumber === 2 || colNumber === 6) {
        cell.style = INCOME_STYLE;
        cell.numFmt = '#,##0.00';
      } else if (colNumber >= 3 && colNumber <= 5) {
        cell.style = EXPENSE_STYLE;
        cell.numFmt = '#,##0.00';
      } else if (colNumber === 7 || colNumber === 8) {
        cell.style = NUMBER_STYLE;
      } else {
        cell.style = CELL_STYLE;
      }
    });
  });

  const grandRow = worksheet.addRow([
    `机构合计（${storeTotalsList.length} 家门店）`,
    Number(grandTotal.totalIncome.toFixed(2)),
    Number(grandTotal.totalDaily.toFixed(2)),
    Number(grandTotal.totalLarge.toFixed(2)),
    Number(grandTotal.totalExpense.toFixed(2)),
    Number((grandTotal.totalIncome - grandTotal.totalExpense).toFixed(2)),
    grandTotal.totalDiners,
    grandTotal.recordCount
  ]);
  grandRow.height = 28;
  grandRow.eachCell((cell, colNumber) => {
    cell.style = colNumber === 1
      ? { ...TOTAL_STYLE, alignment: { horizontal: 'left', vertical: 'middle' } }
      : { ...TOTAL_STYLE };
    if (colNumber >= 2 && colNumber <= 6) {
      cell.numFmt = '#,##0.00';
    }
  });

  worksheet.views = [{ state: 'frozen', ySplit: 5 }];
}

// Enterprise 多店合并导出主流程：给定已经查询好的全机构 records，按门店分组
// 各建一个 Sheet（复用 Core 的 addRecordsSheet），外加一张总览 Sheet + 存证
// 核验码，完成上传并返回最终响应体
async function buildNationalExport(cloud, db, { tenantId, records, periodLabel, startDateStr, endDateStr }) {
  const tenantRes = await db.collection('tenants').doc(tenantId).field({ name: true }).get().catch(() => null);
  const tenantName = (tenantRes && tenantRes.data && tenantRes.data.name) || '本机构';

  const workbook = new ExcelJS.Workbook();
  workbook.creator = '雨花斋爱心账本';
  workbook.created = new Date();

  const groupedByStore = {};
  const storeOrder = [];
  records.forEach(r => {
    const name = r.shopName || '未命名门店';
    if (!groupedByStore[name]) {
      groupedByStore[name] = [];
      storeOrder.push(name);
    }
    groupedByStore[name].push(r);
  });

  let totalIncome = 0;
  let totalDaily = 0;
  let totalLarge = 0;
  let totalExpense = 0;
  let totalDiners = 0;
  let totalVolunteers = 0;
  let totalVolHours = 0;
  let totalMaterialsCount = 0;

  const storeTotalsList = [];
  storeOrder.forEach(name => {
    const storeRecords = groupedByStore[name];
    const totals = addRecordsSheet(workbook, `${name}`, storeRecords);
    storeTotalsList.push({ shopName: name, ...totals });

    totalIncome += totals.totalIncome;
    totalDaily += totals.totalDaily;
    totalLarge += totals.totalLarge;
    totalExpense += totals.totalExpense;
    totalDiners += totals.totalDiners;
    totalVolunteers += totals.totalVolunteers;
    totalVolHours += totals.totalVolHours;
    totalMaterialsCount += totals.totalMaterialsCount;
  });

  const nowStrForCode = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(new Date());

  const verificationCode = generateVerificationCode({
    tenantId,
    periodLabel,
    startDateStr,
    endDateStr,
    storeCount: storeOrder.length,
    totalIncome: Number(totalIncome.toFixed(2)),
    totalExpense: Number(totalExpense.toFixed(2)),
    recordCount: records.length,
    generatedAt: nowStrForCode
  });

  // 🆕 总览 Sheet 需要在明细 Sheet 之前建好才会排在第一个 Tab——但
  // addSummarySheet 依赖上面逐店 addRecordsSheet 算出的 storeTotalsList，
  // 只能后建。exceljs 支持通过 orderNo 手动指定 Tab 顺序，避免为了排序
  // 硬拆成"先占位再填内容"这种更绕的写法
  addSummarySheet(workbook, storeTotalsList, {
    totalIncome, totalDaily, totalLarge, totalExpense, totalDiners, recordCount: records.length
  }, {
    tenantName, periodLabel, startDateStr, endDateStr, generatedAt: nowStrForCode, verificationCode
  });
  // 把总览 Sheet 挪到第一个 Tab 位置（exceljs workbook.worksheets 数组
  // 顺序即 Tab 顺序，orderNo 越小越靠前）
  workbook.worksheets.forEach((ws, idx) => {
    ws.orderNo = ws.name === '总览' ? 0 : idx + 1;
  });

  const safeStoreName = tenantName.replace(/[\\/:*?"<>|]/g, '');

  return uploadWorkbookAndRespond(cloud, workbook, {
    fileLabel: '多店合并阳光台账',
    safeStoreName,
    periodLabel,
    startDateStr,
    endDateStr,
    totalIncome,
    totalExpense,
    totalDiners,
    totalMaterialsCount,
    recordCount: records.length,
    isNationalExport: true,
    verificationCode
  });
}

module.exports = { buildNationalExport, isAdvancedPlanActive };
