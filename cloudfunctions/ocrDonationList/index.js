const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 🌟 AI/OCR 节点与业务计算彻底解耦：本云函数只负责"从截图里认字，把昵称和金额配成对"，
// 绝不做求和/去重/合计等业务判断——那是前端 parseDonorText（唯一权威解析入口，经
// updateParseResult 调用）的职责。这里只输出一行一条的"姓名 金额"标准文本，
// 交给和手动粘贴完全相同的一条解析路径处理，不会另开一套计算逻辑。

// 🛡️ 界面噪声行：截图顶部的"已收到¥186.10"总额提示、收款成功状态、微信支付本身的
// 界面文案，都不是某个具体人的明细，必须整行排除，且排除后要清空"待配对昵称"缓存——
// 避免把这类提示文案误当成紧跟其后那笔金额的付款人昵称。
const HEADER_NOISE_REGEX = /已收到|完成收款|发起(?:了)?群收款|群收款|收款成功|收款方式|钱款已存入|查看转账详情|待确认收款|全部到账|一共|共\d+人(?:付款|支付)|扫码支付|微信支付|收款人|付款人|群主|接龙|零钱通|待入账|转账详情/;

// 🐛 新增噪声黑名单：与 HEADER_NOISE_REGEX 覆盖的"群收款"截图界面文案不同，
// 这里专门排除"个人转账通知卡片"（如"向苏志萍转账¥60.00"）与聊天场景常见的
// 系统提示文案——此前完全没有排除这两类文本，导致截图底部一张与爱心名单
// 毫不相干的转账通知卡片，被误判成本次识别出的唯一一条"明细"，而上面几十条
// 真正的名单反而因为不含 ¥ 符号/"已支付"关键字全部被漏识别（见下方新增的
// INLINE_NAME_AMOUNT 系列正则）
const TRANSFER_NOISE_REGEX = /转账|请收款|微信转账|已收钱|群聊|会计群/;

// 🐛 状态栏/系统信息噪声：截图顶部的时间（07:16）、网络制式（5G）、电量百分比
// (85%)，以及任何"孤零零一个纯数字、前后不带昵称也不带¥/元"的文本行——
// 这类数字本身可能恰好落在合理的捐款金额区间（如电量 "120" 也可能被误判成
// 一笔 120 元的捐赠），但既然它不带任何昵称/¥/元标记，无法确认是一笔真实
// 明细，与其冒险配对出错误数据，不如统一当噪声跳过
const STATUS_BAR_NOISE_REGEX = /^\d{1,2}:\d{2}$|^\d+\s*[gG]$|^\d{1,3}\s*%$|^\d+$/;

// 🛡️ 金额行识别（微信"群收款"截图专用格式）："已支付 ¥1.00"是最常见的写法，
// 也兼容"实付/收款 ¥x.xx"以及裸露的"¥x.xx"（部分截图 OCR 会把"已支付"和
// 金额拆成两个独立文本框，"已支付"单独成行、纯金额单独成行，此时只会命中
// 裸 ¥ 金额这一条分支）——这条分支要求必须出现 ¥/￥ 符号或"已支付/实付/收款"
// 关键字之一，因此不会跟下面新增的 INLINE_NAME_AMOUNT 系列（聊天记录/接龙
// 格式，通常没有 ¥ 符号）互相误判
const AMOUNT_LINE_REGEX = /(?:已支付|实付|收款)\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)|[¥￥]\s*(\d+(?:\.\d{1,2})?)/;

// 🐛 新增：裸金额独立成行（微信"接龙"截图里偶尔会把昵称和金额拆成两行，
// 金额那一行没有 ¥ 符号、只有"3元"这种写法）——与上面 AMOUNT_LINE_REGEX 的
// 区别是不要求 ¥ 符号，但要求整行只有金额本身（前后不能再有昵称文字），
// 否则应该走下面的 INLINE_NAME_AMOUNT 同行配对分支
const BARE_AMOUNT_REGEX = /^[¥￥]?(\d+(?:\.\d{1,2})?)\s*元$/;

// 🌟 新增核心能力：群聊/接龙截图逐行"昵称 + 金额"同行提取——与"群收款"截图
// （昵称金额分两行、金额行必须有 ¥ 符号或"已支付"关键字）是完全不同的排版：
// 群聊场景里义工/家人直接在聊天记录或接龙消息里手打"张三 5元""李四: 2"这种
// 一行一条的格式，没有 ¥ 符号、也没有"已支付"字样，此前完全无法识别。
// 昵称可以包含中英文/emoji/标点/空格（如"💦 回忆、是緯富的延续 つ""刚 xun 豪"），
// 核心思路是"贪婪捕获到行尾的金额数字为止，前面所有内容都算昵称"：
//   INLINE_NAME_AMOUNT_REGEX：昵称与金额之间有分隔符（空格/冒号/逗号）
//   INLINE_NAME_AMOUNT_NO_SEP_REGEX：昵称与金额直接相连，无分隔符（如"苏永裕20元"）
// 两条正则都要求捕获到的"金额"部分是行尾（$ 锚定），避免把昵称里偶然出现的
// 数字（如网名"008 号选手"）误判成金额
const INLINE_NAME_AMOUNT_REGEX = /^(.+?)[\s:：,，]+[¥￥]?(\d+(?:\.\d{1,2})?)\s*元?$/;
const INLINE_NAME_AMOUNT_NO_SEP_REGEX = /^([^\d¥￥]+?)[¥￥]?(\d+(?:\.\d{1,2})?)\s*元?$/;

function parseAmount(rawStr) {
  const num = parseFloat(rawStr);
  return isNaN(num) ? null : num;
}

// 🐛 昵称清洗：去除识别结果里残留的序号（"1."/"12、"/"①"~"⑩"）与首尾多余的
// 冒号、逗号、空白——群聊接龙场景常见"1. 张三 5元"这种带编号的写法，编号
// 本身不属于昵称的一部分
function cleanDonorName(rawName) {
  return String(rawName || '')
    .trim()
    .replace(/^[（(]?\d{1,3}[）)]?[.、,，]?\s*/, '')
    .replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '')
    .replace(/^[:：,，\s]+/, '')
    .replace(/[:：,，\s]+$/, '')
    .trim();
}

exports.main = async (event, context) => {
  const { fileID, fileId, imageBase64 } = event;
  const actualFileId = fileID || fileId;

  try {
    console.log('🚀 [OCR Cloud Function] 开始识别爱心支持明细截图, fileId:', actualFileId);

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

    const donorList = [];
    let pendingName = '';

    for (const line of lines) {
      if (HEADER_NOISE_REGEX.test(line) || TRANSFER_NOISE_REGEX.test(line) || STATUS_BAR_NOISE_REGEX.test(line)) {
        // 顶部总额/收款成功/转账通知卡片/状态栏等界面提示文案，整行跳过，
        // 并清空待配对昵称，避免它被当成紧接着这行金额的付款人昵称
        pendingName = '';
        continue;
      }

      // ① 微信"群收款"截图格式：金额行必须带 ¥ 符号或"已支付/实付/收款"关键字，
      // 昵称与金额可能同行、也可能分两行（此时用上一行缓存的 pendingName）
      const amountMatch = line.match(AMOUNT_LINE_REGEX);
      if (amountMatch) {
        const amount = parseAmount(amountMatch[1] || amountMatch[2]);
        if (amount !== null && amount > 0) {
          // 同一行里"昵称 + 已支付¥金额"一起出现的情况：把金额与"已支付/实付/收款"关键字
          // 从行内剥离，剩下的文本当昵称；如果剥离完是空的，说明这一行本身就是纯金额行，
          // 昵称来自上一行缓存的 pendingName（微信截图更常见的两行式排布）
          const nameOnSameLine = line
            .replace(AMOUNT_LINE_REGEX, '')
            .replace(/已支付|实付|收款|[:：]/g, '')
            .trim();
          const finalName = cleanDonorName(nameOnSameLine || pendingName);

          if (finalName) {
            donorList.push({ name: finalName, amount: amount.toFixed(2) });
          }
        }
        pendingName = '';
        continue;
      }

      // ② 群聊/接龙截图格式：金额独立成行、不带 ¥ 符号（如"3元"单独一行），
      // 昵称来自上一行缓存的 pendingName
      const bareAmountMatch = line.match(BARE_AMOUNT_REGEX);
      if (bareAmountMatch) {
        const amount = parseAmount(bareAmountMatch[1]);
        const finalName = cleanDonorName(pendingName);
        if (amount !== null && amount > 0 && finalName) {
          donorList.push({ name: finalName, amount: amount.toFixed(2) });
        }
        pendingName = '';
        continue;
      }

      // ③ 群聊/接龙截图格式：昵称 + 金额同行出现，不需要 ¥ 符号（如"苏永裕 20元"
      // "💦 回忆、是緯富的延续 つ 2元"）——本次排查修复的核心新增能力，见文件
      // 头部 INLINE_NAME_AMOUNT_REGEX 注释
      const inlineMatch = line.match(INLINE_NAME_AMOUNT_REGEX) || line.match(INLINE_NAME_AMOUNT_NO_SEP_REGEX);
      if (inlineMatch) {
        const amount = parseAmount(inlineMatch[2]);
        const finalName = cleanDonorName(inlineMatch[1]);
        if (amount !== null && amount > 0 && finalName) {
          donorList.push({ name: finalName, amount: amount.toFixed(2) });
          pendingName = '';
          continue;
        }
      }

      // 非金额行、非噪声行：视为一个新的昵称候选，等待下一行的金额与它配对
      pendingName = line;
    }

    if (donorList.length === 0) {
      console.warn('⚠️ [OCR] 未能识别出任何有效的爱心支持明细');
      return {
        success: false,
        itemList: [],
        formattedText: '',
        totalCount: 0,
        totalAmount: '0.00',
        errMsg: '未能从截图中识别出有效的"昵称+金额"明细，请手动录入或重新截取更清晰的图片'
      };
    }

    // 🌟 严格一行一条"姓名 金额"：前端 parseDonorText 是按行读取的，绝不能把多条记录
    // 拼进同一行——那样前端只会把整行当成一个人名解析，静默丢失除最后一笔外的所有记录。
    const formattedText = donorList.map(d => `${d.name} ${d.amount}`).join('\n');
    const totalAmount = donorList.reduce((sum, d) => sum + parseFloat(d.amount), 0).toFixed(2);

    console.log('✅ [解析输出]:', { count: donorList.length, totalAmount });

    return {
      success: true,
      itemList: donorList,
      formattedText: formattedText,
      totalCount: donorList.length,
      totalAmount: totalAmount
    };

  } catch (err) {
    console.error('💥 [OCR 解析异常]:', err);
    return {
      success: false,
      itemList: [],
      formattedText: '',
      totalCount: 0,
      totalAmount: '0.00',
      errMsg: err.message || '识别解析异常'
    };
  }
};
