# 微信小程序 GEO 与外网引流策略

> 本文档由代码现状反推整理（2026-09-05），覆盖"公开大屏与落地页的外网 AI 引用与搜一搜收录规则"。CLAUDE.md 第 1 节引用本文件但此前未落地，以下内容以实际读码结果为准，未验证的机制一律标注"⚠️ 待确认"，不臆造。

## 1. 定位与范围

GEO（搜一搜收录 + 外网/AI 引用）策略只服务于 **轨道二：全国大屏**（社会公信力、公开透明账目），不适用于轨道一的私有工作空间页面（记账、进销存等）。判断标准与 CLAUDE.md 第 2 节一致：这个页面回答的是"整个爱心网络的公开成果是什么"，还是"我的机构做得怎么样"。

## 2. `sitemap.json` 现状（2026-09-05 已收敛为按需放行）

`miniprogram/sitemap.json` 现为显式声明制：

```json
{
  "rules": [
    { "action": "allow", "page": "pages/statistics/statistics" },
    { "action": "allow", "page": "subpackages/admin/pages/public-verify/index" },
    { "action": "disallow", "page": "*" }
  ]
}
```

**只显式放行第 3 节列出的两个已确认公开页面，其余（包括未来新增的所有页面）默认走末尾的 `disallow: "*"` 兜底拒绝收录。** 这是刻意的 fail-closed 设计，与 `wxPayCore.requireInternalCaller`"未配置/不匹配一律拒绝"同一套哲学：
- 新增私有工作空间页面（记账、进销存、多店管理等）不需要额外操心 sitemap——默认就是不放行，不会重蹈"全站放行"的覆辙。
- 新增轨道二（全国大屏子视图、爱心公示页等）公开页面时，必须显式在 `allow` 里补一条规则，否则会被兜底规则挡住收录——这正是第 6 节检查清单第 1 条要求的"按页面显式声明"。

> ⚠️ 曾有一版任务描述里把 `pages/index/index` 当作"小程序入口页/落地页"要求一并放行——核实后发现该页面实际是私有的每日记账/凭证录入表单（`onQuickImportExpenseTemplates`/OCR 小票录入/草稿提交等），不是任何公开落地页，本仓库当前也没有独立的营销落地页，因此未采纳，仍归入 `disallow: "*"` 的默认拒绝范围。

## 3. 公开页面清单

| 页面 | 路径 | 说明 |
|---|---|---|
| 全国大屏 / 统计分析 | `pages/statistics/statistics`（主包） | app.json:8 注册；`navigationStyle: "custom"`（statistics.json:2），没有原生标题栏，也没有设置 `navigationBarTitleText` |
| 公开核验页 | `subpackages/admin/pages/public-verify/index` | app.json 中登记为 `"pages/public-verify/index"`，实际物理路径在 `admin` 子包下 |

`pages/statistics/statistics.json`（1-9 行）只声明了 `usingComponents`，**没有任何 GEO/SEO 相关字段**（无自定义标题、无描述性配置）。

## 4. 未登录死锁排查

### 4.1 前端：无强制跳转，但存在角色门槛
- 全文搜索 `pages/statistics/statistics.ts` 与 `enterprise/nationalDashboardService.ts`，**未发现** `wx.redirectTo`/`wx.reLaunch` 类的强制登录跳转逻辑，不存在"进页面就被踢到登录页"的硬阻断。
- 但客户端存在角色门槛：`canViewNationalDashboard = isSuperAdmin || isPatriarch`（`miniprogram/pages/statistics/statistics.ts:1177`），只有已登录且角色为超管/大家长的用户才会触发 `loadNationalDashboard()`（`miniprogram/pages/statistics/enterprise/nationalDashboardService.ts:136`）。

### 4.2 云函数：✅ 已修复（2026-09-05，commit 648a303）——曾经纯匿名访客会被业务拒绝
`cloudfunctions/getNationalDashboard/index.js` 的核心访问逻辑（`exports.main`，约 287 行起）：
1. 用调用者的 `OPENID` 反查 `user_roles`/`users` 集合确定 `userRole` 和 `tenantId`；查不到角色记录时默认 `userRole='volunteer'`，`tenantId=''`。
2. `ALLOWED_ROLES = ['super_admin', 'store_patriarch', 'hq_finance', 'regional_finance', 'volunteer']` 卡口——默认角色 `volunteer` 本就在名单内，纯匿名访客能通过这一关。
3. **关键点（已改）**：`tenantId` 反查为空时不再 `return { success:false }` 拒绝，而是分流到 `buildPublicAggregateSummary()`（index.js 约 239-285 行）——这是与"本机构大屏"彻底独立的只读聚合分支，只 `count()`/`aggregate().sum()`，不 `get()` 拉取任何一条原始文档，只返回机构数/门店数/服务人次/义工工时等非金额"社会影响力"指标，不返回 `totalIncome`/`totalExpense`/机构名称/门店矩阵等敏感或可识别信息。

**修复前的历史状态**（保留供追溯）：曾经 `if (!tenantId) return { success: false, error: '无法确认您所属的机构，暂不支持访问数据大屏' };`，导致从搜一搜/外部 AI 引荐进来的纯匿名访客点进全国大屏会被业务层直接拒绝，是一个发现性死胡同，且与 CLAUDE.md 历史教训（`getNationalDashboard` 曾把查看权限和 `pro`/`enterprise` 订阅耦合）性质类似但不是同一个 bug。这条风险已随 `buildPublicAggregateSummary()` 分支上线而关闭，`sitemap.json` 现已放心把 `pages/statistics/statistics` 加入 allow 名单（见第 2 节）。

### 4.3 `public-verify` 页面：真正无门槛的公开页
`subpackages/admin/pages/public-verify/index.ts` 的 `onLoad`（116 行起）未发现任何登录跳转或角色校验逻辑，是目前代码库里唯一确认"无死锁"的公开页面范例。

## 5. 分享/外网引用文案现状

全文搜索 `onShareAppMessage`/`onShareTimeline`，命中页面为 `pages/history/history.ts`、`pages/profile/profile.ts`、`pages/index/index.ts`，以及 `pages/statistics/statistics.ts`（约 4847/4866 行起）。

✅ **已修复（2026-09-05，commit 648a303）**：`pages/statistics/statistics.ts` 此前没有定义 `onShareAppMessage`/`onShareTimeline`，分享会退回小程序全局默认卡片；现已补上针对"全国大屏/爱心公示"场景定制的分享文案（见该文件 `onShareAppMessage`/`onShareTimeline` 附近注释，标注了本节问题编号）。

## 6. 新增公开页面检查清单

任何新增"轨道二"性质的公开页面（全国大屏子视图、爱心公示页、落地页等）上线前，必须逐项确认：

1. **sitemap.json**：现为默认 `disallow: "*"` 兜底，新页面无需操心；仅当新页面确属轨道二公开页面时，才需要在 `allow` 规则里补一条显式声明，否则会被兜底规则挡住收录。
2. **未登录可达性**：页面自身（`onLoad`/`onShow`）不得有强制登录跳转；依赖的云函数在匿名/无 `tenantId` 场景下，要明确设计好"该展示什么"，而不是直接 `success:false` 拒绝（参考本文档第 4.2 节的现状问题，避免重蹈覆辙）。
3. **分享卡片**：是否定义了 `onShareAppMessage`/`onShareTimeline`，标题与摘要是否对 GEO/外部引用友好（不要留空退回默认卡片）。
4. **页面配置**：`.json` 是否设置了有辨识度的标题（若使用 `navigationStyle: "custom"`，需在自定义导航栏文案或分享文案里补足，不能两处都空）。
5. **敏感字段脱敏**：涉及金额等财务字段的公开页面，服务端必须按角色脱敏（`sanitizeReportForVolunteer`），不能因为页面"公开"就连角色维度的隐私保护一起去掉。

## 7. 维护须知

新增或调整任何公开页面路由、`sitemap.json` 规则、或全国大屏的匿名访问策略时，必须同步回写本文档，保持"代码现状"与"文档记录"一致；涉及权限模型变更时，同步检查 CLAUDE.md 第 2 节的双轨制原则是否仍然成立。

**本文档回写记录**（供追溯"文档是否跟上代码"，而不是重新翻 commit 历史还原上下文）：
- 2026-09-05：`sitemap.json` 从"全放行"收敛为仅 `allow` 第 3 节列出的两个已确认公开页面 + `disallow:"*"` 兜底（见第 2 节）。同一轮核查中发现并修正了第 4.2/5 节两处已经过时的"未修复"描述——`buildPublicAggregateSummary()` 匿名聚合分支与 `pages/statistics/statistics.ts` 的分享卡片其实早在 commit `648a303` 就已落地，只是本文档当时没有跟上代码，属于典型的"文档滞后于修复"案例，提醒以后每次改动这两块逻辑都要顺手回来看一眼本文档是否还准确。
- 商业级上线审计中与 GEO/sitemap 无关的部分（多租户隔离抽查、支付/结算资金流 CAS 加固等）不重复记录在本文档，完整记录归档在 [`CLAUDE.md`](../CLAUDE.md) 第 6 节，两份文档按各自范畴分工、互相交叉引用。
