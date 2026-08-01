import { getSafeSystemInfo } from './util';

/**
 * 绘制今日食谱宣传海报 (Canvas 2D)：3 列九宫格菜品卡片（实拍图 + 菜名）
 */
export interface DailyMenuPosterDish {
  name: string;
  photoTempPath?: string;
}

export interface DrawDailyMenuPosterOptions {
  canvas: any;
  storeName: string;
  dateDisplay: string;
  // 🍱 早/午/晚餐可独立发布，海报头部展示的餐别文案由调用方按当前记录的
  // mealType 传入，不再写死"午餐"
  mealLabel: string;
  menuText?: string;
  dishes: DailyMenuPosterDish[];
  width: number;
  height: number;
  // 🙏 餐前感恩词摘要（一行即可，不整段塞进海报喧宾夺主），未提供则不画这一行
  gratitudeLine?: string;
  // 小程序码本地临时路径（getStoreQRCode 下载后的 wxfile:// 路径），未提供/
  // 生成失败时优雅降级为不画（不占位留白），与 utils/posterGenerator.ts 里
  // 其它海报对二维码的降级口径一致
  qrLocalPath?: string;
}

const COLS = 3;
const GRID_GAP = 12;
const CELL_MARGIN_X = 24;
const ROW_NAME_HEIGHT = 22;
const ROW_GAP = 14;
const HEADER_HEIGHT = 100;
const FOOTER_HEIGHT = 40;
const MENU_TEXT_LINE_HEIGHT = 20;
const GRATITUDE_LINE_HEIGHT = 32;
const QR_SIZE = 72;
const QR_BLOCK_HEIGHT = QR_SIZE + 18 + 16;

function wrapText(ctx: any, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = '';

  for (const char of text) {
    const test = current + char;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = char;
      if (lines.length >= maxLines) break;
    } else {
      current = test;
    }
  }
  if (lines.length < maxLines && current) {
    lines.push(current);
  }
  if (lines.length === maxLines && current && lines[lines.length - 1] !== current) {
    let last = lines[maxLines - 1];
    while (ctx.measureText(last + '...').width > maxWidth && last.length > 0) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = last + '...';
  }
  return lines;
}

function truncateText(ctx: any, text: string, maxWidth: number): string {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 0 && ctx.measureText(truncated + '…').width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + '…';
}

function drawRoundedRectPath(ctx: any, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 按 aspectFill 语义居中裁剪铺满目标矩形，避免非正方形实拍图被拉伸变形
function drawImageCover(ctx: any, img: any, dx: number, dy: number, dw: number, dh: number): void {
  const srcRatio = img.width / img.height;
  const destRatio = dw / dh;
  let sx = 0, sy = 0, sw = img.width, sh = img.height;

  if (srcRatio > destRatio) {
    sw = img.height * destRatio;
    sx = (img.width - sw) / 2;
  } else {
    sh = img.width / destRatio;
    sy = (img.height - sh) / 2;
  }

  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

/**
 * 根据菜品数量/是否有菜谱文字备注/是否有感恩词/是否有二维码，计算海报画布应有的
 * 高度，供调用方在绘制前设置 <canvas> 尺寸（画布尺寸必须在绘制前确定，无法绘制
 * 完再回头改高度）
 */
export function calcDailyMenuPosterHeight(
  dishCount: number,
  hasMenuText: boolean,
  width: number,
  hasGratitude: boolean = false,
  hasQr: boolean = false
): number {
  const cellW = (width - CELL_MARGIN_X * 2 - GRID_GAP * (COLS - 1)) / COLS;
  const rowH = cellW + ROW_NAME_HEIGHT + ROW_GAP;
  const rows = Math.max(1, Math.ceil(dishCount / COLS));
  const menuTextHeight = hasMenuText ? MENU_TEXT_LINE_HEIGHT * 2 + 12 : 0;
  const gratitudeHeight = hasGratitude ? GRATITUDE_LINE_HEIGHT : 0;
  const qrHeight = hasQr ? QR_BLOCK_HEIGHT : 0;
  return HEADER_HEIGHT + 24 + menuTextHeight + rows * rowH + gratitudeHeight + qrHeight + FOOTER_HEIGHT;
}

export async function drawDailyMenuPoster(opts: DrawDailyMenuPosterOptions): Promise<void> {
  const { canvas, storeName, dateDisplay, mealLabel, menuText, dishes, width, height, gratitudeLine, qrLocalPath } = opts;
  const ctx = canvas.getContext('2d');
  const dpr = getSafeSystemInfo().pixelRatio || 2;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  // 1. 白色底板
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // 2. 顶部品牌色 Header
  const gradient = ctx.createLinearGradient(0, 0, 0, HEADER_HEIGHT);
  gradient.addColorStop(0, '#8C1D18');
  gradient.addColorStop(1, '#B23A2E');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, HEADER_HEIGHT);

  ctx.fillStyle = '#FFE8CC';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('🍱 今日食谱', width / 2, 34);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText(storeName || '雨花斋', width / 2, 64);

  ctx.fillStyle = '#FFE8CC';
  ctx.font = '13px sans-serif';
  ctx.fillText(`${dateDisplay} ${mealLabel}`, width / 2, 88);

  let cursorY = HEADER_HEIGHT + 28;

  // 3. 菜谱文字备注（可选）
  if (menuText && menuText.trim()) {
    ctx.fillStyle = '#555555';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'left';
    const lines = wrapText(ctx, menuText.trim(), width - CELL_MARGIN_X * 2, 2);
    lines.forEach((line) => {
      ctx.fillText(line, CELL_MARGIN_X, cursorY);
      cursorY += MENU_TEXT_LINE_HEIGHT;
    });
    cursorY += 12;
  }

  // 4. 菜品 3 列九宫格：实拍图（aspectFill 圆角方图）+ 菜名
  const cellW = (width - CELL_MARGIN_X * 2 - GRID_GAP * (COLS - 1)) / COLS;

  for (let i = 0; i < dishes.length; i++) {
    const dish = dishes[i];
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = CELL_MARGIN_X + col * (cellW + GRID_GAP);
    const y = cursorY + row * (cellW + ROW_NAME_HEIGHT + ROW_GAP);

    ctx.save();
    drawRoundedRectPath(ctx, x, y, cellW, cellW, 8);
    ctx.clip();

    if (dish.photoTempPath) {
      try {
        const img = canvas.createImage();
        img.src = dish.photoTempPath;
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('dish photo load failed'));
        });
        drawImageCover(ctx, img, x, y, cellW, cellW);
      } catch (e) {
        console.warn('[drawDailyMenuPoster] 菜品图加载失败，使用占位:', e);
        ctx.fillStyle = '#F0F7ED';
        ctx.fillRect(x, y, cellW, cellW);
      }
    } else {
      ctx.fillStyle = '#F0F7ED';
      ctx.fillRect(x, y, cellW, cellW);
    }
    ctx.restore();

    ctx.fillStyle = '#333333';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    const name = truncateText(ctx, dish.name || '未命名菜品', cellW);
    ctx.fillText(name, x + cellW / 2, y + cellW + 16);
  }

  const rows = Math.max(1, Math.ceil(dishes.length / COLS));
  cursorY += rows * (cellW + ROW_NAME_HEIGHT + ROW_GAP) - ROW_GAP + 24;

  // 5. 餐前感恩词摘要（可选，一行即可）
  if (gratitudeLine && gratitudeLine.trim()) {
    ctx.fillStyle = '#B45309';
    ctx.font = 'italic 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`🙏 ${gratitudeLine.trim()}`, width / 2, cursorY);
    cursorY += GRATITUDE_LINE_HEIGHT;
  }

  // 6. 小程序码（可选）：有真实临时路径才画，加载失败/未提供一律跳过，不占位留白
  if (qrLocalPath) {
    try {
      const qrImg = canvas.createImage();
      qrImg.src = qrLocalPath;
      await new Promise<void>((resolve, reject) => {
        qrImg.onload = () => resolve();
        qrImg.onerror = () => reject(new Error('qrcode image load failed'));
      });
      const qrX = (width - QR_SIZE) / 2;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(qrX, cursorY, QR_SIZE, QR_SIZE);
      ctx.drawImage(qrImg, qrX, cursorY, QR_SIZE, QR_SIZE);
      ctx.strokeStyle = '#E8E4DC';
      ctx.lineWidth = 1;
      ctx.strokeRect(qrX, cursorY, QR_SIZE, QR_SIZE);

      ctx.fillStyle = '#999999';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('微信扫码查看', width / 2, cursorY + QR_SIZE + 16);
      cursorY += QR_BLOCK_HEIGHT;
    } catch (e) {
      console.warn('[drawDailyMenuPoster] 二维码绘制失败，跳过:', e);
    }
  }

  // 7. 底部版权
  ctx.fillStyle = '#A67558';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('—  雨花斋餐报助手 · 今日爱心食谱  —', width / 2, height - 20);
}
