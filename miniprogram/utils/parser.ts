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
