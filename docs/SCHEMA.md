# 业务数据字典与接口契约

> 本文档由代码反推生成（2026-09-05），覆盖 `./cloudfunctions/` 与 `./miniprogram/utils/` 中实际落地的数据结构。**如与 `CLAUDE.md` 正文表述冲突，以本文档标注的代码位置为准**——本文档专门记录了几处 CLAUDE.md 正文已经过时或从未完全落地的偏差，见各节 ⚠️ 标注。

---

## 1. 租户与门店模型

### 1.1 `tenants` 集合

| 字段 | 含义 | 来源 |
|---|---|---|
| `tenantId` | 全局唯一租户 ID，格式 `t_<base36时间戳>_<4位随机>` | `cloudfunctions/createTenant/index.js:36-40` |
| `tenantName` | 机构名称 | `cloudfunctions/createTenant/index.js:82` |
| `orgType` | 机构业态标签（见 1.2） | `cloudfunctions/createTenant/index.js:83` |
| `status` | `active` 等状态 | `cloudfunctions/createTenant/index.js:84` |
| `createdBy` / `createdAt` | 创建者 openid / 创建时间 | 同上 |
| `currentStoreCount` | 已接入门店数，`createStore`/`manageTenantSubscription` 原子自增，唯一真源 | `miniprogram/utils/tenantPermission.ts:111-113` |
| `businessType` | ⚠️ 见下方"workspaceType 澄清"，产销工坊租户为 `'live_factory'`，雨花/通用记账租户**不写此字段** | `cloudfunctions/createProductionSpace/index.js:57` |
| `entityType` | 产销工坊专属，观察到取值 `'individual'` | `cloudfunctions/createProductionSpace/index.js:58` |
| `paymentMode` | 产销工坊专属，观察到取值 `'none'` | `cloudfunctions/createProductionSpace/index.js:59` |

**⚠️ `workspaceType` 澄清（重要）**：CLAUDE.md 第 2 节将"工作空间维度"称为 `workspaceType` 字段，枚举"雨花公益食堂专区 / 通用素食记账 / 素食直播产销工坊"三值。**实际代码中不存在名为 `workspaceType` 的字段**（全仓库 `grep -ri workspaceType` 零命中）。真实机制是：
- 产销工坊租户：`tenants.businessType === 'live_factory'`，且**不创建 `stores` 文档**（`createProductionSpace/index.js:3-9` 明确注释"一个租户 = 一个生产工作室"模型，没有多门店语义）。
- 雨花公益食堂专区 / 通用素食记账：**没有专门的区分字段**，两者在数据模型层面是同一种租户（有 `stores` 文档、走 `user_roles` 角色体系），彼此的区分目前仅体现在 `orgType`（横向业态标签）与产品文案层面，不是一个独立的租户级枚举字段。
- 落地新功能时，判断"这个租户是不是产销工坊"应查 `businessType === 'live_factory'`，不要寻找不存在的 `workspaceType` 字段。若确实需要"雨花 vs 通用记账"的租户级区分，目前**没有可用字段**，需先补充设计（⚠️ 待确认/待补齐）。

### 1.2 `orgType` 权威枚举

CLAUDE.md 记录的取值域（`all`/`yuhuazhai`/`elderly_canteen`/`rescue_team`/`volunteer_station`/`children_home`/`other`）**已过时**。当前代码中唯一权威取值域定义在 `miniprogram/utils/constants.ts:30-38`（`ORG_TYPES`），并被 `createTenant`、`createStore`、`manageStoreProfile` 三个云函数各自维护同源拷贝（无跨函数共享模块机制，四处任一取值调整都要同步改另外三处，见 `constants.ts:25-28` 注释）：

| value | label |
|---|---|
| `yuhuazhai` | 雨花斋 |
| `elderly_canteen` | 社区助餐 / 敬老家园 |
| `volunteer_station` | 义工服务站 / 公益团队 |
| `rescue_team` | 应急救援队 |
| `tongxin_children` | 同心 · 儿童关爱 |
| `tongxin_cancer_care` | 同心 · 抗癌关爱 |
| `other` | 其他公益组织 |

无 `children_home`、无 `all`（`all` 是前端"全部平台"筛选态的 UI 语义，不是存储值，未选定具体类型时 `orgType` 字段可为空字符串或历史门店缺省不写）。历史门店（建站前录入）可能没有 `orgType` 字段，`getNationalDashboard` 在"全部平台"模式下正常计入，选定具体类型后会被过滤掉（`cloudfunctions/getNationalDashboard/index.js:410-420`）。

`getNationalDashboard` 另有一个"品牌矩阵"（`platformFamily`）维度，与 `orgType` 筛选互斥，例如"同心慈善会矩阵"覆盖 `tongxin_children` + `tongxin_cancer_care`（`cloudfunctions/getNationalDashboard/index.js:427-429`）。

### 1.3 `stores` 集合（雨花公益 / 通用记账专属，产销工坊租户无此文档）

核心字段（`cloudfunctions/createTenant/index.js:90-108`、`manageStoreProfile/index.js`）：`storeName`、`tenantId`、`status`、`patriarch`/`patriarchOpenId`（大家长姓名/openid）、`manager`/`managerOpenId`（店长姓名/openid）、`address`、`contactPhone`、`province`、`city`、`orgType`、`mealConfig: { supportedMeals: string[] }`（默认 `['lunch']`）、`createdBy`、`createdAt`。

### 1.4 `tenant_members` 集合（产销工坊专属，与 `user_roles` 物理隔离）

⚠️ **架构级隔离，不要合并查询**：`tenant_members` 与雨花公益专区的 `user_roles` 是两个完全独立的集合，字段形状故意保持一致（`_openid`/`tenantId`/`role`/`status`/...）方便复用查询写法，但**物理隔离**——原因是雨花公益专区约 50 个云函数依赖 `db.collection('user_roles').where({_openid}).limit(1)` 这种不带角色过滤条件的查询解析"当前用户的雨花角色"，如果产销工坊成员记录混入同一集合，会导致身兼两种身份的账号被随机命中错误记录，是真实发生过的设计失误（`cloudfunctions/createProductionSpace/index.js:11-20`）。

`tenant_members.role` 取值：`space_owner`（创建者/工坊主）、`producer`/`promoter`（可邀请角色，见 `INVITABLE_ROLES`，`cloudfunctions/manageWorkspaceInvite/index.js:23`）。这三个角色值与下面 2.1 节的六个业务角色**完全独立，互不通用**。

---

## 2. 角色与权限模型

### 2.1 `user_roles` 集合（雨花公益 / 通用记账专属）

真实权威角色枚举，定义于 `miniprogram/utils/authService.ts:23`：

```
'super_admin' | 'store_manager' | 'store_patriarch' | 'finance' | 'volunteer' | 'platform_admin'
```

- `store_patriarch`（大家长）：权限向下继承店长 + 财务的全套日常管理权限（`pages/statistics/statistics.ts:1161-1162`）。对自己租户等价于 `super_admin`（治理类字段：离线检测、联系方式），但 `receiptComplianceRate`/`hasRiskFlag` 等合规审计专属字段仍只对 `super_admin` 开放。
- `platform_admin`：SaaS 平台运维方身份，与业务角色/租户套餐维度完全独立，不属于任何机构的付费主体（`tenantPermission.ts:160-168`）。
- 核心字段：`_openid`、`tenantId`、`storeId`、`storeName`、`realName`、`phone`、`role`、`requestedRole`、`status`（`pending`/`approved`）、`approveTime`、`createTime`（`cloudfunctions/createTenant/index.js:112-127`）。
- `store_family` 是页面展示层用来区分"家人视角"的伪角色，**不在 `UserRole` 枚举里**，缓存时会被规整为 `volunteer`（`authService.ts:412-417`）。

**⚠️ `getNationalDashboard` 的 `ALLOWED_ROLES` 含两个死值**：`cloudfunctions/getNationalDashboard/index.js:252` 定义 `ALLOWED_ROLES = ['super_admin', 'store_patriarch', 'hq_finance', 'regional_finance', 'volunteer']`，其中 `hq_finance`/`regional_finance` **不在 `checkUserRole` 云函数实际下发的角色枚举内**（`pages/statistics/statistics.ts:1168-1172` 明确注释这两个值"永远不会命中的死判断"）。审计/新增角色分支时，以 `authService.ts:23` 的六值枚举为准，不要被这两个遗留值误导为"存在更细的财务角色分层"。

### 2.2 敏感字段脱敏（角色维度，非套餐维度）

`sanitizeReportForVolunteer()`（前端 `miniprogram/utils/dataService.ts:141-166`，云函数侧 `cloudfunctions/getNationalDashboard/index.js:179-209`，两处逻辑各自维护一份同源拷贝）：仅当 `role === 'volunteer'` 时生效，脱敏字段清单（`SENSITIVE_KEYS`）：

`singleMealCost`、`costPerMeal`、`avgMealCost`、`totalIncome`、`totalExpense`、`ingredientExpense`、`nationalTotalIncome`、`nationalTotalExpense`、`nationalNetAccumulation`、`latestBalance`、`balance`、`todayBalance`、`yesterdayBalance`、`fundingDays`、`alertTags`、`rebalanceSuggestions`、`nationalTotalExpenseTrend`、`yangshanAmount`、`yindeAmount`。

这是 CLAUDE.md 强调的"**角色**维度隐私保护，不是**套餐**维度功能锁"的具体落点——务必不要往 `checkTenantPermission()` 里塞这类判断。

---

## 3. 订阅与套餐模型（`tenant_subscriptions` 集合）

字段（权威定义 `cloudfunctions/checkTenantPermission/index.js` + `cloudfunctions/manageTenantSubscription/index.js:588-641`）：

| 字段 | 含义 |
|---|---|
| `tenantId` | 关联租户 |
| `planType` | `'basic'` \| `'pro'` \| `'enterprise'`，到期后服务端自动改写回 `'basic'` |
| `serviceStartDate` / `serviceExpireDate` | `YYYY-MM-DD` 字符串 |
| `cloudQuota.storeLimit` | 门店配额，缺省取 `PLAN_STORE_LIMITS[planType]` |
| `lastRenewedAt` | 服务端时间戳，取"最近一次续费记录"用 `orderBy('lastRenewedAt', 'desc').limit(1)` |
| `isLifetimeGrant` | ⚠️ 终身特权显式布尔标记，**没有发现任何自动化写入路径**（`createStore`/`activateTenantSubscription`/`manageTenantSubscription`/`processRoleAudit` 四处写入点均未设置此字段），推断为平台管理员通过后台人工在文档上直接打标记（与仓库内既有 memory「Perpetual flag must be explicit」一致：不允许从到期日形状反推永久有效）。 |
| `status` | 观察到 `'active'`/`'expired'`/`'suspended'`（`getPlatformOverview/index.js:83-84`） |

`PLAN_STORE_LIMITS = { basic: 2, pro: 10, enterprise: 30 }`——**已知复制粘贴到 5+ 处**（`checkTenantPermission`/`createStore`/`activateTenantSubscription`/`manageTenantSubscription` 等），改配额务必全量搜索同步，不要只改一处（参考仓库既有 memory「Subscription pricing doc」）。

宽限期：`GRACE_PERIOD_DAYS = 7`，到期后 7 天内仍按到期前档位使用，超出才真正降级（`checkTenantPermission/index.js:38-42`）。

### 3.1 `FEATURE_KEYS`（`miniprogram/utils/tenantPermission.ts:37-57`）

三组，**严禁混用**：

1. **免费公开能力**（仅作跨模块标识，禁止传入 `checkTenantPermission()`）：`publicNationalDashboard`、`volunteerCheckIn`、`publicSunshineLedger`。
2. **第一阶段付费能力**（需 `planType` 为 `pro`/`enterprise`）：`excelExport`、`multiStoreDashboard`（已接入实际拦截，字符串值是与服务端 `FEATURE_PLAN_REQUIREMENTS` 的历史约定值，禁止修改）；`advancedRolePermission`、`productionPipeline`、`smsNotification`（仅登记常量，尚未接入拦截）。
3. **第二阶段预留**（功能未建设，仅占位）：`esgCarbonReport`、`d2cSupplyChainOrder`。

服务端功能-套餐矩阵 `FEATURE_PLAN_REQUIREMENTS`（`cloudfunctions/checkTenantPermission/index.js:18-21`）目前只登记了 `multiStoreDashboard`、`excelExport` 两项，未登记的 `featureKey` 一律放行。

---

## 4. 记账流水模型（`report_logs` 集合）

写入唯一入口：`miniprogram/utils/dataService.ts` 的 `saveReport()`（客户端直连数据库写入，**没有云函数中转**，`formattedData` 是白名单机制——不在清单内的字段会被静默丢弃，历史上出过真实数据丢失事故，见 `dataService.ts:238-246` 注释）。

**⚠️ 金额存储口径与 CLAUDE.md 全局军规不一致**：CLAUDE.md 第 3 节要求"金额统一以'分'为单位整型存储"，但 `report_logs` 的金额字段（`yesterdayBalance`/`otherDonation`/`listDonationTotal`/`expenseAmount`/`todayBalance`/`systemBalance`/`adjustedBalance`/`balanceDiff` 等）经 `parseNumber()` 落库，`parseNumber = (v) => parseFloat(v) || 0`（`dataService.ts:96-98`），展示层 `formatMoney()` 直接 `.toFixed(2)`，**没有除以 100 的动作**——即这些字段实际以"元"为单位的浮点数存储，不是分为单位的整型。这条"分"存储规则在本仓库真正落地的地方是**支付类金额**（微信支付订单，见 `cloudfunctions/createSubscriptionOrder/index.js:35-49`，`totalFee: 168800` 注释为 `1688.00 元`），公益记账流水金额字段**不适用**这条规则。新增记账相关字段时按 `report_logs` 现有口径（元浮点数）保持一致，不要擅自改成分存储，否则会和存量数据混算出错；如需推行"分"化改造，需要专项迁移，不在本文档职责范围内提供方案。

### 4.1 `report_logs` 字段一览（`dataService.ts:196-278`）

`dateString`、`reportDate`、`shopName`、`storeId`、`tenantId`、`mpAccount`、`yesterdayBalance`、`otherDonation`、`listDonationTotal`、`expenseAmount`、`expenses`、`dailyExpenseText`、`fixedExpenseText`、`dailyExpenseTotal`、`fixedExpenseTotal`、`fixedExpenseItems[]`、`majorExpenseItems[]`、`dailyIngredientItems[]`、`donationItems[]`、`todayBalance`、`reportText`、`receiptImages[]`、`isManualAdjust`、`systemBalance`、`adjustedBalance`、`balanceDiff`、`adjustReason`、`materials[]`、`volunteerCount`、`volunteerHours`、`diningCount`、`dineInSeniors`、`deliverySeniors`、`dineInVolunteers`、`deliveryVolunteers`、`takeawayCount`、`listeningSeniors`、`totalDineCount`、`totalVolunteers`、`stapleRiceStatus`、`stapleOilStatus`、`isAnonymous`、`ocrMetadata`（`{sourceImageUrl, parsedItemCount, isAutoFilled, ocrRawText}` 或 `null`，目前无前端入口真正填充）、`updateTime`、`isSynced`、`approvalStatus`。

`approvalStatus` 状态机：`'PENDING'`（新记录一律从此起步，无论提交者角色）→ `'APPROVED'` → `'AUDITED_LOCKED'`（终态，由 `manageReportApproval` 云函数由**非本人**执行审核/封账，不存在任何角色可自审自批的捷径）。

---

## 5. 其他已知集合（未逐字段核实，⚠️ 待确认）

以下集合在 `cloudfunctions/` 中被引用，但本次未逐字段核实结构，需要时请直接读取对应云函数源码，不要假设字段名：`activity_logs`、`audit_logs`、`content_audit_logs`、`customer_checkins`、`daily_menus`、`material_logs`、`order_settlements`、`production_capacity_counters`、`production_orders`、`products`、`report_audit_logs`、`sponsors`、`store_invites`、`store_locks`、`subscription_orders`、`tenant_activation_codes`、`user_roles`（角色字段已核实，其余留痕字段未逐一列出）、`users`、`volunteer_duty_logs`、`workspace_invite_codes`。

---

## 维护须知

- 本文档的权威性来自"贴代码位置"，不是来自本身的表述。**任何字段/枚举一旦在代码中变更，必须同步更新本文档对应条目**（这是 CLAUDE.md 治理要求）——尤其是 `orgType`/`businessType` 这类被 3-4 个文件各自维护同源拷贝的取值域，改动时本文档也要算作需要同步的一处。
- 本文档发现的 ⚠️ 标注项（`workspaceType` 字段不存在、`orgType` 枚举过时、`hq_finance`/`regional_finance` 死值、金额分/元口径不一致）建议尽快回写到 `CLAUDE.md` 正文，消除"宪法文档"与实际代码的分歧，避免未来的实现依据过时描述做判断。
- 商业模式/开源边界相关内容分别见 [`BUSINESS_MODEL.md`](./BUSINESS_MODEL.md)、[`OPEN_CORE_ARCHITECTURE.md`](./OPEN_CORE_ARCHITECTURE.md)，本文档不重复覆盖。
