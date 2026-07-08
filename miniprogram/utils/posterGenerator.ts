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

export async function drawMeritPoster(pageInstance: any, data: PosterData): Promise<string> {
  return new Promise((resolve, reject) => {
    const query = wx.createSelectorQuery().in(pageInstance);
    query.select('#posterCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          return reject(new Error('未找到 id="posterCanvas" 节点，请检查 wxml 是否存在且非 wx:if 渲染'));
        }

        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const dpr = wx.getSystemInfoSync().pixelRatio || 2;

        const width = 375;
        const height = 667;

        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.scale(dpr, dpr);

        try {
          ctx.fillStyle = BG_COLOR;
          ctx.fillRect(0, 0, width, height);

          ctx.strokeStyle = BORDER_COLOR;
          ctx.lineWidth = 2;
          ctx.strokeRect(10, 10, width - 20, height - 20);

          ctx.lineWidth = 1;
          ctx.strokeStyle = '#D4CFC4';
          ctx.beginPath();
          ctx.moveTo(30, 110);
          ctx.lineTo(width - 30, 110);
          ctx.stroke();

          ctx.fillStyle = PRIMARY_COLOR;
          ctx.font = 'bold 24px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('随喜赞叹 功德无量', width / 2, 60);

          ctx.fillStyle = SECONDARY_COLOR;
          ctx.font = '18px sans-serif';
          ctx.fillText(data.reportDate, width / 2, 90);

          const cardY = 130;
          const cardHeight = 180;

          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(20, cardY, width - 40, cardHeight);

          ctx.strokeStyle = BORDER_COLOR;
          ctx.lineWidth = 1;
          ctx.strokeRect(20, cardY, width - 40, cardHeight);

          const gradient = ctx.createLinearGradient(20, cardY, width - 20, cardY);
          gradient.addColorStop(0, '#FFF8E7');
          gradient.addColorStop(1, '#FAF7F2');
          ctx.fillStyle = gradient;
          ctx.fillRect(20, cardY, width - 40, 30);

          ctx.fillStyle = PRIMARY_COLOR;
          ctx.font = 'bold 18px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(`【${data.shopName}】今日功德榜`, width / 2, cardY + 22);

          const statSpacing = (width - 40) / 4;
          const statY = cardY + 60;

          const stats = [
            { label: '供养人数', value: `${data.totalCount}人`, color: PRIMARY_COLOR },
            { label: '供养金额', value: `¥${data.totalAmount.toFixed(2)}`, color: '#E53935' },
            { label: '昨日余额', value: `¥${data.yesterdayBalance.toFixed(2)}`, color: '#52C41A' },
            { label: '今日结余', value: `¥${data.todayBalance.toFixed(2)}`, color: '#1890FF' }
          ];

          stats.forEach((stat, index) => {
            const x = 20 + statSpacing * index + statSpacing / 2;

            ctx.fillStyle = LIGHT_TEXT;
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(stat.label, x, statY);

            ctx.fillStyle = stat.color;
            ctx.font = 'bold 16px sans-serif';
            ctx.fillText(stat.value, x, statY + 28);
          });

          ctx.lineWidth = 1;
          ctx.strokeStyle = '#E8E4DC';
          ctx.beginPath();
          ctx.moveTo(20, cardY + 110);
          ctx.lineTo(width - 20, cardY + 110);
          ctx.stroke();

          const expenseY = cardY + 125;
          ctx.fillStyle = LIGHT_TEXT;
          ctx.font = '14px sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText('店铺支出：', 35, expenseY);

          ctx.fillStyle = TEXT_COLOR;
          ctx.font = '14px sans-serif';
          ctx.fillText(data.expenseAmount > 0 ? `¥${data.expenseAmount.toFixed(2)}` : '无', 100, expenseY);

          if (data.otherDonation > 0) {
            ctx.fillStyle = LIGHT_TEXT;
            ctx.font = '14px sans-serif';
            ctx.fillText('其他随喜：', 35, expenseY + 25);

            ctx.fillStyle = '#52C41A';
            ctx.font = '14px sans-serif';
            ctx.fillText(`¥${data.otherDonation.toFixed(2)}`, 100, expenseY + 25);
          }

          const listY = cardY + cardHeight + 15;
          ctx.fillStyle = PRIMARY_COLOR;
          ctx.font = 'bold 18px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('随喜供养名单', width / 2, listY);

          ctx.lineWidth = 1;
          ctx.strokeStyle = '#E8E4DC';
          ctx.beginPath();
          ctx.moveTo(35, listY + 12);
          ctx.lineTo(width - 35, listY + 12);
          ctx.stroke();

          const displayItems = data.items.slice(0, 15);
          let itemY = listY + 35;

          displayItems.forEach((item, index) => {
            if (itemY > height - 80) return;

            ctx.fillStyle = TEXT_COLOR;
            ctx.font = '16px sans-serif';
            ctx.textAlign = 'left';

            const name = item.name.length > 8 ? item.name.substring(0, 8) + '...' : item.name;
            ctx.fillText(`${index + 1}. ${name}`, 35, itemY);

            ctx.fillStyle = '#E53935';
            ctx.font = '16px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(`¥${item.amount.toFixed(2)}`, width - 35, itemY);

            itemY += 26;
          });

          if (data.items.length > 15) {
            ctx.fillStyle = LIGHT_TEXT;
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(`... 等${data.items.length}位爱心人士`, width / 2, itemY);
            itemY += 22;
          }

          const footerY = height - 60;

          ctx.lineWidth = 1;
          ctx.strokeStyle = '#E8E4DC';
          ctx.beginPath();
          ctx.moveTo(20, footerY - 30);
          ctx.lineTo(width - 20, footerY - 30);
          ctx.stroke();

          ctx.fillStyle = SECONDARY_COLOR;
          ctx.font = '14px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('🙏 随喜诸位大德功德', width / 2, footerY - 12);

          ctx.fillStyle = LIGHT_TEXT;
          ctx.font = '12px sans-serif';
          ctx.fillText('雨花斋用餐汇报助手', width / 2, footerY + 12);

          wx.canvasToTempFilePath({
            canvas: canvas,
            x: 0,
            y: 0,
            width: width * dpr,
            height: height * dpr,
            destWidth: width * dpr * 2,
            destHeight: height * dpr * 2,
            fileType: 'png',
            quality: 1,
            success: (tempRes) => resolve(tempRes.tempFilePath),
            fail: (err) => reject(new Error('Canvas 转图片失败: ' + err.errMsg))
          });

        } catch (drawErr) {
          reject(drawErr);
        }
      });
  });
}