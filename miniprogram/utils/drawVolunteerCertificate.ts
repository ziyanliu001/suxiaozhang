/**
 * 绘制义工爱心护持荣誉证书 (Canvas 2D)，风格参考 drawStorePoster.ts 的绘制方式
 */
import { getSafeSystemInfo } from './util';

export interface CertificateData {
  canvas: any;
  nickname: string;
  days: number;
  hours: number;
  qrCodeTempPath: string;
  width: number;
  height: number;
}

// 中文按字符宽度换行更准确（英文单词换行规则不适用），逐字测宽、超宽就换行
function drawWrappedText(ctx: any, text: string, x: number, y: number, maxWidth: number, lineHeight: number): number {
  if (!text) return y;
  let line = '';
  let currentY = y;
  for (const ch of text) {
    const testLine = line + ch;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      ctx.fillText(line, x, currentY);
      line = ch;
      currentY += lineHeight;
    } else {
      line = testLine;
    }
  }
  if (line) {
    ctx.fillText(line, x, currentY);
    currentY += lineHeight;
  }
  return currentY;
}

function formatCertificateDate(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 颁发`;
}

export async function drawVolunteerCertificate(opts: CertificateData): Promise<void> {
  const { canvas, nickname, days, hours, qrCodeTempPath, width, height } = opts;
  const ctx = canvas.getContext('2d');
  // 复用项目已有的 getSafeSystemInfo（已经把 wx.getWindowInfo 缺失时的兜底封装好了），
  // 不再各文件各写一遍同样的三元表达式
  const dpr = getSafeSystemInfo().pixelRatio || 2;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  // 1. 米色宣纸质感底色：径向渐变模拟纸张不均匀的温润质感，而非纯色平涂
  const bgGradient = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.75);
  bgGradient.addColorStop(0, '#FBF6E9');
  bgGradient.addColorStop(1, '#F1E6C8');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // 2. 外层描边 + 内层细线，两层边框营造"证书感"
  const outerMargin = 18;
  const innerMargin = outerMargin + 10;
  ctx.strokeStyle = '#B8860B';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(outerMargin, outerMargin, width - outerMargin * 2, height - outerMargin * 2);
  ctx.strokeStyle = '#D4AF6A';
  ctx.lineWidth = 1;
  ctx.strokeRect(innerMargin, innerMargin, width - innerMargin * 2, height - innerMargin * 2);

  // 3. 四角回字纹装饰角标（简化版：L 形折角笔触，呼应传统证书回纹边框的视觉语言）
  const cornerSize = 22;
  ctx.strokeStyle = '#8C1D18';
  ctx.lineWidth = 3;
  const corners: Array<[number, number, number, number]> = [
    [outerMargin, outerMargin, 1, 1],
    [width - outerMargin, outerMargin, -1, 1],
    [outerMargin, height - outerMargin, 1, -1],
    [width - outerMargin, height - outerMargin, -1, -1]
  ];
  corners.forEach(([cx, cy, dx, dy]) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy + dy * cornerSize);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + dx * cornerSize, cy);
    ctx.stroke();
  });

  // 4. 顶部爱心小图标
  ctx.font = '26px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('❤️', width / 2, innerMargin + 46);

  // 5. 正中央大字标题
  ctx.fillStyle = '#8C1D18';
  ctx.font = 'bold 30px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('爱心护持荣誉证书', width / 2, innerMargin + 92);

  // 标题下方装饰分隔线
  ctx.strokeStyle = '#D4AF6A';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(width / 2 - 56, innerMargin + 108);
  ctx.lineTo(width / 2 + 56, innerMargin + 108);
  ctx.stroke();

  // 6. 正文段落：居中区域内自动换行
  const safeNickname = nickname || '爱心义工';
  const safeDays = Math.max(0, Math.floor(days || 0));
  const safeHours = Math.max(0, Math.round((hours || 0) * 10) / 10);
  // 🛡️ 去宗教化合规要求：证书文案禁止出现"同修"等宗教色彩词汇，统一采用
  // "义工伙伴"这类现代公益/志愿服务通用称谓
  const bodyText = `【${safeNickname}】义工伙伴，感谢您在雨花斋公益活动中的无私奉献。截止目前，您已累计护持 ${safeDays} 天，累计工时达 ${safeHours} 小时。特发此证，以兹鼓励。`;

  ctx.fillStyle = '#4A3200';
  ctx.font = '15px sans-serif';
  ctx.textAlign = 'left';
  const bodyMaxWidth = width - innerMargin * 2 - 36;
  drawWrappedText(ctx, bodyText, innerMargin + 18, innerMargin + 150, bodyMaxWidth, 26);

  // 7. 落款：团队名 + 颁发日期，置于左下角，与右下角二维码分区不冲突
  ctx.fillStyle = '#8C6D46';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('雨花爱心餐报助手团队', innerMargin + 18, height - innerMargin - 62);
  ctx.font = '12px sans-serif';
  ctx.fillText(formatCertificateDate(new Date()), innerMargin + 18, height - innerMargin - 42);

  // 8. 右下角圆形小程序码
  if (qrCodeTempPath) {
    try {
      const qrImage = canvas.createImage();
      qrImage.src = qrCodeTempPath;
      await new Promise<void>((resolve, reject) => {
        qrImage.onload = () => resolve();
        qrImage.onerror = () => reject(new Error('qr load failed'));
      });

      const qrSize = 72;
      const qrX = width - innerMargin - qrSize - 18;
      const qrY = height - innerMargin - qrSize - 18;

      ctx.save();
      ctx.beginPath();
      ctx.arc(qrX + qrSize / 2, qrY + qrSize / 2, qrSize / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(qrImage, qrX, qrY, qrSize, qrSize);
      ctx.restore();

      ctx.strokeStyle = '#B8860B';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(qrX + qrSize / 2, qrY + qrSize / 2, qrSize / 2, 0, Math.PI * 2);
      ctx.stroke();
    } catch (e) {
      console.warn('[drawVolunteerCertificate] 小程序码加载失败，证书将不显示二维码:', e);
    }
  }
}
