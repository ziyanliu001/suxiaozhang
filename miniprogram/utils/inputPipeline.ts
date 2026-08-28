// 🔌 InputPipeline —— 阶段一为阶段二（语音/OCR 解析长辈报餐）预留的统一
// 输入适配层。
//
// 🛡️ 范围说明（务必先读）：本仓库粘贴框/OCR 现状是两条并不同构的通路——
// ocrDonationList 的输出（formattedText）本来就是给 parseDonorText 吃的同款
// 文本格式，是无缝的；ocrExpenseReceipt 的输出（{name,price}+formattedText）
// 跟 parseMaterials 要的 {donor,item,quantity,unit} 完全不是一回事，index.ts
// 现在是绕开 parser.ts 直接手搭 UI 消费的。这两条通路已经在生产稳定跑着，
// 阶段一不重写它们（风险大于收益），本文件只新增"适配语义"这一层薄封装：
//   - donationPasteAdapter/materialPasteAdapter：单纯包一层调用 parser.ts
//     现有函数，零改动原函数，只是让调用方统一走 InputPipeline.normalize()
//   - elderCheckinManualAdapter：唯一一个"从零开始"的新输入源（长辈签到弹窗），
//     阶段一先接入这一个，不强行把两条旧通路也套进来
//
// 阶段二接入方式：新增 voiceAdapter/ocrElderAdapter，各自实现
// normalize(rawChannelOutput) => ElderCheckinPayload[]，注册进 InputPipeline，
// 调用点（elder-checkin-modal 组件）不需要改动表单绑定逻辑。
import { parseDonorText, parseMaterials, DonorItem, MaterialItem, ParseResult } from './parser';

export type InputChannel = 'MANUAL_PASTE' | 'VOICE_LLM' | 'OCR_SCAN';

export interface ElderCheckinPayload {
  target_elder_id: string;
  mealType: 'breakfast' | 'lunch' | 'dinner';
  proxy_type: 'SELF' | 'VOLUNTEER_PROXY' | 'FAMILY_PROXY';
  serviceType?: string;
  hours?: string;
  input_channel: InputChannel;
  raw_ai_payload?: Record<string, any> | null;
}

type Adapter<TRaw, TOut> = (raw: TRaw) => TOut;

export class InputPipeline<TRaw, TOut> {
  private adapter: Adapter<TRaw, TOut>;

  constructor(adapter: Adapter<TRaw, TOut>) {
    this.adapter = adapter;
  }

  normalize(raw: TRaw): TOut {
    return this.adapter(raw);
  }
}

// 爱心支持明细粘贴框：零改动包装 parseDonorText
export const donationPasteAdapter = new InputPipeline<string, ParseResult>(
  (rawText: string) => parseDonorText(rawText)
);

// 食材杂购/物资赞助输入框：零改动包装 parseMaterials
export const materialPasteAdapter = new InputPipeline<string, MaterialItem[]>(
  (rawText: string) => parseMaterials(rawText)
);

export interface ElderCheckinManualForm {
  selectedElderId: string;
  mealType: 'breakfast' | 'lunch' | 'dinner';
  proxyType: 'VOLUNTEER_PROXY' | 'FAMILY_PROXY';
  serviceType?: string;
  hours?: string;
}

// 长辈签到弹窗表单 → ledgerIngestionAdapter 的 checkin 入参形状。阶段二的
// voiceAdapter/ocrElderAdapter 只需产出同样形状的 ElderCheckinPayload，
// 调用 ledgerIngestionAdapter{action:'checkin'} 时把 input_channel 换成
// 'VOICE_LLM'/'OCR_SCAN'、raw_ai_payload 换成真实识别原文/置信度即可
export const elderCheckinManualAdapter = new InputPipeline<ElderCheckinManualForm, ElderCheckinPayload>(
  (form: ElderCheckinManualForm) => ({
    target_elder_id: form.selectedElderId,
    mealType: form.mealType,
    proxy_type: form.proxyType,
    serviceType: form.serviceType || undefined,
    hours: form.serviceType ? form.hours : undefined,
    input_channel: 'MANUAL_PASTE',
    raw_ai_payload: null
  })
);

export type { DonorItem, MaterialItem, ParseResult };
