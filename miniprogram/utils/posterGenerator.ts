import { maskName } from './privacy';
import { FAMILY_STYLE, GRATITUDE_TEXT } from './cultureData';
import { drawStaticWxacodeFallback } from './staticWxacode';
import { computeHonorProgress, drawMedalBadge } from './honorLevels';

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
  // 🔗 门店日志联动：与首页「今日大事记」编辑区同一份数据，见 index.ts fetchTodayActivity。
  // 海报只画文字摘要，不画照片缩图（画照片需要一整套异步加载+动态重算高度的机制，
  // 风险与工作量都明显更大，不在这次范围内）
  activityText?: string;
  volunteerCount?: number;
  volunteerHours?: number;
  // 🆕 验真二维码本地临时路径（getStoreQRCode 下载后的 wxfile:// 路径）：
  // 有值时画真实可扫码的小程序码，未提供/生成失败时优雅降级为占位框
  verifyQrLocalPath?: string;
  // 🌸 可选落款：雨花家风「仁·中·和」与感恩词，仅财务公示版（drawMeritPoster）支持，
  // 未开启时版式与升级前完全一致，见 drawMeritPoster 内 showFamilyStyleFooter/
  // showGratitudeFooter 分支
  showFamilyStyleFooter?: boolean;
  showGratitudeFooter?: boolean;
  // 🏛️ 可选落款：护持家长（对外关系与文化督导）+ 日常店长（记账执行），体现雨花斋
  // 人文双署名文化，均未绑定或未开启 showPeopleSignature 时版式与升级前完全一致
  patriarchName?: string;
  managerName?: string;
  showPeopleSignature?: boolean;
}

// 🆕 9:16 竖屏「温馨故事版」海报数据：只收调用方已经准备好的展示值（与 PosterData
// 同一个设计原则——posterGenerator.ts 不负责去猜"爱心菜单款数该怎么算"这类业务口径，
// 由 index.ts 在调用处按真实数据拼好再传进来）
export interface StoryPosterData {
  shopName: string;
  dateString: string;
  // 门店日志首图（activityImages[0].url）：cloud:// fileID 或 https 直链均可，
  // 下载失败或未提供时优雅降级为无图版式，不阻断海报生成
  heroImageUrl?: string;
  storyText?: string;
  diningCount?: number;
  menuItemCount?: number;
  // 🆕 验真二维码本地临时路径，语义与 PosterData.verifyQrLocalPath 一致
  verifyQrLocalPath?: string;
}

// 🆕 志愿者爱心荣誉卡：与前两张海报同一套"调用方按真实数据拼好再传入"设计原则，
// posterGenerator.ts 不查库、不算业务口径，reportCount/diningCount 由调用方
// 通过 getVolunteerHonorStats 云函数按 _openid 查出真实累计值再传入，不在这里编造
export interface VolunteerHonorData {
  storeName: string;
  nickName: string;
  // 志愿者头像：cloud:// fileID / https 直链 / 本地临时路径均可，与 heroImageUrl 同款
  // 下载兜底逻辑（resolveHeroImageLocalPath），未提供或下载失败时降级为占位圆图标
  avatarUrl?: string;
  serviceDays: number;
  reportCount: number;
  diningCount: number;
  // 🆕 累计护持工时：用于按 utils/honorLevels.ts 的等级门槛现算成就徽章
  // （初心行者/爱心学习者/……），未提供时按 0 小时处理，退化为最低一级的灰色徽章
  totalHours?: number;
  // 邀请二维码本地临时路径（getStoreQRCode 默认用途，非 purpose:'verify'），
  // 语义与 verifyQrLocalPath 一致：有值画真图，未提供/失败时降级为占位框
  qrLocalPath?: string;
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
// 🐛 物资明细文字重叠根因：物资行原先用"姓名+物资"单行 fillText 拼接，没有任何换行/宽度
// 夹取，姓名或物资描述稍长（如"张三：赞助进口东北五常大米50斤"）就会整行超出画布右边缘，
// 且 calculateCanvasHeight 预估高度时按"每条物资固定 1 行"计算，一旦某条实际换行成 2 行，
// 后面"义工感恩奉献"等区块的起绘 Y 坐标就会算少，视觉上与物资区最后一行文字重叠。
// 现改为按 formatMaterialsToText 同款单行文案 + drawMultiLineText 真实换行绘制，
// 高度预估也同步按保守字数换算行数（与 activityLineCount 同一套估算口径），
// 两处口径一致就不会再出现"预估矮了、绘制时压线"的问题
const MATERIALS_CHARS_PER_LINE = 20;
const VOLUNTEER_TITLE_HEIGHT = 40;
const VOLUNTEER_ROW_HEIGHT = 26;
const MATERIALS_ROW_HEIGHT = 22;
const ACTIVITY_TITLE_HEIGHT = 40;
const ACTIVITY_LINE_HEIGHT = 20;
const ACTIVITY_MAX_LINES = 6;
// 保守估字数（用于建高度预估的上界，不小于 drawMultiLineText 实际逐字符换行的行数）
const ACTIVITY_CHARS_PER_LINE = 20;
const ACTIVITY_MAX_CHARS = ACTIVITY_MAX_LINES * ACTIVITY_CHARS_PER_LINE;
const TWO_COLUMN_THRESHOLD = 50;
const FOOTER_TOP_MARGIN = 24;
const FOOTER_LINE_HEIGHT = 20;
const FOOTER_HEIGHT = 90;
// 🆕 右下角「扫码验真」区域：真实小程序码已接入（见 drawVerifyQRArea，
// index.ts resolveVerifyQrLocalPath 调 getStoreQRCode 云函数 purpose:'verify'
// 生成指向 pages/public-verify/index 的码），生成/下载失败时才降级画占位框
const VERIFY_QR_SIZE = 120;
const VERIFY_AREA_HEIGHT = 170;

// 🌸 可选落款（雨花家风/感恩词）：紧凑行高，字号比常规落款更小，突出"轻量点缀"而非主体内容
const CULTURE_FOOTER_LINE_HEIGHT = 16;
// 保守估字数（用于建高度预估的上界，口径同 ACTIVITY_CHARS_PER_LINE：字号更小、
// 实际每行能容纳更多字，这里刻意估少一点，确保预估高度不小于真实绘制高度）
const CULTURE_GRATITUDE_CHARS_PER_LINE = 18;

// 🆕 温馨故事版 (9:16) 专属尺寸：宽度沿用与财务公示版相同的 375（复用同一个
// #posterCanvas 节点，不用在 wxml 里再加一个 canvas），高度按 16:9 换算取整，
// 与请求方给出的"例如 750x1334px"最终导出分辨率一致（375×2 / 667×2 = 750×1334）
const STORY_CANVAS_WIDTH = 375;
const STORY_CANVAS_HEIGHT = 667;
const STORY_HERO_HEIGHT = 260;
const STORY_HERO_RADIUS = 16;
const STORY_MAX_STORY_CHARS = 60;
const STORY_LINE_HEIGHT = 26;
const STORY_QR_SIZE = 70;

// 🆕 志愿者爱心荣誉卡专属尺寸：宽度沿用同一个 375（复用同一个 #posterCanvas 节点），
// 高度取 600（375×2 / 600×2 = 750×1200，社交卡片常见的 2:3 竖屏比例）
const HONOR_CANVAS_WIDTH = 375;
const HONOR_CANVAS_HEIGHT = 600;
const HONOR_AVATAR_RADIUS = 44;
const HONOR_QR_SIZE = 70;
// 🐛 圆角裁剪问题：journey.wxml 预览用的 <image class="honor-card-image"> 靠 CSS
// border-radius 伪装圆角，但 wx.saveImageToPhotosAlbum 保存的是 canvas 导出的原始
// 像素——CSS 圆角不会写进图片文件，保存/转发到微信外部时四角其实是直角，与预览
// 观感不一致。改为在画布层面真正 clip 出圆角矩形，导出的 PNG 本身四角透明镂空
const HONOR_CARD_RADIUS = 24;

const SINGLE_COL_NAME_MAX = 200;
const DOUBLE_COL_NAME_MAX = 110;
const ELLIPSIS = '...';

function calculateCanvasHeight(itemCount: number, materialsLineCount: number = 0, hasVolunteer: boolean = false, activityLineCount: number = 0, cultureFooterHeight: number = 0): number {
  const useTwoColumns = itemCount > TWO_COLUMN_THRESHOLD;
  const itemsPerColumn = useTwoColumns ? Math.ceil(itemCount / 2) : itemCount;
  const listContentHeight = itemsPerColumn * ITEM_ROW_HEIGHT;

  // 🔗 materialsLineCount 是"预估总行数"（每条物资按字数换算可能占 1~N 行），
  // 不再是"物资条数"，与下方 drawMeritPoster 里真实 drawMultiLineText 换行的行数口径一致
  const materialsHeight = materialsLineCount > 0
    ? MATERIALS_TITLE_HEIGHT + materialsLineCount * MATERIALS_ROW_HEIGHT + 20
    : 0;

  const volunteerHeight = hasVolunteer
    ? VOLUNTEER_TITLE_HEIGHT + 2 * VOLUNTEER_ROW_HEIGHT + 20
    : 0;

  // 🔗 门店日志联动：activityLineCount 是按保守字数估出的行数上界，
  // 实际绘制用 drawMultiLineText 精确换行，行数只会更少不会更多
  const activityHeight = activityLineCount > 0
    ? ACTIVITY_TITLE_HEIGHT + activityLineCount * ACTIVITY_LINE_HEIGHT + 20
    : 0;

  const totalHeight = CARD_TOP + CARD_HEIGHT + 35 + materialsHeight + volunteerHeight + activityHeight + LIST_TITLE_HEIGHT + listContentHeight + FOOTER_TOP_MARGIN + FOOTER_HEIGHT + cultureFooterHeight + VERIFY_AREA_HEIGHT + 40;

  return Math.max(totalHeight, 667);
}

// 🆕 「扫码验真」占位框：财务公示版 (drawMeritPoster) 与温馨故事版 (drawStoryPoster)
// 共用同一份绘制逻辑，避免两处各画一份、日后样式改一处漏一处。真实小程序码已通过
// drawVerifyQRArea 接入（见下方），本函数只在没拿到真实二维码本地路径/绘制失败时
// 才被调用，画简约占位框（QR 图标三角块 + 双行提示文字）兜底。
// 🐛 修复"验真二维码文字右侧溢出截断"：此前文字锚点固定在 QR 图标自身的中心
// （x + size/2），隐含假设"文字必然比图标窄"——财务公示版的图标较大（120px）+
// 提示文案较短，凑巧成立；温馨故事版图标更小（70px）+ 提示文案更长（多了"此报表"
// 三字），文字实际渲染宽度远超图标宽度，居中锚点又贴近画布右边缘，右侧直接被
// 画布边界截断。改成用 ctx.measureText 量出文字真实宽度，把锚点 x 夹在
// [安全边距, 画布宽度-安全边距] 之间，不再假设文字一定比图标窄，两个海报共用
// 这一份逻辑就不会有任何一处溢出。
function clampTextCenterX(idealCenterX: number, textWidth: number, canvasWidth: number, marginX: number): number {
  const halfWidth = textWidth / 2;
  const minCenter = marginX + halfWidth;
  const maxCenter = canvasWidth - marginX - halfWidth;
  if (minCenter > maxCenter) return canvasWidth / 2; // 文字比整个安全区还宽，退而居中于整张画布
  return Math.min(Math.max(idealCenterX, minCenter), maxCenter);
}

// 二维码下方的标题 + 提示文案：占位框和真实二维码图片共用同一份，避免两处各写一份
// 文字锚点/夹取逻辑，日后调整只改一处。title 默认"微信扫码验真"（财务公示版/故事版
// 两处既有调用不用改），志愿者荣誉卡的邀请二维码不是"验真"用途，传自己的标题即可
function drawVerifyCaptionText(ctx: any, x: number, y: number, size: number, caption: string, canvasWidth: number, title: string = '微信扫码验真'): void {
  const marginX = 20;
  const idealCenterX = x + size / 2;

  ctx.fillStyle = '#999999';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  const titleWidth = ctx.measureText(title).width;
  ctx.fillText(title, clampTextCenterX(idealCenterX, titleWidth, canvasWidth, marginX), y + size + 18);

  ctx.fillStyle = '#B0B0B0';
  ctx.font = '9px sans-serif';
  const captionWidth = ctx.measureText(caption).width;
  ctx.fillText(caption, clampTextCenterX(idealCenterX, captionWidth, canvasWidth, marginX), y + size + 34);
}

function drawVerifyQRPlaceholder(ctx: any, x: number, y: number, size: number, caption: string, canvasWidth: number, title?: string): void {
  ctx.fillStyle = '#FAFAFA';
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = BORDER_COLOR;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, size, size);

  ctx.strokeStyle = '#B0B0B0';
  ctx.lineWidth = 1.5;
  const markSize = size * 0.22;
  const markPad = size * 0.14;
  const markCorners: Array<[number, number]> = [
    [x + markPad, y + markPad],
    [x + size - markPad - markSize, y + markPad],
    [x + markPad, y + size - markPad - markSize]
  ];
  markCorners.forEach(([mx, my]) => {
    ctx.strokeRect(mx, my, markSize, markSize);
  });

  drawVerifyCaptionText(ctx, x, y, size, caption, canvasWidth, title);
}

// 🆕 二维码区域：有真实小程序码本地路径时画可扫码的真图，加载/绘制失败
// （文件损坏、canvas 节点异常等）时降级为随包打包的官方静态小程序码兜底
// （utils/staticWxacode.ts）——绝不能因为二维码画失败就让整张海报生成中断，
// 也不再用本地 QR 编码算法现画一张只能编码纯文本/通用链接的码：那种码微信
// 扫一扫客户端会直接拦下提示"暂不支持展示二维码中的文本内容"，等于没有码，
// 反而比诚实的占位提示更容易让用户以为自己手机有问题。静态官方码的代价是
// 没有 scene 场景值（无法精确指向具体的验真页/邀请页，统一进小程序默认首页），
// 但至少 100% 能扫码拉起小程序。title 默认"微信扫码验真"，志愿者荣誉卡的邀请
// 二维码传自己的标题（见 drawVolunteerHonorCard），同一份绘制/降级逻辑两种用途共用
async function drawVerifyQRArea(ctx: any, canvas: any, x: number, y: number, size: number, caption: string, canvasWidth: number, qrLocalPath?: string, title?: string): Promise<void> {
  if (qrLocalPath) {
    try {
      const img = await loadImageOntoCanvasNode(canvas, qrLocalPath);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(x, y, size, size);
      ctx.drawImage(img, x, y, size, size);
      ctx.strokeStyle = BORDER_COLOR;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, size, size);
      drawVerifyCaptionText(ctx, x, y, size, caption, canvasWidth, title);
      return;
    } catch (err) {
      console.warn('[drawVerifyQRArea] 真实二维码绘制失败，将改用官方静态小程序码兜底:', err);
    }
  }

  try {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x, y, size, size);
    await drawStaticWxacodeFallback(ctx, canvas, x, y, size);
    ctx.strokeStyle = BORDER_COLOR;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, size, size);
    drawVerifyCaptionText(ctx, x, y, size, caption, canvasWidth, title);
  } catch (err) {
    console.warn('[drawVerifyQRArea] 静态小程序码兜底加载异常，降级为占位框:', err);
    drawVerifyQRPlaceholder(ctx, x, y, size, caption, canvasWidth, title);
  }
}

// 🆕 圆角矩形路径：只画路径，不 fill/stroke/clip，由调用方决定怎么用这个路径
// （drawStoryPoster 里同一个圆角矩形既要"先填充画阴影垫板"又要"再裁剪画图片"，
// 分成路径函数 + 调用方自行 fill/clip 两步，避免复制一份圆角画法两次）
function drawRoundedRectPath(ctx: any, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 🆕 按 aspectFill 语义把图片居中裁剪绘制进目标矩形，避免像 <image> 缺省行为
// （直接拉伸铺满）那样把非目标宽高比的照片画变形——与 archive-modal.ts _drawAvatar
// 修过的同一类问题保持同一套解法
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
        const materialsList = data.materials || [];
        // 🐛 与实际绘制口径对齐：formatMaterialsToText 同款单行文案的字符数换算行数，
        // 保守估计（向上取整），确保预估高度不小于真实绘制高度
        const materialsLineCount = materialsList.reduce((sum, m) => {
          const text = `${maskName(m.donor || '匿名爱心人士')}：赞助 ${m.item || ''} ${m.quantity || ''}${m.unit || ''}`;
          return sum + Math.max(1, Math.ceil(text.length / MATERIALS_CHARS_PER_LINE));
        }, 0);
        const hasVolunteer = (data.volunteerCount && data.volunteerCount > 0) || (data.volunteerHours && data.volunteerHours > 0);
        const useTwoColumns = itemCount > TWO_COLUMN_THRESHOLD;
        const itemsPerColumn = useTwoColumns ? Math.ceil(itemCount / 2) : itemCount;

        // 🔗 门店日志联动：截到最多约 ACTIVITY_MAX_LINES 行的字符量，避免海报被拉得
        // 过长；餐报文本（reportGenerator.ts）走全文，不做这个截断
        const rawActivityText = (data.activityText || '').trim();
        const activityText = rawActivityText.length > ACTIVITY_MAX_CHARS
          ? rawActivityText.slice(0, ACTIVITY_MAX_CHARS) + ELLIPSIS
          : rawActivityText;
        const activityLineCount = activityText ? Math.ceil(activityText.length / ACTIVITY_CHARS_PER_LINE) : 0;

        // 🌸 可选落款：雨花家风「仁·中·和」（固定 1 行）+ 感恩词（拼接全文后按保守
        // 字数估算换行数，与 activityLineCount 同一套"上界估算，真实绘制只会更矮"口径）
        const showFamilyStyleFooter = !!data.showFamilyStyleFooter;
        const showGratitudeFooter = !!data.showGratitudeFooter;
        const gratitudeJoined = showGratitudeFooter ? GRATITUDE_TEXT.join('') : '';
        const gratitudeLineCount = gratitudeJoined ? Math.ceil(gratitudeJoined.length / CULTURE_GRATITUDE_CHARS_PER_LINE) : 0;
        const familyStyleLineCount = showFamilyStyleFooter ? 1 : 0;
        // 🏛️ 护持家长/日常店长落款：固定 1 行，仅在开关打开且至少一个姓名非空时才占用高度
        const showPeopleSignature = !!data.showPeopleSignature && !!((data.patriarchName || '').trim() || (data.managerName || '').trim());
        const peopleSignatureLineCount = showPeopleSignature ? 1 : 0;
        const cultureFooterHeight = (showFamilyStyleFooter || showGratitudeFooter || showPeopleSignature)
          ? 14 + familyStyleLineCount * CULTURE_FOOTER_LINE_HEIGHT + gratitudeLineCount * CULTURE_FOOTER_LINE_HEIGHT + peopleSignatureLineCount * CULTURE_FOOTER_LINE_HEIGHT
          : 0;

        const height = calculateCanvasHeight(itemCount, materialsLineCount, hasVolunteer, activityLineCount, cultureFooterHeight);

        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.scale(dpr, dpr);

        (async () => {
        try {
          // 🐛 圆角裁剪：与 drawVolunteerHonorCard 同一处根因——预览层 .poster-canvas
          // 靠 CSS border-radius 伪装圆角，wx.saveImageToPhotosAlbum/转发保存的却是
          // canvas 导出的原始像素，四角其实是直角。这里在整张海报最外层先 clip 成
          // 圆角矩形，之后所有绘制都天然被裁在圆角范围内
          ctx.save();
          drawRoundedRectPath(ctx, 0, 0, width, height, HONOR_CARD_RADIUS);
          ctx.clip();

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

            // 🐛 修复"物资明细文字重叠/溢出"：原先姓名+物资拼在同一行 fillText，
            // 没有换行/宽度夹取，姓名或物资描述稍长就整行冲出画布右边缘；
            // 现改为 formatMaterialsToText 同款单行文案 + drawMultiLineText 真实换行，
            // 返回值即为下一行起始 Y，与上方 materialsLineCount 高度预估口径一致
            let matY = materialsTitleY + 28;
            ctx.fillStyle = '#B8860B';
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'left';
            data.materials.forEach((m) => {
              const rowText = `• ${maskName(m.donor || '匿名爱心人士')}：赞助 ${m.item || ''} ${m.quantity || ''}${m.unit || ''}`;
              matY = drawMultiLineText(ctx, rowText, 35, matY, width - 70, MATERIALS_ROW_HEIGHT);
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

          // 🔗 今日门店日志：与首页「今日大事记」编辑区同一份数据，仅文字摘要，不画照片
          let activityEndY = volunteerEndY;
          if (activityText) {
            const activityTitleY = volunteerEndY + 10;
            ctx.fillStyle = PRIMARY_COLOR;
            ctx.font = 'bold 16px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('📌 今日门店日志', width / 2, activityTitleY);

            ctx.lineWidth = 1;
            ctx.strokeStyle = '#E8E4DC';
            ctx.beginPath();
            ctx.moveTo(35, activityTitleY + 10);
            ctx.lineTo(width - 35, activityTitleY + 10);
            ctx.stroke();

            ctx.fillStyle = TEXT_COLOR;
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'left';
            const afterActivityY = drawMultiLineText(ctx, activityText, 35, activityTitleY + 28, width - 70, ACTIVITY_LINE_HEIGHT);
            activityEndY = afterActivityY + 8;
          }

          const listTitleY = activityEndY;
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
              const truncatedName = truncateText(ctx, maskName(item.name), Math.max(nameMaxWidth, 20));
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
              const truncatedName = truncateText(ctx, maskName(item.name), Math.max(nameMaxWidth, 20));
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
          
          const thanksLine1 = '❤️ 感谢各位爱心人士的鼎力支持';
          const thanksLine2 = '感恩默默付出的义工团队';
          
          ctx.fillText(thanksLine1, width / 2, footerTop + FOOTER_LINE_HEIGHT + 6);
          ctx.fillText(thanksLine2, width / 2, footerTop + FOOTER_LINE_HEIGHT * 2 + 16);

          ctx.fillStyle = '#B0B0B0';
          ctx.font = '9px sans-serif';
          ctx.fillText('本平台仅用于爱心餐报与志愿服务记录，不直接面向公众发起公开募捐', width / 2, footerTop + FOOTER_LINE_HEIGHT * 3 + 20);

          ctx.fillStyle = COPYRIGHT_COLOR;
          ctx.font = '11px sans-serif';
          ctx.fillText('素小账', width / 2, footerTop + FOOTER_LINE_HEIGHT * 4 + 20);

          // 🌸 可选落款：雨花家风「仁·中·和」+ 感恩词 + 护持家长/日常店长署名，
          // 未开启任何一项时版式与升级前完全一致
          if (showFamilyStyleFooter || showGratitudeFooter || showPeopleSignature) {
            let cultureY = footerTop + FOOTER_LINE_HEIGHT * 4 + 20 + 18;

            ctx.strokeStyle = '#EDE0C8';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(70, cultureY - 12);
            ctx.lineTo(width - 70, cultureY - 12);
            ctx.stroke();

            if (showFamilyStyleFooter) {
              ctx.fillStyle = PRIMARY_COLOR;
              ctx.font = 'bold 12px sans-serif';
              ctx.textAlign = 'center';
              ctx.fillText(`${FAMILY_STYLE.title}：${FAMILY_STYLE.text}`, width / 2, cultureY);
              cultureY += CULTURE_FOOTER_LINE_HEIGHT;
            }

            if (showGratitudeFooter && gratitudeJoined) {
              ctx.fillStyle = '#8C6D46';
              ctx.font = '11px sans-serif';
              ctx.textAlign = 'center';
              cultureY = drawMultiLineText(ctx, gratitudeJoined, width / 2, cultureY, width - 80, CULTURE_FOOTER_LINE_HEIGHT);
            }

            if (showPeopleSignature) {
              const patriarchName = (data.patriarchName || '').trim();
              const managerName = (data.managerName || '').trim();
              const parts: string[] = [];
              if (patriarchName) parts.push(`护持家长：${patriarchName}`);
              if (managerName) parts.push(`日常店长：${managerName}`);
              ctx.fillStyle = SECONDARY_COLOR;
              ctx.font = '11px sans-serif';
              ctx.textAlign = 'center';
              ctx.fillText(parts.join('　'), width / 2, cultureY);
              cultureY += CULTURE_FOOTER_LINE_HEIGHT;
            }
          }

          // 🆕 右下角扫码验真区域（共用 drawVerifyQRPlaceholder，见函数顶部注释）
          const qrAreaTop = footerTop + FOOTER_HEIGHT + cultureFooterHeight;
          const qrSize = VERIFY_QR_SIZE;
          // 整体向左留出 30px 右边距（原 20px），配合 drawVerifyQRPlaceholder 内部的
          // 文字宽度夹取，双重保证不再有任何溢出
          const qrX = width - 30 - qrSize;
          const qrY = qrAreaTop;
          await drawVerifyQRArea(ctx, canvas, qrX, qrY, qrSize, '微信扫码·查看原始发票凭证', width, data.verifyQrLocalPath);

          ctx.restore(); // 对应开头的圆角裁剪 save/clip

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
        })();
      });
  });
}

// 门店日志首图下载：cloud:// fileID 用 wx.cloud.downloadFile，其余（https 直链等）
// 走通用的 wx.downloadFile 兜底。下载失败不抛错，返回 null 交给调用方优雅降级为
// 无图版式，不能因为一张配图挂了就让整张海报生成失败
function downloadHttpFile(url: string): Promise<string> {
  // wx.downloadFile 的类型定义是回调式（返回 DownloadTask 而非 Promise），
  // 与 wx.cloud.downloadFile 不同，这里手动包一层 Promise 保持调用方统一用 await
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: (res) => resolve(res.tempFilePath),
      fail: (err) => reject(err)
    });
  });
}

// 🆕 下载完成后再跑一遍微信原生 wx.compressImage：门店日志首图（菜品图/活动照片）
// 常常是手机实拍原图（几 MB），直接丢给 Canvas drawImage 只是不拉伸/不切边
// （drawImageCover 已保证），但没有解决"体积大、绘制慢、低端机型可能卡顿"的问题。
// 压缩失败（该 API 在极少数机型/基础库版本上不可用）不阻断海报生成，原图路径直接
// 兜底使用——与本文件其余"任一步失败都优雅降级"的一贯策略保持一致。
function compressHeroImage(localPath: string): Promise<string> {
  return new Promise((resolve) => {
    if (!wx.compressImage) {
      resolve(localPath);
      return;
    }
    wx.compressImage({
      src: localPath,
      quality: 80,
      success: (res) => resolve(res.tempFilePath || localPath),
      fail: (err) => {
        console.warn('[drawStoryPoster] wx.compressImage 压缩失败，使用原图:', err);
        resolve(localPath);
      }
    });
  });
}

async function resolveHeroImageLocalPath(url: string): Promise<string | null> {
  if (!url) return null;
  try {
    // 🛡️ activityImages 现在是纯字符串数组，压缩上传还没跑完的这一小段时间里
    // 存的是本机 tempFilePath（wxfile:// 或纯文件系统路径），既不是 cloud:// 也不是
    // http(s):// ——直接原样使用即可，不需要（也不能）再走一次网络下载，否则
    // wx.downloadFile 对着一个本地路径必然失败，白白多等一轮超时才降级
    const isRemote = url.indexOf('cloud://') === 0 || url.indexOf('http://') === 0 || url.indexOf('https://') === 0;
    if (!isRemote) {
      return await compressHeroImage(url);
    }
    const rawPath = url.indexOf('cloud://') === 0
      ? (await wx.cloud.downloadFile({ fileID: url })).tempFilePath
      : await downloadHttpFile(url);
    return await compressHeroImage(rawPath);
  } catch (err) {
    console.warn('[drawStoryPoster] 门店日志配图下载失败，降级为无图版式:', err);
    return null;
  }
}

function loadImageOntoCanvasNode(canvas: any, src: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const img = canvas.createImage();
    img.onload = () => resolve(img);
    img.onerror = (err: any) => reject(new Error('海报配图加载失败: ' + (err && err.errMsg)));
    img.src = src;
  });
}

/**
 * 9:16 竖屏「温馨故事版」海报：面向朋友圈/小红书传播场景，视觉优先于信息密度——
 * 大图 Hero + 一句话故事感言 + 极简摘要条，而不是财务公示版那种账目逐条罗列。
 * 与 drawMeritPoster 共用同一个 #posterCanvas 节点与 drawVerifyQRArea 验真区，
 * 画布宽度也保持一致（375），只是高度固定为 9:16，不像财务版那样按内容量动态算高度。
 */
export async function drawStoryPoster(pageInstance: any, data: StoryPosterData): Promise<string> {
  // 配图下载放在 query 画布节点之前：即使下载失败也不阻塞，只是退化为无图版式
  const heroLocalPath = await resolveHeroImageLocalPath(data.heroImageUrl || '');

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

        const width = STORY_CANVAS_WIDTH;
        const height = STORY_CANVAS_HEIGHT;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.scale(dpr, dpr);

        (async () => {
          try {
            // 🐛 圆角裁剪：与 drawMeritPoster/drawVolunteerHonorCard 同一处根因修复
            ctx.save();
            drawRoundedRectPath(ctx, 0, 0, width, height, HONOR_CARD_RADIUS);
            ctx.clip();

            // 暖色渐变底：与财务公示版的米白纸感刻意区分开，突出"温馨故事"调性
            const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
            bgGradient.addColorStop(0, '#FFF8F0');
            bgGradient.addColorStop(1, '#FFEFE0');
            ctx.fillStyle = bgGradient;
            ctx.fillRect(0, 0, width, height);

            // Header
            ctx.fillStyle = PRIMARY_COLOR;
            ctx.font = 'bold 20px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('素小账 · 今日爱心故事', width / 2, 46);

            ctx.fillStyle = SECONDARY_COLOR;
            ctx.font = '13px sans-serif';
            ctx.fillText(`${data.shopName || ''} · ${data.dateString || ''}`, width / 2, 70);

            let contentTop = 92;
            const heroX = 25;
            const heroWidth = width - 50;

            // 🐛 修复"中间大面积空白"：此前无配图时直接跳过整个 Hero 区域、
            // 无故事文字时也直接跳过 Story 区域，指望"文字会顺势往上补位"——但
            // 两者都没有时（或有图片 URL 但下载/绘制失败时），contentTop 从头到尾
            // 停在 92，一路到底部摘要条之间的几百像素全部是纯背景色，呈现为大面积
            // 留白。改成：Hero 区域永远画点什么（有图画图，没图/图画失败就画一张
            // 柔和文字卡片兜底）；Story 文字永远有内容可展示（没有真实门店日志文字
            // 时兜底显示温馨标语），两处都不再有"什么都不画"的分支。
            const rawStory = (data.storyText || '').trim();
            const DEFAULT_STORY_QUOTE = '用一餐饭的温度，传递温暖与关爱';
            let heroImageDrawn = false;

            if (heroLocalPath) {
              try {
                const img = await loadImageOntoCanvasNode(canvas, heroLocalPath);

                // 阴影背板与图片本体分两步画：canvas 的 shadow* 属性和 clip() 叠加使用
                // 在部分机型上表现不稳定，先画一个带阴影的圆角矩形垫底，再裁剪画真实图片，
                // 比"图片本身直接带阴影"更可靠（与本项目其余 canvas 绘制的既有教训一致）
                ctx.save();
                ctx.shadowColor = 'rgba(0,0,0,0.18)';
                ctx.shadowBlur = 16;
                ctx.shadowOffsetY = 8;
                ctx.fillStyle = '#FFFFFF';
                drawRoundedRectPath(ctx, heroX, contentTop, heroWidth, STORY_HERO_HEIGHT, STORY_HERO_RADIUS);
                ctx.fill();
                ctx.restore();

                ctx.save();
                drawRoundedRectPath(ctx, heroX, contentTop, heroWidth, STORY_HERO_HEIGHT, STORY_HERO_RADIUS);
                ctx.clip();
                drawImageCover(ctx, img, heroX, contentTop, heroWidth, STORY_HERO_HEIGHT);
                ctx.restore();

                heroImageDrawn = true;
              } catch (imgErr) {
                console.warn('[drawStoryPoster] Hero 图绘制失败，降级为纯文字卡片版式:', imgErr);
              }
            }

            // 优雅 Fallback：没有配图、或配图下载/绘制失败时，改画一张柔和文字卡片
            // 顶替 Hero 位置——展示真实门店日志文字（若有）或默认温馨标语，
            // 视觉上仍是一个完整的"卡片"，不是空白背景上飘着几个字
            if (!heroImageDrawn) {
              const cardText = rawStory || DEFAULT_STORY_QUOTE;
              const cardTextClamped = cardText.length > STORY_MAX_STORY_CHARS
                ? cardText.slice(0, STORY_MAX_STORY_CHARS) + ELLIPSIS
                : cardText;

              ctx.save();
              ctx.shadowColor = 'rgba(0,0,0,0.10)';
              ctx.shadowBlur = 12;
              ctx.shadowOffsetY = 6;
              ctx.fillStyle = '#FFFFFF';
              drawRoundedRectPath(ctx, heroX, contentTop, heroWidth, STORY_HERO_HEIGHT, STORY_HERO_RADIUS);
              ctx.fill();
              ctx.restore();

              ctx.fillStyle = PRIMARY_COLOR;
              ctx.font = '32px sans-serif';
              ctx.textAlign = 'center';
              ctx.fillText('🍚', width / 2, contentTop + 70);

              ctx.fillStyle = TEXT_COLOR;
              ctx.font = 'bold 16px sans-serif';
              drawMultiLineText(ctx, cardTextClamped, width / 2, contentTop + 112, heroWidth - 50, 24);
            }

            contentTop += STORY_HERO_HEIGHT + 24;

            // Story：门店日志文字感言，居中排版，超长截断（社交海报以视觉为主，
            // 不适合塞大段文字——与财务公示版的 activityText 全量展示定位不同）。
            // 仅在"配图成功绘制"时才画这一段——没配图时上面的文字卡片已经展示过
            // 同一份文字，不再重复画一遍。
            if (heroImageDrawn) {
              const storyToShow = rawStory || DEFAULT_STORY_QUOTE;
              const storyText = storyToShow.length > STORY_MAX_STORY_CHARS
                ? storyToShow.slice(0, STORY_MAX_STORY_CHARS) + ELLIPSIS
                : storyToShow;

              ctx.fillStyle = TEXT_COLOR;
              ctx.font = '15px sans-serif';
              ctx.textAlign = 'center';
              // drawMultiLineText 内部用 ctx.fillText(line, x, y)，x 语义随当前 textAlign
              // 变化——上面已设为 center，这里直接传中心点 x 即可复用同一份换行逻辑画出
              // 居中效果，不需要再写一份"居中版"的多行文字函数
              drawMultiLineText(ctx, storyText, width / 2, contentTop + 8, width - 60, STORY_LINE_HEIGHT);
            }

            // Summary pill：极简摘要条，固定贴在验真区上方
            const pillHeight = 44;
            const qrY = height - STORY_QR_SIZE - 44 - 10;
            const pillY = qrY - 16 - pillHeight;

            ctx.fillStyle = '#FFFFFF';
            drawRoundedRectPath(ctx, 25, pillY, width - 50, pillHeight, pillHeight / 2);
            ctx.fill();

            const diningPart = data.diningCount ? `今日服务餐次 ${data.diningCount} 人` : '';
            const menuPart = data.menuItemCount ? `爱心菜单 ${data.menuItemCount} 款` : '';
            const summaryText = [diningPart, menuPart].filter(Boolean).join('  |  ') || '感恩每一份用心付出';

            ctx.fillStyle = PRIMARY_COLOR;
            ctx.font = 'bold 13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(summaryText, width / 2, pillY + pillHeight / 2 + 5);

            // Footer：验真区（与财务公示版共用同一份占位绘制逻辑）。整体向左留出
            // 30px 右边距（原 20px）——这个海报图标更小（70px）、提示文案更长，
            // 原先的居中锚点贴着画布右边缘，文字右侧会被截断，配合
            // drawVerifyQRPlaceholder 内部的文字宽度夹取，双重保证不再溢出
            const qrX = width - 30 - STORY_QR_SIZE;
            await drawVerifyQRArea(ctx, canvas, qrX, qrY, STORY_QR_SIZE, '微信扫码·查看此报表原始发票凭证', width, data.verifyQrLocalPath);

            ctx.restore(); // 对应开头的圆角裁剪 save/clip

            wx.canvasToTempFilePath({
              canvas,
              x: 0,
              y: 0,
              width: width * dpr,
              height: height * dpr,
              destWidth: width * dpr * 2,
              destHeight: height * dpr * 2,
              fileType: 'png',
              quality: 1,
              success: (tempRes) => resolve(tempRes.tempFilePath),
              fail: (err: any) => reject(new Error('Canvas 转图片失败: ' + err.errMsg))
            });
          } catch (drawErr) {
            reject(drawErr);
          }
        })();
      });
  });
}

// 🆕 圆形头像绘制：与 archive-modal.ts _drawAvatar 同一套"圆形裁剪 + aspectFill 填充"
// 手法，头像下载/加载失败时（或压根没提供）降级画一个暖色占位圆 + 🌸 图标，绝不
// 让整张荣誉卡因为一张头像挂了而生成失败
async function drawCircularAvatar(ctx: any, canvas: any, avatarLocalPath: string | null, cx: number, cy: number, radius: number): Promise<void> {
  if (avatarLocalPath) {
    try {
      const img = await loadImageOntoCanvasNode(canvas, avatarLocalPath);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      drawImageCover(ctx, img, cx - radius, cy - radius, radius * 2, radius * 2);
      ctx.restore();
      return;
    } catch (err) {
      console.warn('[drawVolunteerHonorCard] 头像绘制失败，降级为占位图标:', err);
    }
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#F3E5D0';
  ctx.fill();
  ctx.fillStyle = PRIMARY_COLOR;
  ctx.font = `${radius}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('🌸', cx, cy);
  ctx.restore();
}

/**
 * 志愿者爱心荣誉卡（2:3 竖屏社交卡片）：面向"义工个人成就感 + 自发传播招募新义工"场景——
 * Header 品牌标题、Profile 头像与身份、三宫格累计数据（服务天数/经手透明账目/协助服务人次）、
 * Footer 邀请二维码，与前两张海报共用同一个 #posterCanvas 节点与 drawVerifyQRArea 二维码
 * 绘制/降级逻辑（传自定义 title，不是"验真"用途）。
 */
export async function drawVolunteerHonorCard(pageInstance: any, data: VolunteerHonorData): Promise<string> {
  // 头像下载放在 query 画布节点之前：即使下载失败也不阻塞，只是退化为占位图标
  const avatarLocalPath = await resolveHeroImageLocalPath(data.avatarUrl || '');

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

        const width = HONOR_CANVAS_WIDTH;
        const height = HONOR_CANVAS_HEIGHT;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.scale(dpr, dpr);

        (async () => {
          try {
            // 🐛 圆角裁剪：整张卡片先 clip 成圆角矩形，之后所有绘制（背景/头像/数据卡/
            // 二维码）都天然被裁在圆角范围内，导出的 PNG 四角是真实透明镂空，
            // 不再依赖预览层的 CSS border-radius 假装圆角
            ctx.save();
            drawRoundedRectPath(ctx, 0, 0, width, height, HONOR_CARD_RADIUS);
            ctx.clip();

            // 暖金渐变底：比故事版的橙粉调更庄重，呼应"荣誉证书"调性
            const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
            bgGradient.addColorStop(0, '#FFF8ED');
            bgGradient.addColorStop(1, '#FDEFD8');
            ctx.fillStyle = bgGradient;
            ctx.fillRect(0, 0, width, height);

            // Header
            ctx.fillStyle = PRIMARY_COLOR;
            ctx.font = 'bold 20px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('素小账 · 爱心志愿者荣誉卡', width / 2, 46);

            ctx.fillStyle = SECONDARY_COLOR;
            ctx.font = '13px sans-serif';
            // 🐛 长图溢出修复：门店名是用户可自定义的文本，此前直接 fillText 不设宽度上限，
            // 超长门店名会在窄幅卡片上左右溢出/与边缘重叠。收窄到画布宽度留白 60px 以内，
            // 超出部分用 truncateText（已在本文件其余海报函数验证过的同一套截断逻辑）省略号收尾
            ctx.fillText(truncateText(ctx, data.storeName || '', width - 60), width / 2, 70);

            // Profile：圆形头像 + 描边 + 身份 + 荣誉标语
            const avatarCx = width / 2;
            const avatarCy = 132;
            await drawCircularAvatar(ctx, canvas, avatarLocalPath, avatarCx, avatarCy, HONOR_AVATAR_RADIUS);

            ctx.beginPath();
            ctx.arc(avatarCx, avatarCy, HONOR_AVATAR_RADIUS + 3, 0, Math.PI * 2);
            ctx.strokeStyle = PRIMARY_COLOR;
            ctx.lineWidth = 2;
            ctx.stroke();

            // 🆕 成就徽章：叠在头像右下角，颜色随累计护持工时对应的等级变化（初心行者=灰、
            // 爱心学习者=铜、守望者=银……见 utils/honorLevels.ts），与身份行的等级名
            // 一起构成"根据护持天数/工时动态展示成就徽章"这一差异化设计要求
            const honor = computeHonorProgress(data.totalHours || 0);
            const badgeR = 18;
            const badgeCx = avatarCx + HONOR_AVATAR_RADIUS * 0.68;
            const badgeCy = avatarCy + HONOR_AVATAR_RADIUS * 0.68;
            drawMedalBadge(ctx, badgeCx, badgeCy, badgeR, honor.currentLevelColor);

            ctx.fillStyle = honor.currentLevelColor;
            ctx.font = 'bold 17px sans-serif';
            ctx.textAlign = 'center';
            // 🐛 长图溢出修复：微信昵称可能是很长的表情符号组合，等级名+昵称拼接后同样
            // 没有宽度上限，会挤出画布甚至压到左右两侧的其他元素上
            const identityLine = truncateText(ctx, `${honor.currentLevelName} · ${data.nickName || '爱心义工'}`, width - 50);
            ctx.fillText(identityLine, width / 2, avatarCy + HONOR_AVATAR_RADIUS + 34);

            ctx.fillStyle = SECONDARY_COLOR;
            ctx.font = 'italic 13px sans-serif';
            ctx.fillText('感谢您用爱心温暖这座城市', width / 2, avatarCy + HONOR_AVATAR_RADIUS + 58);

            // Impact Data：三宫格数据大字框
            const statsTop = avatarCy + HONOR_AVATAR_RADIUS + 84;
            const statsHeight = 96;
            ctx.save();
            ctx.shadowColor = 'rgba(184,134,11,0.12)';
            ctx.shadowBlur = 14;
            ctx.shadowOffsetY = 6;
            ctx.fillStyle = '#FFFFFF';
            drawRoundedRectPath(ctx, 25, statsTop, width - 50, statsHeight, 18);
            ctx.fill();
            ctx.restore();

            const stats = [
              { label: '服务天数', value: `${data.serviceDays || 0}` },
              { label: '经手透明账目', value: `${data.reportCount || 0}` },
              { label: '协助服务人次', value: `${data.diningCount || 0}` }
            ];
            const colWidth = (width - 50) / 3;
            stats.forEach((s, i) => {
              const colCx = 25 + colWidth * i + colWidth / 2;
              ctx.fillStyle = PRIMARY_COLOR;
              ctx.font = 'bold 26px sans-serif';
              ctx.textAlign = 'center';
              ctx.fillText(s.value, colCx, statsTop + 42);

              ctx.fillStyle = LIGHT_TEXT;
              ctx.font = '12px sans-serif';
              ctx.fillText(s.label, colCx, statsTop + 68);

              if (i > 0) {
                ctx.strokeStyle = '#EFE6D8';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(25 + colWidth * i, statsTop + 18);
                ctx.lineTo(25 + colWidth * i, statsTop + statsHeight - 18);
                ctx.stroke();
              }
            });

            // Footer：邀请二维码（非验真用途，指向门店招募入口）
            const qrY = height - HONOR_QR_SIZE - 44 - 20;
            const qrX = width - 30 - HONOR_QR_SIZE;
            await drawVerifyQRArea(ctx, canvas, qrX, qrY, HONOR_QR_SIZE, '微信扫码·一起加入爱心公益', width, data.qrLocalPath, '微信扫码加入');

            ctx.restore(); // 对应开头的圆角裁剪 save/clip

            wx.canvasToTempFilePath({
              canvas,
              x: 0,
              y: 0,
              width: width * dpr,
              height: height * dpr,
              destWidth: width * dpr * 2,
              destHeight: height * dpr * 2,
              fileType: 'png',
              quality: 1,
              success: (tempRes) => resolve(tempRes.tempFilePath),
              fail: (err: any) => reject(new Error('Canvas 转图片失败: ' + err.errMsg))
            });
          } catch (drawErr) {
            reject(drawErr);
          }
        })();
      });
  });
}
