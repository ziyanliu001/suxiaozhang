/**
 * 数字荣誉墙 / 勋章墙：共享的解锁规则与计算逻辑。
 * 被 pages/profile/profile.ts（核心荣誉横向滚动条）与 pages/journey/journey.ts
 * （暖心历程页 3 列勋章墙）共同使用，只维护一份阈值定义与解锁判定，避免两处
 * 各画一套、后续调整门槛时漏改一处。
 */

export interface BadgeConfig {
  id: string;
  emoji: string;
  name: string;
  type: 'days' | 'hours' | 'streak';
  threshold: number;
  meaning: string;
}

export interface BadgeItem {
  id: string;
  emoji: string;
  name: string;
  meaning: string;
  unlocked: boolean;
  hint: string;
  unlockDesc: string;
  progressStatusText: string;
  progressCurrent: number;
  progressThreshold: number;
  progressUnit: string;
  progressPercent: number;
}

// 🌟 荣誉徽章解锁规则：护持天数 / 累计工时 / 连续护持天数（streak）任一维度达标
// 即视为解锁。阈值为产品侧可调参数，这里给出一组由浅入深、早期容易触达的示例梯度，
// 让新义工也能较快解锁第一枚徽章，建立正反馈。streak7/hours30 是较低的早期门槛，
// 与 hours100/century/guardian 等长线目标搭配，避免新义工要等很久才见到第二枚徽章。
export const BADGE_CONFIG: BadgeConfig[] = [
  { id: 'starter', emoji: '🌱', name: '初心', type: 'days', threshold: 1, meaning: '志愿之路的第一步，代表你迈出了守护爱心的初心' },
  { id: 'streak7', emoji: '🔥', name: '连续坚守', type: 'streak', threshold: 7, meaning: '连续 7 天到岗服务，风雨不改，展现你的坚持与恒心' },
  { id: 'hours30', emoji: '🌟', name: '渐入佳境', type: 'hours', threshold: 30, meaning: '累计服务满 30 小时，你已渐入佳境，越来越熟悉这份爱心事业' },
  { id: 'storm', emoji: '☔', name: '风雨无阻', type: 'days', threshold: 30, meaning: '无论刮风下雨，你始终坚持到岗，是站点最踏实的陪伴' },
  { id: 'hours100', emoji: '⏰', name: '百时勋章', type: 'hours', threshold: 100, meaning: '累计服务满百小时，见证你日积月累的默默付出' },
  { id: 'century', emoji: '💯', name: '百日精进', type: 'days', threshold: 100, meaning: '百日精进，代表你已把志愿服务融入日常，是站点的中坚力量' },
  { id: 'guardian', emoji: '🛡️', name: '志愿先锋', type: 'hours', threshold: 500, meaning: '累计工时突破 500 小时，是站点当之无愧的志愿先锋' }
];

function pickCurrent(cfg: BadgeConfig, days: number, hours: number, streak: number): number {
  if (cfg.type === 'hours') return hours;
  if (cfg.type === 'streak') return streak;
  return days;
}

function pickUnitAndVerb(type: BadgeConfig['type'], verb: string): { unit: string; verb: string } {
  if (type === 'hours') return { unit: '小时', verb: '累计' };
  if (type === 'streak') return { unit: '天', verb: `连续${verb}` };
  return { unit: '天', verb };
}

/**
 * 根据服务天数/累计工时/连续天数计算每枚徽章的解锁状态与提示文案。
 * unlocked 判定为 current >= threshold（含等于），已达成条件的徽章不会再被误判为锁定。
 * streak 缺省为 0（调用方未提供连续天数时，streak 类型徽章按未达标处理，不影响
 * days/hours 类型徽章的正常计算）。
 * verb 可选：雨花斋类型传 '护持'，其他爱心组织传 '服务'（缺省），影响勋章进度文案。
 */
export function computeBadgeList(volunteerDays: number, volunteerHours: number, volunteerStreak: number = 0, verb: string = '服务'): BadgeItem[] {
  const days = volunteerDays || 0;
  const hours = volunteerHours || 0;
  const streak = volunteerStreak || 0;

  return BADGE_CONFIG.map((cfg) => {
    const current = pickCurrent(cfg, days, hours, streak);
    const unlocked = current >= cfg.threshold;
    const remaining = Math.max(0, Math.ceil(cfg.threshold - current));
    const { unit, verb: v } = pickUnitAndVerb(cfg.type, verb);
    // 进度条：当前进度 clamp 到不超过阈值，百分比同理 clamp 到 100，避免已解锁很久、
    // 累计数字远超阈值时进度条溢出
    const progressCurrent = Math.min(Math.round(current), cfg.threshold);
    const progressPercent = cfg.threshold > 0 ? Math.min(100, Math.round((current / cfg.threshold) * 100)) : 100;
    // streak 类型的 verb 本身已含"连续xxx"语义，不再叠加"累计"前缀，避免读起来
    // 变成"累计连续服务满 7 天"这种拗口表述
    const unlockDescPrefix = cfg.type === 'streak' ? v : `累计${v}`;

    return {
      id: cfg.id,
      emoji: cfg.emoji,
      name: cfg.name,
      meaning: cfg.meaning,
      unlocked,
      hint: unlocked ? '' : `再${v} ${remaining} ${unit}即可解锁「${cfg.name}」徽章`,
      unlockDesc: `${unlockDescPrefix}满 ${cfg.threshold} ${unit}可解锁`,
      progressStatusText: unlocked
        ? `已${v} ${progressCurrent} ${unit}，恭喜解锁「${cfg.name}」！`
        : `已${v} ${progressCurrent}/${cfg.threshold} ${unit}，还差 ${remaining} ${unit}解锁`,
      progressCurrent,
      progressThreshold: cfg.threshold,
      progressUnit: unit,
      progressPercent
    };
  });
}
