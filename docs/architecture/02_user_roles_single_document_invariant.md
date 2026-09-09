# `user_roles` 单文档不变式：严禁同一 openid 多开记录

> **文档定位**：这不是"目标设计 vs 现状"类文档（与 `01_`/`03_` 不同），是一条**当前系统强依赖、违反会导致身份解析随机错乱的硬约束**。任何涉及"一个人要不要同时管理两个机构"这类需求时，先读本文档，再决策。

---

## 一、发现背景（2026-09-09，真实事故级排查）

雨花斋超管账号尝试管理「嵩屿街道敬老中心助餐点」（真实归属租户 `songyu_elderly_care`，与超管自己的 `yuhuazhai_national` 是两个完全独立的机构，见 `fixTenantHierarchy` 迁移记录）时被正确拒绝（详见 `01_sustainable_charity_and_tenant_isolation.md` 与当次排查记录）。业务侧提出的规范授权方案是：给该超管的 `_openid` 在 `user_roles` 里**新增一条**`tenantId: "songyu_elderly_care"` 的独立记录，实现"一人跨租户任职"。

**该方案被否决**，原因见下节——不是"这个需求不合理"，是"当前代码完全没有为这个场景做好准备，新增第二条记录会让全仓库几十处身份解析同时变得不可靠"。

## 二、不变式内容

**`user_roles` 集合假设：每个 `_openid` 至多对应一条文档。**

这不是数据库层面的唯一索引强制约束（代码里没有任何地方校验"这个 openid 是否已存在记录"再决定是否允许新增），而是一条**全仓库几十处云函数共同依赖、但从未被显式声明过的隐性契约**。几乎所有需要"这个调用者是谁"的云函数，都用同一种写法：

```js
const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
```

**没有 `orderBy`，没有任何 tie-break 规则。** 如果这个 `_openid` 真的存在两条文档，`.limit(1)` 返回哪一条完全取决于 MongoDB 内部的物理存储/索引扫描顺序——不保证每次调用都返回同一条，不保证今天和明天的结果一致，也不因为"这次调用的是哪个云函数"而有规律。

至少在以下云函数中确认使用这一模式（并非穷举，这是本仓库"各云函数独立部署、无共享模块机制"这一贯做法导致的重复拷贝，每个文件各自维护一份）：`manageReportApproval`、`manageStoreProfile`、`getStoreList`、`checkUserRole`、`processRoleAudit` 的部分分支。`processRoleAudit.js` 里已有一处显式注释把自己某个特定查询（`getMyApplicationStatus`，按 `applyTime` 倒序取最新 pending 记录）与"`checkUserRole` 那种 `limit(1)` 不保证取到哪条"的查询做了对比区分——这说明这个风险点在本仓库历史上已经被至少一位开发者注意到，但从未被系统性解决或写成规范，只停留在个别代码注释里。

## 三、如果违反会发生什么

一旦同一个 `_openid` 存在两条（或更多）`user_roles` 文档，上面这种写法会让**同一个账号、同一次会话、甚至同一个页面里先后两次不同的云函数调用，可能解析出两个不同的身份**——例如这次调用被当成"雨花斋超管"（`tenantId: yuhuazhai_national`），下一次调用被当成"嵩屿助餐点大家长"（`tenantId: songyu_elderly_care`），没有任何规律、用户也无法主动选择是"以哪个身份"发起这次操作。

这比现在的状态（清晰、一致地拒绝跨机构访问）更糟：现在的报错可预测、可复现、可解释；违反不变式之后的故障是**不确定性**故障——同一个操作有时成功有时失败，有时读到 A 机构数据有时读到 B 机构数据，测试环境可能很难复现，且几乎不可能在不逐一改造全部 resolveCaller 调用点的情况下定位根因。

## 四、`roles` 数组字段不是这个不变式的例外

本仓库确实支持"一个账号兼任多个身份"（个人中心"切换身份"面板，`switchableRoleOptions`），但这是通过**同一条 `user_roles` 文档内的 `roles` 数组字段**（如 `['VOLUNTEER', 'STORE_PATRIARCH']`）实现的——这些角色 token 共享**同一个 `tenantId`/`storeId` 绑定**，是"在同一家门店，身兼数职"，不是"同时隶属两个不同机构"。`tenantId`/`storeId` 在这条文档里仍然是单一值，不是数组，`resolveCaller()` 读到的仍然只有一个明确的租户归属，`.limit(1)` 的前提（每个 openid 只有一条文档）完全没有被这个机制打破。

## 五、方案三：authorizedTenants 轻量租户漫游（2026-09-09 已实施，见下）

本节原先是"如果未来需要支持跨租户任职，要先做什么"的前瞻分析；当天晚些时候该需求真实出现（songyu_elderly_care 确需要雨花斋超管跨租户管理），业务侧与本文档第四节的分析达成一致后，按**不新增第二条文档**的方向落地了一版范围明确收窄的实现，记录如下，供后续类似场景参考。

**核心思路**：不新增文档，只在调用者自己那**唯一一条** `user_roles` 文档上新增 `authorizedTenants` 数组字段（形如 `[{ tenantId, role, stores, grantedBy, grantedAt }]`）。`resolveCaller()` 升级为可选接受 `opts.targetStoreId`/`opts.targetTenantId`：命中 `authorizedTenants` 里的一条授权时，返回一个"有效身份"对象（`tenantId`/`role`/`storeId` 被替换成授权里的值），不传 `opts`（或命中不了任何授权）时返回值与升级前逐字节一致。`.limit(1)` 查询的对象始终只有这一条文档，不变式没有被打破——漫游是"读同一条文档里的新字段"，不是"新增文档后靠运气选中哪条"。

**实际改造范围（刻意收窄，不是"全仓库统一升级"）**：

- 只升级了 `manageReportApproval`（`getMeritStats` 调用点）、`manageStoreProfile`（`get`/`update` 共用的顶层调用点）与 `getPatriarchDashboard`（2026-09-09 追加，见下）这三个云函数的 `resolveCaller()`——都是真实触发过跨租户拒绝的函数，不是"顺手把全部 30+ 处都改了"。**其余几十处 `resolveCaller` 拷贝（`getStoreList`/`checkUserRole`/`processRoleAudit` 等）仍是升级前的纯 `.where({_openid}).limit(1)` 写法，不认识 `authorizedTenants` 字段，也不支持任何漫游**——如果后续某个新场景需要在其他云函数里支持跨租户访问，要照着这几个文件的改法单独升级那个函数，不能假设"方案三已经覆盖全仓库"。
  - **`getPatriarchDashboard` 追加记录**：部署方案三后实测发现，超管漫游到 `songyu_elderly_care` 管理嵩屿助餐点时，个人中心页面加载会弹出"无权限：目标门店不属于您所在的机构"——根因是 `pages/profile/profile.ts` 的 `fetchPatriarchDashboardData()`（家长大盘卡片，`pendingFetches` 后台预取项之一）调用的 `getPatriarchDashboard` 有它自己独立的一份未升级 `resolveCaller`/`resolveTarget`，且失败时用 `wx.showToast` 弹窗（不同于 `fetchMeritStats` 这类背景预取只 `console.warn` 的惯例）。一并修复：① `getPatriarchDashboard` 的 `resolveCaller()` 按同一套 `opts.targetStoreId` 反查 `authorizedTenants` 的写法升级，`exports.main` 改传 `{ targetStoreId: storeId }`；② `fetchPatriarchDashboardData()`/`loadVolunteerStats()` 都从 legacy `getSelectedStore()` 改为 canonical `getCurrentActiveStore()`，并补上 `NATIONAL_STORE_ID_SENTINELS` 过滤（此前 `loadVolunteerStats` 完全没做这层过滤，超管处于"全国总览"时会把哨兵字面量当 storeId 去过滤本地打卡记录，注定查不到任何匹配）；③ `fetchPatriarchDashboardData()` 失败路径的 `wx.showToast` 改为 `console.warn`，改成与 `fetchMeritStats` 同一套"背景预取失败静默降级"惯例——这张卡片查询失败不影响本页任何核心功能。
- 新增 `cloudfunctions/grantTenantAuthorization`：方案三唯一的授权写入入口，仅 `platform_admin` 可调用（`grant`/`revoke`/`list` 三个 action）。`grant` 时强制：目标 `openId` 必须已有 `user_roles` 文档（绝不新建，这是本不变式在代码层的强制落实）、必须显式列出 `stores`（不支持留空即整租户授权，最小权限原则）、按 `tenantId` 去重覆盖、角色白名单排除 `super_admin`/`platform_admin`（这两个角色代表租户/平台最高权威，不该通过一条轻量数组条目批量授予）。
- 前端**无需任何改动**——`fetchMeritStats()`/组织信息配置弹窗此前已经在传 `storeId`（见 commit `9ea7e4b`），`resolveCaller` 新增的 `opts` 逻辑直接复用这个已有参数反查目标 `tenantId`，不需要新增传参路径。

**与第四节"如果未来真的需要支持跨租户任职"当时设想的差异**：当时设想的是"引入显式 `tenantId` 意图 + 全仓库同步改造 resolveCaller"——实际落地时发现不需要"全仓库"，只需要改**真正会被跨租户访问到的那几个函数**，且"显式意图"不需要前端新增参数，服务端可以从已有的 `storeId` 反查出来。这是一个比最初设想更小、更精确的改动面，但第四节列出的风险分析（尤其是"不能只改一个函数就假设全仓库都安全"）依然成立——只是换成了反过来的提醒：**不要假设"方案三"让所有云函数都具备了漫游能力，它只覆盖明确升级过的那几个**。

## 六、当前的安全替代方案（仍然有效，两者并不互斥）

需要一人管理两个独立机构、又不想/不需要引入 `authorizedTenants` 这层复杂度时，使用**两个独立的微信账号**分别绑定到各自机构——每个账号在 `user_roles` 里仍然只有一条记录，不触碰上述不变式，也不依赖任何云函数是否升级过。方案三适用于"同一个自然人希望用同一个微信账号跨机构操作"这个更具体的体验需求；如果这个需求不存在，独立账号仍然是更简单、攻击面更小的默认选择。

## 七、相关文档

- 本次发现这条不变式的完整排查过程与 `store-picker.ts`/`getStoreList` 的配套代码加固：见 commit `42c73b9`（`fix(store-picker): 跨机构发现门店不再被超管身份误标为已授权`）。
- 方案三的完整实现：见 commit `673c99e`（`feat(auth): 实施方案三——authorizedTenants 轻量租户漫游`）。
- 租户隔离的整体模型与雨花斋专区的商业策略例外：`docs/architecture/01_sustainable_charity_and_tenant_isolation.md`。
