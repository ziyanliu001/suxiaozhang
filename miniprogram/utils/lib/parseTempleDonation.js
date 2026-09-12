'use strict';

// 纯逻辑：宫庙红榜"姓名+传统用语(+具体事项)+金额"识别（parseTempleStyleLine）+
// 物资供奉动词前缀剥离（stripDonationVerbPrefix），从 utils/parser.ts 抽出——
// 该文件其余既有解析逻辑（parseDonorText 的多人一行扫描、parseMaterials 的
// 冒号/无冒号两条既有分支）仍留在原处不动，只把这两块 2026-09-13 新增的、
// 不依赖 wx 全局的纯函数迁到这里，方便配 node --test 单测，与同目录
// resolveEffectiveRole.js/resolveWorkspace.js 同一套既定写法（.ts 文件通过
// import 引入，不重复维护一份判断逻辑）。

// 🙏 宫庙红榜传统用语词库：详见 parser.ts parseTempleStyleLine 调用处的完整
// 背景说明——这些词出现在姓名与金额之间（如"添香油"/"乐捐"），原有的
// "名字紧邻金额"扫描假设会把这段自由文本误当成姓名本身。
const TEMPLE_DONATION_KEYWORDS = [
  '添香油', '添油香', '添灯油', '添植物油', '添食用油', '添油',
  '供灯', '乐捐', '随喜', '修缮', '翻修', '敬献', '奉献', '喜舍', '喜奉', '结缘', '捐建', '功德', '建庙', '芳名'
];
// 用于定位"第一个宫庙用语出现在整行的哪个位置"——名字就是这个位置之前的
// 文本，用语本身连同它之后的一切（可能带着"建庙"这类具体事项）都算噪声。
// 比"从行首贪婪匹配 2-6 个中文字符"更可靠：贪婪匹配在用语与姓名之间没有
// 空格时（如"王某某随喜200"）会把用语一并吞进姓名里，用关键词出现的位置
// 反过来限定姓名的右边界，就不存在这个问题——不管中间有没有空格，姓名
// 恒等于关键词出现位置之前的那一段
const TEMPLE_KEYWORD_SEARCH_REGEX = new RegExp(TEMPLE_DONATION_KEYWORDS.join('|'));
// 姓名必须整体（去除首尾空白后）恰好是 2-6 个连续中文字符，允许"合家/全家/
// 一家/阖家"这类传统落款后缀直接跟在姓名后面（无需空格分隔——固定称谓
// 写法，不是需要剥离的噪声词）；要求整段精确匹配（而不是只匹配前缀），
// 关键词前面如果是一长串不像姓名的文本（如漏识别的整行标题），直接判定
// "这不是一条宫庙格式记录"，返回 null 交给调用方回退到其余解析路径，不会
// 把一段不像姓名的文本硬当成姓名用
const TEMPLE_NAME_EXACT_REGEX = /^([一-龥]{2,6}(?:合家|全家|一家|阖家)?)$/;
// 命中物资单位结尾时不属于本函数职责，退回 null 交给 parseMaterials 处理
const TEMPLE_MATERIAL_UNIT_TAIL_REGEX = /(斤|公斤|kg|箱|袋|桶|瓶|盏|支|升)$/;
const TEMPLE_TRAILING_AMOUNT_REGEX = /(\d+(?:\.\d{1,2})?)\s*(?:元|块)?$/;

// 只在整行确实命中至少一个已知宫庙用语时才启用（调用方在这之前不需要
// 自己判断"这行像不像宫庙格式"，本函数内部已经做了这道门槛），姓名与
// 金额之间的自由文本（用语本身+可能的具体事项，如"建庙"）一律视为噪声、
// 不参与最终结果；命中逗号/顿号（多人一行）、姓名部分不像一个真实姓名、
// 或物资单位结尾时返回 null，交由调用方回退到其余既有解析路径
function parseTempleStyleLine(line) {
  if (!line) return null;
  const keywordMatch = line.match(TEMPLE_KEYWORD_SEARCH_REGEX);
  if (!keywordMatch) return null;
  if (/[,，、]/.test(line)) return null;

  const beforeKeyword = line.slice(0, keywordMatch.index).trim();
  const nameMatch = beforeKeyword.match(TEMPLE_NAME_EXACT_REGEX);
  if (!nameMatch) return null;
  const name = nameMatch[1];

  const rest = line.slice(keywordMatch.index).trim();
  if (!rest) return null;

  if (TEMPLE_MATERIAL_UNIT_TAIL_REGEX.test(rest)) return null;

  const amountMatch = rest.match(TEMPLE_TRAILING_AMOUNT_REGEX);
  if (!amountMatch) return null;
  const amount = parseFloat(amountMatch[1]);
  if (isNaN(amount) || amount <= 0) return null;

  return { name, amount };
}

// 🙏 宫庙实物供奉常见单位：灯盏（盏）、蜡烛（支）、食用油/灯油按体积计（升）——
// 供 parser.ts parseMaterials 的两处单位正则复用，避免同一份单位清单散落
// 成两份拷贝
const MATERIAL_UNIT_PATTERN = '斤|公斤|kg|箱|袋|桶|瓶|份|个|盏|支|升';

// 供奉动词前缀剥离："添植物油2桶"里"添"是动词，剥离后 item 是"植物油"，
// 比保留"添植物油"更贴近物资清单该有的名词化描述
const DONATION_VERB_PREFIX_REGEX = /^(?:赞助|添|敬献|奉献|喜舍|供奉)\s*/;
function stripDonationVerbPrefix(text) {
  const stripped = String(text || '').replace(DONATION_VERB_PREFIX_REGEX, '').trim();
  // 剥离后不能剥成空字符串（如整段就是"添"这一个字的退化情形），此时宁可
  // 保留剥离前的原文，不能让物资描述凭空消失
  return stripped || text;
}

// 🙏（2026-09-13 OCR 手写红榜识别）与 parseTempleStyleLine 共用同一套"关键词
// 定位姓名右边界"思路，区别是要求行尾必须是"数量+单位"（不含"元/块"），
// 用于 ocrDonationList 识别宫庙红榜里的实物供奉行（如"林某某 添植物油2桶"）。
// parseMaterials（parser.ts）已经能处理这类文本，这里单独提供是因为
// ocrDonationList 云函数不认识 parser.ts 的分号/换行分隔多行文本格式，只需要
// 对 OCR 识别出的单行文本做一次判断
function parseTempleMaterialLine(line) {
  if (!line) return null;
  const keywordMatch = line.match(TEMPLE_KEYWORD_SEARCH_REGEX);
  if (!keywordMatch) return null;
  if (/[,，、]/.test(line)) return null;

  const beforeKeyword = line.slice(0, keywordMatch.index).trim();
  const nameMatch = beforeKeyword.match(TEMPLE_NAME_EXACT_REGEX);
  if (!nameMatch) return null;
  const donor = nameMatch[1];

  const rest = line.slice(keywordMatch.index).trim();
  const qtyMatch = rest.match(new RegExp(`^(.+?)\\s*(\\d+(?:\\.\\d+)?)\\s*(${MATERIAL_UNIT_PATTERN})$`, 'i'));
  if (!qtyMatch) return null;

  return {
    donor,
    item: stripDonationVerbPrefix(qtyMatch[1].trim()),
    quantity: qtyMatch[2],
    unit: qtyMatch[3]
  };
}

module.exports = {
  TEMPLE_DONATION_KEYWORDS,
  parseTempleStyleLine,
  parseTempleMaterialLine,
  MATERIAL_UNIT_PATTERN,
  stripDonationVerbPrefix
};
