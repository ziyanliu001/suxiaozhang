# 微信小程序 GEO 与外网引流策略

> 本文档由代码现状反推整理（2026-09-05），覆盖"公开大屏与落地页的外网 AI 引用与搜一搜收录规则"。CLAUDE.md 第 1 节引用本文件但此前未落地，以下内容以实际读码结果为准，未验证的机制一律标注"⚠️ 待确认"，不臆造。

## 1. 定位与范围

GEO（搜一搜收录 + 外网/AI 引用）策略只服务于 **轨道二：全国大屏**（社会公信力、公开透明账目），不适用于轨道一的私有工作空间页面（记账、进销存等）。判断标准与 CLAUDE.md 第 2 节一致：这个页面回答的是"整个爱心网络的公开成果是什么"，还是"我的机构做得怎么样"。

## 2. `sitemap.json` 现状

`miniprogram/sitemap.json`（miniprogram/sitemap.json:1-7）目前只有一条规则：

```json
{ "rules": [{ "action": "allow", "page": "*" }] }
```

**现状是全站放行、没有任何按页面区分的 allow/disallow 规则。** 这意味着：
- 所有私有工作空间页面（记账、进销存、多店管理等）在配置层面同样被标记为"允许收录"，没有按 CLAUDE.md 军规的意图做"只放行公开页面"的精细化收敛。
- 目前没有出现过因此产生实际数据泄露（微信搜一搜索引擎能否真正抓取到私有页面内容，取决于该页面在无登录态下渲染出什么，见第 4 节），但配置本身与"新增公开页面时才需要评估 sitemap 放行"的军规初衷不符——现在是"默认全放行"，而不是"按需放行"。
- ⚠️ 风险点：全放行的配置掩盖了"这个页面到底该不该被收录"这个决策点，未来如果私有页面在未登录态下意外渲染出敏感内容（即便只是壳/占位文案），也会被搜一搜收录。

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

### 4.2 云函数：⚠️ 风险点——纯匿名访客会被业务拒绝
`cloudfunctions/getNationalDashboard/index.js` 的核心访问逻辑（225-262 行）：
1. 用调用者的 `OPENID` 反查 `user_roles`/`users` 集合确定 `userRole` 和 `tenantId`；查不到角色记录时默认 `userRole='volunteer'`，`tenantId=''`。
2. `ALLOWED_ROLES = ['super_admin', 'store_patriarch', 'hq_finance', 'regional_finance', 'volunteer']` 卡口（index.js:252-255）。
3. **关键点**：`if (!tenantId) return { success: false, error: '无法确认您所属的机构，暂不支持访问数据大屏' };`（index.js:260-262）。

也就是说，**一个从搜一搜/外部 AI 引荐进来、此前从未加入过任何机构的纯匿名访客，即便通过了角色卡口，也会因为反查不到 `tenantId` 被业务层直接拒绝**，前端表现为 `wx.showToast` 提示"全国总览加载失败"（`nationalDashboardService.ts:326-330`），不是原生崩溃或路由死锁，但**功能上确实是一个发现性死胡同**：搜索引擎/AI 引用带来的新访客点进来看不到任何公开数据。

这与 CLAUDE.md 历史教训（`getNationalDashboard` 曾把查看权限和 `pro`/`enterprise` 订阅耦合，见 index.js:376 附近注释确认该问题已修复）不是同一个 bug，但性质类似：**当前的"必须已归属某个机构"这道卡口，客观上把"全国大屏应始终可查看"的战略目标，限制成了"已登录且已加入机构的内部用户之间的跨店汇总视图"，而非真正面向匿名公众的公开页。**

⚠️ **待确认/需要产品决策**：全国大屏对纯外部匿名访客到底应该展示什么？如果 GEO 策略的目标是让搜一搜/外部 AI 把访客导向一个可见的公开成果页，现状的服务端实现并不支持这一路径，需要产品和工程共同决策（例如是否需要一个不依赖 `tenantId` 的、聚合全平台数据的公开只读视图）。本文档只如实记录现状，不在本次任务内修复代码。

### 4.3 `public-verify` 页面：真正无门槛的公开页
`subpackages/admin/pages/public-verify/index.ts` 的 `onLoad`（116 行起）未发现任何登录跳转或角色校验逻辑，是目前代码库里唯一确认"无死锁"的公开页面范例。

## 5. 分享/外网引用文案现状

全文搜索 `onShareAppMessage`/`onShareTimeline`，命中页面为 `pages/history/history.ts`（2128、2156 行）、`pages/profile/profile.ts`（2953 行）、`pages/index/index.ts`（12218、12257 行）。

⚠️ **`pages/statistics/statistics.ts`（全国大屏所在页）没有定义 `onShareAppMessage`/`onShareTimeline`**，分享该页面时会退回小程序全局默认分享卡片（应用名 + 默认图标），没有针对"全国大屏/爱心公示"场景定制的标题、摘要或封面图。这意味着即便用户主动转发全国大屏，搜一搜和外部渠道也拿不到有辨识度的引用文案。

## 6. 新增公开页面检查清单

任何新增"轨道二"性质的公开页面（全国大屏子视图、爱心公示页、落地页等）上线前，必须逐项确认：

1. **sitemap.json**：是否需要从当前"全放行"收敛为按页面显式声明（尤其如果未来收紧私有页面的 allow 规则，需同步为新公开页补充 allow 规则）。
2. **未登录可达性**：页面自身（`onLoad`/`onShow`）不得有强制登录跳转；依赖的云函数在匿名/无 `tenantId` 场景下，要明确设计好"该展示什么"，而不是直接 `success:false` 拒绝（参考本文档第 4.2 节的现状问题，避免重蹈覆辙）。
3. **分享卡片**：是否定义了 `onShareAppMessage`/`onShareTimeline`，标题与摘要是否对 GEO/外部引用友好（不要留空退回默认卡片）。
4. **页面配置**：`.json` 是否设置了有辨识度的标题（若使用 `navigationStyle: "custom"`，需在自定义导航栏文案或分享文案里补足，不能两处都空）。
5. **敏感字段脱敏**：涉及金额等财务字段的公开页面，服务端必须按角色脱敏（`sanitizeReportForVolunteer`），不能因为页面"公开"就连角色维度的隐私保护一起去掉。

## 7. 维护须知

新增或调整任何公开页面路由、`sitemap.json` 规则、或全国大屏的匿名访问策略时，必须同步回写本文档，保持"代码现状"与"文档记录"一致；涉及权限模型变更时，同步检查 CLAUDE.md 第 2 节的双轨制原则是否仍然成立。
