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
  return `颁发日期：${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

// 量出实际渲染宽度后收缩字号直到放得下 maxWidth，用于长度不完全可控的动态文本
// （如证书编号）与固定文案共用同一段有限宽度时，保证谁都不会意外撑出预留区域
function fitFontSize(ctx: any, text: string, weight: string, baseSize: number, minSize: number, maxWidth: number): number {
  let size = baseSize;
  ctx.font = `${weight} ${size}px sans-serif`.trim();
  while (ctx.measureText(text).width > maxWidth && size > minSize) {
    size -= 1;
    ctx.font = `${weight} ${size}px sans-serif`.trim();
  }
  return size;
}

// 红色印章：双圈描边 + 居中两行小字，整体略微倾斜，模拟盖章效果；
// globalAlpha < 1 让压在签名文字上的部分保留"透一点底"的手工盖章质感——印章
// 收紧到只覆盖团队名这一行后半径变小，透明度也相应调低一档（0.86→0.75），
// 视觉上更像一枚轻压的小章，不会让底下的团队名文字完全看不清。
// 🐛 内部两行字号/行距此前是按半径 30 写死的固定像素值，radius 改小之后如果
// 不跟着缩，文字会直接超出圆圈范围——这里改为按半径等比例换算，圆章大小无论
// 怎么调，内部文字始终与圆圈边界保持同一比例的留白
function drawSealStamp(ctx: any, centerX: number, centerY: number, radius: number): void {
  ctx.save();
  ctx.globalAlpha = 0.75;
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

  // 内圈直径 (radius-5)*2 要装下 4 个汉字一行，系数按"字宽约等于字号"估算并
  // 留出安全余量（0.9 折）反推：fontSize ≈ 内圈直径 * 0.9 / 4 ≈ radius * 0.32
  const sealFontSize = Math.max(6, Math.round(radius * 0.32));
  const sealLineOffset = radius * 0.2;
  ctx.fillStyle = '#D81E06';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${sealFontSize}px sans-serif`;
  ctx.fillText('雨花爱心', 0, -sealLineOffset);
  ctx.fillText('公益认证', 0, sealLineOffset);

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
  // 🐛 二维码从 64 放大到 100 后，其顶边（qrY，见下方步骤 8）比原来高出 36px、
  // 更往上顶——原来 28px 的行距下，这段正文换行后最后一行的落点在典型天数/工时
  // 数字长度下会非常接近甚至压进二维码顶边。收紧到 24px 行距，换取足够的余量，
  // 不需要按二维码坐标反向裁剪正文（正文在二维码坐标算出来之前就已经画完）
  drawRichWrappedText(ctx, bodyRuns, innerMargin + 18, bodyStartY, bodyMaxWidth, 24);

  // 8. 底部信息区整体布局：左下角放大到 100x100 的小程序码，右侧纵向排列
  // 团队名 / 证书编号 / 颁发日期三行文字，彼此用留白隔开，任何一处都不会互相
  // 压字——此前证书编号与二维码共用同一段 X/Y 区域，二维码在证书编号之后才
  // 绘制，会直接盖掉证书编号左侧一截文字；红色印章的绘制范围也下探到了颁发
  // 日期那一行的基线上，同样存在裁切/遮挡。这里重新规划坐标，各元素之间预留
  // 明确间距，并整体收紧了印章的绘制范围，只压住团队名一角，不再触达日期行。
  const qrSize = 100;
  const qrX = innerMargin + 18;
  const qrY = height - innerMargin - qrSize - 18;

  // 二维码右侧的文字列：与二维码右边缘间隔 14px（远超"至少留 12rpx 间距"的要求），
  // 右边界贴到内边框内侧。证书编号是运行时生成的动态字符串，长度不完全可控，
  // 与团队名/颁发日期共用这段有限宽度的右对齐文字列——量出实际宽度后自动收缩
  // 字号直到放得下，而不是凭经验估算字号，避免个别长字符串意外撑出这段区域、
  // 反过来压回二维码
  const infoColX = qrX + qrSize + 14;
  const infoColRightX = width - innerMargin - 18;
  const infoColWidth = infoColRightX - infoColX;
  const teamNameY = qrY + 18;
  // 🐛 团队名下方紧跟印章（见下方 sealRadius=18 的圆压在这一行上），22px 的行距
  // 只够容纳印章底边和证书编号文字顶部之间几像素的空隙，字体渲染细节稍有出入就
  // 可能贴到一起——加宽到 30px，确保印章边缘与证书编号文字之间有肉眼可辨的留白
  const certNoY = teamNameY + 30;
  const dateY = certNoY + 20;

  ctx.textAlign = 'right';

  const teamNameText = '雨花爱心餐报助手团队';
  const teamNameSize = fitFontSize(ctx, teamNameText, 'bold', 13, 9, infoColWidth);
  ctx.fillStyle = '#8C6D46';
  ctx.font = `bold ${teamNameSize}px sans-serif`;
  ctx.fillText(teamNameText, infoColRightX, teamNameY);

  if (certNo) {
    const certNoText = `证书编号：${certNo}`;
    const certNoSize = fitFontSize(ctx, certNoText, '', 10, 7, infoColWidth);
    ctx.fillStyle = '#A08A6A';
    ctx.font = `${certNoSize}px sans-serif`;
    ctx.fillText(certNoText, infoColRightX, certNoY);
  }

  const dateText = formatCertificateDate(new Date());
  const dateSize = fitFontSize(ctx, dateText, '', 11, 8, infoColWidth);
  ctx.fillStyle = '#8C6D46';
  ctx.font = `${dateSize}px sans-serif`;
  ctx.fillText(dateText, infoColRightX, dateY);

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

  // 10. 红色印章：自然压住团队名一角，模拟实体印章盖上去的效果；放在最后画，
  // 保证压在文字之上。🐛 此前印章半径/圆心是按落款贴在右下角单独一处时的坐标算的，
  // 团队名/证书编号/颁发日期改成三行纵向堆叠后，原印章的绘制范围会一路下探到
  // 颁发日期那一行的基线，出现"公章压住日期文字"的裁切观感。这里收紧印章半径，
  // 只覆盖团队名这一行，圆心相对 infoColRightX 向左内缩，与下方证书编号/颁发日期
  // 之间留出明确间距，绝不触达
  if (showSeal) {
    const sealRadius = 18;
    const sealCenterX = infoColRightX - sealRadius + 6;
    const sealCenterY = teamNameY - 6;
    drawSealStamp(ctx, sealCenterX, sealCenterY, sealRadius);
  }
}
