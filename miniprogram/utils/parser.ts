export interface DonorItem {
  name: string;
  amount: number;
}

export interface ParseResult {
  items: DonorItem[];
  totalCount: number;
  totalAmount: number;
  unrecognizedLines: string[];
}

const TITLE_KEYWORDS = [
  '一、', '二、', '三、', '四、', '五、', '六、', '七、', '八、', '九、', '十、',
  '（一）', '（二）', '（三）',
  '明细', '供养', '支持', '赞助', '爱心', '名单',
  '收入', '支出', '统计', '概况',
  '今日', '昨日', '结余', '余额'
];

const END_AMOUNT_REGEX = /(\d+(?:\.\d+)?)\s*(?:元|块|个)?\s*$/;

function isTitleLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  
  const hasDigit = /\d/.test(trimmed);
  if (hasDigit) return false;
  
  return TITLE_KEYWORDS.some(keyword => trimmed.includes(keyword));
}

function parseLine(line: string): DonorItem | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  
  const match = trimmed.match(END_AMOUNT_REGEX);
  if (!match) return null;
  
  const amountStr = match[1];
  const amount = parseFloat(amountStr);
  
  if (isNaN(amount) || amount <= 0) return null;
  
  const namePart = trimmed.substring(0, match.index).trim();
  
  const cleanedName = namePart
    .replace(/^[•\-·\*\d\.\)、\s]+/, '')
    .replace(/[：:]+$/, '')
    .trim();
  
  if (!cleanedName) return null;
  
  return { name: cleanedName, amount };
}

export function parseDonorText(rawText: string): ParseResult {
  const items: DonorItem[] = [];
  let totalAmount = 0;
  const unrecognizedLines: string[] = [];

  const lines = rawText.split('\n');

  lines.forEach((line, index) => {
    const trimmedLine = line.trim();
    if (!trimmedLine) return;

    if (isTitleLine(trimmedLine)) {
      return;
    }

    const parsed = parseLine(trimmedLine);
    if (parsed && parsed.name && parsed.amount > 0) {
      items.push(parsed);
      totalAmount += parsed.amount;
    } else {
      unrecognizedLines.push(`第 ${index + 1} 行: "${trimmedLine}"`);
    }
  });

  totalAmount = Math.round(totalAmount * 100) / 100;

  return {
    items,
    totalCount: items.length,
    totalAmount,
    unrecognizedLines
  };
}

export interface MaterialItem {
  donor: string;
  item: string;
  quantity: string;
  unit: string;
}

/**
 * 解析「物资赞助明细」自由文本，例如：
 * "张三：大米50斤；李四：赞助食用油2箱"
 */
export function parseMaterials(text: string): MaterialItem[] {
  if (!text || text.trim() === '') return [];

  const lines = text.split(/[;；\n]/).filter(l => l.trim());
  const materials: MaterialItem[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 格式匹配：支持 "张三：大米50斤" / "李四：赞助食用油2箱" / "匿名：面粉100公斤"
    const match = trimmed.match(/^(.+?)[：:]\s*(?:赞助\s*)?(.+?)$/);
    if (match) {
      const donor = match[1].trim();
      const itemPart = match[2].trim();

      // 从物资描述中提取数量和单位
      const qtyMatch = itemPart.match(/^(.+?)\s*(\d+(?:\.\d+)?)\s*(斤|公斤|kg|箱|袋|桶|瓶|份|个)?$/i);
      if (qtyMatch) {
        materials.push({
          donor,
          item: qtyMatch[1].trim(),
          quantity: qtyMatch[2],
          unit: qtyMatch[3] || '份'
        });
      } else {
        // 无法解析数量时，整段作为物资描述
        materials.push({
          donor,
          item: itemPart,
          quantity: '1',
          unit: '份'
        });
      }
    } else {
      // 尝试简单格式：直接"大米50斤"（匿名服务记录）
      const simpleMatch = trimmed.match(/^(?:赞助\s*)?(.+?)\s*(\d+(?:\.\d+)?)\s*(斤|公斤|kg|箱|袋|桶|瓶|份|个)?$/i);
      if (simpleMatch) {
        materials.push({
          donor: '匿名爱心人士',
          item: simpleMatch[1].trim(),
          quantity: simpleMatch[2],
          unit: simpleMatch[3] || '份'
        });
      }
    }
  }

  return materials;
}

/** 将 donationItems 结构化数组还原为可编辑的自由文本（每行 "姓名 金额"） */
export function formatDonationItemsToText(items: any[]): string {
  if (!items || !Array.isArray(items) || items.length === 0) {
    return '';
  }
  return items.map(item => {
    const name = item.name || item.donor || '';
    const amount = item.amount || item.value || 0;
    return `${name} ${amount}`;
  }).join('\n');
}

/** 将 materials 结构化数组还原为可编辑的自由文本（"捐赠人：物资数量单位"，分号分隔） */
export function formatMaterialsToText(materials: any[]): string {
  if (!materials || !Array.isArray(materials) || materials.length === 0) {
    return '';
  }
  return materials.map(m => {
    const donor = m.donor || '匿名爱心人士';
    const item = m.item || '';
    const quantity = m.quantity || '';
    const unit = m.unit || '';
    return `${donor}：${item}${quantity}${unit}`;
  }).join('；');
}
