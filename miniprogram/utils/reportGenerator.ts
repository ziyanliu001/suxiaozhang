export interface DonorItem {
  name: string;
  amount: number;
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
  todayBalance: number;
  expenses: string;
  mpAccount: string;
}

export function formatMoney(value: number): string {
  return value.toFixed(2);
}

export function generateReportText(data: ReportData): string {
  const { shopName, reportDate, items, totalAmount, otherDonation, yesterdayBalance, expenseAmount, todayBalance, expenses, mpAccount } = data;
  
  let text = `🌸 【${shopName}】今日用餐与随喜账目汇报（${reportDate}）\n\n`;
  
  text += `💝 爱心人士供养明细\n`;
  text += `──────────────────\n`;
  
  if (items.length > 0) {
    items.forEach(item => {
      text += `• ${item.name}：${formatMoney(item.amount)}元\n`;
    });
  } else {
    text += `• 暂无随喜供养名单\n`;
  }
  
  text += `\n📊 供养统计\n`;
  text += `──────────────────\n`;
  text += `总人数：${items.length}人\n`;
  text += `总金额：${formatMoney(totalAmount)}元\n`;
  
  if (otherDonation > 0) {
    text += `其他随喜：${formatMoney(otherDonation)}元\n`;
  }
  
  text += `\n💰 收支概况\n`;
  text += `──────────────────\n`;
  text += `昨日余额：${formatMoney(yesterdayBalance)}元\n`;
  
  const todayIncome = totalAmount + otherDonation;
  text += `今日随喜收入：${formatMoney(todayIncome)}元\n`;
  
  text += `店铺支出：${expenses || '无'}\n`;
  
  text += `今日结余：${formatMoney(todayBalance)}元\n\n`;
  
  text += `🙏 随喜诸位大德功德，感恩默默付出的爱心义工！\n\n`;
  
  text += `🌱 吃 素 一 日   健 康 一 天\n`;
  text += `🌱 吃 素 一 日   环 保 一 天\n\n`;
  
  if (mpAccount) {
    text += `公众号：${mpAccount}\n\n`;
  }
  
  text += `—— 本报告由【素食小账本助手】智能生成\n微信小程序搜索“素食小账本助手”\n轻松搞定日常餐报汇总！`;
  
  return text;
}
