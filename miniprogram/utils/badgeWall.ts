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
  type: 'days' | 'hours';
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

// 🌟 荣誉徽章解锁规则：护持天数 / 累计工时任一维度达标即视为解锁。
// 阈值为产品侧可调参数，这里给出一组由浅入深、早期容易触达的示例梯度，
// 让新义工也能较快解锁第一枚徽章，建立正反馈。
export const BADGE_CONFIG: BadgeConfig[] = [
  { id: 'starter', emoji: '🌱', name: '初心', type: 'days', threshold: 1, meaning: '义工之路的第一步，代表你迈出了守护雨花斋的初心' },
  { id: 'storm', emoji: '☔', name: '风雨无阻', type: 'days', threshold: 30, meaning: '无论刮风下雨，你始终坚持到岗，是雨花斋最踏实的陪伴' },
  { id: 'hours100', emoji: '⏰', name: '百时勋章', type: 'hours', threshold: 100, meaning: '累计护持满百小时，见证你日积月累的默默付出' },
  { id: 'century', emoji: '💯', name: '百日精进', type: 'days', threshold: 100, meaning: '百日精进，代表你已把护持融入日常，是雨花斋的中坚力量' },
  { id: 'guardian', emoji: '🛡️', name: '护持先锋', type: 'hours', threshold: 500, meaning: '累计工时突破 500 小时，是雨花斋当之无愧的护持先锋' }
];

/**
 * 根据护持天数/累计工时计算每枚徽章的解锁状态与提示文案。
 * unlocked 判定为 current >= threshold（含等于），已达成条件的徽章不会再被误判为锁定。
 */
export function computeBadgeList(volunteerDays: number, volunteerHours: number): BadgeItem[] {
  const days = volunteerDays || 0;
  const hours = volunteerHours || 0;

  return BADGE_CONFIG.map((cfg) => {
    const current = cfg.type === 'days' ? days : hours;
    const unlocked = current >= cfg.threshold;
    const remaining = Math.max(0, Math.ceil(cfg.threshold - current));
    const unit = cfg.type === 'days' ? '天' : '小时';
    const verb = cfg.type === 'days' ? '护持' : '累计';
    // 进度条：当前进度 clamp 到不超过阈值，百分比同理 clamp 到 100，避免已解锁很久、
    // 累计数字远超阈值时进度条溢出
    const progressCurrent = Math.min(Math.round(current), cfg.threshold);
    const progressPercent = cfg.threshold > 0 ? Math.min(100, Math.round((current / cfg.threshold) * 100)) : 100;

    return {
      id: cfg.id,
      emoji: cfg.emoji,
      name: cfg.name,
      meaning: cfg.meaning,
      unlocked,
      hint: unlocked ? '' : `再${verb} ${remaining} ${unit}即可解锁「${cfg.name}」徽章`,
      unlockDesc: `累计${verb}满 ${cfg.threshold} ${unit}可解锁`,
      progressStatusText: unlocked
        ? `已${verb} ${progressCurrent} ${unit}，恭喜解锁「${cfg.name}」！`
        : `已${verb} ${progressCurrent}/${cfg.threshold} ${unit}，还差 ${remaining} ${unit}解锁`,
      progressCurrent,
      progressThreshold: cfg.threshold,
      progressUnit: unit,
      progressPercent
    };
  });
}
