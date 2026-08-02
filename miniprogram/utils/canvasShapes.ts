/**
 * Canvas 2D 绘制基础图形的兼容性工具，供各处海报/证书绘制逻辑共用。
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
