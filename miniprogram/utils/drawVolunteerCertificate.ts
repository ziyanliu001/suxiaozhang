/**
 * 绘制义工爱心护持荣誉证书 (Canvas 2D)，风格参考 drawStorePoster.ts 的绘制方式
 */
import { getSafeSystemInfo } from './util';
import { drawStaticWxacodeFallback } from './staticWxacode';

export interface CertificateData {
  canvas: any;
  nickname: string;
  days: number;
  hours: number;
  qrCodeTempPath: string;
  width: number;
  height: number;
  // 落款右侧的红色印章是可选装饰，默认展示；如某天需要一个"无印章"的简洁版本，
  // 调用方可以直接传 false 关掉，不用改这个绘制函数本身
  showSeal?: boolean;
  // 🏪 所属门店：与姓名同一视觉层级展示，空值不绘制该行（不占位）
  storeName?: string;
  // 🔖 专属证书编号：由调用方生成（通常按 openid+日期派生的确定性短码），
  // 空值不绘制该行
  certNo?: string;
}

interface TextRun {
  text: string;
  font: string;
  color: string;
}

// 富文本换行：按字符宽度逐字测宽换行，同时支持每个 run 各自的字号/字重/颜色
// （用于正文里"天数/工时"这类需要加粗强调色、但前后文字是普通样式的场景）
function drawRichWrappedText(ctx: any, runs: TextRun[], x: number, y: number, maxWidth: number, lineHeight: number): number {
  let curX = x;
  let curY = y;
  for (const run of runs) {
    ctx.font = run.font;
    ctx.fillStyle = run.color;
    for (const ch of run.text) {
      const chWidth = ctx.measureText(ch).width;
      if (curX + chWidth > x + maxWidth && curX > x) {
        curX = x;
        curY += lineHeight;
      }
      ctx.fillText(ch, curX, curY);
      curX += chWidth;
    }
  }
  return curY + lineHeight;
}

function formatCertificateDate(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 颁发`;
}

// 红色印章：双圈描边 + 居中两行小字，整体略微倾斜，模拟盖章效果；
// globalAlpha < 1 让压在签名文字上的部分保留"透一点底"的手工盖章质感
function drawSealStamp(ctx: any, centerX: number, centerY: number, radius: number): void {
  ctx.save();
  ctx.globalAlpha = 0.86;
  ctx.translate(centerX, centerY);
  ctx.rotate((-10 * Math.PI) / 180);

  ctx.strokeStyle = '#D81E06';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, radius - 5, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#D81E06';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText('雨花爱心', 0, -6);
  ctx.fillText('公益认证', 0, 10);

  ctx.restore();
}

export async function drawVolunteerCertificate(opts: CertificateData): Promise<void> {
  const { canvas, nickname, days, hours, qrCodeTempPath, width, height, showSeal = true, storeName = '', certNo = '' } = opts;
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

  // 1b. 四角淡淡压暗的暗角叠加，叠加在底色渐变之上，让纸张看起来更有厚度/年份感
  //     （而不是新增一层独立肌理算法，避免小画布上性能/观感双重打折）
  const vignette = ctx.createRadialGradient(width / 2, height / 2, Math.max(width, height) * 0.32, width / 2, height / 2, Math.max(width, height) * 0.72);
  vignette.addColorStop(0, 'rgba(140, 109, 70, 0)');
  vignette.addColorStop(1, 'rgba(140, 109, 70, 0.10)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  // 2. 外层描边 + 中间虚线 + 内层细线，三层边框营造更正式的"证书花边"感
  const outerMargin = 18;
  const innerMargin = outerMargin + 10;
  const midMargin = (outerMargin + innerMargin) / 2;
  ctx.strokeStyle = '#B8860B';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(outerMargin, outerMargin, width - outerMargin * 2, height - outerMargin * 2);
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = '#D4AF6A';
  ctx.lineWidth = 1;
  ctx.strokeRect(midMargin, midMargin, width - midMargin * 2, height - midMargin * 2);
  ctx.restore();
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

  // 6. 义工姓名单独一行、加粗居中展示；过长昵称自动缩字号，避免超出内边框
  const safeNickname = nickname || '爱心义工';
  const safeDays = Math.max(0, Math.floor(days || 0));
  const safeHours = Math.max(0, Math.round((hours || 0) * 10) / 10);
  const nameText = `【${safeNickname}】`;
  const nameMaxWidth = width - innerMargin * 2 - 36;
  let nameFontSize = 22;
  ctx.font = `bold ${nameFontSize}px sans-serif`;
  while (ctx.measureText(nameText).width > nameMaxWidth && nameFontSize > 14) {
    nameFontSize -= 1;
    ctx.font = `bold ${nameFontSize}px sans-serif`;
  }
  ctx.fillStyle = '#8C1D18';
  ctx.textAlign = 'center';
  const nameY = innerMargin + 144;
  ctx.fillText(nameText, width / 2, nameY);

  // 6b. 所属门店：紧贴姓名下方一行，字号较小、颜色较淡，与姓名形成主次层级；
  // 空值不绘制，也不占用下方正文的起始行高
  let bodyStartY = nameY + 34;
  if (storeName) {
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#8C6D46';
    ctx.textAlign = 'center';
    ctx.fillText(`所属门店：${storeName}`, width / 2, nameY + 22);
    bodyStartY = nameY + 56;
  }

  // 7. 正文段落：护持天数/累积工时用加粗强调色单独标出，其余为普通正文，
  // 🛡️ 去宗教化合规要求：证书文案禁止出现"同修"等宗教色彩词汇，统一采用
  // "义工伙伴"这类现代公益/志愿服务通用称谓
  const normalFont = '15px sans-serif';
  const normalColor = '#4A3200';
  const highlightFont = 'bold 18px sans-serif';
  const highlightColor = '#D81E06';
  const bodyRuns: TextRun[] = [
    { text: '义工伙伴，感谢您在雨花斋公益活动中的无私奉献。截止目前，您已累计护持 ', font: normalFont, color: normalColor },
    { text: `${safeDays} 天`, font: highlightFont, color: highlightColor },
    { text: '，累计工时达 ', font: normalFont, color: normalColor },
    { text: `${safeHours} 小时`, font: highlightFont, color: highlightColor },
    { text: '。特发此证，以兹鼓励。', font: normalFont, color: normalColor }
  ];

  ctx.textAlign = 'left';
  const bodyMaxWidth = width - innerMargin * 2 - 36;
  drawRichWrappedText(ctx, bodyRuns, innerMargin + 18, bodyStartY, bodyMaxWidth, 28);

  // 8. 落款：团队名 + 颁发日期，靠右对齐置于右下角——传统证书落款惯例是贴右边界，
  // X 坐标固定在内边框内侧（width - innerMargin - 18），配合印章盖在文字右上方
  const signRightX = width - innerMargin - 18;
  ctx.fillStyle = '#8C6D46';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('雨花爱心餐报助手团队', signRightX, height - innerMargin - 62);
  ctx.font = '12px sans-serif';
  ctx.fillText(formatCertificateDate(new Date()), signRightX, height - innerMargin - 42);

  // 8b. 专属证书编号：左对齐落在 QR 码右侧与印章之间的空白横向区域，与右侧的
  // 颁发日期同一行基线对齐，空值不绘制
  if (certNo) {
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#A08A6A';
    ctx.textAlign = 'left';
    ctx.fillText(`证书编号：${certNo}`, innerMargin + 18, height - innerMargin - 42);
  }

  // 9. 左下角二维码（落款移到右下角后，二维码换到左下角，避免和落款/印章挤在一起）
  const qrSize = 64;
  const qrX = innerMargin + 18;
  const qrY = height - innerMargin - qrSize - 18;
  let realQrLoaded = false;

  if (qrCodeTempPath) {
    try {
      const qrImage = canvas.createImage();
      qrImage.src = qrCodeTempPath;
      await new Promise<void>((resolve, reject) => {
        qrImage.onload = () => resolve();
        qrImage.onerror = () => reject(new Error('qr load failed'));
      });

      // 真小程序码走圆形裁剪展示（图片自带白色留白，裁掉的只是留白角落，不动到
      // 定位图形），与整体证书的圆润视觉语言更搭
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
      realQrLoaded = true;
    } catch (e) {
      console.warn('[drawVolunteerCertificate] 小程序码加载失败，将改用本地兜底二维码:', e);
    }
  }

  if (!realQrLoaded) {
    // 🐛 云函数不可用（无网络/超时/权限异常）或压根没传 qrCodeTempPath 时，不再
    // 直接留空，也不再用 utils/qrEncoder.ts 现算本地 QR 码——那种码只能编码纯
    // 文本/通用链接，微信扫一扫客户端会直接拦下提示"暂不支持展示二维码中的文本
    // 内容"，等于没有码。改用随包打包的官方静态小程序码兜底（见
    // utils/staticWxacode.ts），扫码 100% 能拉起本小程序。注意：这里不能套用
    // 上面真小程序码的圆形裁剪，圆形会切掉正方形码四角的定位图形导致扫不出来——
    // 兜底必须是方形、四周留白完整的方式绘制
    try {
      await drawStaticWxacodeFallback(ctx, canvas, qrX, qrY, qrSize);
      ctx.strokeStyle = '#B8860B';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(qrX, qrY, qrSize, qrSize);
    } catch (e) {
      console.warn('[drawVolunteerCertificate] 静态小程序码兜底加载异常:', e);
    }
  }

  // 10. 红色印章：自然盖在靠右落款文字的右侧/上方，压住团队名一角，略微倾斜、半透明，
  // 模拟实体印章盖上去的效果；放在最后画，保证压在签名文字之上。圆心相对 signRightX
  // 向左内缩半个直径，让圆的右边缘落在内边框以内，不会被边框裁切
  if (showSeal) {
    const sealRadius = 30;
    const sealCenterX = signRightX - sealRadius + 6;
    const sealCenterY = height - innerMargin - 62 - 10;
    drawSealStamp(ctx, sealCenterX, sealCenterY, sealRadius);
  }
}
