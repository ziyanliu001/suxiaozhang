const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 🛡️ 金额识别关键字：按优先级分两档。
// 第一优先级——实际支付渠道/实付金额，这是顾客真正付出的钱，最贴近"今日支出"口径；
// 第二优先级——实收/应付/合计/小计，多数小票会有但不一定是优惠后的最终支付额。
// 🐛 修复"57.30 实付被误识别为 60.61"：旧版本把"金额""总计"也纳入同一档关键词，
// 一次遍历里先在文本中出现哪个就用哪个，与"哪个更权威"无关；"金额"是"总金额"的子串，
// 会被"总金额: 60.61"（优惠前原价）这类行意外命中，且原价行往往排在实付行前面，先被匹配到。
// 🐛 补齐"微支付"：部分生鲜/菜市场秤重小票（如"鑫盛生鲜超市"）POS 机具打印的是"微支付"
// 这个两字缩写，而不是"微信支付"四字全称——旧正则只认后者，导致"微支付: 40.40"整行完全
// 识别不到关键词金额，keywordAmount 退回到明细累加兜底，一旦某一件商品的秤重数字有微小
// 累加误差，最终"实付"就会和小票上印的数字对不上。
const TIER1_KEYWORD_REGEX = /(?:在线支付|商品实付|实付金额|实付|微信支付|微支付|支付宝)\s*[:：]?\s*([¥￥]?\s*\d+(?:\.\d{1,2})?)/i;
const TIER2_KEYWORD_REGEX = /(?:实收|应付|合计|小计)\s*[:：]?\s*([¥￥]?\s*\d+(?:\.\d{1,2})?)/i;

// 🛡️ "关键字单独一行、金额在下一行"的兼容匹配：OCR 逐行识别经常会把"商品实付"和
// "57.30"拆成两行分别输出，上面两个正则要求关键字与数值紧邻同行，遇到这种拆行情况
// 会直接匹配失败、拿不到金额。这两个正则只用来判断"这一行是不是纯关键字（没有数值）"，
// 命中后再去看下一行是不是一个孤立的金额数字。
const TIER1_BARE_KEYWORD_REGEX = /^(?:在线支付|商品实付|实付金额|实付|微信支付|微支付|支付宝)\s*[:：]?\s*$/i;
const TIER2_BARE_KEYWORD_REGEX = /^(?:实收|应付|合计|小计)\s*[:：]?\s*$/i;
const BARE_AMOUNT_LINE_REGEX = /^[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*$/;

// 🌟 AI/OCR 节点与业务计算彻底解耦：本云函数只负责"从小票里认字、把数字挑出来"，
// 绝不做任何加减法去推导"今日支出"——那是前端 computeTodayFinancials（唯一权威计算入口）
// 的职责。这里额外拆出 raw_total_amount / shipping_fee / discount_amount 三个字段，
// 单纯是为了让"识别到的原始数字"和"最终认定的实付金额 actual_pay"互相独立、可各自核对，
// 而不是把它们混算成一个不可回溯的黑盒总数。
// - 运费：配送费/运费/配送运费，小票上通常只有一行
const SHIPPING_FEE_REGEX = /(?:配送运费|配送费|运费)\s*[:：]?\s*([¥￥]?\s*\d+(?:\.\d{1,2})?)/;
const SHIPPING_FEE_BARE_KEYWORD_REGEX = /^(?:配送运费|配送费|运费)\s*[:：]?\s*$/;
// - 优惠：优惠券/满减/立减/店铺优惠/会员优惠/膨胀优惠等，同一张小票可能出现多行，
//   全部识别到的优惠金额需要累加（如 5.00 + 7.99 = 12.99），而不是只取第一条
// 🐛 补齐"为您节省"：生鲜秤重类小票常见的优惠表达方式（如"为您节省: 4.10"），语义上和
// "优惠券/满减"完全等价，都是"原价小计 - 这部分 = 实付"链路里必须扣掉的一环——漏掉它会导致
// isConfidenceLow 的核对算式变成"原价44.50 + 运费0 - 优惠0 = 44.50"，和真实实付40.40 差了
// 一个"为您节省"的量，明明是完全正常的一张小票却被误判成低置信度。
const DISCOUNT_LINE_REGEX = /(?:优惠券|满减|立减|店铺优惠|会员优惠|膨胀优惠|商品优惠|为您节省|优惠)\s*[:：]?\s*([¥￥]?\s*\d+(?:\.\d{1,2})?)/g;
// 🐛 修复"商品优惠"这类关键字被漏记：这条正则用 ^...$ 锚定要求关键字必须从第 0 个字符开始，
// "商品优惠"以"商品"开头、"优惠"在后半段，即使把"优惠"单列为兜底关键字也匹配不到——
// anchor 只认"从头就是列表里的某个词"，不认"字符串结尾是列表里的某个词"。显式补上"商品优惠"
// 才能覆盖这种"业务前缀 + 优惠"的常见小票写法，而不是指望结尾的通用"优惠"兜底。
const DISCOUNT_BARE_KEYWORD_REGEX = /^(?:优惠券|满减|立减|店铺优惠|会员优惠|膨胀优惠|商品优惠|为您节省|优惠)\s*[:：]?\s*$/;
// - 原价小计：商品优惠前的合计，用于与"实付"交叉核对是否存在运费/优惠调整
// 🐛 补齐"商品小计"：这是比"商品原价合计"更常见的写法（很多小票直接写"商品小计"表示
// 折前商品合计），此前漏掉这个关键字会导致 rawTotalAmount 只能退回明细累加 sumExtracted，
// 在"购物袋等非商品加项是否计入小计"这类分类口径不一致的场景下，白白制造一次本可避免的
// 差异告警——有明确的"商品小计"关键字行时，应该优先信它，而不是自己拿商品明细重新加一遍。
const RAW_TOTAL_REGEX = /(?:商品原价合计|原价合计|商品金额合计|商品小计)\s*[:：]?\s*([¥￥]?\s*\d+(?:\.\d{1,2})?)/;
const RAW_TOTAL_BARE_KEYWORD_REGEX = /^(?:商品原价合计|原价合计|商品金额合计|商品小计)\s*[:：]?\s*$/;

// 🛡️ 排除规则：
// - "总金额"：通常指优惠前的原价，不参与匹配（即使该行同时含有一/二优先级关键词也整行跳过，
//   因为真实小票里"总金额"和"实付"极少会写在同一行，一旦同现更可能是"总金额"这个词本身干扰）。
// - "优惠"：仅当该行不包含任何一/二优先级关键词时才排除（避免误伤"优惠后实付 57.30"这类
//   本身就是最终支付额的合法行——它含有"优惠"字样，但要匹配的是后面的"实付"）。
function isExcludedLine(line) {
  if (/总金额/.test(line)) return true;
  if (/优惠/.test(line) && !TIER1_KEYWORD_REGEX.test(line) && !TIER2_KEYWORD_REGEX.test(line)) return true;
  return false;
}

// 🛡️ 噪声行过滤：日期(YYYYMMDD)、手机号(1开头11位)、订单/流水号(长纯数字)一律不参与金额匹配，
// 因为关键词正则本身要求"关键字 + 数值"紧邻出现，这些噪声行天然不会被误配，
// 这里额外补一层显式排除，防止未来关键字列表扩充后误伤
function isNoiseNumberLine(str) {
  if (/^\d{8}$/.test(str.trim())) return true; // 纯 8 位日期
  if (/^1\d{10}$/.test(str.trim())) return true; // 11 位手机号
  if (/^\d{12,}$/.test(str.trim())) return true; // 长纯数字流水号/订单号
  return false;
}

function parseAmount(rawStr) {
  const cleaned = String(rawStr || '').replace(/[¥￥\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// 🛡️ 白名单：购物袋/塑料袋/包装袋容易被"品名/金额"等噪声词误伤（或本身金额很小甚至为 0），
// 一旦被当噪声行跳过会导致该商品整行消失，且紧随其后的价格数字会被错误并入上一件商品的价格块——
// 即"购物袋丢失 + 后一件商品价格错位成购物袋的价格"。命中白名单的行永远当有效品名行处理，
// 不受噪声词过滤影响。
function isWhitelistedItemLine(str) {
  return /购物袋|塑料袋|包装袋|袋/.test(str);
}

// 🛡️ 纯数字条码/货号行（如 13 位 EAN 条码 "6954427544460"，或短货号 "2243922"）：
// 不携带任何价格信息，必须显式识别并跳过，不能被当成价格数字吞进当前商品的价格块，
// 也不能因为它既不是名称行也不是数字行而被误处理，进而干扰下一行真实商品名称/价格的对齐
function isBarcodeOnlyLine(str) {
  return /^\d{6,}$/.test(str.trim());
}

// 🛡️ 商品明细区结束标记：出现这些关键字，意味着"商品明细"到此结束，后面是
// 配送运费/优惠券/商品小计/商品实付/总金额等汇总与费用信息，绝不能再被解析成商品。
// 🐛 修复"配送费：0.50"被当成商品行吞进 formattedText：旧正则只写了"配送运费"这个
// 四字词，"配送费""运费""满减""立减"等同义/近义写法不是它的子串，会漏判；这里补齐后
// 与 SHIPPING_FEE_REGEX / DISCOUNT_LINE_REGEX 的关键字集合保持一致，避免同一类费用行
// 在"金额提取"和"商品分区截断"两处的识别范围不一致。
// 🐛 补齐裸词"实付"/"支付宝"：TIER1_KEYWORD_REGEX 早就把"实付"（不带"商品"/"在线"前缀）、
// "支付宝"列为一档关键词用于金额提取，但这里的分区截断标记一直没有同步这两个词——
// 当小票把"实付"单独一行、金额另起一行时，"实付"这一行会因为不匹配任何截断标记，
// 被当成商品明细区的一部分继续往下解析，进而在 isNoiseLine 里同样漏判，最终被
// 误当成一件品名叫"实付"、价格是实付金额的假商品混进列表。
const SECTION_END_MARKERS = /商品数量合计|---其他---|商品小计|商品实付|在线支付|实付|支付宝|应付|合计|小计|总计|总金额|配送运费|配送费|运费|优惠券|优惠|满减|立减/;

// 🛡️ 数量标记 [x2] / (x2) / ×2：识别后需要把该商品的单价乘以数量，
// 而不是把 [x2] 里的数字误当成另一个价格
const QUANTITY_MULTIPLIER_REGEX = /[\[\(]\s*[xX×]\s*(\d+)\s*[\]\)]/;

// 🌾（2026-08-31 商业化生态演进第二步）食材品类关键字：与 material_logs/
// getNationalDashboard 的"大米/面粉/食用油/蔬菜"四类核心物资口径一致。
// 🛡️ 诚实的能力边界——这是一次轻量正则清洗，不是接入了付费的通用票据结构化
// OCR 产品（那类产品才能做到"表格级"字段对齐，需要额外的 Tencent Cloud API
// 密钥与计费，不在本次范围内）。只有当"品类关键字"与"数字+重量单位"出现在
// 同一行（如"大米 5斤 25.00"）才能提取出 weightKg；品类名与重量数字分属
// 两行（部分小票的常见排版）时本版本识别不到，交给用户在确认弹窗里手动填写，
// 不做没有把握的跨行猜测拼接
const RICE_KEYWORDS_REGEX = /大米|香米|籼米|粳米|东北大米/;
const FLOUR_KEYWORDS_REGEX = /面粉|富强粉|小麦粉/;
const OIL_KEYWORDS_REGEX = /食用油|大豆油|花生油|菜籽油|调和油|色拉油|玉米油|葵花籽油|橄榄油/;
const VEGGIE_KEYWORDS_REGEX = /蔬菜|青菜|白菜|土豆|萝卜|黄瓜|西红柿|番茄|生菜|包菜|花菜|茄子|豆角|辣椒|冬瓜|南瓜|芹菜|菠菜|韭菜|豆芽/;
// 数字 + 重量单位紧邻出现——只认带显式单位的重量数字，不去猜测"这一行里
// 哪个孤立数字是重量、哪个是价格"，那类猜测精度不可控，容易把价格错当重量
const WEIGHT_UNIT_REGEX = /(\d+(?:\.\d+)?)\s*(斤|千克|公斤|kg|KG|Kg)/;

function classifyIngredientLine(line) {
  if (RICE_KEYWORDS_REGEX.test(line)) return 'rice';
  if (FLOUR_KEYWORDS_REGEX.test(line)) return 'flour';
  if (OIL_KEYWORDS_REGEX.test(line)) return 'oil';
  if (VEGGIE_KEYWORDS_REGEX.test(line)) return 'veggie';
  return null;
}

// 斤转公斤：除以 2；千克/公斤/kg 本身已是标准公斤单位，原样返回
function normalizeWeightToKg(value, unit) {
  if (unit === '斤') return value * 0.5;
  return value;
}

exports.main = async (event, context) => {
  const { fileID, fileId, imageBase64 } = event;
  const actualFileId = fileID || fileId;

  try {
    console.log('🚀 [OCR Cloud Function] 开始解析小票, fileId:', actualFileId);

    let ocrResult;
    try {
      if (actualFileId) {
        const tempRes = await cloud.getTempFileURL({ fileList: [actualFileId] });
        const imgUrl = (tempRes.fileList && tempRes.fileList[0]) ? tempRes.fileList[0].tempFileURL : null;
        if (imgUrl) {
          ocrResult = await cloud.openapi.ocr.printedText({
            type: 'photo',
            imgUrl: imgUrl
          });
        } else {
          const fileRes = await cloud.downloadFile({ fileID: actualFileId });
          ocrResult = await cloud.openapi.ocr.printedText({
            type: 'photo',
            img: { contentType: 'image/jpg', value: fileRes.fileContent }
          });
        }
      } else if (imageBase64) {
        ocrResult = await cloud.openapi.ocr.printedText({
          type: 'photo',
          img: { contentType: 'image/jpg', value: Buffer.from(imageBase64, 'base64') }
        });
      } else {
        ocrResult = { items: [] };
      }
    } catch (ocrErr) {
      console.warn('⚠️ OCR 接口调用异常:', ocrErr);
      ocrResult = { items: [] };
    }

    const rawItems = ocrResult.items || ocrResult.textList || ocrResult.results || [];
    const lines = rawItems.map(item => (item.text || item.words || item || '').trim()).filter(Boolean);

    console.log('📝 [OCR 原始文本行]:', lines);

    // 🛡️ 1. 分两档优先级提取金额：先整份小票找第一优先级（实付/在线支付/微信支付/支付宝），
    // 全文都没有才退而求其次找第二优先级（实收/应付/合计/小计）；过滤"总金额"/纯优惠行/
    // 日期/手机号/订单号等噪声行，确保拿到的是顾客真正支付的那个数字。
    // 注意：金额提取始终扫描完整的 lines（商品实付/总金额等关键字本就出现在商品明细区之后），
    // 只有下面的"商品明细解析"才需要做分区截断。
    let tier1Amount = null;
    let tier2Amount = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isNoiseNumberLine(line) || isExcludedLine(line)) continue;

      if (tier1Amount === null) {
        const tier1Match = line.match(TIER1_KEYWORD_REGEX);
        if (tier1Match) {
          const amt = parseAmount(tier1Match[1]);
          if (amt !== null && amt > 0) tier1Amount = amt;
        } else if (TIER1_BARE_KEYWORD_REGEX.test(line)) {
          // 关键字单独一行，金额很可能在紧接着的下一行
          const nextLine = lines[i + 1];
          if (nextLine && !isExcludedLine(nextLine) && !isNoiseNumberLine(nextLine)) {
            const bareMatch = nextLine.match(BARE_AMOUNT_LINE_REGEX);
            if (bareMatch) {
              const amt = parseAmount(bareMatch[1]);
              if (amt !== null && amt > 0) tier1Amount = amt;
            }
          }
        }
      }

      if (tier1Amount === null && tier2Amount === null) {
        const tier2Match = line.match(TIER2_KEYWORD_REGEX);
        if (tier2Match) {
          const amt = parseAmount(tier2Match[1]);
          if (amt !== null && amt > 0) tier2Amount = amt;
        } else if (TIER2_BARE_KEYWORD_REGEX.test(line)) {
          const nextLine = lines[i + 1];
          if (nextLine && !isExcludedLine(nextLine) && !isNoiseNumberLine(nextLine)) {
            const bareMatch = nextLine.match(BARE_AMOUNT_LINE_REGEX);
            if (bareMatch) {
              const amt = parseAmount(bareMatch[1]);
              if (amt !== null && amt > 0) tier2Amount = amt;
            }
          }
        }
      }
    }

    const keywordAmount = tier1Amount !== null ? tier1Amount : tier2Amount;
    console.log('💰 [金额提取] 第一优先级(实付类):', tier1Amount, '第二优先级(实收/合计类):', tier2Amount, '最终采用:', keywordAmount);

    // 🛡️ 1.5 结构化提取运费/优惠/原价小计——三者都是"认字"，不做任何加减推导。
    // 优惠可能出现多行（如"店铺优惠 5.00" + "优惠券 7.99"），逐行匹配到就累加进 discountAmount，
    // 这里的"累加"只是把 AI 识别到的多条优惠数字汇总成一个数，本身不构成"业务计算"。
    let shippingFee = 0;
    let discountAmount = 0;
    let rawTotalAmount = null;

    // 🛡️ 与 TIER1/TIER2 同理：OCR 逐行识别经常把"配送运费""优惠券""商品原价合计"这类
    // 关键字与其后的金额拆成两行，这里同样需要"关键字单独一行 + 下一行是孤立金额"的兜底匹配，
    // 否则拆行小票会导致运费/优惠/原价小计全部识别成 0，交叉核对形同虚设。
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isNoiseNumberLine(line)) continue;
      const nextLine = lines[i + 1];
      const nextIsBareAmount = nextLine && !isNoiseNumberLine(nextLine) ? nextLine.match(BARE_AMOUNT_LINE_REGEX) : null;

      const shippingMatch = line.match(SHIPPING_FEE_REGEX);
      if (shippingMatch) {
        const amt = parseAmount(shippingMatch[1]);
        if (amt !== null && amt >= 0) shippingFee += amt;
      } else if (SHIPPING_FEE_BARE_KEYWORD_REGEX.test(line) && nextIsBareAmount) {
        const amt = parseAmount(nextIsBareAmount[1]);
        if (amt !== null && amt >= 0) shippingFee += amt;
      }

      let discountMatch;
      let discountMatchedThisLine = false;
      DISCOUNT_LINE_REGEX.lastIndex = 0;
      while ((discountMatch = DISCOUNT_LINE_REGEX.exec(line)) !== null) {
        const amt = parseAmount(discountMatch[1]);
        if (amt !== null && amt >= 0) {
          discountAmount += amt;
          discountMatchedThisLine = true;
        }
      }
      if (!discountMatchedThisLine && DISCOUNT_BARE_KEYWORD_REGEX.test(line) && nextIsBareAmount) {
        const amt = parseAmount(nextIsBareAmount[1]);
        if (amt !== null && amt >= 0) discountAmount += amt;
      }

      if (rawTotalAmount === null) {
        const rawTotalMatch = line.match(RAW_TOTAL_REGEX);
        if (rawTotalMatch) {
          const amt = parseAmount(rawTotalMatch[1]);
          if (amt !== null && amt > 0) rawTotalAmount = amt;
        } else if (RAW_TOTAL_BARE_KEYWORD_REGEX.test(line) && nextIsBareAmount) {
          const amt = parseAmount(nextIsBareAmount[1]);
          if (amt !== null && amt > 0) rawTotalAmount = amt;
        }
      }
    }

    shippingFee = parseFloat(shippingFee.toFixed(2));
    discountAmount = parseFloat(discountAmount.toFixed(2));
    console.log('🧾 [结构化字段] 运费:', shippingFee, '优惠合计:', discountAmount, '原价小计(关键字):', rawTotalAmount);

    // 🛡️ 2. 商品明细分区截断：找到最早出现的"商品数量合计/---其他---/商品小计/商品实付/
    // 在线支付/应付/合计/小计/总计/总金额/配送运费/优惠券/优惠"等结束标记，商品明细解析
    // 只处理这个标记之前的行，标记及其之后的内容一律不参与商品列表提取——
    // 从根源上禁止把"配送运费""优惠券""商品小计""总金额"这类汇总/费用信息解析成商品。
    let itemSectionEndIndex = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (SECTION_END_MARKERS.test(lines[i])) {
        itemSectionEndIndex = i;
        break;
      }
    }
    const itemSectionLines = lines.slice(0, itemSectionEndIndex);
    console.log(`✂️ [分区截断] 商品明细区共 ${itemSectionLines.length} 行（截止于第 ${itemSectionEndIndex} 行结束标记）`);

    // 🌾（2026-08-31 商业化生态演进第二步）食材重量提取：独立于下面的商品名/
    // 价格拼接逻辑单独扫一遍商品明细区——只关心"这一行是不是米面油菜品类 +
    // 是否带显式重量单位"，与下面 parsedGoodsList 的拼行/白名单/数量标记等
    // 逻辑无关，两段互不干扰、互不依赖
    let riceKg = 0;
    let flourKg = 0;
    let oilKg = 0;
    let veggieKg = 0;
    const parsedItems = [];
    itemSectionLines.forEach((line) => {
      const category = classifyIngredientLine(line);
      if (!category) return;

      const weightMatch = line.match(WEIGHT_UNIT_REGEX);
      let weightKg;
      if (weightMatch) {
        const rawValue = parseFloat(weightMatch[1]);
        if (!isNaN(rawValue) && rawValue > 0) {
          weightKg = Number(normalizeWeightToKg(rawValue, weightMatch[2]).toFixed(2));
          if (category === 'rice') riceKg += weightKg;
          else if (category === 'flour') flourKg += weightKg;
          else if (category === 'oil') oilKg += weightKg;
          else if (category === 'veggie') veggieKg += weightKg;
        }
      }

      // 品名/金额：与 weightKg 是否识别到无关，即使这一行没有显式重量单位，
      // 也如实记进 parsedItems（weightKg 留空），供前端展示"识别到了这个
      // 品类但没认出重量，需要手动填写斤两"
      const priceMatches = line.match(/\d+\.\d{1,3}/g) || [];
      const priceCandidate = priceMatches.length > 0 ? parseFloat(priceMatches[priceMatches.length - 1]) : 0;
      const cleanedName = line
        .replace(WEIGHT_UNIT_REGEX, '')
        .replace(/\d+\.\d{1,3}/g, '')
        .replace(/[•·:：\s]/g, '')
        .trim();
      parsedItems.push({
        name: cleanedName || line,
        amount: !isNaN(priceCandidate) ? priceCandidate : 0,
        weightKg
      });
    });
    riceKg = Number(riceKg.toFixed(2));
    flourKg = Number(flourKg.toFixed(2));
    oilKg = Number(oilKg.toFixed(2));
    veggieKg = Number(veggieKg.toFixed(2));
    console.log('🌾 [食材重量提取]:', { riceKg, flourKg, oilKg, veggieKg, parsedItemsCount: parsedItems.length });

    const isNoiseLine = (str) => {
      return /店号|工号|单号|品名|数量|单价|金额|售出商品|原价合计|为您节省|实收|回找|微支付|微信支付|检索号|会员|销售时间|欢迎光临|请保留|存根|小票|合计|小计|总计|商品小计|商品实付|在线支付|实付|支付宝|应付/i.test(str);
    };

    let parsedGoodsList = [];
    let currentGoodsName = '';
    let currentGoodsIsWhitelisted = false;
    // 🛡️ 是否怀疑当前品名经历过 OCR 识别异常（见下方"通用清洗"注释）——
    // 不去猜测/硬编码"正确"品名应该是什么，只负责标记"这条数据不太可信，请人工核对"
    let currentGoodsNameSuspicious = false;
    let currentBlockNumbers = [];
    let currentQuantity = 1;

    // 🐛 修复"购物袋丢失 + 下一件商品价格错位"：把"结算上一件商品"的逻辑抽成一个函数，
    // 白名单品类即使一个有效数字都没采集到（如免费赠送的购物袋），也保留为一条明细、
    // 价格记 0.00，而不是像普通商品那样在 currentBlockNumbers 为空时被静默丢弃——
    // 丢弃正是导致"购物袋消失、其价格数字被并入下一件商品"的根本原因。
    // 🌟 数量标记 [xN]：单价 × 数量才是该商品的最终小计（如 ¥7.99 [x2] = ¥15.98）。
    const flushCurrentGoods = () => {
      if (!currentGoodsName) return;
      if (currentBlockNumbers.length > 0) {
        const unitPrice = currentBlockNumbers[currentBlockNumbers.length - 1];
        const finalPrice = unitPrice * currentQuantity;
        parsedGoodsList.push({ name: currentGoodsName, price: finalPrice.toFixed(2), isSuspiciousName: currentGoodsNameSuspicious });
      } else if (currentGoodsIsWhitelisted) {
        parsedGoodsList.push({ name: currentGoodsName, price: '0.00', isSuspiciousName: currentGoodsNameSuspicious });
      }
    };

    for (let i = 0; i < itemSectionLines.length; i++) {
      const line = itemSectionLines[i];

      // 纯条码/货号行：直接跳过，既不影响当前商品的价格采集，也不会被误当成品名行
      if (isBarcodeOnlyLine(line)) continue;

      const isWhitelisted = isWhitelistedItemLine(line);
      if (!isWhitelisted && isNoiseLine(line)) {
        // 光过滤"合计/小计"这一行本身还不够：这类汇总关键字标志着"上一件商品的明细到此为止"，
        // 必须在这里就收尾并清空 currentGoodsName——否则该行下面紧跟着的汇总金额数字
        // 会被继续吞进最后一件商品的价格块，把该商品的价格错误覆盖成整张小票的汇总金额。
        flushCurrentGoods();
        currentGoodsName = '';
        currentGoodsIsWhitelisted = false;
        currentGoodsNameSuspicious = false;
        currentBlockNumbers = [];
        currentQuantity = 1;
        continue;
      }

      // 数量标记 [xN] 可能出现在商品名称行，也可能单独出现在价格行下方；无论哪种都要先
      // 提取出来并从行文本中剥离，避免其中的数字干扰名称清洗/价格匹配
      const qtyMatch = line.match(QUANTITY_MULTIPLIER_REGEX);
      const lineForParsing = line.replace(QUANTITY_MULTIPLIER_REGEX, '').trim();

      const isNameLine = isWhitelisted || (/[一-龥]/.test(lineForParsing) && !/^\d{8,}/.test(line));

      if (isNameLine) {
        flushCurrentGoods();

        let cleanedName = lineForParsing
          .split('/')[0]
          .split('(')[0]
          .split('（')[0]
          .replace(/[•·:：\s]/g, '')
          .trim();

        // 🛡️ 通用清洗（非本单一小票专属）：品名行开头偶尔会残留一个孤立的拉丁字母 + 分隔符，
        // 常见于"4."这类商品序号被 OCR 误识别成"A"这样的单字母——只剥离"单个字母+分隔符"
        // 这一种明确形态，不处理多字母开头的情况（例如真实名称"Miss顾"不会被误伤）。
        // 剥离动作本身说明这一行大概率经历过 OCR 识别异常，记进 nameWasCleaned 供后面
        // 标记 isSuspiciousName，交给前端弹窗高亮提醒店长人工核对，而不是尝试"猜"出正确品名——
        // 猜错的品名会把错误数据悄悄写进账本，比"留空等人工核对"风险高得多。
        const beforeStrip = cleanedName;
        cleanedName = cleanedName.replace(/^[A-Za-z][.、\s]?/, '');
        const nameWasCleaned = cleanedName !== beforeStrip;

        currentGoodsName = cleanedName || '食材杂购';
        // 单字符品名（非白名单）本身就很可能是识别残缺，一并标记为可疑
        currentGoodsNameSuspicious = nameWasCleaned || (currentGoodsName.length <= 1 && !isWhitelisted);
        currentGoodsIsWhitelisted = isWhitelisted;

        currentBlockNumbers = [];
        currentQuantity = 1;
        if (qtyMatch) {
          const q = parseInt(qtyMatch[1], 10);
          if (q > 0) currentQuantity = q;
        }

        // 品名与金额同行的情况（如"生物降解塑料购物袋(大) 0.80"一整行）：
        // 顺带把同一行里出现的价格数字也采集进来，不再要求金额必须出现在下一行；
        // 允许 num === 0（免费赠送的购物袋等场景）
        const inlineMatches = lineForParsing.match(/\d+\.\d{1,3}/g);
        if (inlineMatches) {
          inlineMatches.forEach(numStr => {
            const num = parseFloat(numStr);
            if (num >= 0 && num < 300) {
              currentBlockNumbers.push(num);
            }
          });
        }
      } else if (currentGoodsName) {
        if (qtyMatch) {
          const q = parseInt(qtyMatch[1], 10);
          if (q > 0) currentQuantity = q;
        }
        const matches = lineForParsing.match(/\d+\.\d{1,3}/g);
        if (matches) {
          matches.forEach(numStr => {
            const num = parseFloat(numStr);
            if (num > 0 && num < 300) {
              currentBlockNumbers.push(num);
            }
          });
        }
      }
    }

    flushCurrentGoods();

    // 🛡️ 过滤"金额为 0 且品名只有 1-2 个字"的条目：这类多半是印刷换行/条码切割产生的
    // OCR 噪声碎片（比如把某个字单独截成一行），混进商品明细会让最终填单列表显得很脏。
    // 🐛 但白名单品类（购物袋/塑料袋/包装袋，含单字"袋"）本身就允许免费赠送、价格记 0——
    // 那是本次要保留的合法条目，不能被这条噪声过滤规则连带清掉，否则会重新引入
    // 本会话更早修复过的"购物袋丢失"问题。所以必须先排除白名单品类，再按长度过滤。
    parsedGoodsList = parsedGoodsList.filter(item => {
      const priceNum = parseFloat(item.price);
      const isZeroPrice = !isNaN(priceNum) && priceNum === 0;
      const isShortName = (item.name || '').length <= 2;
      if (isZeroPrice && isShortName && !isWhitelistedItemLine(item.name)) {
        return false;
      }
      return true;
    });

    const sumExtracted = parsedGoodsList.reduce((acc, cur) => acc + parseFloat(cur.price), 0);
    console.log('📊 [明细汇总]:', sumExtracted, '关键字匹配金额:', keywordAmount);

    // 原价小计若未识别到专门的关键字行，退回商品明细汇总——两者语义等价（都是折前原价），
    // 只是数据来源不同；这一步仍然是"认字/取数"，不涉及业务侧的收支计算
    if (rawTotalAmount === null && sumExtracted > 0) {
      rawTotalAmount = sumExtracted;
    }

    // 🛡️ 3. 锚定最终开餐支出：商品实付/在线支付（第一优先级）优先作为最终支出金额 actual_pay；
    // 用"原价小计 + 运费 - 优惠"重建一个理论总额，与 actual_pay 二次核对——若相差超过 ¥2 或 5%
    // （取较大者），以 actual_pay 为准，同时向前端标记低置信度，提醒人工复核（isConfidenceLow）。
    // 🌟 相比只拿"商品明细原价汇总"直接比对 actual_pay，这里把识别到的运费/优惠也计入理论总额，
    // 避免"小票本身就有合法优惠"被系统误判成"识别出错"而无谓触发低置信度警告。
    let isHighConfidence = true;
    let finalAmount = null;

    if (keywordAmount !== null) {
      finalAmount = keywordAmount;
      if (rawTotalAmount !== null && rawTotalAmount > 0) {
        const reconciledTotal = rawTotalAmount + shippingFee - discountAmount;
        const diff = Math.abs(keywordAmount - reconciledTotal);
        const tolerance = Math.max(2, keywordAmount * 0.05);
        if (diff > tolerance) {
          isHighConfidence = false;
          console.warn(`⚠️ [核对不一致] 实付 ¥${keywordAmount} 与"原价${rawTotalAmount}+运费${shippingFee}-优惠${discountAmount}=¥${reconciledTotal.toFixed(2)}"相差 ¥${diff.toFixed(2)}，以实付为准，标记低置信度`);
        }
      }
    } else if (sumExtracted > 0) {
      // 未匹配到关键字金额，只能退回明细汇总——本身就是较弱的推断，标记低置信度
      finalAmount = sumExtracted;
      isHighConfidence = false;
    }

    if (finalAmount === null || finalAmount <= 0 || finalAmount > 50000) {
      isHighConfidence = false;
    }

    // 🛡️ 彻底无法识别出任何金额：不再伪造一个看似合理的默认值（如之前硬编码的 ¥40.40），
    // 明确返回失败，交给前端提示"未能自动识别，请手动填写"，避免店长把假数据当真
    if (finalAmount === null || finalAmount <= 0) {
      console.warn('⚠️ [OCR] 未能识别出任何有效金额');
      return {
        success: false,
        itemList: [],
        formattedText: '',
        totalAmount: '',
        amount: '',
        isHighConfidence: false,
        isConfidenceLow: true,
        errMsg: '未能从图片中识别出有效金额，请手动填写或重新拍摄更清晰的小票',
        // 🌾 金额识别失败不代表食材重量也识别失败——比如一张只拍了食材品类、
        // 没拍到底部合计行的小票，riceKg 等字段仍然是有效数据，不因为上面
        // 的金额判定失败就一并清空扔掉，让 material-usage-modal 的拍照识别
        // 场景（只关心食材重量，不关心金额）仍能用上这批数据
        ingredients: { riceKg, flourKg, oilKg, veggieKg },
        parsedItems,
        rawTextList: lines
      };
    }

    let formattedText = '';
    const finalTotalStr = finalAmount.toFixed(2);

    if (parsedGoodsList.length > 0) {
      formattedText = parsedGoodsList.map(g => `• ${g.name}：¥${g.price}`).join('\n');
    } else {
      formattedText = `• 小票金额：¥${finalTotalStr}`;
    }

    let merchantName = '';
    for (const line of lines) {
      if (/^\d/.test(line)) continue;
      if (/\d+\.\d{2}/.test(line)) continue;
      if (isNoiseLine(line)) continue;
      const chineseCount = (line.match(/[一-龥]/g) || []).length;
      if (chineseCount >= 2 && line.length <= 25) {
        merchantName = line;
        break;
      }
    }

    console.log('✅ [解析输出]:', { count: parsedGoodsList.length, formattedText, finalTotalStr, isHighConfidence });

    return {
      success: true,
      itemList: parsedGoodsList,
      formattedText: formattedText,
      // 🌟 totalAmount / amount 是既有前端已在用的字段名，继续等于 actual_pay，保持兼容；
      // raw_total_amount / shipping_fee / discount_amount / actual_pay 是本次新增的结构化字段——
      // 本云函数（AI/OCR 节点）到此为止，只负责"认字识数"，绝不再往下做 yesterdayBalance
      // +todayIncome-todayExpense 这类业务计算，那一步完全交给前端 computeTodayFinancials。
      totalAmount: finalTotalStr,
      amount: finalTotalStr,
      raw_total_amount: rawTotalAmount !== null ? rawTotalAmount.toFixed(2) : '',
      shipping_fee: shippingFee.toFixed(2),
      discount_amount: discountAmount.toFixed(2),
      actual_pay: finalTotalStr,
      isHighConfidence,
      // 🌟 isConfidenceLow 与 isHighConfidence 互为反义，同时提供给前端——
      // isHighConfidence 是既有页面已在用的字段，isConfidenceLow 是本次新增的显式字段名
      isConfidenceLow: !isHighConfidence,
      merchant: merchantName || '',
      // 🌾（2026-08-31 商业化生态演进第二步）食材品类重量提取：见文件头部
      // classifyIngredientLine/WEIGHT_UNIT_REGEX 注释——只有品类关键字与显式
      // 重量单位同行出现时才认得出 weightKg，未识别到重量的品类行仍会出现在
      // parsedItems 里（weightKg 留空），供前端提示"识别到但没认出重量，请
      // 手动填写"，不做没有把握的猜测
      ingredients: { riceKg, flourKg, oilKg, veggieKg },
      parsedItems,
      rawTextList: lines
    };

  } catch (err) {
    console.error('💥 [OCR 解析异常]:', err);
    // 🛡️ 异常时同样不伪造金额，明确返回失败
    return {
      success: false,
      itemList: [],
      formattedText: '',
      totalAmount: '',
      amount: '',
      isHighConfidence: false,
      isConfidenceLow: true,
      errMsg: err.message || '识别解析异常',
      ingredients: { riceKg: 0, flourKg: 0, oilKg: 0, veggieKg: 0 },
      parsedItems: [],
      rawTextList: []
    };
  }
};
