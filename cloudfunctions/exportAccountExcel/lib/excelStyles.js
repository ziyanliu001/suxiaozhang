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

// 🏛️（2026-09-03 审计级台账样式）以下常量专供 lib/auditLedgerExcel.js 的
// 三工作表审计台账使用，与上面 HEADER_STYLE 等品牌红配色的"扁平流水表"样式
// 完全独立——审计台账对标《民间非营利组织会计制度》底稿抽查的中性配色规范
// （浅灰表头 #F2F3F5），不复用品牌色，避免视觉上被误认成营销物料
const AUDIT_TITLE_STYLE = {
  font: { bold: true, size: 16 },
  alignment: { horizontal: 'center', vertical: 'middle' }
};

const AUDIT_SUBTITLE_STYLE = {
  font: { size: 10, color: { argb: 'FF868E96' } },
  alignment: { horizontal: 'center', vertical: 'middle' }
};

const AUDIT_META_LABEL_STYLE = {
  font: { bold: true, size: 10 },
  alignment: { horizontal: 'left', vertical: 'middle' }
};

const AUDIT_HEADER_STYLE = {
  font: { bold: true, size: 11 },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F3F5' } },
  alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
  border: {
    top: { style: 'thin', color: { argb: 'FFADB5BD' } },
    left: { style: 'thin', color: { argb: 'FFADB5BD' } },
    bottom: { style: 'thin', color: { argb: 'FFADB5BD' } },
    right: { style: 'thin', color: { argb: 'FFADB5BD' } }
  }
};

const AUDIT_CELL_STYLE = {
  font: { size: 10 },
  alignment: { vertical: 'middle', wrapText: true },
  border: {
    top: { style: 'thin', color: { argb: 'FFE9ECEF' } },
    left: { style: 'thin', color: { argb: 'FFE9ECEF' } },
    bottom: { style: 'thin', color: { argb: 'FFE9ECEF' } },
    right: { style: 'thin', color: { argb: 'FFE9ECEF' } }
  }
};

const AUDIT_NUMBER_STYLE = {
  ...AUDIT_CELL_STYLE,
  alignment: { horizontal: 'right', vertical: 'middle' },
  numFmt: '#,##0.00'
};

const AUDIT_DATE_STYLE = {
  ...AUDIT_CELL_STYLE,
  alignment: { horizontal: 'center', vertical: 'middle' },
  numFmt: 'yyyy-mm-dd'
};

const AUDIT_TOTAL_STYLE = {
  font: { bold: true, size: 11 },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F3F5' } },
  alignment: { horizontal: 'right', vertical: 'middle' },
  border: {
    top: { style: 'medium', color: { argb: 'FF495057' } },
    left: { style: 'thin', color: { argb: 'FFADB5BD' } },
    bottom: { style: 'thin', color: { argb: 'FFADB5BD' } },
    right: { style: 'thin', color: { argb: 'FFADB5BD' } }
  },
  numFmt: '#,##0.00'
};

const AUDIT_SIGNATURE_STYLE = {
  font: { size: 10 },
  alignment: { horizontal: 'left', vertical: 'middle' }
};

const AUDIT_NOTE_STYLE = {
  font: { size: 9, italic: true, color: { argb: 'FF868E96' } },
  alignment: { horizontal: 'left', vertical: 'middle', wrapText: true }
};

module.exports = {
  HEADER_STYLE, CELL_STYLE, NUMBER_STYLE, INCOME_STYLE, EXPENSE_STYLE, TOTAL_STYLE,
  AUDIT_TITLE_STYLE, AUDIT_SUBTITLE_STYLE, AUDIT_META_LABEL_STYLE, AUDIT_HEADER_STYLE,
  AUDIT_CELL_STYLE, AUDIT_NUMBER_STYLE, AUDIT_DATE_STYLE, AUDIT_TOTAL_STYLE,
  AUDIT_SIGNATURE_STYLE, AUDIT_NOTE_STYLE
};
