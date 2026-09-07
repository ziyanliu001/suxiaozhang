// 构建对账明细 xlsx 工作簿并上传云存储，返回下载直链。参考仓库既有
// exportAccountExcel/lib/exportSingleStoreExcel.js 的"建表 -> 合计行 ->
// writeBuffer -> uploadFile -> getTempFileURL"既有模式，但作用对象是
// order_settlements 的归并明细（buildDetailRows 的产出），不是 report_logs。
'use strict';

const ExcelJS = require('exceljs');
const { HEADER_STYLE, CELL_STYLE, NUMBER_STYLE, ANOMALY_STYLE, ANOMALY_NUMBER_STYLE, TOTAL_STYLE } = require('./excelStyles');

const STATUS_LABEL = {
  unsettled: '待结算',
  settled: '已结算',
  settled_then_reversed: '已结算(后续退款冲销)',
  refunded: '已撤销(未产生实际支付)'
};

function yuan(fen) {
  return Number(((fen || 0) / 100).toFixed(2));
}

function fmtDateTime(d) {
  if (!d) return '';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// @param rows 已经过 checkInvariant 标注 invariantOk 字段的 buildDetailRows 产出
async function buildSettlementWorkbook(cloud, { tenantId, rows, startDate, endDate }) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('对账明细', { properties: { defaultColWidth: 14 } });

  worksheet.columns = [
    { header: '订单号', key: 'orderId', width: 24 },
    { header: '应付总额(元)', key: 'payAmount', width: 14 },
    { header: '制作方分成(元)', key: 'producerAmount', width: 16 },
    { header: '推广分成(元)', key: 'promoterAmount', width: 14 },
    { header: '平台服务费(元)', key: 'platformFee', width: 16 },
    { header: '结算状态', key: 'statusLabel', width: 22 },
    { header: '恒等式复核', key: 'invariantLabel', width: 14 },
    { header: '创建时间', key: 'createdAt', width: 20 },
    { header: '结算时间', key: 'settledAt', width: 20 },
    { header: '红冲时间', key: 'reversedAt', width: 20 }
  ];

  const headerRow = worksheet.getRow(1);
  headerRow.height = 28;
  headerRow.eachCell((cell) => { cell.style = HEADER_STYLE; });

  let totalPay = 0;
  let totalProducer = 0;
  let totalPromoter = 0;
  let totalPlatform = 0;
  let anomalyCount = 0;

  rows.forEach((r) => {
    totalPay += r.payAmount || 0;
    totalProducer += r.producerAmount || 0;
    totalPromoter += r.promoterAmount || 0;
    totalPlatform += r.platformFee || 0;
    if (!r.invariantOk) anomalyCount++;

    const row = worksheet.addRow({
      orderId: r.orderId,
      payAmount: yuan(r.payAmount),
      producerAmount: yuan(r.producerAmount),
      promoterAmount: yuan(r.promoterAmount),
      platformFee: yuan(r.platformFee),
      statusLabel: STATUS_LABEL[r.settlementStatus] || r.settlementStatus,
      invariantLabel: r.invariantOk ? '正常' : '⚠ 金额不一致',
      createdAt: fmtDateTime(r.createdAt),
      settledAt: fmtDateTime(r.settledAt),
      reversedAt: fmtDateTime(r.reversedAt)
    });
    row.eachCell((cell, colNumber) => {
      const isNumberCol = colNumber >= 2 && colNumber <= 5;
      if (!r.invariantOk) {
        cell.style = isNumberCol ? ANOMALY_NUMBER_STYLE : ANOMALY_STYLE;
      } else {
        cell.style = isNumberCol ? NUMBER_STYLE : CELL_STYLE;
      }
    });
  });

  const totalRow = worksheet.addRow({
    orderId: '合计',
    payAmount: yuan(totalPay),
    producerAmount: yuan(totalProducer),
    promoterAmount: yuan(totalPromoter),
    platformFee: yuan(totalPlatform)
  });
  totalRow.height = 28;
  totalRow.eachCell((cell, colNumber) => {
    cell.style = colNumber === 1
      ? { ...TOTAL_STYLE, alignment: { horizontal: 'left', vertical: 'middle' } }
      : TOTAL_STYLE;
  });

  worksheet.views = [{ state: 'frozen', ySplit: 1 }];

  const buffer = await workbook.xlsx.writeBuffer();
  const timestamp = Date.now();
  const periodLabel = (startDate || endDate) ? `${startDate || '起始'}_${endDate || '至今'}` : '全部';
  const cloudPath = `exports/settlement_${tenantId}_${periodLabel}_${timestamp}.xlsx`;

  const uploadRes = await cloud.uploadFile({ cloudPath, fileContent: buffer });
  const tempUrlRes = await cloud.getTempFileURL({ fileList: [uploadRes.fileID] });
  const fileList = tempUrlRes.fileList || [];
  const tempFileURL = fileList.length > 0 ? fileList[0].tempFileURL : '';

  return {
    success: true,
    fileID: uploadRes.fileID,
    tempFileURL,
    fileName: `工坊对账明细_${periodLabel}.xlsx`,
    recordCount: rows.length,
    anomalyCount
  };
}

module.exports = { buildSettlementWorkbook };
