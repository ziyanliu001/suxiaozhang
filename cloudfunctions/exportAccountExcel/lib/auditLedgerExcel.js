// 🏛️（2026-09-03 审计级台账升级）Core 拟开源组件：单店"公益业务收支与资产
// 台账"三工作表审计级 Excel 构建，对标《民间非营利组织会计制度》及公益业务
// 底稿抽查规范。与 exportSingleStoreExcel.js 的关系：
//   - addRecordsSheet/uploadWorkbookAndRespond（exportSingleStoreExcel.js）
//     是 Enterprise 多店合并导出（exportNationalExcel.js）反向依赖的"扁平流水
//     表"契约，绝不能改动其行为，否则会破坏 Enterprise 侧的"每店一个 Sheet"
//     合并导出。
//   - 本文件是单店导出（buildSingleStoreExport）改走的新实现，只反向复用
//     uploadWorkbookAndRespond 做文件上传/响应体组装（该函数只依赖聚合数字，
//     对工作表内部结构无感知，复用安全），不复用 addRecordsSheet。
//
// 🛡️ 依赖方向与 exportSingleStoreExcel.js 保持一致：本文件不 require 任何
// Enterprise 模块。
//
// 📋 数据诚实性约束（本文件多处遵循）：系统当前没有采集"结算方式"（微信/
// 现金/转账）、没有逐笔"票据类型"（增值税发票/定额发票/农贸市场收据）分类、
// 也没有物资库存的实物盘点基线——本文件绝不为了填满审计模板列而编造这些数据，
// 缺失处一律显示"-"或明确的说明文字，并在台账附注中如实披露，而不是让审计
// 抽查方误以为这是经过盘点/分类的真实数据。
const ExcelJS = require('exceljs');
const {
  AUDIT_TITLE_STYLE, AUDIT_SUBTITLE_STYLE, AUDIT_META_LABEL_STYLE, AUDIT_HEADER_STYLE,
  AUDIT_CELL_STYLE, AUDIT_NUMBER_STYLE, AUDIT_DATE_STYLE, AUDIT_TOTAL_STYLE,
  AUDIT_SIGNATURE_STYLE, AUDIT_NOTE_STYLE
} = require('./excelStyles');

const COLS = 10; // 三张工作表统一 10 列（A~J），头部/尾部合并区按此宽度铺满
const LAST_COL_LETTER = 'J';

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function nowInShanghai() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());
}

// 🌾 库存/消耗跟踪目前只覆盖大米/面粉/食用油/蔬菜四大主粮品类（与
// manageVolunteerSubmission writeMaterialLog 的固定字段一致），单位固定"斤"。
// 捐入物资是自由文本录入（parser.ts parseMaterials），这里用关键词粗分类，
// 且只在单位包含"斤"时才计入四大品类的数量累计——避免"50斤"与"2箱"被直接相加
// 得出没有物理意义的数字
const STAPLE_CATEGORIES = [
  { key: 'rice', label: '大米' },
  { key: 'flour', label: '面粉' },
  { key: 'oil', label: '食用油' },
  { key: 'vegetable', label: '蔬菜' }
];

function classifyStapleCategory(itemName) {
  const name = String(itemName || '');
  if (/大米|米(?!粉|线|醋)/.test(name)) return 'rice';
  if (/面粉|白面/.test(name)) return 'flour';
  if (/食用油|(?:^|[^蔬青])油(?!条|菜|麦)/.test(name)) return 'oil';
  if (/蔬菜|青菜|白菜|时蔬/.test(name)) return 'vegetable';
  return null;
}

function isJinUnit(unit) {
  return /斤/.test(String(unit || ''));
}

// 👤 逐笔"经办人"：批量把 report_logs 记录里的 _openid 解析成 user_roles.nickName，
// 分片查询（微信数据库 command.in 单次数量有限制），查不到时退化为脱敏 openid 尾号
async function resolveOperatorNames(db, records) {
  const _ = db.command;
  const openids = Array.from(new Set(records.map(r => r._openid).filter(Boolean)));
  const nameMap = {};
  if (openids.length === 0) return nameMap;
  const chunks = chunkArray(openids, 20);
  for (const chunk of chunks) {
    try {
      const res = await db.collection('user_roles').where({ _openid: _.in(chunk) }).field({ _openid: true, nickName: true }).get();
      (res.data || []).forEach(row => {
        if (row._openid) nameMap[row._openid] = row.nickName || '';
      });
    } catch (err) {
      console.warn('[auditLedgerExcel] 批量解析经办人昵称失败，跳过该批:', err);
    }
  }
  return nameMap;
}

function operatorDisplayName(nameMap, openid) {
  if (!openid) return '-';
  const name = nameMap[openid];
  if (name) return name;
  return `微信用户-${String(openid).slice(-6)}`;
}

// 🖼️ 凭证影像：report 级 receiptImages/receiptImageList（日常食材共用票据）+
// fixedExpenseItems[].independent_image_urls（大额专项逐笔独立票据）两类
// cloud:// fileID 统一解析成可点击打开的临时 HTTPS 链接。cloud.getTempFileURL
// 单次调用有数量上限，分片请求
async function resolveReceiptUrls(cloud, records) {
  const fileIdSet = new Set();
  records.forEach(record => {
    const shared = (Array.isArray(record.receiptImages) && record.receiptImages.length > 0)
      ? record.receiptImages
      : (Array.isArray(record.receiptImageList) ? record.receiptImageList : []);
    shared.forEach(f => { if (f) fileIdSet.add(f); });
    if (Array.isArray(record.fixedExpenseItems)) {
      record.fixedExpenseItems.forEach(item => {
        if (Array.isArray(item.independent_image_urls)) {
          item.independent_image_urls.forEach(f => { if (f) fileIdSet.add(f); });
        }
      });
    }
  });

  const urlMap = {};
  const fileIds = Array.from(fileIdSet);
  if (fileIds.length === 0) return urlMap;
  const chunks = chunkArray(fileIds, 50);
  for (const chunk of chunks) {
    try {
      const res = await cloud.getTempFileURL({ fileList: chunk });
      (res.fileList || []).forEach(item => {
        if (item.fileID && item.tempFileURL) urlMap[item.fileID] = item.tempFileURL;
      });
    } catch (err) {
      console.warn('[auditLedgerExcel] 批量解析凭证影像链接失败，跳过该批:', err);
    }
  }
  return urlMap;
}

// 📋 头部元数据区（第 1~4 行）：主标题（合并 A~J）/ 副标题（合并 A~J）/
// 基本要素行（核算期间·填报站点·币种·导出时间，4 组 label+value）/ 空行留白。
// 返回值：正文列头应从第几行开始写（固定 5）
function addHeaderMetaRows(worksheet, { mainTitle, subtitle, periodLabel, startDateStr, endDateStr, storeName, exportTimeStr }) {
  worksheet.mergeCells(`A1:${LAST_COL_LETTER}1`);
  const titleCell = worksheet.getCell('A1');
  titleCell.value = mainTitle;
  titleCell.style = AUDIT_TITLE_STYLE;
  worksheet.getRow(1).height = 30;

  worksheet.mergeCells(`A2:${LAST_COL_LETTER}2`);
  const subtitleCell = worksheet.getCell('A2');
  subtitleCell.value = subtitle;
  subtitleCell.style = AUDIT_SUBTITLE_STYLE;
  worksheet.getRow(2).height = 18;

  const metaRow = worksheet.getRow(3);
  metaRow.height = 20;
  const periodText = periodLabel ? `${periodLabel}（${startDateStr} 至 ${endDateStr}）` : `${startDateStr} 至 ${endDateStr}`;
  worksheet.getCell('A3').value = '核算期间：';
  worksheet.mergeCells('B3:C3');
  worksheet.getCell('B3').value = periodText;
  worksheet.getCell('D3').value = '填报站点：';
  worksheet.mergeCells('E3:F3');
  worksheet.getCell('E3').value = storeName || '-';
  worksheet.getCell('G3').value = '币种：';
  worksheet.getCell('H3').value = '人民币元';
  worksheet.getCell('I3').value = '导出时间：';
  worksheet.getCell('J3').value = exportTimeStr;
  ['A3', 'B3', 'C3', 'D3', 'E3', 'F3', 'G3', 'H3', 'I3', 'J3'].forEach(ref => {
    const cell = worksheet.getCell(ref);
    const isLabel = ref === 'A3' || ref === 'D3' || ref === 'G3' || ref === 'I3';
    cell.style = isLabel ? AUDIT_META_LABEL_STYLE : { font: { size: 10 }, alignment: { horizontal: 'left', vertical: 'middle' } };
  });

  worksheet.getRow(4).height = 6; // 留白分隔行

  return 5; // 列头行号
}

// ✍️ 尾部审计区：空行 → 合计行（真实 SUM/SUMIF 公式）→ 空行 → 签署问责行
// （制表人/复核人财务/负责人店长/批次号）→ 空行 → 底部诚信附注。startRow 是
// 数据区最后一行的下一行；返回最终写到的行号
function addSignatureBlock(worksheet, { afterRow, batchId, extraNoteLines }) {
  let row = afterRow + 1; // 空行

  row += 1;
  const sigRow = worksheet.getRow(row);
  worksheet.mergeCells(`A${row}:C${row}`);
  worksheet.mergeCells(`D${row}:F${row}`);
  worksheet.mergeCells(`G${row}:H${row}`);
  worksheet.mergeCells(`I${row}:${LAST_COL_LETTER}${row}`);
  worksheet.getCell(`A${row}`).value = '制表人：_____________';
  worksheet.getCell(`D${row}`).value = '复核人/财务：_____________';
  worksheet.getCell(`G${row}`).value = '负责人/店长：_____________';
  worksheet.getCell(`I${row}`).value = `生成批次号：${batchId}`;
  [`A${row}`, `D${row}`, `G${row}`, `I${row}`].forEach(ref => {
    worksheet.getCell(ref).style = AUDIT_SIGNATURE_STYLE;
  });
  sigRow.height = 20;

  row += 2; // 空行
  worksheet.mergeCells(`A${row}:${LAST_COL_LETTER}${row}`);
  worksheet.getCell(`A${row}`).value = '注：本台账经本店店长与财务审核确认，所附流水与凭证影像真实有效，作为民间非营利组织原始业务核算与审计备查底稿。';
  worksheet.getCell(`A${row}`).style = AUDIT_NOTE_STYLE;
  worksheet.getRow(row).height = 24;

  if (Array.isArray(extraNoteLines) && extraNoteLines.length > 0) {
    extraNoteLines.forEach(line => {
      row += 1;
      worksheet.mergeCells(`A${row}:${LAST_COL_LETTER}${row}`);
      worksheet.getCell(`A${row}`).value = line;
      worksheet.getCell(`A${row}`).style = AUDIT_NOTE_STYLE;
      worksheet.getRow(row).height = 22;
    });
  }

  return row;
}

function setAuditColumns(worksheet, widths) {
  widths.forEach((w, idx) => {
    worksheet.getColumn(idx + 1).width = w;
  });
}

function writeHeaderCells(worksheet, rowIndex, labels) {
  const row = worksheet.getRow(rowIndex);
  row.height = 30;
  labels.forEach((label, idx) => {
    const cell = row.getCell(idx + 1);
    cell.value = label;
    cell.style = AUDIT_HEADER_STYLE;
  });
}

// ============ Sheet1: Cash_Flow ============
function buildCashFlowSheet(workbook, { records, operatorNameMap, receiptUrlMap, storeName, periodLabel, startDateStr, endDateStr, exportTimeStr, batchId }) {
  const worksheet = workbook.addWorksheet('Cash_Flow', { properties: { defaultColWidth: 14 } });
  setAuditColumns(worksheet, [6, 12, 12, 24, 12, 12, 14, 14, 26, 22]);

  const headerRowIndex = addHeaderMetaRows(worksheet, {
    mainTitle: `【${storeName}】公益业务收支与资产台账 —— 现金流水明细`,
    subtitle: '本表依据《民间非营利组织会计制度》及公益台账核算规范生成',
    periodLabel, startDateStr, endDateStr, storeName, exportTimeStr
  });

  writeHeaderCells(worksheet, headerRowIndex, [
    '序号', '日期', '收支类型', '核算科目', '金额(元)', '结算方式', '经办人', '票据类型', '凭证编号/影像索引', '审核状态与审核人'
  ]);

  const dataStartRow = headerRowIndex + 1;
  let seq = 0;
  let totalIncome = 0;
  let totalExpense = 0;

  function auditStatusText(record) {
    if (record.isFinanceAudited && record.isLocked) {
      const by = record.auditedBy || record.approvedBy || '-';
      return `已审核·已锁定${by !== '-' ? '（' + by + '）' : ''}`;
    }
    if (record.isManagerConfirmed || record.approvalStatus === 'APPROVED') {
      const by = record.approvedBy || '-';
      return `店长已确认·待财务复核${by !== '-' ? '（' + by + '）' : ''}`;
    }
    return '待审核';
  }

  function addLedgerRow({ dateStr, incomeExpenseType, subject, amount, voucherType, voucherUrl, voucherExtraCount, record }) {
    seq += 1;
    const row = worksheet.addRow([
      seq,
      dateStr,
      incomeExpenseType,
      subject,
      Number((amount || 0).toFixed(2)),
      '-',
      operatorDisplayName(operatorNameMap, record._openid),
      voucherType,
      '',
      auditStatusText(record)
    ]);
    row.height = 20;
    row.eachCell((cell, colNumber) => {
      if (colNumber === 2) cell.style = AUDIT_DATE_STYLE;
      else if (colNumber === 5) cell.style = AUDIT_NUMBER_STYLE;
      else cell.style = AUDIT_CELL_STYLE;
    });
    const voucherCell = row.getCell(9);
    if (voucherUrl) {
      voucherCell.value = { text: `查看凭证${voucherExtraCount ? '(+' + voucherExtraCount + '张)' : ''}`, hyperlink: voucherUrl };
      voucherCell.font = { size: 10, color: { argb: 'FF1971C2' }, underline: true };
    } else {
      voucherCell.value = `记录ID:${record._id || '-'}`;
    }
    voucherCell.style = { ...AUDIT_CELL_STYLE, ...voucherCell.style };
  }

  records.forEach(record => {
    const dateStr = record.dateString || '';

    // —— 收入：捐赠收入 ——
    if (Array.isArray(record.donationItems) && record.donationItems.length > 0) {
      record.donationItems.forEach(d => {
        const amt = parseFloat(d.amount) || 0;
        if (amt <= 0) return;
        totalIncome += amt;
        const donorLabel = d.isAnonymous ? '匿名' : (d.name || '匿名');
        addLedgerRow({
          dateStr, incomeExpenseType: '捐赠收入', subject: `非限定性随喜收入（${donorLabel}）`,
          amount: amt, voucherType: '随喜捐赠(系统记录)', voucherUrl: '', record
        });
      });
    }
    const otherDonation = parseFloat(record.otherDonation) || 0;
    if (otherDonation > 0) {
      totalIncome += otherDonation;
      addLedgerRow({
        dateStr, incomeExpenseType: '捐赠收入', subject: '非限定性随喜收入（其他/汇总）',
        amount: otherDonation, voucherType: '随喜捐赠(系统记录)', voucherUrl: '', record
      });
    }

    // —— 支出：业务活动成本（日常食材）——
    const sharedReceipts = (Array.isArray(record.receiptImages) && record.receiptImages.length > 0)
      ? record.receiptImages
      : (Array.isArray(record.receiptImageList) ? record.receiptImageList : []);
    const sharedFirstUrl = sharedReceipts.length > 0 ? receiptUrlMap[sharedReceipts[0]] : '';
    const sharedVoucherType = sharedReceipts.length > 0 ? '有影像凭证' : '无凭证影像';

    if (Array.isArray(record.dailyIngredientItems) && record.dailyIngredientItems.length > 0) {
      record.dailyIngredientItems.forEach(item => {
        const amt = parseFloat(item.amount) || 0;
        if (amt <= 0) return;
        totalExpense += amt;
        addLedgerRow({
          dateStr, incomeExpenseType: '业务活动成本', subject: `食材采买-${item.title || '未命名'}`,
          amount: amt, voucherType: sharedVoucherType, voucherUrl: sharedFirstUrl,
          voucherExtraCount: sharedReceipts.length > 1 ? sharedReceipts.length - 1 : 0, record
        });
      });
    } else {
      const dailyExp = parseFloat(record.dailyExpenseTotal) || 0;
      if (dailyExp > 0) {
        totalExpense += dailyExp;
        addLedgerRow({
          dateStr, incomeExpenseType: '业务活动成本', subject: '食材采买（汇总）',
          amount: dailyExp, voucherType: sharedVoucherType, voucherUrl: sharedFirstUrl,
          voucherExtraCount: sharedReceipts.length > 1 ? sharedReceipts.length - 1 : 0, record
        });
      }
    }

    // —— 支出：公用经费（大额专项，如房租水电）——
    if (Array.isArray(record.fixedExpenseItems) && record.fixedExpenseItems.length > 0) {
      record.fixedExpenseItems.forEach(item => {
        const amt = parseFloat(item.amount) || 0;
        if (amt <= 0) return;
        totalExpense += amt;
        const imgs = Array.isArray(item.independent_image_urls) ? item.independent_image_urls : [];
        const firstUrl = imgs.length > 0 ? receiptUrlMap[imgs[0]] : '';
        addLedgerRow({
          dateStr, incomeExpenseType: '公用经费', subject: `公用经费-${item.name || '未命名'}`,
          amount: amt, voucherType: imgs.length > 0 ? '有影像凭证' : '无凭证影像',
          voucherUrl: firstUrl, voucherExtraCount: imgs.length > 1 ? imgs.length - 1 : 0, record
        });
      });
    } else if (Array.isArray(record.majorExpenseItems) && record.majorExpenseItems.length > 0) {
      record.majorExpenseItems.forEach(item => {
        const amt = parseFloat(item.amount) || 0;
        if (amt <= 0) return;
        totalExpense += amt;
        addLedgerRow({
          dateStr, incomeExpenseType: '公用经费', subject: `公用经费-${item.title || '未命名'}`,
          amount: amt, voucherType: sharedVoucherType, voucherUrl: sharedFirstUrl, record
        });
      });
    } else {
      const fixedExp = parseFloat(record.fixedExpenseTotal) || 0;
      if (fixedExp > 0) {
        totalExpense += fixedExp;
        addLedgerRow({
          dateStr, incomeExpenseType: '公用经费', subject: '公用经费（汇总）',
          amount: fixedExp, voucherType: sharedVoucherType, voucherUrl: sharedFirstUrl, record
        });
      }
    }
  });

  const dataEndRow = dataStartRow + seq - 1;
  const safeEndRow = seq > 0 ? dataEndRow : dataStartRow; // 无明细行时公式区间仍合法

  // 合计区：真实 SUM/SUMIF 公式，收入合计/支出合计/净额三行，分开呈现避免
  // 收支金额混合相加得出没有意义的数字
  let row = safeEndRow + 1;
  const incomeRow = row + 1;
  worksheet.getCell(`D${incomeRow}`).value = '收支合计 —— 收入合计';
  worksheet.getCell(`E${incomeRow}`).value = { formula: `SUMIF(C${dataStartRow}:C${safeEndRow},"捐赠收入",E${dataStartRow}:E${safeEndRow})` };
  const expenseRow = incomeRow + 1;
  worksheet.getCell(`D${expenseRow}`).value = '支出合计（业务活动成本+公用经费）';
  worksheet.getCell(`E${expenseRow}`).value = {
    formula: `SUMIF(C${dataStartRow}:C${safeEndRow},"业务活动成本",E${dataStartRow}:E${safeEndRow})+SUMIF(C${dataStartRow}:C${safeEndRow},"公用经费",E${dataStartRow}:E${safeEndRow})`
  };
  const netRow = expenseRow + 1;
  worksheet.getCell(`D${netRow}`).value = '净额（收入-支出）';
  worksheet.getCell(`E${netRow}`).value = { formula: `E${incomeRow}-E${expenseRow}` };
  [incomeRow, expenseRow, netRow].forEach(r => {
    worksheet.getRow(r).height = 20;
    for (let c = 1; c <= COLS; c++) {
      const cell = worksheet.getCell(r, c);
      cell.style = c === 5 ? AUDIT_TOTAL_STYLE : { ...AUDIT_TOTAL_STYLE, alignment: { horizontal: c === 4 ? 'right' : 'left', vertical: 'middle' } };
    }
  });

  const lastAggRow = addSignatureBlock(worksheet, {
    afterRow: netRow, batchId,
    extraNoteLines: ['注：本表"结算方式"（微信支付/现金/转账）与"票据类型"细分（增值税发票/定额发票/农贸市场收据）系统当前未按笔采集，标注"-"处需结合原始凭证线下核实，不构成系统自动分类结论。']
  });

  worksheet.views = [{ state: 'frozen', ySplit: headerRowIndex }];

  return { totalIncome, totalExpense, recordCount: records.length, lastRow: lastAggRow };
}

// ============ Sheet2: Material_Inventory ============
async function buildMaterialInventorySheet(workbook, { db, storeId, tenantId, records, startDateStr, endDateStr, storeName, periodLabel, exportTimeStr, batchId }) {
  const worksheet = workbook.addWorksheet('Material_Inventory', { properties: { defaultColWidth: 14 } });
  setAuditColumns(worksheet, [6, 20, 16, 12, 12, 12, 12, 12, 22, 16]);

  const headerRowIndex = addHeaderMetaRows(worksheet, {
    mainTitle: `【${storeName}】公益业务收支与资产台账 —— 物资捐赠与库存`,
    subtitle: '本表依据《民间非营利组织会计制度》及公益台账核算规范生成',
    periodLabel, startDateStr, endDateStr, storeName, exportTimeStr
  });

  writeHeaderCells(worksheet, headerRowIndex, [
    '序号', '日期', '物资品名', '规格单位', '期初结存', '本期爱心捐入', '本期厨房消耗', '期末盘点结存', '捐赠人(公示名/匿名)', '经手保管人'
  ]);

  const dataStartRow = headerRowIndex + 1;
  const _ = db.command;
  let baselineLogs = [];
  let periodLogs = [];
  let baselineHitCap = false;
  // 🛡️ 与 CLAUDE.md 多租户隔离原则一致：storeId 主键本身已唯一定位到租户，
  // 这里额外叠加 tenantId 收敛是防御性纵深，防止任何未来重构让 storeId 变得
  // 可跨租户重复时查询静默退化成跨租户聚合
  try {
    const [baselineRes, periodRes] = await Promise.all([
      db.collection('material_logs').where({ storeId, tenantId, dateString: _.lt(startDateStr) }).limit(3000).get(),
      db.collection('material_logs').where({ storeId, tenantId, dateString: _.gte(startDateStr).and(_.lte(endDateStr)) }).limit(2000).get()
    ]);
    baselineLogs = baselineRes.data || [];
    periodLogs = periodRes.data || [];
    baselineHitCap = baselineLogs.length >= 3000;
  } catch (err) {
    console.warn('[auditLedgerExcel] 查询 material_logs 消耗记录失败，本期消耗按 0 处理:', err);
  }

  let baselineDonationRecords = [];
  let baselineDonationHitCap = false;
  try {
    const baselineDonationRes = await db.collection('report_logs')
      .where({ storeId, tenantId, dateString: _.lt(startDateStr), isVoid: _.neq(true) })
      .field({ materials: true })
      .limit(3000)
      .get();
    baselineDonationRecords = baselineDonationRes.data || [];
    baselineDonationHitCap = baselineDonationRecords.length >= 3000;
  } catch (err) {
    console.warn('[auditLedgerExcel] 查询历史物资捐赠基线失败，期初捐入按 0 处理:', err);
  }

  const staple = {};
  STAPLE_CATEGORIES.forEach(c => {
    staple[c.key] = { baselineIn: 0, baselineOut: 0, periodIn: 0, periodOut: 0, donors: new Set(), keeper: '', keeperTime: '' };
  });

  baselineLogs.forEach(log => {
    staple.rice.baselineOut += parseFloat(log.riceCount) || 0;
    staple.flour.baselineOut += parseFloat(log.flourCount) || 0;
    staple.oil.baselineOut += parseFloat(log.oilCount) || 0;
    staple.vegetable.baselineOut += parseFloat(log.vegetableCount) || 0;
  });
  periodLogs.forEach(log => {
    staple.rice.periodOut += parseFloat(log.riceCount) || 0;
    staple.flour.periodOut += parseFloat(log.flourCount) || 0;
    staple.oil.periodOut += parseFloat(log.oilCount) || 0;
    staple.vegetable.periodOut += parseFloat(log.vegetableCount) || 0;
    const t = log.createTime ? String(log.createTime) : '';
    ['rice', 'flour', 'oil', 'vegetable'].forEach(key => {
      if (t >= staple[key].keeperTime) {
        staple[key].keeperTime = t;
        staple[key].keeper = log.submittedByName || staple[key].keeper;
      }
    });
  });

  function classifyMaterialsInto(materialsArr, targetBucket, otherAggMap) {
    if (!Array.isArray(materialsArr)) return;
    materialsArr.forEach(m => {
      const qty = parseFloat(m.quantity) || 0;
      if (qty <= 0) return;
      const cat = classifyStapleCategory(m.item);
      if (cat && isJinUnit(m.unit)) {
        targetBucket[cat] += qty;
        if (m.donor) staple[cat].donors.add(m.donor);
      } else if (otherAggMap) {
        const key = `${m.item || '未命名物资'}__${m.unit || ''}`;
        if (!otherAggMap[key]) otherAggMap[key] = { item: m.item || '未命名物资', unit: m.unit || '', qty: 0, donors: new Set() };
        otherAggMap[key].qty += qty;
        if (m.donor) otherAggMap[key].donors.add(m.donor);
      }
    });
  }

  const baselineInBucket = { rice: 0, flour: 0, oil: 0, vegetable: 0 };
  baselineDonationRecords.forEach(r => classifyMaterialsInto(r.materials, baselineInBucket, null));
  const periodInBucket = { rice: 0, flour: 0, oil: 0, vegetable: 0 };
  const otherAggMap = {};
  records.forEach(r => classifyMaterialsInto(r.materials, periodInBucket, otherAggMap));

  let seq = 0;
  const periodRangeText = `${startDateStr}~${endDateStr}`;

  STAPLE_CATEGORIES.forEach(cat => {
    seq += 1;
    const s = staple[cat.key];
    const openBal = baselineInBucket[cat.key] - s.baselineOut;
    const periodIn = periodInBucket[cat.key];
    const periodOut = s.periodOut;
    const donorText = s.donors.size > 0 ? Array.from(s.donors).slice(0, 5).join('、') + (s.donors.size > 5 ? ` 等${s.donors.size}人` : '') : '本期无捐入记录';

    const row = worksheet.addRow([
      seq, periodRangeText, cat.label, '斤',
      Number(openBal.toFixed(2)), Number(periodIn.toFixed(2)), Number(periodOut.toFixed(2)), null,
      donorText, s.keeper || '-'
    ]);
    row.height = 20;
    row.eachCell((cell, colNumber) => {
      if ([5, 6, 7, 8].includes(colNumber)) cell.style = AUDIT_NUMBER_STYLE;
      else cell.style = AUDIT_CELL_STYLE;
    });
    row.getCell(8).value = { formula: `E${row.number}+F${row.number}-G${row.number}` };
  });

  Object.keys(otherAggMap).forEach(key => {
    const agg = otherAggMap[key];
    seq += 1;
    const donorText = agg.donors.size > 0 ? Array.from(agg.donors).slice(0, 5).join('、') + (agg.donors.size > 5 ? ` 等${agg.donors.size}人` : '') : '匿名';
    const row = worksheet.addRow([
      seq, periodRangeText, agg.item, agg.unit || '-',
      '不适用', Number(agg.qty.toFixed(2)), '未纳入系统消耗跟踪', '不适用',
      donorText, '-'
    ]);
    row.height = 20;
    row.eachCell((cell, colNumber) => {
      if (colNumber === 6) cell.style = AUDIT_NUMBER_STYLE;
      else cell.style = AUDIT_CELL_STYLE;
    });
  });

  const dataEndRow = dataStartRow + seq - 1;
  const notes = [
    '注：期初/期末结存为系统按捐入-消耗滚动推算的账面数，非现场实物盘点数，如与实际库存有差异请以现场盘点为准并在下方签署处注明。',
    '注：物资品名/规格单位来自门店自由文本录入与语音识别，同名不同计量单位（如"斤"与"箱"）不做数量合并，分行列示。'
  ];
  if (baselineHitCap || baselineDonationHitCap) {
    notes.push('注：本店历史记录量较大，期初结存的历史基线查询已达系统上限（3000 条），期初数可能不完整，建议结合门店纸质台账核对。');
  }
  const lastRow = addSignatureBlock(worksheet, { afterRow: dataEndRow > 0 ? dataEndRow : dataStartRow, batchId, extraNoteLines: notes });

  worksheet.views = [{ state: 'frozen', ySplit: headerRowIndex }];

  return { materialsCount: seq, lastRow };
}

// ============ Sheet3: Service_Proof ============
async function buildServiceProofSheet(workbook, { db, storeId, records, startDateStr, endDateStr, storeName, periodLabel, exportTimeStr, batchId }) {
  const worksheet = workbook.addWorksheet('Service_Proof', { properties: { defaultColWidth: 14 } });
  setAuditColumns(worksheet, [14, 12, 10, 12, 10, 12, 10, 10, 14, 30]);

  const headerRowIndex = addHeaderMetaRows(worksheet, {
    mainTitle: `【${storeName}】公益业务收支与资产台账 —— 服务量证明`,
    subtitle: '本表依据《民间非营利组织会计制度》及公益台账核算规范生成',
    periodLabel, startDateStr, endDateStr, storeName, exportTimeStr
  });

  writeHeaderCells(worksheet, headerRowIndex, [
    '开餐日期', '餐别', '堂食人次', '爱心送餐份数', '打包份数', '就餐总人次', '到岗义工数', '出勤总工时', '倾听关怀长者数', '当日菜谱'
  ]);

  const dataStartRow = headerRowIndex + 1;
  const _ = db.command;
  const menuByDate = {};
  try {
    const menuRes = await db.collection('daily_menus')
      .where({ storeId, dateString: _.gte(startDateStr).and(_.lte(endDateStr)) })
      .field({ dateString: true, mealType: true, menuText: true })
      .limit(2000)
      .get();
    (menuRes.data || []).forEach(m => {
      if (!menuByDate[m.dateString]) menuByDate[m.dateString] = [];
      menuByDate[m.dateString].push(m);
    });
  } catch (err) {
    console.warn('[auditLedgerExcel] 查询 daily_menus 当日菜谱失败，菜谱列按未记录处理:', err);
  }

  const MEAL_LABEL = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' };
  let seq = 0;
  records.forEach(record => {
    seq += 1;
    const menus = menuByDate[record.dateString] || [];
    const mealTypes = menus.length > 0
      ? Array.from(new Set(menus.map(m => MEAL_LABEL[m.mealType] || MEAL_LABEL.lunch))).join('/')
      : '全天（未按餐次细分）';
    const menuText = menus.length > 0
      ? menus.map(m => m.menuText).filter(Boolean).join('；') || '未填写菜品文字'
      : '未上传当日菜谱记录';

    const dineIn = parseFloat(record.dineInSeniors) || 0;
    const delivery = parseFloat(record.deliverySeniors) || 0;
    const takeaway = parseFloat(record.takeawayCount) || 0;
    const totalDine = parseFloat(record.totalDineCount) || parseFloat(record.diningCount) || 0;
    const totalVol = parseFloat(record.totalVolunteers) || parseFloat(record.volunteerCount) || 0;
    const volHours = parseFloat(record.volunteerHours) || 0;
    const listening = parseFloat(record.listeningSeniors) || 0;

    const row = worksheet.addRow([
      record.dateString || '', mealTypes, dineIn, delivery, takeaway, totalDine, totalVol,
      Number(volHours.toFixed(1)), listening, menuText
    ]);
    row.height = 20;
    row.eachCell((cell, colNumber) => {
      if (colNumber === 1) cell.style = AUDIT_DATE_STYLE;
      else if ([3, 4, 5, 6, 7, 8, 9].includes(colNumber)) cell.style = AUDIT_NUMBER_STYLE;
      else cell.style = AUDIT_CELL_STYLE;
    });
  });

  const dataEndRow = dataStartRow + seq - 1;
  const safeEndRow = seq > 0 ? dataEndRow : dataStartRow;
  const totalRowIndex = safeEndRow + 2;
  worksheet.getCell(`A${totalRowIndex}`).value = '合计';
  worksheet.getCell(`B${totalRowIndex}`).value = `共 ${seq} 天`;
  ['C', 'D', 'E', 'F', 'G', 'H', 'I'].forEach(col => {
    worksheet.getCell(`${col}${totalRowIndex}`).value = { formula: `SUM(${col}${dataStartRow}:${col}${safeEndRow})` };
  });
  worksheet.getRow(totalRowIndex).height = 20;
  for (let c = 1; c <= COLS; c++) {
    worksheet.getCell(totalRowIndex, c).style = c === 1
      ? { ...AUDIT_TOTAL_STYLE, alignment: { horizontal: 'left', vertical: 'middle' } }
      : AUDIT_TOTAL_STYLE;
  }

  const lastRow = addSignatureBlock(worksheet, {
    afterRow: totalRowIndex, batchId,
    extraNoteLines: ['注：本系统财务日报按"整天"维度记账，未按早/午/晚餐分别记录人次与支出，"餐别"列取自当日菜谱发布记录，若当日未发布菜谱则显示"全天"。']
  });

  worksheet.views = [{ state: 'frozen', ySplit: headerRowIndex }];

  return { totalDiners: 0 /* 由调用方用 totalDine 求和另算，避免与 Sheet1 重复口径 */, lastRow };
}

async function buildAuditGradeSingleStoreExport(cloud, db, { records, periodLabel, startDateStr, endDateStr, shopName, storeId, tenantId }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '雨花斋爱心账本';
  workbook.created = new Date();

  const storeName = String(shopName || '全部门店');
  const safeStoreName = storeName.replace(/[\\/:*?"<>|]/g, '');
  const exportTimeStr = nowInShanghai();
  const batchId = `AUD-${(storeId || safeStoreName || 'NA').toString().slice(-8)}-${Date.now()}`;

  const [operatorNameMap, receiptUrlMap] = await Promise.all([
    resolveOperatorNames(db, records),
    resolveReceiptUrls(cloud, records)
  ]);

  const cashFlow = buildCashFlowSheet(workbook, {
    records, operatorNameMap, receiptUrlMap, storeName, periodLabel, startDateStr, endDateStr, exportTimeStr, batchId
  });

  await buildMaterialInventorySheet(workbook, {
    db, storeId: storeId || '', tenantId: tenantId || '', records, startDateStr, endDateStr, storeName, periodLabel, exportTimeStr, batchId
  });

  await buildServiceProofSheet(workbook, {
    db, storeId: storeId || '', records, startDateStr, endDateStr, storeName, periodLabel, exportTimeStr, batchId
  });

  let totalDiners = 0;
  // 🐛（自查修复）totalMaterialsCount 供 uploadWorkbookAndRespond 拼进公开的
  // "财务审计公示"文案（供店长复制到理事会/捐赠群），必须是真实捐赠笔数——
  // materialInventory.materialsCount 是 Sheet2 的物理行数，含"大米/面粉/食用油/
  // 蔬菜"四个即使本期零捐入也固定输出的结构完整性占位行，不能拿来当捐赠笔数，
  // 否则会让公示文案在零捐赠期间也显示"物资捐赠：4 笔"，误导捐赠人/审计方
  let totalMaterialsCount = 0;
  records.forEach(r => {
    totalDiners += parseFloat(r.totalDineCount) || parseFloat(r.diningCount) || 0;
    if (Array.isArray(r.materials)) totalMaterialsCount += r.materials.length;
  });

  const { uploadWorkbookAndRespond } = require('./exportSingleStoreExcel');
  return uploadWorkbookAndRespond(cloud, workbook, {
    fileLabel: '公益审计台账',
    safeStoreName,
    periodLabel,
    startDateStr,
    endDateStr,
    totalIncome: cashFlow.totalIncome,
    totalExpense: cashFlow.totalExpense,
    totalDiners,
    totalMaterialsCount,
    recordCount: records.length,
    isNationalExport: false
  });
}

module.exports = { buildAuditGradeSingleStoreExport };
