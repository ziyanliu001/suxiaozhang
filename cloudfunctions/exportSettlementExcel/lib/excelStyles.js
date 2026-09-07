// 🏛️（护城河三 M2）样式常量：与 exportAccountExcel/lib/excelStyles.js 视觉
// 语言一致（同款表头/边框/合计行结构），但改用工坊子包既有的品牌红 #8C1D18
// （settlement-summary/product-management 等页面统一色），不沿用雨花斋橙色
// #D9480E——两个模块物理隔离，样式常量也各自维护一份，不跨云函数共享文件。
'use strict';

const HEADER_STYLE = {
  font: { bold: true, size: 12, color: { argb: 'FFFFFFFF' } },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8C1D18' } },
  alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
  border: {
    top: { style: 'thin', color: { argb: 'FFDEE2E6' } },
    left: { style: 'thin', color: { argb: 'FFDEE2E6' } },
    bottom: { style: 'thin', color: { argb: 'FFDEE2E6' } },
    right: { style: 'thin', color: { argb: 'FFDEE2E6' } }
  }
};

const CELL_STYLE = {
  font: { size: 11 },
  alignment: { vertical: 'middle', wrapText: true },
  border: {
    top: { style: 'thin', color: { argb: 'FFDEE2E6' } },
    left: { style: 'thin', color: { argb: 'FFDEE2E6' } },
    bottom: { style: 'thin', color: { argb: 'FFDEE2E6' } },
    right: { style: 'thin', color: { argb: 'FFDEE2E6' } }
  }
};

const NUMBER_STYLE = {
  ...CELL_STYLE,
  alignment: { horizontal: 'right', vertical: 'middle' }
};

const ANOMALY_STYLE = {
  ...CELL_STYLE,
  font: { size: 11, bold: true, color: { argb: 'FFE03131' } }
};

const ANOMALY_NUMBER_STYLE = {
  ...NUMBER_STYLE,
  font: { size: 11, bold: true, color: { argb: 'FFE03131' } }
};

const TOTAL_STYLE = {
  font: { bold: true, size: 12, color: { argb: 'FF8C1D18' } },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3BF' } },
  alignment: { horizontal: 'right', vertical: 'middle' },
  border: {
    top: { style: 'medium', color: { argb: 'FF8C1D18' } },
    left: { style: 'thin', color: { argb: 'FFDEE2E6' } },
    bottom: { style: 'thin', color: { argb: 'FFDEE2E6' } },
    right: { style: 'thin', color: { argb: 'FFDEE2E6' } }
  }
};

module.exports = { HEADER_STYLE, CELL_STYLE, NUMBER_STYLE, ANOMALY_STYLE, ANOMALY_NUMBER_STYLE, TOTAL_STYLE };
