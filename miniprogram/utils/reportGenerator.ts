import { maskName } from './privacy';

const YUHUA_GOLDEN_QUOTES = [
  "用一餐饭的温度，传递温暖与关爱。",
  "拒绝浪费，珍惜粮食；一粥一饭，来之不易。",
  "用一餐饭的温度，传递温暖与关爱。每一餐，都有您的爱心护持。",
  "端上一碗热饭，温暖世间一颗心。欢迎大家回家吃饭！"
];

export interface DonorItem {
  name: string;
  amount: number;
}

export interface MaterialItem {
  donor: string;
  item: string;
  quantity: string;
  unit: string;
}

export interface ReportData {
  shopName: string;
  dateString: string;
  reportDate: string;
  items: DonorItem[];
  totalAmount: number;
  otherDonation: number;
  yesterdayBalance: number;
  expenseAmount: number;
  dailyExpenseTotal?: number;
  fixedExpenseTotal?: number;
  todayBalance: number;
  expenses: string;
  dailyExpenseText?: string;
  fixedExpenseText?: string;
  mpAccount: string;
  thankText?: string;
  slogan1?: string;
  slogan2?: string;
  materials?: MaterialItem[];
  // 🔗 门店日志联动：与首页「今日大事记」编辑区同一份数据，见 index.ts fetchTodayActivity
  activityText?: string;
  volunteerCount?: number;
  volunteerHours?: number;
  diningCount?: number;
  stapleRiceStatus?: string;
  stapleOilStatus?: string;
  noticeTag?: string;
  noticeTitle?: string;
  noticeContent?: string;
  mergeToReportText?: boolean;
  reportMode?: 'group' | 'moments';
}

export function formatMoney(value: number): string {
  return value.toFixed(2);
}

export function generateReportText(data: ReportData): string {
  const { shopName, reportDate, items, totalAmount, otherDonation, yesterdayBalance, expenseAmount, dailyExpenseTotal, fixedExpenseTotal, todayBalance, expenses, dailyExpenseText, fixedExpenseText, mpAccount, thankText, slogan1, slogan2, materials, activityText, volunteerCount, volunteerHours, diningCount, stapleRiceStatus, stapleOilStatus, noticeTag, noticeTitle, noticeContent, mergeToReportText, reportMode } = data;

  const defaultThankText = '感谢大家的自愿赞助\n与默默付出的义工！';
  const defaultSlogan1 = '吃 素 一 日   健 康 一 天';
  const defaultSlogan2 = '吃 素 一 日   环 保 一 天';

  const statusMap: Record<string, string> = {
    'sufficient': '充足',
    'normal': '一般',
    'urgent': '告急'
  };

  const todayIncome = totalAmount + otherDonation;
  const totalMeals = (diningCount || 0) + (volunteerCount || 0);
  const dailyCost = dailyExpenseTotal || expenseAmount;
  const costPerMeal = totalMeals > 0 && dailyCost > 0 ? (dailyCost / totalMeals).toFixed(2) : '0.00';

  // ------------------------------------------------------------------
  // 模式 A：朋友圈 3 行精简版
  // ------------------------------------------------------------------
  if (reportMode === 'moments') {
    let text = `🌸【${shopName}】每日爱心打卡 (${reportDate || new Date().toISOString().split('T')[0]})\n`;
    
    if (Number(diningCount) > 0) {
      text += `🍲 今日服务用餐：${diningCount} 人次 (食材投入 ¥${costPerMeal}/人)\n`;
    } else {
      text += `🌱 今日为开餐筹备期，蓄力待发\n`;
    }

    if (Number(volunteerCount) > 0) {
      text += `🤝 ${volunteerCount} 位志愿者无偿服务 ${volunteerHours || 0} 小时\n`;
    }

    text += `💳 账户结余：¥${formatMoney(todayBalance)} 元 | 拒绝浪费，爱心传递！\n`;
    text += `❤️ 欢迎各位家人回家吃饭！`;
    return text;
  }

  // ------------------------------------------------------------------
  // 模式 B：微信群全量详细版
  // ------------------------------------------------------------------
  let textArray: string[] = [];

  if (mergeToReportText && noticeContent && noticeContent.trim()) {
    let tagEmoji = '📢';
    let spacedTag = '特 别 通 报';

    if (noticeTag === '暂停营业' || noticeTag === '紧急提醒') {
      tagEmoji = '🚨';
      spacedTag = '关 键 通 报 ｜ 暂 停 营 业';
    } else if (noticeTag === '喜讯通报') {
      tagEmoji = '🎉';
      spacedTag = '喜 讯 通 报';
    } else if (noticeTag === '义工招募') {
      tagEmoji = '❤️';
      spacedTag = '爱 心 义 工 招 募';
    } else if (noticeTag === '物资呼吁') {
      tagEmoji = '📦';
      spacedTag = '爱 心 物 资 呼 吁';
    } else if (noticeTag === '感恩致谢') {
      tagEmoji = '❤️';
      spacedTag = '感 恩 致 谢';
    } else if (noticeTag) {
      spacedTag = noticeTag.split('').join(' ');
    }

    const cleanedContent = noticeContent
      .replace(/^【[^】]+】[\s：:]*/, '')
      .trim();

    textArray.push(`${tagEmoji}【 ${spacedTag} 】`);
    if (noticeTitle && noticeTitle.trim()) {
      textArray.push(`▶ 事项：${noticeTitle.trim()}`);
    }
    textArray.push('');
    textArray.push(`${cleanedContent}`);
    textArray.push('');
    textArray.push('');
  }

  textArray.push(`🌸【${shopName}】每日爱心餐报`);
  if (reportDate) textArray.push(`📅 汇报日期：${reportDate}`);
  textArray.push('');

  const hasDiningStats = (volunteerCount && volunteerCount > 0) || (volunteerHours && volunteerHours > 0) || (diningCount && diningCount > 0);
  
  if (hasDiningStats) {
    textArray.push(`🤝【义工与结缘成果】`);
    if (diningCount && diningCount > 0) {
      textArray.push(`• 今日结缘用餐：${diningCount} 人次`);
    } else {
      textArray.push(`• 运营状态：休餐筹措期 (未正式开餐)`);
    }
    if (volunteerCount && volunteerCount > 0) {
      textArray.push(`• 到岗护持义工：${volunteerCount} 人 (服务总时长 ${volunteerHours || 0} 小时)`);
    }
    textArray.push('感恩诸位志愿者无私奉献，用一餐饭的温度，温暖世间人心！');
    textArray.push('');
  }

  textArray.push(`💰【收支透明账本】`);
  textArray.push(`• 昨日结余：¥${formatMoney(yesterdayBalance)}`);
  textArray.push(`• 今日爱心汇入：+¥${formatMoney(todayIncome)}`);

  if (dailyExpenseTotal && dailyExpenseTotal > 0) {
    textArray.push(`• 今日开餐支出：-¥${formatMoney(dailyExpenseTotal)}`);
    
    let detailText = (dailyExpenseText || '').trim();
    
    if (detailText) {
      detailText = detailText
        .replace(/^开餐支出.*?[：:]/g, '')
        .replace(/^食材采购小票.*?[：:]/g, '')
        .replace(/^食材采购明细.*?[：:]/g, '')
        .trim();
      
      if (detailText.includes('\n')) {
        textArray.push(detailText);
      } else if (detailText.startsWith('•')) {
        textArray.push(detailText);
      } else {
        textArray.push(`  ${detailText}`);
      }
    }
  }
  if (fixedExpenseTotal && fixedExpenseTotal > 0) {
    let fixedText = (fixedExpenseText || '').trim();
    textArray.push(`• 专项支出（房租/设备）：-¥${fixedText || formatMoney(fixedExpenseTotal)}`);
  }
  if (!dailyExpenseTotal && !fixedExpenseTotal) {
    textArray.push(`• 今日开餐支出：无`);
  }

  textArray.push('--------------------------');
  textArray.push(`✨ 今日实时总结余：¥${formatMoney(todayBalance)}`);
  textArray.push('');

  if (items.length > 0) {
    textArray.push(`💗【爱心支持明细】`);
    if (items.length >= 4) {
      for (let i = 0; i < items.length; i += 2) {
        const left = items[i];
        const right = items[i + 1];
        const leftStr = `${i + 1}.${maskName(left.name)} ¥${formatMoney(left.amount)}`;
        if (right) {
          const rightStr = `${i + 2}.${maskName(right.name)} ¥${formatMoney(right.amount)}`;
          textArray.push(`${leftStr.padEnd(16, ' ')} | ${rightStr}`);
        } else {
          textArray.push(`${leftStr}`);
        }
      }
    } else {
      items.forEach((item, index) => {
        textArray.push(`${index + 1}. ${maskName(item.name)}：¥${formatMoney(item.amount)}`);
      });
    }
    textArray.push(`📊 总人数：${items.length}人 | 总金额：¥${formatMoney(totalAmount)}`);
    if (otherDonation > 0) {
      textArray.push(`其他支持：¥${formatMoney(otherDonation)}`);
    }
    textArray.push('');
  }

  if (materials && materials.length > 0) {
    textArray.push(`📦【现收物资赞助明细】`);
    materials.forEach(m => {
      textArray.push(`• ${maskName(m.donor)}：赞助 ${m.item} ${m.quantity}${m.unit}`);
    });
    textArray.push('');
  }

  // 🔗 门店日志联动：与首页「今日大事记」编辑区同一份数据，见 index.ts fetchTodayActivity
  if (activityText && activityText.trim()) {
    textArray.push(`📌【今日门店日志】`);
    textArray.push(activityText.trim());
    textArray.push('');
  }

  textArray.push(`📦【主食物资储备状态】`);
  textArray.push(`• 大米/面粉：${statusMap[stapleRiceStatus] || '一般'}`);
  textArray.push(`• 食用油：${statusMap[stapleOilStatus] || '充足'}`);

  const isRiceUrgent = stapleRiceStatus === 'urgent';
  const isOilUrgent = stapleOilStatus === 'urgent';
  if (isRiceUrgent || isOilUrgent) {
    const urgentItems = [];
    if (isRiceUrgent) urgentItems.push('大米/面粉');
    if (isOilUrgent) urgentItems.push('食用油');
    textArray.push('');
    textArray.push(`🌾【急需爱心物资】雨花斋今日${urgentItems.join('与')}储备告急，恳请各位家人伸出援手，奉献一份爱心！`);
  }

  textArray.push('');

  const randomQuote = YUHUA_GOLDEN_QUOTES[Math.floor(Math.random() * YUHUA_GOLDEN_QUOTES.length)];
  textArray.push(`💡【雨花心语】${randomQuote}`);
  textArray.push('');

  textArray.push(`❤️ ${thankText || defaultThankText}`);
  textArray.push('');

  textArray.push(`🌱 ${slogan1 || defaultSlogan1}`);
  textArray.push(`🌱 ${slogan2 || defaultSlogan2}`);
  textArray.push('');

  if (mpAccount) {
    textArray.push(`公众号：${mpAccount}`);
    textArray.push('');
  }

  textArray.push(`💡 本报告由微信小程序【素小账】一键生成`);

  return textArray.join('\n');
}