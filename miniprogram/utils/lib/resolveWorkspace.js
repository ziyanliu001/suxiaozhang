'use strict';

// 纯逻辑：拆自 utils/workspaceManager.ts，不依赖 wx 全局，便于单测——与同目录
// resolveEffectiveRole.js/resolveActiveRoleGrant.js 同一套既定写法（.ts 文件
// 通过 import 引入，不重复维护一份判断逻辑）。
//
// resolveWorkspaceForOrgType：从 pages/index/index.ts autoResumeWorkspaceMode()
// 原有的 `orgType === 'yuhuazhai' ? 'yuhua' : 'general'` 判断抽出来，供该方法
// 与未来任何需要同样判断的调用点复用。orgType 为空（未归属任何真实门店的
// 账号）时返回 null——调用方应据此保持在"选择工作空间"首页，不能替它猜一个
// 专区。
//
// ⚠️ 返回值特意用与 pages/index/index.ts currentPlatformMode 现存字面量完全
// 一致的字符串（'yuhua'/'general'），不是 workspaceManager.ts 里更贴合业务
// 语境的 WorkspaceMode.COMMUNITY 这个枚举成员名——两者字符串值相同
// （COMMUNITY='general'），调用方用哪种写法比较都不影响判断结果。
function resolveWorkspaceForOrgType(orgType) {
  if (!orgType) return null;
  return orgType === 'yuhuazhai' ? 'yuhua' : 'general';
}

module.exports = { resolveWorkspaceForOrgType };
