'use strict';

// 🧾 发票/小票 OCR 智能记账 · 第一阶段（2026-09-10）
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
// 空数组，绝不抛异常
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
    .map((s) => String(s || '').trim())
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
  }

  // 发票的「价税合计」是法定总额，比小票的实付/合计关键词更权威，优先采用
  if (invoiceTotal !== null) return { amount: invoiceTotal, source: 'invoice_total' };
  if (tier1 !== null) return { amount: tier1, source: 'tier1_actual_pay' };
  if (tier2 !== null) return { amount: tier2, source: 'tier2_subtotal' };
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

function extractReportDate(lines) {
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
const CATEGORY_RULES = [
  {
    key: 'staple_grain_oil',
    label: '主食粮油',
    regex: /大米|香米|籼米|粳米|东北大米|面粉|富强粉|小麦粉|挂面|面条|米粉|食用油|大豆油|花生油|菜籽油|调和油|色拉油|玉米油|葵花籽油|橄榄油|食盐|白糖|酱油|食醋|调味/
  },
  {
    key: 'fresh_veggie',
    label: '生鲜蔬菜',
    regex: /蔬菜|青菜|白菜|土豆|萝卜|黄瓜|西红柿|番茄|生菜|包菜|花菜|茄子|豆角|辣椒|冬瓜|南瓜|芹菜|菠菜|韭菜|豆芽|豆腐|香菇|木耳|平菇|金针菇|水果|苹果|香蕉|橙子/
  },
  {
    key: 'kitchen_supplies',
    label: '后厨耗材',
    regex: /洗洁精|纸巾|抹布|垃圾袋|保鲜膜|保鲜袋|清洁球|钢丝球|消毒液|84消毒|一次性手套|厨房纸|购物袋|塑料袋|包装袋|餐盒/
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

// 模式 C（手写只给重量+小计，没有单独写单价）：「品名 数量+重量单位 金额」
const WEIGHT_PAIR_REGEX = new RegExp(`^(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s*(斤|千克|公斤|kg|KG|Kg)\\s+${AMOUNT_TOKEN_SRC}$`);

// 模式 D（兜底，仅品名+金额，数量记 1）：「品名 [xN]? 金额」
const SIMPLE_PAIR_REGEX = new RegExp(`^(.+?)\\s*(?:[\\[\\(]\\s*[xX×]\\s*(\\d+)\\s*[\\]\\)])?\\s+${AMOUNT_TOKEN_SRC}$`);

// 单价×数量 与识别到的行金额之间允许的合理误差：取「5分钱」与「2%」两者较大值，
// 覆盖常见的四舍五入/秤重末位截断，超出才视为真正的识别错位
function amountsReconcile(expected, actual) {
  const diff = Math.abs(expected - actual);
  const tolerance = Math.max(0.05, actual * 0.02);
  return diff <= tolerance;
}

function parseItemLines(candidateLines) {
  const items = [];

  candidateLines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;

    let m = line.match(LABELED_TRIPLE_REGEX);
    if (m) {
      const name = m[1].replace(LABELED_NAME_PREFIX_REGEX, '').trim() || line;
      const quantity = parseFloat(m[2]);
      const unitPrice = parseAmountToken(m[3]);
      const amount = parseAmountToken(m[4]);
      pushItem(items, name, quantity, unitPrice, amount);
      return;
    }

    m = line.match(CALC_TRIPLE_REGEX);
    if (m) {
      const name = m[1].trim();
      const quantity = parseFloat(m[2]);
      const unitPrice = parseAmountToken(m[3]);
      const amount = parseAmountToken(m[4]);
      pushItem(items, name, quantity, unitPrice, amount);
      return;
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
      return;
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
      return;
    }
  });

  return items;
}

function pushItem(items, name, quantity, unitPrice, amount, opts) {
  if (!name || amount === null || !(amount >= 0)) return;
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
 * @returns {object} 支出台账草稿
 */
function parseReceiptPayload(rawPayload) {
  const lines = normalizeLines(rawPayload);
  const reviewReasons = [];

  const { amount: totalAmount, source: totalSource } = extractTotalAmount(lines);
  const discountAmount = extractDiscountAmount(lines);
  const merchant = extractMerchant(lines);
  const reportDate = extractReportDate(lines);

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
  OTHER_CATEGORY
};
