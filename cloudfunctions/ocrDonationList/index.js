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

// 🛡️ 金额行识别："已支付 ¥1.00" 是微信群收款截图最常见的写法，也兼容"实付/收款 ¥x.xx"
// 以及裸露的"¥x.xx"（部分截图 OCR 会把"已支付"和金额拆成两个独立文本框，"已支付"单独
// 成行、纯金额单独成行，此时只会命中裸 ¥ 金额这一条分支）
const AMOUNT_LINE_REGEX = /(?:已支付|实付|收款)\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)|[¥￥]\s*(\d+(?:\.\d{1,2})?)/;

function parseAmount(rawStr) {
  const num = parseFloat(rawStr);
  return isNaN(num) ? null : num;
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
      if (HEADER_NOISE_REGEX.test(line)) {
        // 顶部总额/收款成功等界面提示文案，整行跳过，并清空待配对昵称，
        // 避免它被当成紧接着这行金额的付款人昵称
        pendingName = '';
        continue;
      }

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
          const finalName = nameOnSameLine || pendingName;

          if (finalName) {
            donorList.push({ name: finalName, amount: amount.toFixed(2) });
          }
        }
        pendingName = '';
        continue;
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
