// 纯校验逻辑，不依赖 wx-server-sdk，便于单元测试（与 wxPayCore 的
// refundValidation.js / profitSharingValidation.js 同一个拆分理由）。
'use strict';

const NAME_MAX_LEN = 60;
const DESCRIPTION_MAX_LEN = 500;
const MATERIAL_NAME_MAX_LEN = 40;
const OPENID_MAX_LEN = 128; // 微信 openid 实际长度 ~28 字符，留出余量而非硬编码精确长度

/**
 * 校验创建/更新商品时提交的字段。price/dailyCapacityLimit 单位分别为
 * "分"（整数分）与"件"，leadTimeDays 单位"天"，均要求非负整数——避免
 * 排产算法（liveFactoryCore/lib/scheduling.js）拿到浮点数/负数后产生
 * 无意义的批次日推算。
 *
 * producerOpenId 可选：指定该商品的制作方/分账接收人。留空是合法状态——
 * 未配置时 completeProductionOrder 不会替这件商品猜一个接收人去分账，
 * producer 份额停留在人工/受托结算路径，不做无依据的归属推断。
 *
 * description 可选：图文简介的文字部分（纯文本简介，图片上传本轮未实现，
 * 留空同样是合法状态）。
 */
function validateProductInput({ name, price, dailyCapacityLimit, leadTimeDays, materialList, producerOpenId, description }) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return { valid: false, error: '请填写商品名称' };
  if (trimmedName.length > NAME_MAX_LEN) return { valid: false, error: `商品名称不能超过 ${NAME_MAX_LEN} 个字符` };

  const trimmedDescription = String(description || '').trim();
  if (trimmedDescription.length > DESCRIPTION_MAX_LEN) {
    return { valid: false, error: `商品简介不能超过 ${DESCRIPTION_MAX_LEN} 个字符` };
  }

  if (!Number.isInteger(price) || price <= 0) {
    return { valid: false, error: '价格必须是正整数（分）' };
  }
  if (!Number.isInteger(dailyCapacityLimit) || dailyCapacityLimit <= 0) {
    return { valid: false, error: '单日产能上限必须是正整数（件）' };
  }
  if (!Number.isInteger(leadTimeDays) || leadTimeDays < 0) {
    return { valid: false, error: '前置天数必须是非负整数（天）' };
  }

  if (materialList !== undefined) {
    if (!Array.isArray(materialList)) return { valid: false, error: 'materialList 必须是数组' };
    for (const m of materialList) {
      if (!m || !String(m.materialName || '').trim()) return { valid: false, error: '物料清单每一项都需要 materialName' };
      if (String(m.materialName).trim().length > MATERIAL_NAME_MAX_LEN) {
        return { valid: false, error: `物料名称不能超过 ${MATERIAL_NAME_MAX_LEN} 个字符` };
      }
      if (!Number.isFinite(m.qtyPerUnit) || m.qtyPerUnit <= 0) {
        return { valid: false, error: '物料清单每一项 qtyPerUnit 必须是正数' };
      }
    }
  }

  const trimmedProducerOpenId = String(producerOpenId || '').trim();
  if (trimmedProducerOpenId.length > OPENID_MAX_LEN) {
    return { valid: false, error: 'producerOpenId 长度异常' };
  }

  return { valid: true, name: trimmedName, producerOpenId: trimmedProducerOpenId, description: trimmedDescription };
}

module.exports = { validateProductInput, NAME_MAX_LEN, DESCRIPTION_MAX_LEN, MATERIAL_NAME_MAX_LEN, OPENID_MAX_LEN };
