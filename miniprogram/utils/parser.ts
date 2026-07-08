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

export function parseDonorText(rawText: string): ParseResult {
  const items: DonorItem[] = [];
  let totalAmount = 0;
  const unrecognizedLines: string[] = [];

  const regex = /([\u4e00-\u9fa5A-Za-z·\(\)（）]{2,12})\s*(\d+(?:\.\d+)?)\s*(?:元|块|个)?/g;

  let match;
  const matchedTextSegments: string[] = [];

  while ((match = regex.exec(rawText)) !== null) {
    const name = match[1].trim();
    const amount = parseFloat(match[2]);

    if (name && !isNaN(amount)) {
      items.push({ name, amount });
      totalAmount += amount;
      matchedTextSegments.push(match[0]);
    }
  }

  const lines = rawText.split('\n');
  lines.forEach((line, index) => {
    const trimmedLine = line.trim();
    if (!trimmedLine) return;

    const isMatched = matchedTextSegments.some(segment => trimmedLine.includes(segment.trim()));
    if (!isMatched) {
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
