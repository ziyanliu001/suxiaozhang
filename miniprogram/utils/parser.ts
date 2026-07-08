export interface DonationItem {
  name: string;
  amount: number;
  lineNumber: number;
  raw: string;
}

export interface ParseResult {
  items: DonationItem[];
  errors: { lineNumber: number; message: string; raw: string }[];
  totalAmount: number;
  totalCount: number;
}

const AMOUNT_SUFFIX_REGEX = /(?:元|块|个|份|位|人|笔)$/;
const AMOUNT_REGEX = /([\d.]+)\s*(?:元|块|个|份|位|人|笔)?\s*$/;

export function parseDonations(text: string): ParseResult {
  const items: DonationItem[] = [];
  const errors: { lineNumber: number; message: string; raw: string }[] = [];
  
  if (!text || text.trim() === '') {
    return { items, errors, totalAmount: 0, totalCount: 0 };
  }

  const lines = text.split(/\r?\n/);
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    
    let trimmedLine = line.trim();
    
    if (!trimmedLine) {
      continue;
    }

    if (trimmedLine.includes('爱心人士供养') || 
        trimmedLine.includes('用餐汇报') || 
        trimmedLine.includes('今日合计') || 
        trimmedLine.includes('店铺余额') ||
        trimmedLine.includes('随喜供养') ||
        trimmedLine.includes('名单供养')) {
      continue;
    }

    trimmedLine = trimmedLine.replace(AMOUNT_SUFFIX_REGEX, '');
    
    const amountMatch = trimmedLine.match(AMOUNT_REGEX);
    
    if (amountMatch) {
      const amount = parseFloat(amountMatch[1]);
      
      if (!isNaN(amount) && amount > 0) {
        const namePart = trimmedLine.substring(0, trimmedLine.length - amountMatch[0].length).trim();
        
        if (namePart && namePart.length > 0) {
          items.push({
            name: namePart,
            amount: amount,
            lineNumber: lineNumber,
            raw: line
          });
        } else {
          errors.push({
            lineNumber: lineNumber,
            message: '未识别到姓名，请检查格式',
            raw: line
          });
        }
      } else {
        errors.push({
          lineNumber: lineNumber,
          message: '金额无效，请检查数字格式',
          raw: line
        });
      }
    } else {
      errors.push({
        lineNumber: lineNumber,
        message: '未识别，请使用"姓名 金额"格式',
        raw: line
      });
    }
  }

  const totalAmount = Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
  const totalCount = items.length;

  return { items, errors, totalAmount, totalCount };
}

export function formatDonationItem(item: DonationItem): string {
  return `${item.name} ${item.amount}`;
}
