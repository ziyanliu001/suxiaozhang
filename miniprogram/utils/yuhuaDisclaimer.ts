// 🌸 雨花平台专属合规声明的本地持久化状态。key 统一加 yuhua_ 前缀并独立于通用
// complianceHandoff（那是页面间"想看一次完整声明"的跳转标记，不落地确认状态），
// 避免未来其他机构/平台（社区助餐、义工站等）各自的声明逻辑复用同一个 key 互相踩踏。
//
// 分两档独立记忆：'general' 档任何角色首次进入雨花平台都需要阅读一次；'privileged'
// 档店长/财务/超管在此基础上需二次确认（能看到具体金额账本，合规风险更高于普通义工视角）。
// 两档都只在用户主动点击"进入雨花平台"入口时才校验，绝不在 onLoad/onShow 里自动触发。
const GENERAL_KEY = 'yuhua_disclaimer_agreed_v1_general';
const PRIVILEGED_KEY = 'yuhua_disclaimer_agreed_v1_privileged';

export function hasAgreedYuhuaGeneralDisclaimer(): boolean {
  return !!wx.getStorageSync(GENERAL_KEY);
}

export function acknowledgeYuhuaGeneralDisclaimer(): void {
  wx.setStorageSync(GENERAL_KEY, true);
}

export function hasAgreedYuhuaPrivilegedDisclaimer(): boolean {
  return !!wx.getStorageSync(PRIVILEGED_KEY);
}

export function acknowledgeYuhuaPrivilegedDisclaimer(): void {
  wx.setStorageSync(PRIVILEGED_KEY, true);
}
