'use strict';

// 🧾 发票/小票 OCR 智能记账 · 第一阶段（2026-09-10）+ 端到端压测容错加固（2026-09-11）
//
// 纯逻辑：不做 db I/O、不依赖 wx-server-sdk，便于单测；与本仓库
// manageDailyMenu/manageVolunteerCheckIn 等云函数已有的既定写法一致——
// index.js 通过 require('./lib/parseReceiptPayload') 引入，index.js 只负责
// 调 OCR API 拿到原始文本行，纯粹的"清洗成台账草稿"逻辑全部委托给这里。
//
// 🛡️ 与本目录 index.js 既有默认行为（无 action 字段时的老逻辑）职责边界：
// 老逻辑是"认字识数 + 拼出商品明细/实付金额"，服务于既有的手动录入表单
// 回填场景；本模块是全新的 action:'parseReceipt' 用到的"结构化台账草稿"
// 清洗器，目标产物不同（多了品类归集、日期规范化、交易对手识别、结构化
// 疑点标记），两者独立维护，不互相依赖、不互相改动对方的正则/取数逻辑。
//
// 🛡️ 诚实的能力边界（与既有 OCR 函数一脉相承的哲学）：这是一次轻量正则
// 清洗，不是接入了付费的通用票据结构化 OCR 产品——识别不到/校验不上的
// 地方一律用 flagNeedsReview + reviewReasons 如实标记，交给人工核对，
// 绝不编造一个"看起来合理"的假数据。
//
// 🔧（2026-09-11 真实/高拟真小票端到端压测·容错加固）本轮新增能力边界
// 同样如实标注：
// - OCR 数字噪声纠偏只处理"数字/O/o/I/l 混排"与"逗号误当小数点"两类最
//   常见、最能安全判定的场景，不做通用的模糊纠错（不猜测任意乱码）；
// - 中文大写/小写金额解析覆盖到"万"这一级、常见的十/百/千位值读法，不
//   处理"廿""卅"等更生僻的文言文数字表达；
// - 无年份日期（MM-DD）兜底要求整行只有日期本身，不在长文本里挖字段，
//   避免把无关数字片段误判成日期。

// ---------------- OCR 数字噪声预清洗 ----------------
//
// 在所有金额/品名/日期提取之前，先对每一行做一次轻量数字纠偏——覆盖两类
// 最常见的 OCR 误识别：(1) 数字 0/1 被误识别成形近字母 O/o/I/l；(2) 小数点
// 被误识别成逗号（多见于印刷模糊/热敏纸褪色）。只在"看起来像数字"的片段
// 内做替换，不触碰纯中文/纯英文文本——片段本身必须混有至少一个真实数字
// 才会被处理，纯字母词（如商户名里的英文缩写）不受影响。

// 数字噪声片段：由 数字/O/o/I/l 及小数点、逗号组成的连续片段
const OCR_NUMERIC_TOKEN_REGEX = /[0-9OoIl]+(?:[.,，][0-9OoIl]+)*/g;

function normalizeOcrDigits(line) {
  return String(line || '').replace(OCR_NUMERIC_TOKEN_REGEX, (token) => {
    if (!/\d/.test(token)) return token; // 片段里一个真实数字都没有，不当数字噪声处理，避免误伤纯字母词
    return token.replace(/[Oo]/g, '0').replace(/[Il]/g, '1');
  });
}

// 逗号到底是"千分位"还是"被误识别的小数点"，用后面跟的数字位数区分：
// 跟 3 位及以上数字是典型千分位写法（1,234 保持不变，交给 AMOUNT_TOKEN_SRC
// 自己的千分位分支处理——(?!\d) 负向先行断言确保后面确实没有第 3 位数字才
// 会命中）；跟 1-2 位数字更像小数点误判（12,50 → 12.50）
const OCR_DECIMAL_COMMA_REGEX = /(\d+)[,，](\d{1,2})(?!\d)/g;

function normalizeDecimalComma(line) {
  return String(line || '').replace(OCR_DECIMAL_COMMA_REGEX, '$1.$2');
}

function preprocessOcrLine(line) {
  return normalizeDecimalComma(normalizeOcrDigits(line));
}

// ---------------- 中文数字（大写金额/汉字日期）解析 ----------------
//
// 农贸市场手写白条/收据常见"只写中文金额，没有任何阿拉伯数字"的情况（如
// "肆拾伍元整"）。覆盖标准大写数字（零壹贰叁肆伍陆柒捌玖拾佰仟万）与常见
// 小写数字（一二三四五六七八九十百千万）的位值读法，覆盖到"万"这一级。
const CN_DIGIT_MAP = {
  '零': 0, '〇': 0, '一': 1, '壹': 1, '二': 2, '贰': 2, '两': 2, '三': 3, '叁': 3,
  '四': 4, '肆': 4, '五': 5, '伍': 5, '六': 6, '陆': 6, '七': 7, '柒': 7,
  '八': 8, '捌': 8, '九': 9, '玖': 9
};
const CN_UNIT_MAP = { '十': 10, '拾': 10, '百': 100, '佰': 100, '千': 1000, '仟': 1000 };
const CN_NUMERAL_CHAR_CLASS = '零〇一二三四五六七八九壹贰叁肆伍陆柒捌玖两十拾百佰千仟万';

// 位值读数：把一个不含"万"的中文数字片段（如"壹佰贰拾叁"）读成整数。
// 标准算法：碰到数字字符先记下来，碰到单位字符就"数字×单位"累加进小计，
// "十/拾"单独出现（前面没有数字）按 1 十处理（"十五"="一十五"=15）；
// "零"只起占位作用，不参与数值计算
function parseChineseDigitSection(str) {
  let section = 0;
  let current = 0;
  for (const ch of String(str || '')) {
    if (ch === '零' || ch === '〇') continue;
    if (ch in CN_DIGIT_MAP) {
      current = CN_DIGIT_MAP[ch];
    } else if (ch in CN_UNIT_MAP) {
      section += (current || 1) * CN_UNIT_MAP[ch];
      current = 0;
    }
  }
  return section + current;
}

/**
 * 把中文数字整数部分（可能带"万"）转成阿拉伯数字。非法/空输入返回 null，
 * 不编造数据。
 * @param {string} str
 * @returns {number|null}
 */
function chineseNumeralToValue(str) {
  if (!str) return null;
  const wanIndex = str.indexOf('万');
  let value;
  if (wanIndex !== -1) {
    const wanPart = parseChineseDigitSection(str.slice(0, wanIndex));
    const restPart = str.slice(wanIndex + 1);
    value = wanPart * 10000 + (restPart ? parseChineseDigitSection(restPart) : 0);
  } else {
    value = parseChineseDigitSection(str);
  }
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// 大写/小写中文金额：「壹拾伍元伍角」「肆拾伍元整」等。
// 🛡️ 降噪：要求元前面的数字片段至少 2 个字符、且"整"或角/分子单位至少
// 出现一个，排除"三元里"这类地名/商户名里偶然出现的"数字+元"片段被误
// 当成金额——这类地名几乎不会再跟"整"或角分子单位
const CN_AMOUNT_REGEX = new RegExp(
  `([${CN_NUMERAL_CHAR_CLASS}]{2,})元(?:([${CN_NUMERAL_CHAR_CLASS}])角)?(?:([${CN_NUMERAL_CHAR_CLASS}])分)?(整)?`
);

/**
 * 从一行文本里提取中文大写/小写金额（如"肆拾伍元整"→45），提取不到或
 * 判定为噪声返回 null。
 * @param {string} line
 * @returns {number|null}
 */
function extractChineseWordAmount(line) {
  const m = String(line || '').match(CN_AMOUNT_REGEX);
  if (!m) return null;
  if (!m[4] && !m[2] && !m[3]) return null; // 既无"整"也无角/分，判定为噪声匹配
  const yuan = chineseNumeralToValue(m[1]);
  if (yuan === null) return null;
  const jiao = m[2] ? (CN_DIGIT_MAP[m[2]] || 0) : 0;
  const fen = m[3] ? (CN_DIGIT_MAP[m[3]] || 0) : 0;
  return round2(yuan + jiao * 0.1 + fen * 0.01);
}

// 汉字数字年份：如"二零二六年"——纯数字字符逐字读（不含十/百/千单位），
// 与金额的位值读法是两套完全不同的读法，不能共用同一个函数
function chineseYearToArabic(str) {
  let out = '';
  for (const ch of String(str || '')) {
    if (!(ch in CN_DIGIT_MAP)) return null;
    out += String(CN_DIGIT_MAP[ch]);
  }
  return out;
}

// 完整汉字日期：如"二零二六年九月十日"——年份逐字读，月/日用位值读法
// （复用 parseChineseDigitSection，日常场景下足够覆盖 1-31 的月/日范围）
const CN_FULL_DATE_REGEX = new RegExp(
  `([零〇一二三四五六七八九]{4})年([${CN_NUMERAL_CHAR_CLASS}]+)月([${CN_NUMERAL_CHAR_CLASS}]+)日`
);

function extractChineseDate(line) {
  const m = String(line || '').match(CN_FULL_DATE_REGEX);
  if (!m) return null;
  const yearStr = chineseYearToArabic(m[1]);
  if (!yearStr) return null;
  const month = parseChineseDigitSection(m[2]);
  const day = parseChineseDigitSection(m[3]);
  return toIsoDate(yearStr, month, day);
}

// ---------------- 金额解析基础工具 ----------------

// 统一金额 token：可选 ¥/￥ 前缀、可选千分位逗号、最多两位小数
const AMOUNT_TOKEN_SRC = '([¥￥]?\\s*\\d[\\d,，]*(?:\\.\\d{1,2})?)';

function parseAmountToken(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/[¥￥,，\s]/g, '');
  if (!cleaned) return null;
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

function round2(num) {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

// ---------------- 输入归一化 ----------------

// 兼容三种入参形态：字符串（按换行拆行）、字符串数组、{text|words}[] 对象数组
// （腾讯云 OCR printedText 的 items 就是这个形状）——任何非法输入一律兜底成
// 空数组，绝不抛异常。每一行在 trim 之后立即过一遍 preprocessOcrLine 数字
// 噪声纠偏，下游所有提取函数自动获益，不需要各自重复处理
function normalizeLines(rawPayload) {
  let raw = rawPayload;
  if (typeof raw === 'string') {
    raw = raw.split(/\r?\n/);
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return item.text || item.words || item.Text || '';
      return '';
    })
    .map((s) => preprocessOcrLine(String(s || '').trim()))
    .filter(Boolean);
}

// ---------------- 总金额提取 ----------------

// 第一优先级：顾客/买方真正付出的钱（与 index.js 既有 TIER1 关键词口径一致，
// 独立维护一份正则，不互相 require，避免两个函数的取数逻辑被耦合在一起）
const TOTAL_TIER1_REGEX = new RegExp(`(?:在线支付|商品实付|实付金额|实付|微信支付|微支付|支付宝支付|支付宝)\\s*[:：]?\\s*${AMOUNT_TOKEN_SRC}`);
// 第二优先级：合计/应付类，多数小票有但不一定是优惠后的最终支付额
const TOTAL_TIER2_REGEX = new RegExp(`(?:实收|应收|应付金额|应付|合计金额|合计|小计)\\s*[:：]?\\s*${AMOUNT_TOKEN_SRC}`);
// 增值税发票专属：「价税合计」的「小写」金额是法定含税总额，权威性等同 TIER1，
// 但发票版式固定把「（大写）中文金额」夹在中间，用非贪婪匹配跳过它
const TOTAL_INVOICE_REGEX = new RegExp(`价税合计[\\s\\S]{0,24}?小写[)）]?\\s*[:：]?\\s*${AMOUNT_TOKEN_SRC}`);

// 🛡️「关键字单独一行、金额在下一行」兼容匹配：与本目录 index.js 已经踩过的
// 坑同源——OCR 逐行识别经常把"商品实付"/"合计"和后面的数字拆成两行分别
// 输出，上面几个正则要求关键字与数值紧邻同行会直接匹配失败。这两个正则
// 只判断"这一行是不是纯关键字（没有数值）"，命中后再看下一行是不是一个
// 孤立的金额数字。
const TOTAL_TIER1_BARE_REGEX = /^(?:在线支付|商品实付|实付金额|实付|微信支付|微支付|支付宝支付|支付宝)\s*[:：]?\s*$/;
const TOTAL_TIER2_BARE_REGEX = /^(?:实收|应收|应付金额|应付|合计金额|合计|小计)\s*[:：]?\s*$/;
const BARE_AMOUNT_LINE_REGEX = /^[¥￥]?\s*(\d[\d,，]*(?:\.\d{1,2})?)\s*$/;

// 找零/流水号/会员卡号等噪声行：绝不能被当成总金额或商品行的候选数字来源，
// 这正是需求里"剔除找零、折扣等噪音"的落地点——找零金额本身是"多退给顾客
// 的钱"，混进总金额提取会直接得出错误结果
const CHANGE_OR_NOISE_LINE_REGEX = /找零|找回|应找|流水号|订单号|会员卡|积分|电话|热线|条码|税号|纳税人识别号|开户行|账号/;

function extractTotalAmount(lines) {
  let tier1 = null;
  let tier2 = null;
  let invoiceTotal = null;
  let chineseWordsAmount = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (CHANGE_OR_NOISE_LINE_REGEX.test(line)) continue;
    const nextLine = lines[i + 1];
    const nextIsBareAmount = nextLine && !CHANGE_OR_NOISE_LINE_REGEX.test(nextLine) ? nextLine.match(BARE_AMOUNT_LINE_REGEX) : null;

    if (invoiceTotal === null) {
      const m = line.match(TOTAL_INVOICE_REGEX);
      if (m) {
        const amt = parseAmountToken(m[1]);
        if (amt !== null && amt > 0) invoiceTotal = amt;
      }
    }
    if (tier1 === null) {
      const m = line.match(TOTAL_TIER1_REGEX);
      if (m) {
        const amt = parseAmountToken(m[1]);
        if (amt !== null && amt > 0) tier1 = amt;
      } else if (TOTAL_TIER1_BARE_REGEX.test(line) && nextIsBareAmount) {
        const amt = parseAmountToken(nextIsBareAmount[1]);
        if (amt !== null && amt > 0) tier1 = amt;
      }
    }
    if (tier1 === null && tier2 === null) {
      const m = line.match(TOTAL_TIER2_REGEX);
      if (m) {
        const amt = parseAmountToken(m[1]);
        if (amt !== null && amt > 0) tier2 = amt;
      } else if (TOTAL_TIER2_BARE_REGEX.test(line) && nextIsBareAmount) {
        const amt = parseAmountToken(nextIsBareAmount[1]);
        if (amt !== null && amt > 0) tier2 = amt;
      }
    }
    // 🔧（2026-09-11）中文大写/小写金额兜底——只在没有任何阿拉伯数字总金额
    // 关键字命中时才有意义采用，优先级低于以上三档（手写白条场景下，往往
    // 也是唯一能找到的总金额来源）
    if (chineseWordsAmount === null) {
      const cnAmt = extractChineseWordAmount(line);
      if (cnAmt !== null && cnAmt > 0) chineseWordsAmount = cnAmt;
    }
  }

  // 发票的「价税合计」是法定总额，比小票的实付/合计关键词更权威，优先采用
  if (invoiceTotal !== null) return { amount: invoiceTotal, source: 'invoice_total' };
  if (tier1 !== null) return { amount: tier1, source: 'tier1_actual_pay' };
  if (tier2 !== null) return { amount: tier2, source: 'tier2_subtotal' };
  if (chineseWordsAmount !== null) return { amount: chineseWordsAmount, source: 'chinese_words_amount' };
  return { amount: null, source: null };
}

// 优惠/折扣：同一张小票可能出现多行，需要累加而不是只取第一条
const DISCOUNT_LINE_REGEX = new RegExp(`(?:优惠券|满减|立减|会员优惠|店铺优惠|商品优惠|膨胀优惠|为您节省)\\s*[:：]?\\s*${AMOUNT_TOKEN_SRC}`, 'g');

function extractDiscountAmount(lines) {
  let total = 0;
  for (const line of lines) {
    DISCOUNT_LINE_REGEX.lastIndex = 0;
    let m;
    while ((m = DISCOUNT_LINE_REGEX.exec(line)) !== null) {
      const amt = parseAmountToken(m[1]);
      if (amt !== null && amt >= 0) total += amt;
    }
  }
  return round2(total);
}

// ---------------- 交易对手（商户/销售方）提取 ----------------

// 显式标签：发票的「销售方名称」/小票偶见的「商户名称」——命中即视为权威来源
const MERCHANT_LABEL_REGEX = /^(?:销售方名称|销售方|商户名称|门店名称|收款方)\s*[:：]\s*(.+)$/;
const MERCHANT_LABEL_BARE_REGEX = /^(?:销售方名称|销售方|商户名称|门店名称|收款方)\s*[:：]?\s*$/;
// 「购买方」是雨花斋自己（付款人），绝不能被误当成交易对手——这是与既有
// index.js 只有单一"店铺抬头"场景不同的新增歧义源，增值税发票同时印着
// 购买方与销售方两个机构名称，必须显式排除购买方分支
const BUYER_LABEL_REGEX = /^(?:购买方名称|购买方|购方)/;

const MERCHANT_NOISE_LINE_REGEX = /发票代码|发票号码|开票日期|纳税人识别号|税号|地址|电话|开户行|账号|密码区|备注|收款人|复核|开票人|欢迎光临|光临|谢谢惠顾|服务热线|会员|积分|价税合计|合计|小计|应付|实付|应收|实收|在线支付|微信支付|支付宝|找零/;

function extractMerchant(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (BUYER_LABEL_REGEX.test(line)) continue;
    const m = line.match(MERCHANT_LABEL_REGEX);
    if (m && m[1].trim()) return m[1].trim();
    if (MERCHANT_LABEL_BARE_REGEX.test(line)) {
      const next = lines[i + 1];
      if (next && !BUYER_LABEL_REGEX.test(next) && !MERCHANT_NOISE_LINE_REGEX.test(next)) {
        return next.trim();
      }
    }
  }

  // 没有显式标签：退回启发式——纯中文、不含数字金额、不是噪声/购买方行的
  // 第一行，通常是小票抬头的店铺名（与 index.js 既有商户名启发式同一思路）
  for (const line of lines) {
    if (BUYER_LABEL_REGEX.test(line)) continue;
    if (MERCHANT_NOISE_LINE_REGEX.test(line)) continue;
    if (/^\d/.test(line)) continue;
    if (/\d+\.\d{1,2}/.test(line)) continue;
    const chineseCount = (line.match(/[一-龥]/g) || []).length;
    if (chineseCount >= 2 && line.length <= 25) return line;
  }
  return '';
}

// ---------------- 日期清洗 ----------------

const DATE_LABEL_REGEX = /(?:开票日期|交易时间|消费时间|下单时间|日期|时间)\s*[:：]?\s*(\d{4})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})日?/;
const DATE_BARE_REGEX = /(\d{4})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})日?/;
// 🔧（2026-09-11）无年份日期兜底：要求整行只有"MM-DD"/"MM/DD"本身（可选带
// 时间后缀），不在长文本里挖字段——避免把"09-10元"这类无关数字片段、或
// 电话号码/单号里恰好出现的短横线组合误判成日期
const DATE_NO_YEAR_REGEX = /^(\d{1,2})[-\/](\d{1,2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/;

function toIsoDate(y, m, d) {
  const year = parseInt(y, 10);
  const month = parseInt(m, 10);
  const day = parseInt(d, 10);
  if (!(year >= 1900 && year <= 2200)) return null;
  if (!(month >= 1 && month <= 12)) return null;
  if (!(day >= 1 && day <= 31)) return null;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * @param {string[]} lines
 * @param {number} [assumedYear] 无年份日期兜底时假定的年份，默认取真实
 *   当前年份；测试场景显式传入固定值，保持函数确定性可测
 */
function extractReportDate(lines, assumedYear) {
  for (const line of lines) {
    const m = line.match(DATE_LABEL_REGEX);
    if (m) {
      const iso = toIsoDate(m[1], m[2], m[3]);
      if (iso) return iso;
    }
  }
  for (const line of lines) {
    const m = line.match(DATE_BARE_REGEX);
    if (m) {
      const iso = toIsoDate(m[1], m[2], m[3]);
      if (iso) return iso;
    }
  }
  for (const line of lines) {
    const iso = extractChineseDate(line);
    if (iso) return iso;
  }
  const effectiveYear = typeof assumedYear === 'number' ? assumedYear : new Date().getFullYear();
  for (const line of lines) {
    const m = line.trim().match(DATE_NO_YEAR_REGEX);
    if (m) {
      const iso = toIsoDate(effectiveYear, m[1], m[2]);
      if (iso) return iso;
    }
  }
  return '';
}

// ---------------- 品类归集与自动分类 ----------------
//
// ⚠️ 与 docs/SCHEMA.md 第 6 节 inventory_items.category（grain_oil/
// fresh_produce/mushroom_dried/plant_protein/packaging）是两套完全独立的
// 枚举，故意不复用：inventory_items 明确只服务商业专区（orgType !==
// 'yuhuazhai'，雨花斋被硬拒绝），本模块反过来专门服务"雨花斋标准支出台账"，
// 两者业态边界相反，混用会把不该出现在雨花斋场景的商业进销存概念带进来。
// key 也刻意避开重名（用 fresh_veggie 而不是 fresh_produce），防止未来
// 有人望文生义地当成同一套体系互相 require。
//
// 🔧（2026-09-11 端到端压测）关键词表补齐常见方言/口语别名（洋芋=土豆、
// 番薯/地瓜=红薯等），压测数据集里"农贸市场手写收据"品类命中率的提升
// 主要来自这一批扩充
const CATEGORY_RULES = [
  {
    key: 'staple_grain_oil',
    label: '主食粮油',
    regex: /大米|香米|籼米|粳米|东北大米|面粉|富强粉|小麦粉|挂面|面条|米粉|玉米面|小米|糯米|黑米|薏米|黄豆|绿豆|红豆|食用油|大豆油|花生油|菜籽油|调和油|色拉油|玉米油|葵花籽油|橄榄油|芝麻油|花椒油|食盐|白糖|酱油|食醋|味精|鸡精|蚝油|料酒|调味/
  },
  {
    key: 'fresh_veggie',
    label: '生鲜蔬菜',
    regex: /蔬菜|青菜|白菜|土豆|洋芋|萝卜|黄瓜|西红柿|番茄|生菜|包菜|花菜|菜花|茄子|豆角|辣椒|冬瓜|南瓜|芹菜|菠菜|韭菜|韭黄|豆芽|豆腐|香菇|木耳|平菇|金针菇|莴笋|芥菜|苦瓜|丝瓜|秋葵|西兰花|红薯|地瓜|番薯|大葱|小葱|香葱|生姜|大蒜|蒜头|水果|苹果|香蕉|橙子|梨|葡萄|西瓜|柚子/
  },
  {
    key: 'kitchen_supplies',
    label: '后厨耗材',
    regex: /洗洁精|纸巾|抹布|垃圾袋|垃圾桶|保鲜膜|保鲜袋|清洁球|钢丝球|消毒液|84消毒|漂白水|一次性手套|口罩|厨房纸|洗碗布|百洁布|购物袋|塑料袋|包装袋|餐盒/
  }
];
const OTHER_CATEGORY = { key: 'other', label: '其他' };

function classifyItemCategory(name) {
  const str = String(name || '');
  for (const rule of CATEGORY_RULES) {
    if (rule.regex.test(str)) return { key: rule.key, label: rule.label };
  }
  return { key: OTHER_CATEGORY.key, label: OTHER_CATEGORY.label };
}

function emptyCategorySummary() {
  const summary = {};
  CATEGORY_RULES.forEach((r) => { summary[r.key] = 0; });
  summary[OTHER_CATEGORY.key] = 0;
  return summary;
}

// ---------------- 品名净化 ----------------
//
// 🔧（2026-09-11）促销/活动标签净化：【特价】【春节特惠】等中/英文方括号
// 包裹的营销文案常混进品名文本里，剥离后不影响品类判定（品类关键词大多
// 仍留在剩余文本里），只是让展示出来的品名更干净。同时收敛掉品名里残留
// 的空白字符（OCR 断行/断字经常在品名中间插入多余空格）
const PROMO_TAG_REGEX = /[【\[［].*?[】\]］]/g;

function cleanItemName(name) {
  return String(name || '')
    .replace(PROMO_TAG_REGEX, '')
    .replace(/\s+/g, '')
    .trim();
}

// ---------------- 商品明细行解析 ----------------

// 商品明细区结束标记：与总金额/优惠/发票尾部信息同源，命中即视为"明细区
// 到此为止"，避免把汇总行/发票落款误解析成商品
const SECTION_NOISE_REGEX = new RegExp(
  [
    TOTAL_TIER1_REGEX.source,
    TOTAL_TIER2_REGEX.source,
    TOTAL_INVOICE_REGEX.source,
    TOTAL_TIER1_BARE_REGEX.source,
    TOTAL_TIER2_BARE_REGEX.source,
    DISCOUNT_LINE_REGEX.source,
    '找零|找回|应找|流水号|订单号|会员卡|积分|电话|热线|条码|税号|纳税人识别号|开户行|账号',
    '发票代码|发票号码|开票日期|购买方|销售方|价税合计|备注|收款人|复核|开票人|欢迎光临|光临|谢谢惠顾|服务热线'
  ].join('|')
);

function isItemCandidateLine(line) {
  if (CHANGE_OR_NOISE_LINE_REGEX.test(line)) return false;
  if (SECTION_NOISE_REGEX.test(line)) return false;
  if (MERCHANT_LABEL_REGEX.test(line) || MERCHANT_LABEL_BARE_REGEX.test(line)) return false;
  if (DATE_LABEL_REGEX.test(line)) return false;
  // 纯日期/纯条码/纯流水号行：不携带任何品名+价格信息
  if (/^\d{6,}$/.test(line.trim())) return false;
  // 🔧（2026-09-11）中文大写金额行/中文日期行不含任何阿拉伯数字，如果不
  // 显式排除会被模式 E（跨行品名+金额，见 isBareNameOnlyLine）误判成"纯
  // 品名候选行"，与后续行意外配对出一条假商品
  if (extractChineseWordAmount(line) !== null) return false;
  if (extractChineseDate(line) !== null) return false;
  return true;
}

// 数量单位：斤/千克/公斤/kg 等重量单位，以及件/袋/瓶/包/只/条等计数单位
const QTY_UNIT_SRC = '(?:斤|千克|公斤|kg|KG|Kg|件|袋|瓶|包|只|条|盒|箱|个)';

// 模式 A（发票/表格style，字段带显式标签）：「品名... 数量:N 单价:P 金额:A」
const LABELED_TRIPLE_REGEX = new RegExp(
  `^(.+?)\\s*数量\\s*[:：]\\s*(\\d+(?:\\.\\d+)?)\\s*${QTY_UNIT_SRC}?\\s*单价\\s*[:：]\\s*${AMOUNT_TOKEN_SRC}\\s*金额\\s*[:：]\\s*${AMOUNT_TOKEN_SRC}`
);
const LABELED_NAME_PREFIX_REGEX = /^(?:货物或应税劳务[,，]?服务名称|货物名称|品名|商品名称)\s*[:：]?\s*/;

// 模式 B（农贸市场手写/计算器式）：「品名 数量[单位] x 单价 = 金额」
const CALC_TRIPLE_REGEX = new RegExp(
  `^(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s*${QTY_UNIT_SRC}?\\s*[×xX*]\\s*${AMOUNT_TOKEN_SRC}\\s*=\\s*${AMOUNT_TOKEN_SRC}$`
);

// 🚨（2026-09-11 超市"数量*单价 金额"无等号紧急加固）模式 B'：与模式 B 是
// 同一种"数量×单价=金额"写法的印刷变体——连锁超市小票常见省略"="、单价
// 与金额之间只留一个空格（如"伊利心情 5*2.90 14.50"），此前这类行会整体
// 落进模式 D（SIMPLE_PAIR_REGEX），把"5*2.90"这段计价算式当成品名的一部分
// 一并吞进 name 字段。与模式 B 共用同一份 QTY_UNIT_SRC/AMOUNT_TOKEN_SRC，
// 唯一差异是用 `\s+` 代替 `=`
const CALC_TRIPLE_NO_EQUALS_REGEX = new RegExp(
  `^(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s*${QTY_UNIT_SRC}?\\s*[×xX*]\\s*${AMOUNT_TOKEN_SRC}\\s+${AMOUNT_TOKEN_SRC}$`
);

// 模式 C（手写只给重量+小计，没有单独写单价）：「品名 数量+重量单位 金额」
const WEIGHT_PAIR_REGEX = new RegExp(`^(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s*(斤|千克|公斤|kg|KG|Kg)\\s+${AMOUNT_TOKEN_SRC}$`);

// 模式 D（兜底，仅品名+金额，数量记 1）：「品名 [xN]? 金额」
const SIMPLE_PAIR_REGEX = new RegExp(`^(.+?)\\s*(?:[\\[\\(]\\s*[xX×]\\s*(\\d+)\\s*[\\]\\)])?\\s+${AMOUNT_TOKEN_SRC}$`);

// 🔧（2026-09-11）模式 E：品名与金额被 OCR 拆成两行——本行不含任何数字，
// 判定为"纯品名候选行"，下一行是孤立的金额数字。与总金额提取里"关键字
// 单独一行、金额在下一行"同一处兼容思路，覆盖热敏纸小票折痕断行场景
function isBareNameOnlyLine(line) {
  return !/\d/.test(line) && /[一-龥]/.test(line) && line.length <= 20;
}

// 🚨（2026-09-11 生鲜小票双行结构紧急加固）模式 F：超市生鲜柜台小票常见的
// "品名/计价单位"+"条码 数量 单价 金额"两行结构——第一行是纯品名（可能带
// /斤、/kg、/件 等计价单位后缀，如"一级茶树菇/斤"），第二行以 8~14 位数字
// 条码开头，紧跟数量、单价、金额三个数字（如"2105019011004 0.22 49.90
// 11.00"）。此前这两行各自落进模式 D（SIMPLE_PAIR_REGEX）独立解析：条码行
// 被当成"品名+金额"，cleanItemName 又把空格全部去掉，把条码/数量/单价拼成
// 一串毫无意义的数字（如"21050190110040.2249.90"）当成品名；真正的中文
// 品名所在行因为末尾没有金额，任何模式都匹配不上，直接被静默丢弃（有时还
// 被 extractMerchant 的启发式误当成商户名）。
// 修复：品名严格取第一行剥离计价单位后缀之后的纯文字，金额严格取第二行
// 最后一项数字（真正的成交金额），条码/数量/单价三项一律丢弃，不落入
// quantity/unitPrice 字段——这三个数字对台账记账没有意义，硬塞进去反而会
// 触发错误的 priceMismatch 校验（如拿"数量×单价"去对"金额"反而对不上）
const FRESH_PRODUCE_UNIT_SUFFIX_REGEX = /\/(斤|千克|公斤|kg|KG|Kg|克|g|件|袋|包|个|只|条|盒|箱)$/;
const FRESH_PRODUCE_BARCODE_LINE_REGEX = new RegExp(
  `^\\d{8,14}\\s+\\d+(?:\\.\\d+)?\\s+\\d+(?:\\.\\d+)?\\s+${AMOUNT_TOKEN_SRC}$`
);

function stripFreshProduceUnitSuffix(name) {
  return String(name || '').replace(FRESH_PRODUCE_UNIT_SUFFIX_REGEX, '').trim();
}

// 🚨（2026-09-11 连锁超市"编号.品名(规格)/单位"双行结构紧急加固）模式 G：
// 中润华联等连锁超市小票常见的"编号.品名(规格)/计量单位"一行 + "数量*单价
// 金额"（无等号，空格分隔）另起一行——与模式 F（生鲜柜台条码行）是同一类
// "品名与金额分行打印"问题的不同变体，差异在第二行的形状（模式 F 是"条码
// 数量 单价 金额"四段纯数字，模式 G 是"数量*单价 金额"三段）。此前这两行
// 各自独立解析：品名行因为带着"编号."（如"1."）、"(规格)"（如"(40支装)"）
// 这类合法但含数字的修饰成分，被模式 E 的 isBareNameOnlyLine（要求整行不
// 含任何数字）挡在两行组合识别之外，直接静默丢弃；价格行"5*2.90 14.50"
// 整体落进模式 D（SIMPLE_PAIR_REGEX），被当成"品名=5*2.90，金额=14.50"——
// 真正的商品名被计价算式顶替，同一张小票里数量=1（没有"N*"前缀、只有
// 单个金额）的商品行（如"4.50"）则完全没有任何模式能匹配，直接漏算。
//
// 修复：新增 isLabeledProductNameLine 作为 isBareNameOnlyLine 的补充判定——
// 剥离"编号."前缀/"(规格)"括号/"/单位"后缀后，只要剩余文本还有 ≥2 个汉字
// 就认定是品名候选行（不再要求整行不含任何数字，因为编号/规格本身就含
// 合法数字，甚至品名自身可能含数字，如真实产品"雀巢8次方"）；配合下一行
// 是模式 G 的"数量*单价 金额"还是模式 E 的纯金额，分别取对应的数量/单价/
// 金额组合，都不会重复计入 quantity/unitPrice 字段导致误判 priceMismatch
const SEQ_NUMBER_PREFIX_REGEX = /^\d{1,3}[.、]\s*/;
const SPEC_PAREN_REGEX = /[（(][^（）()]*[）)]/g;
const NAME_UNIT_SUFFIX_REGEX = /\/[一-龥A-Za-z]{1,6}$/;

function extractLabeledProductName(line) {
  return String(line || '')
    .replace(SEQ_NUMBER_PREFIX_REGEX, '')
    .replace(SPEC_PAREN_REGEX, '')
    .replace(NAME_UNIT_SUFFIX_REGEX, '')
    .trim();
}

// PURE_NUMERIC_NAME_REGEX 定义在本文件下方 pushItem 附近，与本函数同一个
// 模块作用域内，调用时机（parseItemLines 运行期）晚于模块整体求值完成，
// 此处提前引用不会有时序问题——两处共用同一份"纯数字/小数点判定为非法
// 品名"口径，不再各写一份
function isLabeledProductNameLine(line) {
  const stripped = extractLabeledProductName(line);
  if (!stripped || PURE_NUMERIC_NAME_REGEX.test(stripped)) return false;
  const chineseCount = (stripped.match(/[一-龥]/g) || []).length;
  return chineseCount >= 2;
}

// 「数量*单价 金额」——数量与单价之间是乘号，单价与金额之间只有空格
// （没有"="），与 CALC_TRIPLE_NO_EQUALS_REGEX 是同一种写法，这里单独复用
// 一份不含品名捕获组的版本，专供模式 G 的"下一行"匹配使用
const MULTI_UNIT_CALC_LINE_REGEX = new RegExp(
  `^(\\d+(?:\\.\\d+)?)\\s*[×xX*]\\s*${AMOUNT_TOKEN_SRC}\\s+${AMOUNT_TOKEN_SRC}$`
);

// 单价×数量 与识别到的行金额之间允许的合理误差：取「5分钱」与「2%」两者较大值，
// 覆盖常见的四舍五入/秤重末位截断，超出才视为真正的识别错位
function amountsReconcile(expected, actual) {
  const diff = Math.abs(expected - actual);
  const tolerance = Math.max(0.05, actual * 0.02);
  return diff <= tolerance;
}

function parseItemLines(candidateLines) {
  const items = [];

  for (let i = 0; i < candidateLines.length; i++) {
    const line = candidateLines[i].trim();
    if (!line) continue;

    let m = line.match(LABELED_TRIPLE_REGEX);
    if (m) {
      const name = m[1].replace(LABELED_NAME_PREFIX_REGEX, '').trim() || line;
      const quantity = parseFloat(m[2]);
      const unitPrice = parseAmountToken(m[3]);
      const amount = parseAmountToken(m[4]);
      pushItem(items, name, quantity, unitPrice, amount);
      continue;
    }

    m = line.match(CALC_TRIPLE_REGEX);
    if (m) {
      const name = m[1].trim();
      const quantity = parseFloat(m[2]);
      const unitPrice = parseAmountToken(m[3]);
      const amount = parseAmountToken(m[4]);
      pushItem(items, name, quantity, unitPrice, amount);
      continue;
    }

    // 模式 B'：同一行「品名 数量*单价 金额」（无等号），见该正则头部注释。
    // 必须排在模式 D（SIMPLE_PAIR_REGEX）之前——否则"5*2.90"这段计价算式
    // 会被模式 D 的宽松匹配整体吞进品名字段
    m = line.match(CALC_TRIPLE_NO_EQUALS_REGEX);
    if (m) {
      const name = m[1].trim();
      const quantity = parseFloat(m[2]);
      const unitPrice = parseAmountToken(m[3]);
      const amount = parseAmountToken(m[4]);
      pushItem(items, name, quantity, unitPrice, amount);
      continue;
    }

    m = line.match(WEIGHT_PAIR_REGEX);
    if (m) {
      const name = m[1].trim();
      const quantity = parseFloat(m[2]);
      const amount = parseAmountToken(m[4]);
      // 只给了重量+小计，单价是反推出来的参考值，不参与一致性校验
      // （没有第三个独立数字可供交叉核对）
      const unitPrice = quantity > 0 && amount !== null ? round2(amount / quantity) : null;
      pushItem(items, name, quantity, unitPrice, amount, { unitPriceIsDerived: true });
      continue;
    }

    m = line.match(SIMPLE_PAIR_REGEX);
    if (m) {
      const name = m[1].trim();
      const hasQty = !!m[2];
      const quantity = hasQty ? parseFloat(m[2]) : 1;
      const rawNumber = parseAmountToken(m[3]);
      if (hasQty && rawNumber !== null) {
        // 🐛 [xN] 数量标记场景：与 index.js 既有 QUANTITY_MULTIPLIER_REGEX 同一
        // 约定——印在票面上的数字是单价，[xN] 之后要乘以数量才是这一行的
        // 小计，不能把印刷数字直接当成 amount（那会导致本应"单价×数量=
        // 小计"的合法数据被误判为 priceMismatch）
        const unitPrice = rawNumber;
        const amount = round2(unitPrice * quantity);
        pushItem(items, name, quantity, unitPrice, amount);
      } else {
        pushItem(items, name, quantity, rawNumber, rawNumber);
      }
      continue;
    }

    // 品名单独一行时，依次尝试模式 F（生鲜条码行）、模式 G（编号.品名(规格)/
    // 单位 + 数量*单价 金额）、模式 E（纯金额行）——三者的"下一行"形状互斥
    // （分别要求四段数字/三段数字/单个孤立数字），顺序不影响正确性，越具体
    // 的模式放越前面。isLabeledProductNameLine 是 isBareNameOnlyLine 的
    // 补充判定（见该函数头部注释），任一个成立就进入本分支
    const isLabeledName = isLabeledProductNameLine(line);
    if (isBareNameOnlyLine(line) || isLabeledName) {
      const nextLine = candidateLines[i + 1];
      const trimmedNext = nextLine ? nextLine.trim() : '';
      // 品名统一走 extractLabeledProductName 剥离编号/规格/单位——纯品名行
      // （isBareNameOnlyLine 命中、无需剥离任何修饰）剥离后结果与原文一致，
      // 两个分支不需要分别维护一套取名逻辑
      const cleanedLineName = extractLabeledProductName(line) || line;

      // 模式 F：生鲜小票双行结构（品名/计价单位 + 条码 数量 单价 金额）
      const barcodeMatch = trimmedNext.match(FRESH_PRODUCE_BARCODE_LINE_REGEX);
      if (barcodeMatch) {
        const amount = parseAmountToken(barcodeMatch[1]);
        const name = stripFreshProduceUnitSuffix(line);
        pushItem(items, name, 1, amount, amount);
        i++; // 跳过已消费的条码行，避免被下一轮循环重复处理/误判成独立商品
        continue;
      }

      // 🚨 模式 G：编号.品名(规格)/单位 + 数量*单价 金额（无等号，见头部注释）
      const multiUnitMatch = trimmedNext.match(MULTI_UNIT_CALC_LINE_REGEX);
      if (multiUnitMatch) {
        const quantity = parseFloat(multiUnitMatch[1]);
        const unitPrice = parseAmountToken(multiUnitMatch[2]);
        const amount = parseAmountToken(multiUnitMatch[3]);
        pushItem(items, cleanedLineName, quantity, unitPrice, amount);
        i++; // 跳过已消费的价格行
        continue;
      }

      // 模式 E：跨行品名+金额（见 isBareNameOnlyLine 头部注释）
      const bareMatch = trimmedNext.match(BARE_AMOUNT_LINE_REGEX);
      if (bareMatch) {
        const amount = parseAmountToken(bareMatch[1]);
        pushItem(items, cleanedLineName, 1, amount, amount);
        i++; // 跳过已消费的金额行，避免被下一轮循环重复处理
      }
    }
  }

  return items;
}

// 🚨（2026-09-11 生鲜小票双行结构紧急加固）纯数字/小数点品名一律禁止入选：
// 条码、称重克重、单价等数字被误判/误拼接成"品名"时，清洗后必然是一串
// 只含数字和小数点的字符串（如"21050190110040.2249.90"、"0.22"）——真实
// 商品名不可能不含任何汉字/字母，这是最后一道防线，兜住模式 F 之外任何
// 还会把条码行独立解析成"品名+金额"的场景（如条码行前面恰好没有紧邻
// 一行合法的纯品名候选行）
const PURE_NUMERIC_NAME_REGEX = /^[\d.]+$/;

function pushItem(items, rawName, quantity, unitPrice, amount, opts) {
  const name = cleanItemName(rawName);
  if (!name || amount === null || !(amount >= 0)) return;
  if (PURE_NUMERIC_NAME_REGEX.test(name)) return;
  const category = classifyItemCategory(name);
  const item = {
    name,
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
    unitPrice: unitPrice !== null && Number.isFinite(unitPrice) ? round2(unitPrice) : null,
    amount: round2(amount),
    category: category.key,
    categoryLabel: category.label,
    priceMismatch: false
  };

  // 1a. 单价 × 数量与总价的合理性校验：三个数字都齐全时才有交叉核对的依据，
  // 只有重量反推单价（unitPriceIsDerived）时不校验——那是用 amount 算出来的，
  // 拿它反过来对 amount 校验没有意义，永远"一致"
  if (!(opts && opts.unitPriceIsDerived) && item.quantity !== null && item.unitPrice !== null) {
    const expected = round2(item.quantity * item.unitPrice);
    if (!amountsReconcile(expected, item.amount)) {
      item.priceMismatch = true;
      item.expectedAmount = expected;
    }
  }

  items.push(item);
}

// ---------------- 主入口 ----------------

/**
 * 将 OCR/多模态识别返回的原始文本块清洗为雨花斋标准支出台账草稿。
 * 永不抛异常——任何异常输入都归约为"识别不到、标记疑点"，不编造数据。
 * @param {string|string[]|{text?:string,words?:string}[]} rawPayload
 * @param {{assumedYear?: number}} [options] assumedYear：无年份日期兜底
 *   （见 extractReportDate）时假定的年份，默认真实当前年份
 * @returns {object} 支出台账草稿
 */
function parseReceiptPayload(rawPayload, options) {
  const lines = normalizeLines(rawPayload);
  const reviewReasons = [];
  const assumedYear = options && typeof options.assumedYear === 'number' ? options.assumedYear : undefined;

  const { amount: totalAmount, source: totalSource } = extractTotalAmount(lines);
  const discountAmount = extractDiscountAmount(lines);
  const merchant = extractMerchant(lines);
  const reportDate = extractReportDate(lines, assumedYear);

  const candidateLines = lines.filter(isItemCandidateLine);
  const items = parseItemLines(candidateLines);

  const categorySummary = emptyCategorySummary();
  let sumItemsAmount = 0;
  const mismatchedItemNames = [];
  items.forEach((item) => {
    categorySummary[item.category] = round2((categorySummary[item.category] || 0) + item.amount);
    sumItemsAmount = round2(sumItemsAmount + item.amount);
    if (item.priceMismatch) mismatchedItemNames.push(item.name);
  });

  if (lines.length === 0) {
    reviewReasons.push('未识别到任何有效文本，请确认图片清晰或重新拍摄');
  }

  let finalTotalAmount = totalAmount;
  if (finalTotalAmount === null) {
    if (sumItemsAmount > 0) {
      // 没有关键字总金额，退回商品明细汇总——本身是较弱的推断，必须标记疑点
      finalTotalAmount = sumItemsAmount;
      reviewReasons.push('未识别到总金额关键字（实付/合计/价税合计等），已用商品明细合计代替，请核对');
    } else {
      reviewReasons.push('未能识别到总金额，且无可用的商品明细合计，请手动填写');
    }
  } else if (items.length > 0) {
    // 有总金额也有明细：交叉核对"明细合计 - 优惠 ≈ 总金额"，超出容差视为低置信度
    const reconciledTotal = round2(sumItemsAmount - discountAmount);
    const diff = Math.abs(reconciledTotal - finalTotalAmount);
    const tolerance = Math.max(1, finalTotalAmount * 0.05);
    if (diff > tolerance) {
      reviewReasons.push(
        `商品明细合计¥${sumItemsAmount.toFixed(2)}减优惠¥${discountAmount.toFixed(2)}=¥${reconciledTotal.toFixed(2)}，与总金额¥${finalTotalAmount.toFixed(2)}相差¥${diff.toFixed(2)}，请核对`
      );
    }
  }

  if (mismatchedItemNames.length > 0) {
    reviewReasons.push(`以下商品的单价×数量与识别金额不一致，请核对：${mismatchedItemNames.join('、')}`);
  }

  if (!merchant) {
    reviewReasons.push('未识别到交易对手（销售方/商户名称），请人工补充');
  }
  if (!reportDate) {
    reviewReasons.push('未识别到有效日期，请人工补充');
  }

  return {
    merchant,
    reportDate,
    totalAmount: finalTotalAmount !== null ? round2(finalTotalAmount) : null,
    totalAmountSource: totalSource,
    discountAmount,
    items,
    categorySummary,
    sumItemsAmount: round2(sumItemsAmount),
    flagNeedsReview: reviewReasons.length > 0,
    reviewReasons,
    rawTextLines: lines
  };
}

module.exports = {
  parseReceiptPayload,
  classifyItemCategory,
  extractTotalAmount,
  extractMerchant,
  extractReportDate,
  extractDiscountAmount,
  CATEGORY_RULES,
  OTHER_CATEGORY,
  // 🔧（2026-09-11 端到端压测容错加固）新增导出，供压测套件直接单测
  normalizeOcrDigits,
  normalizeDecimalComma,
  chineseNumeralToValue,
  extractChineseWordAmount,
  extractChineseDate,
  cleanItemName,
  // 🚨（2026-09-11 生鲜小票双行结构紧急加固）新增导出，供单测直接覆盖
  stripFreshProduceUnitSuffix,
  // 🚨（2026-09-11 连锁超市"编号.品名(规格)/单位"双行结构紧急加固）新增
  // 导出，供单测直接覆盖
  isLabeledProductNameLine,
  extractLabeledProductName
};
