import { resolveWorkspaceForOrgType as resolveWorkspaceForOrgTypeImpl } from './lib/resolveWorkspace';
import { AuthService } from './authService';

// 🏢 WorkspaceManager：工作空间概念的统一收敛服务
//
// 🛡️ 如实标注两个与最初任务描述不完全一致的地方，避免以后有人对着这个文件
// 的字面接口误以为底层真的有一套三态并列的状态机：
//
// 1. 本项目代码里从未存在过 "workspaceType" 这个字段/概念（全仓库 grep 零
//    命中，CLAUDE.md 第 2 节"⚠️ 术语澄清"已经明确记录过这一点）——真正驱动
//    首页"雨花斋 / 通用记账"两态切换的是 pages/index/index.ts 的页面内存态
//    字段 currentPlatformMode，取值只有 '' / 'yuhua' / 'general' 三种，
//    从未有过 'workshop'。
// 2. WorkspaceMode.WORKSHOP（素食直播产销工坊）不是 currentPlatformMode 的
//    第三个取值——它是完全独立的 wx.navigateTo 跳转（见 index.ts
//    onSelectFactoryPlatform，目标是 /subpackages/factory/... 这个独立
//    子包），不是这个页面内 2 态切换的一部分。纳入这个枚举只是为了让
//    switchWorkspace() 能提供"三个专区统一一个入口"的调用体验，不代表底层
//    真的有三个并列的页面状态。
//
// 因此本文件是一个**克制的、附加式**的收敛：只新增当前确实缺失的能力
// （管理员角色的冷启动记忆，见下方 getLastAdminWorkspace 头部注释），把
// index.ts 里原本分散的 orgType→专区判断逻辑抽出一个可复用/可测试的纯函数
// （resolveWorkspaceForOrgType），不去批量重写 index.ts 里现存全部
// `currentPlatformMode === 'general'` 这类字符串字面量比较——那是一次
// 大范围、无自动化测试覆盖、纯靠人工审查很难保证不出回归的重构，本次不做。
//
// 枚举成员的字符串值特意保持与 currentPlatformMode 现存字面量完全一致
// （YUHUA='yuhua'/COMMUNITY='general'），只是给 COMMUNITY 这个更贴合实际
// 业务语境的名字（"社区普惠与社会互助专区"，与 fetchCommunityZoneStoreList
// 等处的既有措辞对齐）——这样 WorkspaceMode.COMMUNITY 在任何等值比较里都能
// 与现存的 'general' 字面量互换，不需要迁移任何既有代码。
export enum WorkspaceMode {
  YUHUA = 'yuhua',
  COMMUNITY = 'general',
  WORKSHOP = 'workshop'
}

const WORKSPACE_NAMES: Record<WorkspaceMode, string> = {
  [WorkspaceMode.YUHUA]: '雨花公益食堂专区',
  [WorkspaceMode.COMMUNITY]: '社区普惠与社会互助专区',
  [WorkspaceMode.WORKSHOP]: '素食直播产销工坊'
};

export function getWorkspaceName(mode: WorkspaceMode | string): string {
  return (WORKSPACE_NAMES as Record<string, string>)[mode] || '';
}

// 🛡️ 判断逻辑（从 index.ts autoResumeWorkspaceMode() 原有的
// `orgType === 'yuhuazhai' ? 'yuhua' : 'general'` 抽出来）拆到
// lib/resolveWorkspace.js（纯函数，不依赖 wx 全局，配套单测同目录
// resolveWorkspace.test.js）——与同目录 resolveEffectiveRole.js/
// resolveActiveRoleGrant.js 同一套既定写法，这里只做类型收窄后再导出。
export function resolveWorkspaceForOrgType(orgType: string): WorkspaceMode.YUHUA | WorkspaceMode.COMMUNITY | null {
  const result = resolveWorkspaceForOrgTypeImpl(orgType);
  return result as WorkspaceMode.YUHUA | WorkspaceMode.COMMUNITY | null;
}

// 🆕（2026-09-13 工作空间架构升级）仅面向 super_admin/platform_admin 的
// 冷启动记忆——这两类账号的 orgType 没有确定性意义（不隶属单一门店/机构，
// 或需要自由预览两个专区，见 index.ts autoResumeWorkspaceMode 原有注释），
// 此前因此从未享受过"账号已有明确归属时跳过选择页"这条规则，每次冷启动
// 都停在【选择工作空间】首页，需要重新点一次。
//
// 🛡️ 与"不引入持久化缓存"这条既有原则并不冲突：那条原则针对的是"用缓存
// 替代真实业务数据"——普通账号的专区归属是可以变化的服务端事实（真实
// 绑定门店的 orgType），缓存下来就有跟真相脱节的风险，所以那条路径至今
// 仍然坚持"每次现查、不缓存"。super_admin/platform_admin 恰恰没有这类
// "真实业务归属"可以脱节——这里记录的只是"这个管理员上次自己点了哪张
// 专区卡片"这个纯粹的个人 UI 使用习惯，不代表、也不会覆盖任何业务事实，
// 不存在"缓存变旧"这个概念（人的偏好本来就是可以随时被下一次主动选择
// 覆盖的，不需要跟谁保持一致）。
//
// 只记录 YUHUA/COMMUNITY 两个真实的页面状态；WORKSHOP 是跳转到另一个子包，
// 不是需要"记住并跳过选择页"的页面内状态，不纳入这份记忆。
const STORAGE_KEY_LAST_ADMIN_WORKSPACE = 'last_admin_workspace_mode';

export function getLastAdminWorkspace(): WorkspaceMode.YUHUA | WorkspaceMode.COMMUNITY | null {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY_LAST_ADMIN_WORKSPACE);
    if (raw === WorkspaceMode.YUHUA || raw === WorkspaceMode.COMMUNITY) {
      return raw;
    }
    return null;
  } catch (e) {
    return null;
  }
}

export function setLastAdminWorkspace(mode: WorkspaceMode.YUHUA | WorkspaceMode.COMMUNITY): void {
  try {
    wx.setStorageSync(STORAGE_KEY_LAST_ADMIN_WORKSPACE, mode);
  } catch (e) {
    // 写入失败（隐私模式/存储已满等）不影响主流程，下次冷启动退回选择
    // 首页，不算功能缺失——这本来就是没有这份记忆时的原有行为
  }
}

// 🛡️ 如实标注：currentPlatformMode 只是 pages/index/index.ts 页面实例的
// 内存态字段，从未持久化、也没有挂到任何全局可访问的位置（app.globalData/
// wx.storage 都没有），本文件拿不到"index 页面此刻字面上正在展示哪个专区"
// 这个瞬时值——这不是本文件的实现缺陷，是 index.ts 头部注释里"不引入持久化
// 缓存"这条既有原则的直接结果。
//
// 这里返回的是"以当前已知信息推算，这个账号大概率应该处于哪个专区"，与
// index.ts autoResumeWorkspaceMode() 的判断依据完全一致：有真实业务归属
// （orgType）的账号按归属推算；super_admin/platform_admin 没有归属，退回
// getLastAdminWorkspace() 记忆；两者都没有则返回 null（意味着应该停留在
// "选择工作空间"首页）。供不在 index.ts 页面实例上、但需要"猜一下这个
// 账号大概率在哪个专区"的其它页面/组件调用，不追求与 index.ts 当前实际
// 渲染状态逐帧一致。
export function getCurrentWorkspace(): WorkspaceMode.YUHUA | WorkspaceMode.COMMUNITY | null {
  const cached = AuthService.getCachedRoleInfo();
  const isAdminAccount = !!(cached && (cached.role === 'super_admin' || cached.role === 'platform_admin'));
  if (isAdminAccount) {
    return getLastAdminWorkspace();
  }
  return resolveWorkspaceForOrgType((cached && cached.orgType) || '');
}

// 🛡️ 只做两件与具体页面无关的事——记住这次选择（供 getLastAdminWorkspace
// 使用）+ 返回解析后的目标枚举值，不代替调用方执行 setData/wx.navigateTo
// 这类必须绑定在具体页面实例上的真正切换动作（如 index.ts
// enterYuhuaWorkspaceFlow() 内部还要处理合规声明弹窗/tabBar 显隐等一整套
// 页面特有的副作用，不适合搬进这个通用 utils 文件，也没有必要——调用方
// 拿到返回值后自己决定怎么把它落地成页面状态，与 resolveActiveRoleGrant
// 等纯决策函数"只返回决策、由调用方执行副作用"是同一个既定分工）。
// rememberForAdmin 由调用方显式传入（通常是 isCurrentAccountSuperAdmin()
// 的结果）——本文件不认识"当前登录账号是谁"，不能自己判断要不要写这份
// 管理员专属记忆。WORKSHOP 是跳转到独立子包，不需要、也不会被记忆。
export function switchWorkspace(mode: WorkspaceMode, rememberForAdmin: boolean): WorkspaceMode {
  if (rememberForAdmin && (mode === WorkspaceMode.YUHUA || mode === WorkspaceMode.COMMUNITY)) {
    setLastAdminWorkspace(mode);
  }
  return mode;
}
