const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 🌾 云函数：ocrMaterialList — 识别「爱心物资明细」手写登记册/群接龙截图，
// 只负责"从图片里认字，把捐赠人和物资数量配成对"，绝不做单位换算/汇总——
// 那是前端 utils/parser.ts 的 parseMaterials()（唯一权威解析入口，经
// index.ts updateMaterialsParse 调用）的职责。这里只输出一行一条的
// "捐赠人：物资数量单位"标准文本，交给和手动粘贴完全相同的一条解析路径
// 处理，不会另开一套结构化逻辑——与同目录 ocrDonationList/ocrExpenseReceipt
// 的"AI/OCR 节点与业务计算彻底解耦"设计原则保持一致。
//
// ⚠️ 首个版本，尚未经过真实样本反复打磨：与 ocrDonationList（历经多轮真实
// 截图报错迭代加固，见其文件头部注释）不同，本函数目前只覆盖"姓名 物资
// 数量单位"同行或姓名/物资分两行这两种最常见排版的识别，手写字迹潦草、
// 群聊接龙里数量单位缺失等边界情况尚未针对真实样本验证过，如实标注，
// 后续按真实使用反馈持续加固，不假装这是一份已经打磨成熟的实现。

const UNIT_ALTERNATION = '斤|公斤|kg|箱|袋|桶|瓶|份|个';
// 🛡️ 数量单位后缀：与前端 parseMaterials() 认识的单位集合保持一致，任何一处
// 扩充单位列表都要同步改另一处，否则云端识别出来的文本前端反而解析不了
const QUANTITY_SUFFIX_REGEX = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_ALTERNATION})`, 'i');

// 🛡️ 界面噪声：登记表/统计截图常见的表头、合计行——这些不是某一位具体
// 捐赠人的明细，必须整行排除，且排除后清空"待配对姓名"缓存，避免被误当成
// 紧跟其后那行物资的捐赠人姓名
const NOISE_REGEX = /物资登记|物资统计|物资明细|登记表|合计|共计|小计|总计|序号|品名|数量|单位|捐赠人|供奉人|备注|日期|时间/;

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
    console.log('🚀 [OCR Cloud Function] 开始识别爱心物资明细, fileId:', actualFileId);

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

    const materialList = [];
    let pendingName = '';

    for (const line of lines) {
      if (NOISE_REGEX.test(line)) {
        pendingName = '';
        continue;
      }

      const qtyMatch = line.match(QUANTITY_SUFFIX_REGEX);
      if (qtyMatch) {
        const beforeQty = line.slice(0, qtyMatch.index).trim();
        const quantity = qtyMatch[1];
        const unit = qtyMatch[2];

        let donor = '';
        let itemName = '';

        // ① 姓名与物资同行、以冒号分隔（如"李四：爱心面粉2袋"）
        const colonIdx = beforeQty.search(/[：:]/);
        if (colonIdx > 0 && colonIdx < beforeQty.length - 1) {
          donor = beforeQty.slice(0, colonIdx);
          itemName = beforeQty.slice(colonIdx + 1).replace(/^赞助\s*/, '').trim();
        } else {
          // ② 姓名与物资同行、以空格分隔（如"李四 爱心面粉2袋"）；
          //    完全没有分隔符时（如登记册"姓名"独立成行、"物资 数量"紧跟
          //    下一行），姓名来自上一行缓存的 pendingName
          const spaceIdx = beforeQty.indexOf(' ');
          const hasInlineName = spaceIdx > 0 && spaceIdx < beforeQty.length - 1;
          donor = hasInlineName ? beforeQty.slice(0, spaceIdx) : pendingName;
          itemName = hasInlineName ? beforeQty.slice(spaceIdx + 1).trim() : beforeQty;
        }

        donor = cleanDonorName(donor);
        itemName = itemName.trim();

        if (donor && itemName) {
          materialList.push({ donor, item: itemName, quantity, unit });
        }
        pendingName = '';
        continue;
      }

      // 非数量行：视为一个新的姓名候选，等待下一行的物资/数量与它配对
      pendingName = line;
    }

    if (materialList.length === 0) {
      console.warn('⚠️ [OCR] 未能识别出任何有效的物资明细');
      return {
        success: false,
        itemList: [],
        formattedText: '',
        totalCount: 0,
        errMsg: '未能从图片中识别出有效的"姓名+物资+数量"明细，请手动录入或重新拍摄更清晰的图片'
      };
    }

    // 🌟 严格一行一条"捐赠人：物资数量单位"，与手动粘贴的格式完全一致，
    // 直接交给前端 parseMaterials() 解析，不再另起一套结构化逻辑
    const formattedText = materialList.map(m => `${m.donor}：${m.item}${m.quantity}${m.unit}`).join('\n');

    console.log('✅ [解析输出]:', { count: materialList.length });

    return {
      success: true,
      itemList: materialList,
      formattedText: formattedText,
      totalCount: materialList.length
    };

  } catch (err) {
    console.error('💥 [OCR 解析异常]:', err);
    return {
      success: false,
      itemList: [],
      formattedText: '',
      totalCount: 0,
      errMsg: err.message || '识别解析异常'
    };
  }
};
