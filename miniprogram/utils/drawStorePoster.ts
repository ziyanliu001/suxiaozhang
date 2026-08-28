/**
 * 绘制高颜值雨花斋门店邀请海报 (Canvas 2D)
 */
import { safeRoundRect } from './canvasShapes';
export interface SponsorInfo {
  companyName: string;
  brandSlogan: string;
  logoUrl?: string;
}

export interface DrawPosterOptions {
  canvas: any;
  storeName: string;
  sponsorInfo?: SponsorInfo | null;
  qrCodeTempPath: string;
  width: number;
  height: number;
  // 🌟 门店简介/地址：可选，未提供时版式与升级前完全一致（原有 index.ts 调用点不用改）
  address?: string;
  intro?: string;
}

export async function drawStoreInvitationPoster(opts: DrawPosterOptions): Promise<void> {
  const { canvas, storeName, sponsorInfo, qrCodeTempPath, width, height } = opts;
  const ctx = canvas.getContext('2d');
  // 🐛 白屏根因之一：极少数模拟器/低版本基础库下 canvas.getContext('2d') 会
  // 返回 null 而不是抛异常，后续 ctx.scale/fillRect 等调用会直接因
  // "Cannot read property of null" 中断整个绘制——调用方的 try/catch 虽然能
  // 兜住不崩溃，但报错信息完全看不出是 ctx 拿不到，这里提前给一个明确的错误
  if (!ctx) {
    throw new Error('CANVAS_CONTEXT_UNAVAILABLE: canvas.getContext(2d) 返回空');
  }
  const dpr = ((wx as any).getWindowInfo ? (wx as any).getWindowInfo().pixelRatio : 2) || 2;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  // 🎨 统一高质感圆角：与 posterGenerator.ts drawMeritPoster/drawStoryPoster
  // 同款修复——预览层 .poster-canvas 靠 CSS border-radius 伪装圆角，但
  // wx.canvasToTempFilePath 导出/分享/保存到相册的是画布原始像素，四角其实
  // 是直角。这里在最外层先 clip 成圆角矩形，之后所有绘制天然被裁在圆角范围内，
  // 结尾 ctx.restore() 收回裁剪区，不影响这个 canvas 之后可能的其他绘制
  ctx.save();
  safeRoundRect(ctx, 0, 0, width, height, 24);
  ctx.clip();

  // 1. 白色底板
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // 2. 顶部渐变 Header
  const gradient = ctx.createLinearGradient(0, 0, 0, 160);
  gradient.addColorStop(0, '#FFE066');
  gradient.addColorStop(1, '#FFF3BF');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, 160);

  // 3. 顶部标语与门店名
  ctx.fillStyle = '#D9480E';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('❤️ 关爱生命 · 敬老行善', width / 2, 55);

  ctx.fillStyle = '#212529';
  ctx.font = 'bold 26px sans-serif';
  ctx.fillText(storeName || '雨花斋', width / 2, 105);

  // 4. 动态赞助商冠名绘制
  if (sponsorInfo && sponsorInfo.companyName) {
    ctx.fillStyle = '#C8592B';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(`✨ 爱心冠名单位：${sponsorInfo.companyName}`, width / 2, 132);

    if (sponsorInfo.brandSlogan) {
      ctx.fillStyle = '#8C6D46';
      ctx.font = '10px sans-serif';
      ctx.fillText(sponsorInfo.brandSlogan, width / 2, 150);
    }
  } else {
    ctx.fillStyle = '#D9480E';
    ctx.font = '14px sans-serif';
    ctx.fillText('义工记账与爱心服务团队邀请', width / 2, 135);
  }

  // 4. 二维码白卡
  const cardX = 30;
  const cardY = 180;
  const cardW = width - 60;
  const cardH = 280;

  ctx.fillStyle = '#F8F9FA';
  ctx.strokeStyle = '#FFE066';
  ctx.lineWidth = 2;

  // 🛡️ 不再用 typeof ctx.roundRect === 'function' 做存在性检查后直接调用原生
  // roundRect——Linux 平台微信开发者工具模拟器上该方法虽然存在，但对单数字 radius
  // 参数处理不规范，调用时直接抛 TypeError，存在性检查拦不住"存在但调用即抛"，
  // 见 utils/canvasShapes.ts safeRoundRect 的说明
  safeRoundRect(ctx, cardX, cardY, cardW, cardH, 16);
  ctx.fill();
  ctx.stroke();

  // 5. 绘制小程序码
  // 🐛 白屏根因之二：此前仅当 qrCodeTempPath 非空时才进入绘制分支，调用方
  // getStoreQRCode 云函数失败/downloadFile 网络异常时 qrCodeTempPath 会是
  // 空字符串——原逻辑对这种情况什么都不画，卡片中间就是一块彻底的留白，观感
  // 上跟"白屏"没有区别。现在无论是路径为空还是图片异步加载失败/超时，
  // 都统一落到同一个 drawQrPlaceholder 兜底分支，保证卡片区域一定有内容
  // 🐛 二维码与下方引导文字重叠修复：qrSize 从 180 收缩到 160，腾出的空间
  // 用来满足下方三段文案要求的最小间距（QR→第一行 ≥16px 等），而不是继续
  // 压缩间距凑数；QR_TOP_PAD 与下方内容总高度一起，让整块"QR+三行文案"在
  // 卡片（cardY ~ cardY+cardH）内接近垂直居中，两端各留约 19px
  const qrSize = 160;
  const qrX = (width - qrSize) / 2;
  const QR_TOP_PAD = 19;
  const qrY = cardY + QR_TOP_PAD;
  const drawQrPlaceholder = () => {
    ctx.fillStyle = '#F1F3F5';
    safeRoundRect(ctx, qrX, qrY, qrSize, qrSize, 12);
    ctx.fill();
    ctx.fillStyle = '#ADB5BD';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('二维码生成中', qrX + qrSize / 2, qrY + qrSize / 2 - 8);
    ctx.fillText('请稍后重试', qrX + qrSize / 2, qrY + qrSize / 2 + 14);
  };

  if (qrCodeTempPath) {
    try {
      const qrImage = canvas.createImage();
      qrImage.src = qrCodeTempPath;
      // 🛡️ onload/onerror 在个别环境下可能都不触发（例如临时文件已被系统清理），
      // 不加超时会导致整个海报绘制流程永久挂起，外层 wx.showLoading 转圈转到
      // 天荒地老——3s 后仍未回调则视为加载失败，走占位分支
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('qr load timeout')), 3000);
        qrImage.onload = () => {
          clearTimeout(timer);
          resolve();
        };
        qrImage.onerror = () => {
          clearTimeout(timer);
          reject(new Error('qr load failed'));
        };
      });
      safeRoundRect(ctx, qrX, qrY, qrSize, qrSize, 12);
      ctx.save();
      ctx.clip();
      ctx.drawImage(qrImage, qrX, qrY, qrSize, qrSize);
      ctx.restore();
    } catch (e) {
      console.warn('[drawPoster] 二维码加载失败，使用占位:', e);
      drawQrPlaceholder();
    }
  } else {
    drawQrPlaceholder();
  }

  // 🐛 重叠根因：这三行文案此前都是相对 cardY 的硬编码偏移量（+218/+240/+250），
  // 跟 qrY/qrSize 完全脱节——一旦 qrSize 调整，偏移量不会跟着变，QR 底部和
  // 第一行文字之间的实际间距就会跟着漂移，真机上多次出现文字贴着/压在二维码
  // 图片下沿的问题。现在改成每一行的坐标都从上一行的视觉底部 + 具体 marginGap
  // 常量累加算出来，qrY/qrSize 之后再怎么调整，这条链路都会自动跟着重新算，
  // 不会再出现"改了尺寸忘了改偏移量"导致的重叠。
  //
  // fillText 用的是文字基线（baseline）坐标，不是视觉顶部——这里用
  // "字号 × 0.8" 近似基线相对行顶的位置、"字号 × 0.25" 近似基线以下的
  // 下伸部分（descender），不追求排版软件级别的精确度量，只保证按此推算出的
  // "视觉底部"不会比实际渲染更靠上，从而让间距计算始终是保守值（宁可间距
  // 略大，不会出现按公式算完实际却仍然重叠的情况）。
  const qrBottom = qrY + qrSize; // qrCodeY + qrCodeSize

  const GAP_QR_TO_LINE1 = 16; // 用户要求：QR 底部 → 第一行文字 ≥16~20px
  const LINE1_FONT_SIZE = 14;
  const line1BaselineY = qrBottom + GAP_QR_TO_LINE1 + LINE1_FONT_SIZE * 0.8;
  const line1BottomY = line1BaselineY + LINE1_FONT_SIZE * 0.25;

  ctx.fillStyle = '#495057';
  ctx.font = `${LINE1_FONT_SIZE}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('📱 微信长按或扫描二维码', width / 2, line1BaselineY);

  // 🎨 底部引导文案重构：原先"申请成为【财务记账义工】或【现场奉献家人】"
  // 长句改为"主标题 + 两个身份胶囊标签"的对称结构，字号统一 14px 加粗，
  // 与卡片左右两侧的黄色描边（cardX ~ cardX+cardW）之间强制留够 ≥16px 安全
  // 边距，胶囊底部与卡片底边（cardY+cardH）之间也留出清晰间隙，不贴边框。
  const GAP_LINE1_TO_TITLE = 8;
  const TITLE_FONT_SIZE = 14;
  const titleBaselineY = line1BottomY + GAP_LINE1_TO_TITLE + TITLE_FONT_SIZE * 0.8;
  const titleBottomY = titleBaselineY + TITLE_FONT_SIZE * 0.25;

  ctx.fillStyle = '#D9480E';
  ctx.font = `bold ${TITLE_FONT_SIZE}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('扫码加入 · 共同护持爱心食堂', width / 2, titleBaselineY);

  // 身份胶囊标签：财务记账义工（金色系）/ 现场服务家人（绿色系），配色区分
  // 两种身份，一眼可辨；宽度按 ctx.measureText 实测文字宽度动态算，不是拍脑袋
  // 硬编码固定像素——避免字体渲染差异导致文字溢出胶囊边缘
  const GAP_TITLE_TO_BADGE = 10;
  const badgeFontSize = 14;
  const badgePaddingX = 10;
  const badgeGap = 10;
  const badgeHeight = 20;
  const badgeTopY = titleBottomY + GAP_TITLE_TO_BADGE;

  ctx.font = `bold ${badgeFontSize}px sans-serif`;
  const financeLabel = '财务记账义工';
  const familyLabel = '现场服务家人';
  const financeBadgeWidth = ctx.measureText(financeLabel).width + badgePaddingX * 2;
  const familyBadgeWidth = ctx.measureText(familyLabel).width + badgePaddingX * 2;
  const badgeGroupWidth = financeBadgeWidth + badgeGap + familyBadgeWidth;
  // 🛡️ 左右两端安全边距强制 ≥16px：默认居中，但当胶囊组宽度逼近/超出卡片
  // 内容安全区（cardX+16 ~ cardX+cardW-16）时，先夹住左边界，再用右边界兜底
  // 收回——两条约束都满足不了的极端场景（字体渲染异常放大等）才会退化为
  // 贴着右边界 16px，不会整段跑出卡片黄色描边之外
  const safeLeftX = cardX + 16;
  const safeRightX = cardX + cardW - 16;
  let badgeGroupStartX = width / 2 - badgeGroupWidth / 2;
  if (badgeGroupStartX < safeLeftX) badgeGroupStartX = safeLeftX;
  if (badgeGroupStartX + badgeGroupWidth > safeRightX) badgeGroupStartX = safeRightX - badgeGroupWidth;

  ctx.textBaseline = 'middle';

  safeRoundRect(ctx, badgeGroupStartX, badgeTopY, financeBadgeWidth, badgeHeight, badgeHeight / 2);
  ctx.fillStyle = '#FFF3BF';
  ctx.fill();
  ctx.fillStyle = '#D9480E';
  ctx.textAlign = 'center';
  ctx.fillText(financeLabel, badgeGroupStartX + financeBadgeWidth / 2, badgeTopY + badgeHeight / 2);

  const familyBadgeX = badgeGroupStartX + financeBadgeWidth + badgeGap;
  safeRoundRect(ctx, familyBadgeX, badgeTopY, familyBadgeWidth, badgeHeight, badgeHeight / 2);
  ctx.fillStyle = '#E6F4EA';
  ctx.fill();
  ctx.fillStyle = '#2F9E44';
  ctx.fillText(familyLabel, familyBadgeX + familyBadgeWidth / 2, badgeTopY + badgeHeight / 2);

  // 🐛 还原默认 textBaseline：下方 introY（地址/简介）与底部版权行都依赖
  // canvas 默认的 'alphabetic' 基线定位，遗留 'middle' 会让那几行文字整体
  // 向上偏移，错位到看起来"悬浮"在预期位置上方
  ctx.textBaseline = 'alphabetic';

  // 5.5 门店简介/地址：仅在调用方提供时才绘制，未提供时版式与升级前完全一致
  // （原有 index.ts 调用点不传这两个字段，不受影响）。绘制区固定卡片正下方，
  // 调用方若传了这两个字段，需要相应把 height 调高留出空间，避免和底部版权撞在一起
  let introY = cardY + cardH + 34;
  if (opts.address) {
    ctx.fillStyle = '#666666';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`📍 ${opts.address}`, width / 2, introY);
    introY += 22;
  }
  if (opts.intro) {
    ctx.fillStyle = '#8C6D46';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(opts.intro, width / 2, introY);
  }

  // 6. 底部版权
  ctx.fillStyle = '#8C6D46';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('—  雨花斋餐报助手 · 让爱心收支 100% 公开透明  —', width / 2, height - 24);

  // 对应函数开头的外层圆角裁剪 save/clip
  ctx.restore();
}
