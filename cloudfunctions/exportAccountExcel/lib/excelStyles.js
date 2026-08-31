// 🏛️（2026-08-31 Open-Core 架构拆分）Excel 样式常量：单店导出（Core）与
// 多店合并导出（Enterprise）共用同一套视觉规范，抽成独立文件避免两处各自
// 维护一份容易走样的样式定义。本文件本身不含任何商业/单店专属逻辑，纯样式
// 常量，Core/Enterprise 两侧都可以安全依赖。
const HEADER_STYLE = {
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

const INCOME_STYLE = {
  ...NUMBER_STYLE,
  font: { size: 11, color: { argb: 'FF2F9E44' } }
};

const EXPENSE_STYLE = {
  ...NUMBER_STYLE,
  font: { size: 11, color: { argb: 'FFE03131' } }
};

const TOTAL_STYLE = {
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

module.exports = { HEADER_STYLE, CELL_STYLE, NUMBER_STYLE, INCOME_STYLE, EXPENSE_STYLE, TOTAL_STYLE };
