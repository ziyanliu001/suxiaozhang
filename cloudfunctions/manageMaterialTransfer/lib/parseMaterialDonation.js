'use strict';

// 纯逻辑：把 report_logs.materials[]（utils/parser.ts parseMaterials() 解析出的
// 自由文本捐赠记录，形如 {donor:'张三', item:'大米', quantity:'50', unit:'斤'}）
// 归类进"大米/食用油/面粉/时蔬"四类目，并把重量统一换算成"斤"。不做 db I/O，
// 便于单测。
//
// ⚠️ 这是本仓库唯一一处需要处理自由文本捐赠品名的地方——`material_purchase_logs`
// （采购入库）是结构化表单提交，不经过这个文件；不要把两者的解析逻辑混在一起。
//
// 品名关键词按"更具体的在前"排列，避免"食用油"被更泛的"油"截胡（此处顺序其实
// 不影响 oil 类目本身，但 rice/flour 都不含"米"以外的歧义词，真正需要在意顺序
// 的是"避免不同类目之间互相误判"——四组关键词彼此互斥，因此遍历顺序对结果无影响，
// 这里固定 rice→oil→flour→vegetable 只是为了让匹配结果可预测、便于读单测）。
const CATEGORY_KEYWORDS = {
  rice: ['大米', '香米', '籼米', '粳米', '米'],
  oil: ['食用油', '菜籽油', '花生油', '大豆油', '色拉油', '菜油', '油'],
  flour: ['面粉', '白面', '小麦粉', '面'],
  vegetable: ['时蔬', '蔬菜', '青菜', '白菜', '土豆', '萝卜', '菜']
};

const CATEGORY_ORDER = ['rice', 'oil', 'flour', 'vegetable'];

// utils/lib/parseTempleDonation.js 的 MATERIAL_UNIT_PATTERN 覆盖 斤/公斤/kg/箱/
// 袋/桶/瓶/份/个/盏/支/升——这里只认可以无损换算成"斤"的两种，其余单位（箱/桶/
// 瓶等，含"多少个/多少箱"这类计件单位）无法确定实际重量，直接跳过，不瞎猜换算比例
const JIN_PER_UNIT = {
  '斤': 1,
  '公斤': 2,
  'kg': 2,
  'KG': 2,
  'Kg': 2
};

/**
 * 自由文本品名 → 四类目关键词匹配，不看单位。
 * @param {string} itemText
 * @returns {'rice'|'oil'|'flour'|'vegetable'|null}
 */
function matchMaterialCategory(itemText) {
  const text = String(itemText || '').trim();
  if (!text) return null;
  for (const category of CATEGORY_ORDER) {
    const keywords = CATEGORY_KEYWORDS[category];
    for (const kw of keywords) {
      if (text.indexOf(kw) !== -1) return category;
    }
  }
  return null;
}

/**
 * 把一条 parseMaterials() 解析出的捐赠记录换算成 {category, jin}；品名未命中
 * 四类目、单位不是斤/公斤/kg、或数量不是合法正数时返回 null（宁可漏算，不瞎猜）。
 * @param {{item?:string, quantity?:string|number, unit?:string}} materialItem
 * @returns {{category:'rice'|'oil'|'flour'|'vegetable', jin:number}|null}
 */
function parseMaterialDonationToJin(materialItem) {
  if (!materialItem) return null;
  const category = matchMaterialCategory(materialItem.item);
  if (!category) return null;

  const unit = String(materialItem.unit || '').trim();
  const perUnitJin = JIN_PER_UNIT[unit];
  if (!perUnitJin) return null;

  const quantity = parseFloat(materialItem.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;

  return { category, jin: Math.round(quantity * perUnitJin * 100) / 100 };
}

module.exports = { matchMaterialCategory, parseMaterialDonationToJin, CATEGORY_KEYWORDS, JIN_PER_UNIT };
