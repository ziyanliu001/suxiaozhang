export interface DonorItem {
  name: string;
  amount: number;
  // 🌸🌿 逐条阳善（实名公示）/阴德（匿名）区分：可选字段，三种状态——
  //   true  ：这一条明确标记为"积阴德"（匿名），无论报告级 meritType 是什么
  //   false ：这一条明确标记为"阳善"（实名公示），无论报告级 meritType 是什么
  //   未定义 ：未单独标记，跟随报告级 meritType 的默认值展示/提交
  // 通过行尾"匿名"/"实名"文字标记随文本一起持久化（见 parseLine/
  // formatDonationItemsToText），不额外维护一份脱离文本的旁路状态，
  // 与本文件"文本是唯一权威来源"的既有设计保持一致
  isAnonymous?: boolean;
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

// 🐛 根因修复：原 END_AMOUNT_REGEX 只在整行末尾找一个数字，隐含假设"一行 = 一条
// 捐赠记录"；当用户一次粘贴多人一行（逗号/空格分隔，如 "李海10, 张燕90 李堂80"）时，
// 最后一个数字之前的所有文本会被整段当成一个人名，前面几个人的姓名和金额全部丢失。
// 改为全局扫描"姓名+金额"重复片段，一行可以解析出任意多条记录；姓名字符集刻意
// 不包含数字/常见项目符号（•-·*、() 等），扫描引擎会自然跳过它们去找下一个有效
// 姓名起点，行首编号"1. 张三 100"、"• 李四 50" 不需要额外清洗就已经是干净姓名。
const NAME_AMOUNT_REGEX = /([一-龥a-zA-Z][一-龥a-zA-Z·]{0,19})\s*[:：=]?\s*[,，、\s]*\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块|个)?/g;

function isTitleLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  const hasDigit = /\d/.test(trimmed);
  if (hasDigit) return false;

  return TITLE_KEYWORDS.some(keyword => trimmed.includes(keyword));
}

// 🌟 一行可能塞了多个人（逗号/空格/顿号分隔），返回该行解析出的全部条目，
// 而不再是"至多一条"；调用方通过返回数组是否为空判断这一行是否可识别。
// 🌸🌿 逐条阳善/阴德文字标记：行尾出现"匿名"/"匿"即显式标记这一行（们）为
// 阴德，"实名"/"阳善"即显式标记为阳善；不出现任何标记则不设置该字段，交由
// 报告级 meritType 兜底。只支持"标记在整行末尾"，天然对应 formatDonationItemsToText
// 生成的"一行一人"格式——多人共享一行时不支持逐条区分，该行统一按未标记处理，
// 这是刻意的简化（多人共享一行本就是批量粘贴场景，精细化区分需求较低）
const LINE_ANONYMITY_MARKER_REGEX = /(?:^|\s)(匿名|匿|实名|阳善)\s*$/;

function parseLine(line: string): DonorItem[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  const markerMatch = trimmed.match(LINE_ANONYMITY_MARKER_REGEX);
  let lineIsAnonymous: boolean | undefined;
  let scanTarget = trimmed;
  if (markerMatch) {
    lineIsAnonymous = (markerMatch[1] === '匿名' || markerMatch[1] === '匿');
    scanTarget = trimmed.slice(0, markerMatch.index).trim();
  }

  const results: DonorItem[] = [];

  // 🛡️ NAME_AMOUNT_REGEX 带 g 标志、是模块级共享对象，lastIndex 会在多次 exec()
  // 调用之间保留状态。exec() 正常耗尽返回 null 时引擎会自动把 lastIndex 归零，
  // 这里仍显式重置一次，防止未来任何提前 return/break 导致下一行从错误的中间
  // 位置开始扫描，静默漏掉本该匹配到的前几条记录。
  NAME_AMOUNT_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = NAME_AMOUNT_REGEX.exec(scanTarget)) !== null) {
    const amount = parseFloat(match[2]);
    if (isNaN(amount) || amount <= 0) continue;

    // 姓名字符集已天然排除数字/项目符号/冒号，这两条 replace 目前基本是防御性
    // 冗余（成本极低，作为双保险继续留着），详见函数上方注释。
    const cleanedName = match[1]
      .replace(/^[•\-·\*\d\.\)、\s]+/, '')
      .replace(/[：:]+$/, '')
      .trim();

    if (!cleanedName) continue;

    const item: DonorItem = { name: cleanedName, amount };
    if (lineIsAnonymous !== undefined) {
      item.isAnonymous = lineIsAnonymous;
    }
    results.push(item);
  }

  return results;
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
    if (parsed.length > 0) {
      parsed.forEach(item => {
        items.push(item);
        totalAmount += item.amount;
      });
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
      // 🐛（2026-08-31 追加修复）此前无冒号分隔时一律当"匿名服务记录"整体
      // 处理——"张三: 大米50斤"能正确拆出捐赠人，但没有冒号的"李四 爱心面粉
      // 2袋"/"王五 苹果3箱"这类同样常见的口语化写法，会把"李四""王五"错误
      // 并入物资描述本身（item 变成"李四 爱心面粉"），姓名却被填成"匿名爱心
      // 人士"——姓名信息没丢，只是被安错了地方。
      // 先按原逻辑提取出数量/单位之前的剩余文本 beforeQty，再看这段文本里
      // 有没有空格：有（如"李四 爱心面粉"）就取第一个空格前的词当捐赠人、
      // 其余当物资描述；完全没有分隔符（如"大米50斤"或"王五苹果3箱"全部
      // 连写）时无法可靠区分姓名和物资，保留原有"匿名爱心人士"兜底，不做
      // 没有把握的猜测拼接（宁可保守，不臆造一个可能是错的姓名）
      const simpleMatch = trimmed.match(/^(?:赞助\s*)?(.+?)\s*(\d+(?:\.\d+)?)\s*(斤|公斤|kg|箱|袋|桶|瓶|份|个)?$/i);
      if (simpleMatch) {
        const beforeQty = simpleMatch[1].trim();
        const spaceIdx = beforeQty.indexOf(' ');
        const hasNameSeparator = spaceIdx > 0 && spaceIdx < beforeQty.length - 1;
        materials.push({
          donor: hasNameSeparator ? beforeQty.slice(0, spaceIdx).trim() : '匿名爱心人士',
          item: hasNameSeparator ? beforeQty.slice(spaceIdx + 1).trim() : beforeQty,
          quantity: simpleMatch[2],
          unit: simpleMatch[3] || '份'
        });
      }
    }
  }

  return materials;
}

/** 将 donationItems 结构化数组还原为可编辑的自由文本（每行 "姓名 金额"，
 * 逐条显式标记为阳善/阴德的条目会在行尾追加"实名"/"匿名"文字标记，
 * 与 parseLine 的 LINE_ANONYMITY_MARKER_REGEX 互为逆操作，保证
 * "解析→编辑→再解析"全程不丢失逐条标记状态） */
export function formatDonationItemsToText(items: any[]): string {
  if (!items || !Array.isArray(items) || items.length === 0) {
    return '';
  }
  return items.map(item => {
    const name = item.name || item.donor || '';
    const amount = item.amount || item.value || 0;
    const suffix = item.isAnonymous === true ? ' 匿名' : (item.isAnonymous === false ? ' 实名' : '');
    return `${name} ${amount}${suffix}`;
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
