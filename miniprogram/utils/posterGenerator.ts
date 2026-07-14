export interface MaterialItem {
  donor: string;
  item: string;
  quantity: string;
  unit: string;
}

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
  thankText?: string;
  slogan1?: string;
  slogan2?: string;
  materials?: MaterialItem[];
  volunteerCount?: number;
  volunteerHours?: number;
}

const BG_COLOR = '#FAF7F2';
const BORDER_COLOR = '#E8E4DC';
const PRIMARY_COLOR = '#B8860B';
const SECONDARY_COLOR = '#8B7355';
const TEXT_COLOR = '#3D3D3D';
const LIGHT_TEXT = '#888888';
const COPYRIGHT_COLOR = '#999999';

const CANVAS_WIDTH = 375;
const TOP_SAFE_PADDING = 30;
const CARD_TOP = 130 + TOP_SAFE_PADDING;
const CARD_HEIGHT = 180;
const LIST_TITLE_HEIGHT = 60;
const ITEM_ROW_HEIGHT = 26;
const MATERIALS_TITLE_HEIGHT = 40;
const VOLUNTEER_TITLE_HEIGHT = 40;
const VOLUNTEER_ROW_HEIGHT = 26;
const MATERIALS_ROW_HEIGHT = 22;
const TWO_COLUMN_THRESHOLD = 50;
const FOOTER_TOP_MARGIN = 24;
const FOOTER_LINE_HEIGHT = 20;
const FOOTER_HEIGHT = 70;
const SINGLE_COL_NAME_MAX = 200;
const DOUBLE_COL_NAME_MAX = 110;
const ELLIPSIS = '...';

function calculateCanvasHeight(itemCount: number, materialsCount: number = 0, hasVolunteer: boolean = false): number {
  const useTwoColumns = itemCount > TWO_COLUMN_THRESHOLD;
  const itemsPerColumn = useTwoColumns ? Math.ceil(itemCount / 2) : itemCount;
  const listContentHeight = itemsPerColumn * ITEM_ROW_HEIGHT;

  const materialsHeight = materialsCount > 0
    ? MATERIALS_TITLE_HEIGHT + materialsCount * MATERIALS_ROW_HEIGHT + 20
    : 0;

  const volunteerHeight = hasVolunteer
    ? VOLUNTEER_TITLE_HEIGHT + 2 * VOLUNTEER_ROW_HEIGHT + 20
    : 0;

  const totalHeight = CARD_TOP + CARD_HEIGHT + 35 + materialsHeight + volunteerHeight + LIST_TITLE_HEIGHT + listContentHeight + FOOTER_TOP_MARGIN + FOOTER_HEIGHT + 40;

  return Math.max(totalHeight, 667);
}

function truncateText(ctx: any, text: string, maxWidth: number): string {
  if (!text) return '';
  const measured = ctx.measureText(text);
  if (measured.width <= maxWidth) return text;

  const ellipsisWidth = ctx.measureText(ELLIPSIS).width;
  const targetWidth = maxWidth - ellipsisWidth;
  if (targetWidth <= 0) return ELLIPSIS;

  let low = 0;
  let high = text.length;
  let result = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.substring(0, mid);
    const w = ctx.measureText(candidate).width;
    if (w <= targetWidth) {
      result = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result + ELLIPSIS;
}

function drawMultiLineText(ctx: any, text: string, x: number, y: number, maxWidth: number, lineHeight: number): number {
  if (!text) return y;

  const words = text.split('');
  let line = '';
  let currentY = y;

  for (let i = 0; i < words.length; i++) {
    const testLine = line + words[i];
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && line) {
      ctx.fillText(line, x, currentY);
      line = words[i];
      currentY += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, x, currentY);
  return currentY + lineHeight;
}

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
        const dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2;

        const width = CANVAS_WIDTH;
        const itemCount = data.items.length;
        const materialsCount = (data.materials && data.materials.length) || 0;
        const hasVolunteer = (data.volunteerCount && data.volunteerCount > 0) || (data.volunteerHours && data.volunteerHours > 0);
        const useTwoColumns = itemCount > TWO_COLUMN_THRESHOLD;
        const itemsPerColumn = useTwoColumns ? Math.ceil(itemCount / 2) : itemCount;
        const height = calculateCanvasHeight(itemCount, materialsCount, hasVolunteer);

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
          ctx.moveTo(30, 110 + TOP_SAFE_PADDING);
          ctx.lineTo(width - 30, 110 + TOP_SAFE_PADDING);
          ctx.stroke();

          ctx.fillStyle = PRIMARY_COLOR;
          ctx.font = 'bold 24px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(data.slogan1 || '清晰记账 透明运行', width / 2, 60 + TOP_SAFE_PADDING);

          ctx.fillStyle = SECONDARY_COLOR;
          ctx.font = '18px sans-serif';
          ctx.fillText(data.reportDate, width / 2, 90 + TOP_SAFE_PADDING);

          const cardY = CARD_TOP;
          const cardHeight = CARD_HEIGHT;

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
          ctx.fillText(`【${data.shopName}】今日支持明细`, width / 2, cardY + 22);

          const statSpacing = (width - 40) / 4;
          const statY = cardY + 60;

          const stats = [
            { label: '赞助人数', value: `${data.totalCount}人`, color: PRIMARY_COLOR },
            { label: '赞助金额', value: `¥${data.totalAmount.toFixed(2)}`, color: '#E53935' },
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
            ctx.fillText('其他支持：', 35, expenseY + 25);

            ctx.fillStyle = '#52C41A';
            ctx.font = '14px sans-serif';
            ctx.fillText(`¥${data.otherDonation.toFixed(2)}`, 100, expenseY + 25);
          }

          // 物资赞助明细区域
          let materialsEndY = cardY + cardHeight + 35;
          if (data.materials && data.materials.length > 0) {
            const materialsTitleY = cardY + cardHeight + 30;
            ctx.fillStyle = PRIMARY_COLOR;
            ctx.font = 'bold 16px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('📦 物资赞助明细', width / 2, materialsTitleY);

            ctx.lineWidth = 1;
            ctx.strokeStyle = '#E8E4DC';
            ctx.beginPath();
            ctx.moveTo(35, materialsTitleY + 10);
            ctx.lineTo(width - 35, materialsTitleY + 10);
            ctx.stroke();

            let matY = materialsTitleY + 28;
            data.materials.forEach((m) => {
              ctx.fillStyle = TEXT_COLOR;
              ctx.font = '13px sans-serif';
              ctx.textAlign = 'left';
              const donorText = `• ${m.donor}：`;
              ctx.fillText(donorText, 35, matY);

              const donorWidth = ctx.measureText(donorText).width;
              ctx.fillStyle = '#B8860B';
              ctx.font = 'bold 13px sans-serif';
              ctx.fillText(`赞助 ${m.item} ${m.quantity}${m.unit}`, 35 + donorWidth, matY);

              matY += MATERIALS_ROW_HEIGHT;
            });
            materialsEndY = matY + 8;
          }

          // 义工感恩奉献区域
          let volunteerEndY = materialsEndY;
          const hasVolunteer = (data.volunteerCount && data.volunteerCount > 0) || (data.volunteerHours && data.volunteerHours > 0);
          if (hasVolunteer) {
            const volunteerTitleY = materialsEndY + 10;
            ctx.fillStyle = '#D2691E';
            ctx.font = 'bold 16px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('🧡 义工感恩奉献', width / 2, volunteerTitleY);

            ctx.lineWidth = 1;
            ctx.strokeStyle = '#FFDAB9';
            ctx.beginPath();
            ctx.moveTo(35, volunteerTitleY + 10);
            ctx.lineTo(width - 35, volunteerTitleY + 10);
            ctx.stroke();

            let volY = volunteerTitleY + 30;
            ctx.textAlign = 'left';
            ctx.font = '14px sans-serif';

            if (data.volunteerCount && data.volunteerCount > 0) {
              ctx.fillStyle = LIGHT_TEXT;
              ctx.fillText('• 今日到岗义工：', 35, volY);
              ctx.fillStyle = '#D2691E';
              ctx.font = 'bold 14px sans-serif';
              const labelWidth = ctx.measureText('• 今日到岗义工：').width;
              ctx.fillText(`${data.volunteerCount} 人`, 35 + labelWidth, volY);
              volY += 26;
            }

            if (data.volunteerHours && data.volunteerHours > 0) {
              ctx.fillStyle = LIGHT_TEXT;
              ctx.font = '14px sans-serif';
              ctx.fillText('• 奉献服务时长：', 35, volY);
              ctx.fillStyle = '#D2691E';
              ctx.font = 'bold 14px sans-serif';
              const labelWidth2 = ctx.measureText('• 奉献服务时长：').width;
              ctx.fillText(`${data.volunteerHours} 小时`, 35 + labelWidth2, volY);
              volY += 26;
            }

            volunteerEndY = volY + 8;
          }

          const listTitleY = volunteerEndY;
          ctx.fillStyle = PRIMARY_COLOR;
          ctx.font = 'bold 18px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('自愿赞助名单', width / 2, listTitleY);

          ctx.lineWidth = 1;
          ctx.strokeStyle = '#E8E4DC';
          ctx.beginPath();
          ctx.moveTo(35, listTitleY + 12);
          ctx.lineTo(width - 35, listTitleY + 12);
          ctx.stroke();

          let itemY = listTitleY + 35;

          if (useTwoColumns) {
            const col1X = 35;
            const col2X = width / 2 + 10;
            const colAmountRightX = [width / 2 - 15, width - 35];

            for (let i = 0; i < itemCount; i++) {
              const item = data.items[i];
              const colIndex = Math.floor(i / itemsPerColumn);
              const rowInCol = i % itemsPerColumn;
              const x = colIndex === 0 ? col1X : col2X;
              const y = itemY + rowInCol * ITEM_ROW_HEIGHT;

              ctx.fillStyle = TEXT_COLOR;
              ctx.font = '14px sans-serif';
              ctx.textAlign = 'left';

              const prefix = `${i + 1}. `;
              const prefixWidth = ctx.measureText(prefix).width;
              const amountStr = `¥${item.amount.toFixed(2)}`;
              const amountWidth = ctx.measureText(amountStr).width;
              const nameStartX = x + prefixWidth;
              const nameMaxWidth = colAmountRightX[colIndex] - nameStartX - amountWidth - 12;
              const truncatedName = truncateText(ctx, item.name, Math.max(nameMaxWidth, 20));
              ctx.fillText(prefix + truncatedName, x, y);

              ctx.fillStyle = '#E53935';
              ctx.font = '14px sans-serif';
              ctx.textAlign = 'right';
              ctx.fillText(amountStr, colAmountRightX[colIndex], y);
            }

            itemY += itemsPerColumn * ITEM_ROW_HEIGHT;
          } else {
            const nameStartX = 35;
            const amountRightX = width - 35;

            data.items.forEach((item, index) => {
              ctx.fillStyle = TEXT_COLOR;
              ctx.font = '16px sans-serif';
              ctx.textAlign = 'left';

              const prefix = `${index + 1}. `;
              const prefixWidth = ctx.measureText(prefix).width;
              const nameStartOffset = nameStartX + prefixWidth;
              const amountStr = `¥${item.amount.toFixed(2)}`;
              const amountWidth = ctx.measureText(amountStr).width;
              const nameMaxWidth = amountRightX - nameStartOffset - amountWidth - 10;
              const truncatedName = truncateText(ctx, item.name, Math.max(nameMaxWidth, 20));
              ctx.fillText(prefix + truncatedName, nameStartX, itemY);

              ctx.fillStyle = '#E53935';
              ctx.font = '16px sans-serif';
              ctx.textAlign = 'right';
              ctx.fillText(amountStr, amountRightX, itemY);

              itemY += ITEM_ROW_HEIGHT;
            });
          }

          const footerTop = itemY + FOOTER_TOP_MARGIN;

          ctx.lineWidth = 1;
          ctx.strokeStyle = '#E8E4DC';
          ctx.beginPath();
          ctx.moveTo(20, footerTop);
          ctx.lineTo(width - 20, footerTop);
          ctx.stroke();

          ctx.fillStyle = LIGHT_TEXT;
          ctx.font = '13px sans-serif';
          ctx.textAlign = 'center';
          
          const thanksLine1 = '🙏 感谢各位爱心人士的鼎力支持';
          const thanksLine2 = '感恩默默付出的义工团队';
          
          ctx.fillText(thanksLine1, width / 2, footerTop + FOOTER_LINE_HEIGHT + 6);
          ctx.fillText(thanksLine2, width / 2, footerTop + FOOTER_LINE_HEIGHT * 2 + 16);

          ctx.fillStyle = COPYRIGHT_COLOR;
          ctx.font = '11px sans-serif';
          ctx.fillText('素小账', width / 2, footerTop + FOOTER_LINE_HEIGHT * 3 + 24);

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
