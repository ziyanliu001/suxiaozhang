import { getSafeSystemInfo } from './util';
import { safeRoundRect } from './canvasShapes';

/**
 * 绘制大事记活动海报 (Canvas 2D)
 */
export interface DrawActivityPosterOptions {
  canvas: any;
  storeName: string;
  title: string;
  eventTime: string;
  content: string;
  photoTempPath?: string;
  width: number;
  height: number;
}

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

export async function drawActivityPoster(opts: DrawActivityPosterOptions): Promise<void> {
  const { canvas, storeName, title, eventTime, content, photoTempPath, width, height } = opts;
  const ctx = canvas.getContext('2d');
  const dpr = getSafeSystemInfo().pixelRatio || 2;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  // 1. 白色底板
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // 2. 顶部品牌色 Header
  const gradient = ctx.createLinearGradient(0, 0, 0, 100);
  gradient.addColorStop(0, '#8C1D18');
  gradient.addColorStop(1, '#B23A2E');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, 100);

  ctx.fillStyle = '#FFE8CC';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('📌 活动大事记', width / 2, 36);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(storeName || '雨花斋', width / 2, 70);

  // 3. 标题 + 日期
  ctx.fillStyle = '#333333';
  ctx.font = 'bold 20px sans-serif';
  ctx.textAlign = 'left';
  const titleLines = wrapText(ctx, title || '（未命名活动）', width - 48, 2);
  let cursorY = 138;
  titleLines.forEach((line) => {
    ctx.fillText(line, 24, cursorY);
    cursorY += 28;
  });

  ctx.fillStyle = '#8C1D18';
  ctx.font = '13px sans-serif';
  ctx.fillText(`🗓 ${eventTime || ''}`, 24, cursorY + 6);
  cursorY += 30;

  // 4. 配图（若有）
  const photoTop = cursorY;
  const photoHeight = 200;
  if (photoTempPath) {
    try {
      const img = canvas.createImage();
      img.src = photoTempPath;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('photo load failed'));
      });

      // 居中裁切铺满，避免拉伸变形
      const boxW = width - 48;
      const boxH = photoHeight;
      const scale = Math.max(boxW / img.width, boxH / img.height);
      const drawW = img.width * scale;
      const drawH = img.height * scale;
      const dx = 24 - (drawW - boxW) / 2;
      const dy = photoTop - (drawH - boxH) / 2;

      ctx.save();
      // 🛡️ 不依赖原生 ctx.roundRect 存在性检查，见 utils/canvasShapes.ts safeRoundRect 说明
      safeRoundRect(ctx, 24, photoTop, boxW, boxH, 12);
      ctx.clip();
      ctx.drawImage(img, dx, dy, drawW, drawH);
      ctx.restore();
    } catch (e) {
      console.warn('[drawActivityPoster] 配图加载失败，使用占位:', e);
      ctx.fillStyle = '#F1F3F5';
      ctx.fillRect(24, photoTop, width - 48, photoHeight);
    }
    cursorY = photoTop + photoHeight + 24;
  }

  // 5. 图文内容摘要
  if (content) {
    ctx.fillStyle = '#555555';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'left';
    const contentLines = wrapText(ctx, content, width - 48, photoTempPath ? 4 : 8);
    contentLines.forEach((line) => {
      ctx.fillText(line, 24, cursorY);
      cursorY += 22;
    });
    cursorY += 10;
  }

  // 6. 底部版权
  ctx.fillStyle = '#A67558';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('—  雨花斋餐报助手 · 义工工作与活动大事记  —', width / 2, height - 20);
}
