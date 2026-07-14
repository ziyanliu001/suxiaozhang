/**
 * 绘制高颜值雨花斋门店邀请海报 (Canvas 2D)
 */
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
}

export async function drawStoreInvitationPoster(opts: DrawPosterOptions): Promise<void> {
  const { canvas, storeName, sponsorInfo, qrCodeTempPath, width, height } = opts;
  const ctx = canvas.getContext('2d');
  const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2) || 2;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

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
  ctx.fillText('❤️ 恭敬生命 · 敬老行善', width / 2, 55);

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

  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(cardX, cardY, cardW, cardH, 16);
  } else {
    ctx.rect(cardX, cardY, cardW, cardH);
  }
  ctx.fill();
  ctx.stroke();

  // 5. 绘制小程序码
  if (qrCodeTempPath) {
    try {
      const qrImage = canvas.createImage();
      qrImage.src = qrCodeTempPath;
      await new Promise<void>((resolve, reject) => {
        qrImage.onload = () => resolve();
        qrImage.onerror = () => reject(new Error('qr load failed'));
      });
      const qrSize = 180;
      ctx.drawImage(qrImage, (width - qrSize) / 2, cardY + 30, qrSize, qrSize);
    } catch (e) {
      console.warn('[drawPoster] 二维码加载失败，使用占位:', e);
      ctx.fillStyle = '#E9ECEF';
      ctx.fillRect((width - 180) / 2, cardY + 30, 180, 180);
    }
  }

  ctx.fillStyle = '#495057';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('📱 微信长按或扫描二维码', width / 2, cardY + 235);

  ctx.fillStyle = '#D9480E';
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText('申请成为【财务记账义工】或【现场奉献家人】', width / 2, cardY + 258);

  // 6. 底部版权
  ctx.fillStyle = '#8C6D46';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('—  雨花斋餐报助手 · 让爱心收支 100% 公开透明  —', width / 2, height - 24);
}
