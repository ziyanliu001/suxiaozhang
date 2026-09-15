/**
 * Canvas 2D 绘制基础工具，供各处海报/证书绘制逻辑共用。
 *
 * 🔧（2026-09-16 海报绘图逻辑解耦）本文件原本只有 safeRoundRect 一个圆角矩形
 * 兼容性工具。审查 drawActivityPoster.ts/drawDailyMenuPoster.ts/
 * posterGenerator.ts 三处海报绘制逻辑时发现，除了圆角矩形之外，"按 aspectFill
 * 裁剪绘制图片""量出真实宽度后截断加省略号""按最大宽度/最大行数逐字符换行"
 * 这三类基础绘制操作也各自被独立重复实现了 2~3 遍（且部分实现细节不完全一致，
 * 如 drawDailyMenuPoster.ts 的圆角矩形路径缺少本文件 safeRoundRect 已有的半径
 * 钳制保护）。这里补齐 drawImageCover/truncateText/wrapTextLines 三个函数，
 * 各处重复实现收敛到这一份，不产生行为差异（细节差异见各函数注释）。
 */

/**
 * 圆角矩形路径：不依赖原生 ctx.roundRect。
 *
 * 🛡️ 根因：不同基础库/模拟器环境下，ctx.roundRect 有的版本压根不存在（较早基础库），
 * 有的版本虽然存在、但对单数字 radius 参数的处理不规范，实际调用时直接抛
 * TypeError（典型出现在 Linux 平台的微信开发者工具模拟器）——仅凭
 * `typeof ctx.roundRect === 'function'` 的存在性判断，拦不住"方法存在但一调用就抛"
 * 这种情况，之前 drawStorePoster.ts/drawActivityPoster.ts 各自的降级分支都只做了
 * 存在性检查，没有覆盖这一种。
 *
 * 改用 moveTo + arcTo 手工画路径——这是 Canvas 2D 规范最早期就支持的基础 API，
 * 各端环境行为完全一致，不需要任何特性检测或 try/catch。
 *
 * 与原生 roundRect 用法一致：只 beginPath + 画路径，不调用 fill/stroke，
 * 由调用方在自己现有的 fillStyle/strokeStyle 设置好之后自行 fill()/stroke()。
 */
export function safeRoundRect(ctx: any, x: number, y: number, w: number, h: number, r: number): void {
  // 半径不能超过矩形短边的一半，否则四个圆角会互相重叠、画出畸形路径
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * 按 aspectFill 语义把图片居中裁剪绘制进目标矩形，避免像 <image> 缺省行为
 * （直接拉伸铺满）那样把非目标宽高比的照片画变形。原先 posterGenerator.ts 与
 * drawDailyMenuPoster.ts 各自维护一份算法完全相同的实现，这里收敛为一份。
 */
export function drawImageCover(ctx: any, img: any, dx: number, dy: number, dw: number, dh: number): void {
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

const DEFAULT_ELLIPSIS = '...';

/**
 * 量出文字真实渲染宽度，超出 maxWidth 时二分查找截断点并补上省略号。
 * 原先 posterGenerator.ts（二分查找 + '...' 三点省略号）与
 * drawDailyMenuPoster.ts（线性逐字符收缩 + '…' 单字符省略号）各自维护一份
 * 目的相同、实现细节不同的截断逻辑——这里统一用二分查找（更快，虽然海报文字
 * 通常很短，性能差异可忽略，但没有理由保留更慢的版本）+ 全项目更常见的
 * '...' 三点省略号（ellipsis 参数仍可覆盖，不强制）。
 */
export function truncateText(ctx: any, text: string, maxWidth: number, ellipsis: string = DEFAULT_ELLIPSIS): string {
  if (!text) return '';
  const measured = ctx.measureText(text);
  if (measured.width <= maxWidth) return text;

  const ellipsisWidth = ctx.measureText(ellipsis).width;
  const targetWidth = maxWidth - ellipsisWidth;
  if (targetWidth <= 0) return ellipsis;

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
  return result + ellipsis;
}

/**
 * 按最大宽度逐字符换行，最多 maxLines 行，超出部分在最后一行末尾补省略号；
 * 只返回按行拆好的字符串数组，不负责实际 fillText——由调用方决定每行怎么画
 * （标题/摘要这类需要"限定行数、超出截断"的场景）。与 posterGenerator.ts 里
 * 直接 fillText 逐行绘制、不限制行数的 drawMultiLineText 是两种不同用途，
 * 不合并：一个是"画多长都行、不丢内容"，一个是"最多几行、多了就砍"。
 * 原先 drawActivityPoster.ts 与 drawDailyMenuPoster.ts 各维护一份逐字节
 * 相同的实现，这里收敛为一份。
 */
export function wrapTextLines(ctx: any, text: string, maxWidth: number, maxLines: number): string[] {
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
