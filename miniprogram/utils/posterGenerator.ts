export interface DonorItem {
  name: string;
  amount: number;
}

export interface PosterData {
  shopName: string;
  dateString: string;
  reportDate: string;
  items: DonorItem[];
  totalCount: number;
  totalAmount: number;
  otherDonation: number;
  yesterdayBalance: number;
  expenseAmount: number;
  todayBalance: number;
  mpAccount: string;
}

const BG_COLOR = '#FAF7F2';
const BORDER_COLOR = '#E8E4DC';
const PRIMARY_COLOR = '#B8860B';
const SECONDARY_COLOR = '#8B7355';
const TEXT_COLOR = '#3D3D3D';
const LIGHT_TEXT = '#888888';

export async function drawMeritPoster(canvasId: string, data: PosterData): Promise<string> {
  return new Promise((resolve, reject) => {
    const ctx = wx.createCanvasContext(canvasId);
    
    const width = 680;
    const height = 960;
    
    ctx.setFillStyle(BG_COLOR);
    ctx.fillRect(0, 0, width, height);
    
    ctx.setStrokeStyle(BORDER_COLOR);
    ctx.setLineWidth(2);
    ctx.strokeRect(10, 10, width - 20, height - 20);
    
    ctx.setLineWidth(1);
    ctx.setStrokeStyle('#D4CFC4');
    ctx.beginPath();
    ctx.moveTo(30, 160);
    ctx.lineTo(width - 30, 160);
    ctx.stroke();
    
    ctx.setFillStyle(PRIMARY_COLOR);
    ctx.setFontSize(36);
    ctx.setTextAlign('center');
    ctx.fillText('随喜赞叹 功德无量', width / 2, 80);
    
    ctx.setFillStyle(SECONDARY_COLOR);
    ctx.setFontSize(24);
    ctx.fillText(data.reportDate, width / 2, 120);
    
    const cardY = 180;
    const cardHeight = 280;
    
    ctx.setFillStyle('#FFFFFF');
    ctx.fillRect(30, cardY, width - 60, cardHeight);
    
    ctx.setStrokeStyle(BORDER_COLOR);
    ctx.setLineWidth(1);
    ctx.strokeRect(30, cardY, width - 60, cardHeight);
    
    const gradient = ctx.createLinearGradient(30, cardY, width - 30, cardY);
    gradient.addColorStop(0, '#FFF8E7');
    gradient.addColorStop(1, '#FAF7F2');
    ctx.setFillStyle(gradient);
    ctx.fillRect(30, cardY, width - 60, 40);
    
    ctx.setFillStyle(PRIMARY_COLOR);
    ctx.setFontSize(26);
    ctx.setTextAlign('center');
    ctx.fillText(`【${data.shopName}】今日功德榜`, width / 2, cardY + 28);
    
    const statSpacing = (width - 60) / 4;
    const statY = cardY + 80;
    
    const stats = [
      { label: '供养人数', value: `${data.totalCount}人`, color: PRIMARY_COLOR },
      { label: '供养金额', value: `¥${data.totalAmount.toFixed(2)}`, color: '#E53935' },
      { label: '昨日余额', value: `¥${data.yesterdayBalance.toFixed(2)}`, color: '#52C41A' },
      { label: '今日结余', value: `¥${data.todayBalance.toFixed(2)}`, color: '#1890FF' }
    ];
    
    stats.forEach((stat, index) => {
      const x = 30 + statSpacing * index + statSpacing / 2;
      
      ctx.setFillStyle(LIGHT_TEXT);
      ctx.setFontSize(22);
      ctx.setTextAlign('center');
      ctx.fillText(stat.label, x, statY);
      
      ctx.setFillStyle(stat.color);
      ctx.setFontSize(28);
      ctx.setFontWeight('bold');
      ctx.fillText(stat.value, x, statY + 40);
    });
    
    ctx.setLineWidth(1);
    ctx.setStrokeStyle('#E8E4DC');
    ctx.beginPath();
    ctx.moveTo(30, cardY + 160);
    ctx.lineTo(width - 30, cardY + 160);
    ctx.stroke();
    
    const expenseY = cardY + 180;
    ctx.setFillStyle(LIGHT_TEXT);
    ctx.setFontSize(22);
    ctx.setTextAlign('left');
    ctx.fillText('店铺支出：', 50, expenseY);
    
    ctx.setFillStyle(TEXT_COLOR);
    ctx.setFontSize(22);
    ctx.fillText(data.expenseAmount > 0 ? `¥${data.expenseAmount.toFixed(2)}` : '无', 150, expenseY);
    
    if (data.otherDonation > 0) {
      ctx.setFillStyle(LIGHT_TEXT);
      ctx.setFontSize(22);
      ctx.fillText('其他随喜：', 50, expenseY + 35);
      
      ctx.setFillStyle('#52C41A');
      ctx.setFontSize(22);
      ctx.fillText(`¥${data.otherDonation.toFixed(2)}`, 150, expenseY + 35);
    }
    
    const listY = cardY + cardHeight + 20;
    ctx.setFillStyle(PRIMARY_COLOR);
    ctx.setFontSize(26);
    ctx.setTextAlign('center');
    ctx.fillText('随喜供养名单', width / 2, listY);
    
    ctx.setLineWidth(1);
    ctx.setStrokeStyle('#E8E4DC');
    ctx.beginPath();
    ctx.moveTo(50, listY + 15);
    ctx.lineTo(width - 50, listY + 15);
    ctx.stroke();
    
    const displayItems = data.items.slice(0, 15);
    let itemY = listY + 40;
    
    displayItems.forEach((item, index) => {
      if (itemY > height - 120) return;
      
      ctx.setFillStyle(TEXT_COLOR);
      ctx.setFontSize(24);
      ctx.setTextAlign('left');
      
      const name = item.name.length > 8 ? item.name.substring(0, 8) + '...' : item.name;
      ctx.fillText(`${index + 1}. ${name}`, 50, itemY);
      
      ctx.setFillStyle('#E53935');
      ctx.setFontSize(24);
      ctx.setTextAlign('right');
      ctx.fillText(`¥${item.amount.toFixed(2)}`, width - 50, itemY);
      
      itemY += 36;
    });
    
    if (data.items.length > 15) {
      ctx.setFillStyle(LIGHT_TEXT);
      ctx.setFontSize(22);
      ctx.setTextAlign('center');
      ctx.fillText(`... 等${data.items.length}位爱心人士`, width / 2, itemY);
      itemY += 30;
    }
    
    const footerY = height - 80;
    
    ctx.setLineWidth(1);
    ctx.setStrokeStyle('#E8E4DC');
    ctx.beginPath();
    ctx.moveTo(30, footerY - 40);
    ctx.lineTo(width - 30, footerY - 40);
    ctx.stroke();
    
    ctx.setFillStyle(SECONDARY_COLOR);
    ctx.setFontSize(20);
    ctx.setTextAlign('center');
    ctx.fillText('🙏 随喜诸位大德功德', width / 2, footerY - 15);
    
    ctx.setFillStyle(LIGHT_TEXT);
    ctx.setFontSize(18);
    ctx.fillText('雨花斋用餐汇报助手', width / 2, footerY + 15);
    
    ctx.draw(false, () => {
      wx.canvasToTempFilePath({
        canvasId: canvasId,
        success: (res) => {
          resolve(res.tempFilePath);
        },
        fail: (err) => {
          reject(err);
        }
      });
    });
  });
}
