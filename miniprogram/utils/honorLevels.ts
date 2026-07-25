/**
 * 义工荣誉等级：护持工时对应的称号/勋章色阶，被两处海报生成逻辑共用——
 * components/archive-modal/archive-modal.ts（首页「分享荣誉海报」）与
 * utils/posterGenerator.ts 的 drawVolunteerHonorCard（暖心历程「生成我的爱心荣誉卡」）。
 * 抽成共享模块只维护一份等级定义，避免两处各画一套、后续改等级门槛时漏改一处。
 */

export interface HonorProgress {
  currentLevelName: string;
  currentLevelColor: string;
  currentLevelIndex: number;
  nextLevelName: string;
  currentHours: number;
  nextHours: number;
  progressPercent: number;
  remainHours: number;
}

export const MEDAL_LEVELS = [
  { name: '初心行者', minHours: 0, color: '#9E9E9E' },
  { name: '雨花爱心学习者', minHours: 10, color: '#CD7F32' },
  { name: '雨花爱心守望者', minHours: 25, color: '#C0C0C0' },
  { name: '雨花金牌守护者', minHours: 50, color: '#F5A623' },
  { name: '雨花钻石护持者', minHours: 100, color: '#B22222' },
  { name: '雨花无上菩提行者', minHours: 200, color: '#8C1D18' }
];

export function computeHonorProgress(totalHours: number): HonorProgress {
  for (let i = MEDAL_LEVELS.length - 1; i >= 0; i--) {
    if (totalHours >= MEDAL_LEVELS[i].minHours) {
      const nextLevel = MEDAL_LEVELS[i + 1];
      if (nextLevel) {
        const range = nextLevel.minHours - MEDAL_LEVELS[i].minHours;
        const progress = totalHours - MEDAL_LEVELS[i].minHours;
        const percent = Math.min(100, Math.max(0, Math.round((progress / range) * 100)));
        return {
          currentLevelName: MEDAL_LEVELS[i].name,
          currentLevelColor: MEDAL_LEVELS[i].color,
          currentLevelIndex: i,
          nextLevelName: nextLevel.name,
          currentHours: totalHours,
          nextHours: nextLevel.minHours,
          progressPercent: percent,
          remainHours: parseFloat((nextLevel.minHours - totalHours).toFixed(1))
        };
      }
      // 满级
      return {
        currentLevelName: MEDAL_LEVELS[i].name,
        currentLevelColor: MEDAL_LEVELS[i].color,
        currentLevelIndex: i,
        nextLevelName: '已是最高荣誉',
        currentHours: totalHours,
        nextHours: totalHours,
        progressPercent: 100,
        remainHours: 0
      };
    }
  }
  return {
    currentLevelName: MEDAL_LEVELS[0].name,
    currentLevelColor: MEDAL_LEVELS[0].color,
    currentLevelIndex: 0,
    nextLevelName: MEDAL_LEVELS[1].name,
    currentHours: totalHours,
    nextHours: MEDAL_LEVELS[1].minHours,
    progressPercent: Math.min(100, Math.max(0, Math.round((totalHours / MEDAL_LEVELS[1].minHours) * 100))),
    remainHours: parseFloat((MEDAL_LEVELS[1].minHours - totalHours).toFixed(1))
  };
}

// 十六进制颜色朝白色方向混合，用于给勋章色系生成"浅色渐变端"，不用为每个
// 等级手写一套浅/深两份配色
export function lightenHex(hex: string, amount: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.round(((num >> 16) & 0xff) + (255 - ((num >> 16) & 0xff)) * amount);
  const g = Math.round(((num >> 8) & 0xff) + (255 - ((num >> 8) & 0xff)) * amount);
  const b = Math.round((num & 0xff) + (255 - (num & 0xff)) * amount);
  return `rgb(${r},${g},${b})`;
}

// 五角星路径（供成就徽章内部图标复用），不 fill，由调用方决定颜色
export function drawStarPath(ctx: any, cx: number, cy: number, outerR: number, innerR: number, points: number): void {
  ctx.beginPath();
  const step = Math.PI / points;
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = i * step - Math.PI / 2;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// 成就徽章：白色外圈（分离背景）+ 勋章色径向渐变主体 + 五角星图标，颜色完全由
// 调用方传入的 color 决定——同一份绘制逻辑，换个颜色就是不同等级的徽章
export function drawMedalBadge(ctx: any, cx: number, cy: number, radius: number, color: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.shadowColor = 'rgba(0,0,0,0.18)';
  ctx.shadowBlur = radius * 0.18;
  ctx.fill();
  ctx.shadowBlur = 0;

  const inner = radius * 0.86;
  const medalGrad = ctx.createRadialGradient(cx - inner * 0.3, cy - inner * 0.3, inner * 0.1, cx, cy, inner);
  medalGrad.addColorStop(0, lightenHex(color, 0.45));
  medalGrad.addColorStop(1, color);
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, Math.PI * 2);
  ctx.fillStyle = medalGrad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = Math.max(1, radius * 0.04);
  ctx.stroke();

  ctx.fillStyle = '#FFFFFF';
  drawStarPath(ctx, cx, cy - inner * 0.04, inner * 0.42, inner * 0.18, 5);
  ctx.fill();
  ctx.restore();
}
