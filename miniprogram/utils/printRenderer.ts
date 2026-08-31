// 🖨️ 高对比度打印清单：结构比照 posterGenerator.ts 的 drawMeritPoster
// （wx.createSelectorQuery 取 canvas 节点 → 2d ctx → 按内容量动态算高度 →
// wx.canvasToTempFilePath 导出临时图片路径），但版式完全不同——纯黑白、
// 无渐变/无圆角装饰、大字号、粗边框，供年长义工/长辈直接连接便携热敏打印机
// 打印，或保存成白底黑字高清图片放大查看。
//
// 数据源直接复用 index.ts 已有的 buildFinancialPosterData()（PosterData 类型，
// posterGenerator.ts 导出），不重新定义一套数据结构、不重新计算财务口径。
import { PosterData } from './posterGenerator';
import { maskName } from './core/privacy';

// PosterData.totalCount 是"捐款笔数"（爱心支持明细条数），不是用餐人次——
// 用餐总人次在这个页面里叫 diningCount/totalDineCount，PosterData 没有这个
// 字段，调用方（index.ts onExportPrintList）额外拼一个 diningCount 上来
export interface PrintListData extends PosterData {
  diningCount?: number;
}

const CANVAS_WIDTH = 375;
const MARGIN = 24;
const CONTENT_WIDTH = CANVAS_WIDTH - MARGIN * 2;

// 高对比度配色：只有纯黑/纯白两色，不引入任何中间灰阶装饰色，最大化热敏打印
// 与老花眼可读性
const BG_COLOR = '#FFFFFF';
const TEXT_COLOR = '#000000';
const BORDER_WIDTH = 3;

const TITLE_FONT = 'bold 30px sans-serif';
const SECTION_FONT = 'bold 24px sans-serif';
const BODY_FONT = '22px sans-serif';
const SMALL_FONT = '18px sans-serif';

const LINE_HEIGHT = 34;
const SECTION_GAP = 16;

function measureListHeight(lineCount: number): number {
  return lineCount * LINE_HEIGHT;
}

function calcCanvasHeight(data: PrintListData): number {
  let height = MARGIN * 2;
  height += 44; // 标题行
  height += 32; // 门店 + 日期行
  height += SECTION_GAP;

  // 今日供餐/义工统计：固定 3 行（用餐总数/义工人次/服务工时），有值才画
  const hasDining = !!data.diningCount;
  const hasVolunteer = !!(data.volunteerCount || data.volunteerHours);
  if (hasDining || hasVolunteer) {
    height += 36; // 小节标题
    height += LINE_HEIGHT * ((hasDining ? 1 : 0) + (hasVolunteer ? 2 : 0));
    height += SECTION_GAP;
  }

  const items = data.items || [];
  if (items.length > 0) {
    height += 36;
    height += measureListHeight(items.length);
    height += SECTION_GAP;
  }

  const materials = data.materials || [];
  if (materials.length > 0) {
    height += 36;
    height += measureListHeight(materials.length);
    height += SECTION_GAP;
  }

  height += 30; // 底部生成时间落款
  return Math.max(height, 400);
}

export async function drawPrintList(pageInstance: any, data: PrintListData): Promise<string> {
  return new Promise((resolve, reject) => {
    const query = wx.createSelectorQuery().in(pageInstance);
    query.select('#printCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          return reject(new Error('未找到 id="printCanvas" 节点，请检查 wxml 是否存在且非 wx:if 渲染'));
        }

        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const dpr = (wx as any).getWindowInfo ? (wx as any).getWindowInfo().pixelRatio : 2;

        const width = CANVAS_WIDTH;
        const height = calcCanvasHeight(data);
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.scale(dpr, dpr);

        try {
          ctx.fillStyle = BG_COLOR;
          ctx.fillRect(0, 0, width, height);

          // 🛡️ 粗边框：热敏纸/黑白打印下依然清晰可辨的整页外框，不依赖颜色区分区域
          ctx.strokeStyle = TEXT_COLOR;
          ctx.lineWidth = BORDER_WIDTH;
          ctx.strokeRect(BORDER_WIDTH / 2, BORDER_WIDTH / 2, width - BORDER_WIDTH, height - BORDER_WIDTH);

          let y = MARGIN + 30;
          ctx.fillStyle = TEXT_COLOR;
          ctx.textAlign = 'center';
          ctx.font = TITLE_FONT;
          ctx.fillText('餐报打印清单', width / 2, y);
          y += 40;

          ctx.font = BODY_FONT;
          ctx.fillText(`${data.shopName || ''}  ${data.reportDate || data.dateString || ''}`, width / 2, y);
          y += 20;

          ctx.textAlign = 'left';
          ctx.beginPath();
          ctx.moveTo(MARGIN, y + 10);
          ctx.lineTo(width - MARGIN, y + 10);
          ctx.lineWidth = 2;
          ctx.stroke();
          y += 10 + SECTION_GAP;

          const diningCount = data.diningCount || 0;
          const hasDining = !!diningCount;
          const hasVolunteer = !!(data.volunteerCount || data.volunteerHours);
          if (hasDining || hasVolunteer) {
            ctx.font = SECTION_FONT;
            ctx.fillText('今日供餐 / 义工统计', MARGIN, y);
            y += 36;
            ctx.font = BODY_FONT;
            if (hasDining) {
              ctx.fillText(`用餐总人次：${diningCount}`, MARGIN, y);
              y += LINE_HEIGHT;
            }
            if (data.volunteerCount) {
              ctx.fillText(`义工到岗人次：${data.volunteerCount}`, MARGIN, y);
              y += LINE_HEIGHT;
            }
            if (data.volunteerHours) {
              ctx.fillText(`累计服务工时：${data.volunteerHours} 小时`, MARGIN, y);
              y += LINE_HEIGHT;
            }
            y += SECTION_GAP;
          }

          const items = data.items || [];
          if (items.length > 0) {
            ctx.font = SECTION_FONT;
            ctx.fillText(`爱心支持明细（共 ${items.length} 笔）`, MARGIN, y);
            y += 36;
            ctx.font = BODY_FONT;
            items.forEach((item) => {
              const name = data.isAnonymous ? '爱心善士' : maskName(item.name || '爱心人士');
              const line = `${name}    随喜 ¥${item.amount}`;
              ctx.fillText(line, MARGIN, y);
              y += LINE_HEIGHT;
            });
            y += SECTION_GAP;
          }

          const materials = data.materials || [];
          if (materials.length > 0) {
            ctx.font = SECTION_FONT;
            ctx.fillText(`物资赞助明细（共 ${materials.length} 笔）`, MARGIN, y);
            y += 36;
            ctx.font = BODY_FONT;
            materials.forEach((m) => {
              const donor = data.isAnonymous ? '爱心善士' : maskName(m.donor || '匿名爱心人士');
              const line = `${donor}：${m.item || ''} ${m.quantity || ''}${m.unit || ''}`;
              ctx.fillText(line, MARGIN, y);
              y += LINE_HEIGHT;
            });
            y += SECTION_GAP;
          }

          ctx.textAlign = 'center';
          ctx.font = SMALL_FONT;
          const now = new Date();
          const pad = (n: number) => String(n).padStart(2, '0');
          const genTimeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
          ctx.fillText(`生成时间：${genTimeStr}`, width / 2, height - MARGIN);

          wx.canvasToTempFilePath({
            canvas,
            x: 0,
            y: 0,
            width: width * dpr,
            height: height * dpr,
            destWidth: width * dpr,
            destHeight: height * dpr,
            fileType: 'png',
            quality: 1,
            success: (fileRes) => resolve(fileRes.tempFilePath),
            fail: (err: any) => reject(new Error('Canvas 转图片失败: ' + err.errMsg))
          });
        } catch (err) {
          reject(err);
        }
      });
  });
}
