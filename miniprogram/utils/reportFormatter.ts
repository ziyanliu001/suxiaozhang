export interface GratitudeReportData {
  periodTitle?: string;
  storeName?: string;
  diningDays?: number;
  incomeDays?: number;
  totalDiners?: number;
  volunteerCount?: number;
  volunteerHours?: number;
  totalIncome?: number;
  totalExpense?: number;
  dailyFoodExpense?: number;
  totalBalance?: number;
  estimatedDays?: string;
  riceStatus?: string;
  oilStatus?: string;
}

export function formatGratitudeReportText(statsData: GratitudeReportData): string {
  const {
    periodTitle = '2026年7月 第2周',
    storeName = '海沧区雨花斋',
    diningDays = 0,
    incomeDays = 0,
    totalDiners = 0,
    volunteerCount = 0,
    volunteerHours = 0,
    totalIncome = 0,
    totalExpense = 0,
    dailyFoodExpense = 0,
    totalBalance = 0,
    estimatedDays = '28 ~ 34',
    riceStatus = '一般',
    oilStatus = '充足'
  } = statsData;

  const netIncome = totalIncome - totalExpense;
  const isPreparing = diningDays === 0 && totalIncome > 0;
  const hasMeals = totalDiners > 0 && dailyFoodExpense > 0;

  let text = `🌸【雨花斋爱心账本·${periodTitle}汇报】\n`;
  text += `🗓 统计周期：${periodTitle}\n`;
  text += `📍 运行门店：${storeName}\n`;
  text += `──────────────────\n`;
  text += `💰 爱心汇入：+¥${totalIncome.toFixed(2)}\n`;

  if (hasMeals) {
    text += `🥗 日常开餐食材：-¥${dailyFoodExpense.toFixed(2)}\n`;
    const costPerMeal = (dailyFoodExpense / totalDiners).toFixed(2);
    text += `🍲 累计用餐服务：${totalDiners} 人次（单餐食材成本约 ¥${costPerMeal}/餐）\n`;
  } else if (isPreparing) {
    text += `📌 运营状态：休餐筹措期/准备期\n`;
    text += `🙏 本期共收到 ${incomeDays || 0} 笔爱心汇入\n`;
  } else {
    text += `🍲 累计用餐服务：${totalDiners} 人次\n`;
  }

  if (totalExpense > dailyFoodExpense) {
    const majorExpense = totalExpense - dailyFoodExpense;
    text += `🏛 房租/大额专项：-¥${majorExpense.toFixed(2)}\n`;
  }

  text += `💳 账户实时总结余：¥${totalBalance.toFixed(2)}\n`;
  if (estimatedDays && estimatedDays !== '—') {
    text += `📊 预计可支撑：${estimatedDays}\n`;
  }
  text += `📦 核心物资：大米[${riceStatus}] / 食用油[${oilStatus}]\n`;
  text += `❤️ 义工护持：${volunteerCount} 人次（${volunteerHours} 小时）\n`;
  text += `──────────────────\n`;
  text += `🙏 感恩各位家人与爱心人士无私护持，积沙成塔，共植福田！`;

  return text;
}