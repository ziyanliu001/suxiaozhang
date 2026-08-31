# Open-Core 架构拆分方案（2026-08-31 第一阶段）

> 本文档回答"如果要把「素小账」拆成开源 Core + 商业 Enterprise 两部分，边界画在哪里、怎么落地"。第一阶段只完成了规划、SPI 契约定义、一处 Core 工具库的真实抽取（`utils/core/privacy.ts`）与一处前端能力判定层的解耦重构（`utils/enterpriseCapabilities.ts`），**没有**把云函数物理拆库、没有真正发布任何 npm 包/子仓库。这些是本文档明确标注的后续阶段工作，不在本次改动范围内。

## 1. 边界定义原则

一个能力划入 **Core**，当且仅当：

1. 服务的是单店（或同一机构内的多店，但不涉及跨机构/全国聚合）透明记账、义工打卡、存证校验这类"公益信任基础设施"；
2. 不依赖 `tenant_subscriptions` / SaaS 订阅套餐概念——一个完全没有订阅系统的自托管部署，这个能力也该能正常工作；
3. 不包含商业计费规则、私有联系方式、定价文案等敏感/私有信息。

其余（全国大屏跨机构聚合、跨店调拨撮合、多店合并导出、SaaS 订阅配额门禁本身）划入 **Enterprise**。

这与仓库既有的「多租户隔离与全国公信力大屏双轨制设计」（见 `CLAUDE.md`）是**两条不同的轴**：双轨制回答"这个数据能不能免费查看"，Open-Core 拆分回答"这段代码要不要公开源码"。两者有交集但不等价——例如全国大屏的*查看*按双轨制原则应当免费，但按 Open-Core 原则，"全国大屏"这套跨机构聚合的实现代码本身仍划入 Enterprise（不开源），只是 Enterprise 版本运行时对查看不收费。

## 2. Core 层清单（拟开源）

### 云函数（各自独立部署，物理上已经是独立单元，天然适合按目录整体开源）

| 云函数 | 说明 |
| --- | --- |
| `stampReportChecksum` | 单店记账 HMAC 防篡改校验码盖章 |
| `cascadeRecalculator` / `updateAndRecalculateCascade` | 单店资金流水级联重算 + 同一套 HMAC 校验 |
| `publicVerifyReport` | 单条记录的公开核验 |
| `getReports` | 单店/同机构范围内的记录查询（`TENANT_WIDE_ROLES` 分支是机构内部治理，不涉及订阅门禁，仍属 Core） |
| `getSunshineLedger` | 单店阳光账本聚合（含本次新增的 `personalFootprint`）——**注意**：无鉴权设计本身就是为了让它能独立于整个租户/订阅体系工作，是 Core 精神的最佳范例 |
| `manageVolunteerCheckIn` | 义工打卡 + 单店爱心护持榜（`leaderboard` action 限定 `storeId`，不做跨店聚合） |
| `getVolunteerHonorStats` 的 `personal` action | 个人义工荣誉统计（`networkSummary` action 要求 `super_admin` + 跨店聚合，属于 Enterprise 边界灰色地带，见下表） |

### 前端工具库

| 文件 | 说明 |
| --- | --- |
| `miniprogram/utils/core/privacy.ts`（本次从 `utils/privacy.ts` 迁移） | 阳光脱敏规范：`maskName`/`maskPersonName`/`formatDisplayName`/`maskPhone`/`maskIdCard`/`maskBankAccount` |
| `miniprogram/utils/dataService.ts` 的 `saveReport()` | 单店记账写入主路径（含本次新增的 `ocrMetadata` 协议预留） |

云函数目录内部同样各自维护了一份 `maskName` 拷贝（`manageVolunteerCheckIn`、`publicVerifyReport`、`getSunshineLedger`、`getNationalDashboard`）——这是本仓库"云函数间无共享模块机制"的既有约束，不是本次遗留问题，物理拆库时这几份拷贝需要跟着各自所在的云函数走向对应的仓库（Core 云函数拷贝 Core 版本，Enterprise 云函数拷贝同一份规则）。

## 3. Enterprise 层清单（商业私有闭环）

| 云函数/模块 | 商业能力 | 备注 |
| --- | --- | --- |
| `cloudfunctions/getNationalDashboard` | 全国大屏跨机构聚合、跨店调拨撮合（`rebalanceSuggestions`）、存证验真徽章（`auditProofSummary`）、义工全网荣誉榜、SaaS 配额展示（`subscriptionQuota`） | 查看权限本身遵循双轨制免费，但实现代码不开源 |
| `cloudfunctions/exportAccountExcel` 的 `isNationalExport` 分支 | 多店合并阳光台账导出 + 存证核验签名 | ⚠️ **混合文件**，见下方"待办"一节 |
| `cloudfunctions/checkTenantPermission` | SaaS 订阅配额与衍生能力门禁 | |
| `cloudfunctions/activateTenantSubscription` / `manageTenantSubscription` / `createSubscriptionOrder` | 订阅开通/续费/支付下单 | |
| `miniprogram/utils/tenantPermission.ts` | 前端订阅鉴权封装（`FEATURE_KEYS`/`checkTenantPermission()`） | |
| `miniprogram/utils/enterpriseCapabilities.ts`（本次新增） | 前端"商业能力是否可用"判定封装 | 不放进 `utils/core/`，因为它依赖 Enterprise 云函数返回体形状 |
| `pages/profile/profile.ts` 的 `showSubscriptionModal` 及价格/客服联系方式常量 | 定价文案、平台客服微信/电话 | 已核查：这些常量只出现在 `profile.ts`/`statistics.ts` 里，未出现在任何 Core 候选文件中（见第 5 节审计结论） |

## 4. SPI 契约（`miniprogram/utils/enterpriseSpi.ts`，本次新增）

定义了三个契约接口，对应 Enterprise 三个云函数的方法级边界（入参/出参顶层信封）：

- `IDashboardService.getNationalDashboard()` ← `cloudfunctions/getNationalDashboard`
- `IBatchExportService.exportNationalLedger()` ← `cloudfunctions/exportAccountExcel`（仅 `isNationalExport:true` 部分）
- `ISubscriptionQuotaService.checkTenantPermission()` ← `cloudfunctions/checkTenantPermission`

**这是契约定义阶段，不是契约强制阶段**——现有调用点（如 `statistics.ts` 的 `loadNationalDashboard()`）尚未真正 import 这些类型做端到端类型检查，那需要对 `nationalSummary` 五十多个字段逐一建模，属于更大规模的独立类型迁移工作。云函数之间也没有共享模块机制，无法把三份实现合并成一份——这份契约的价值在于：①固定 Core/Enterprise 的方法级边界，供未来任何一方（云函数团队/前端团队/第三方 Enterprise 插件开发者）对齐实现；②物理拆库时作为"这些方法必须存在"的验收清单。

## 5. 敏感信息审计结论

### 🚨 严重（阻断开源前必须处理）

`cloudfunctions/stampReportChecksum`、`cascadeRecalculator`、`updateAndRecalculateCascade` 三处共享同一段代码模式：

```js
const HMAC_SECRET = process.env.LEDGER_HMAC_SECRET || 'yuhua_ledger_default_secret_please_override_in_cloud_env';
```

一旦代码公开，这个硬编码默认密钥人人可见——任何没有在云开发控制台配置 `LEDGER_HMAC_SECRET` 环境变量覆盖的部署，其资金流水防篡改校验码形同虚设，可被任意伪造。对比 `cloudfunctions/wxPayCore` 的 `WXPAY_INTERNAL_TOKEN` 已经采用"未配置直接拒绝"（fail-closed）原则，这三处仍是"未配置则静默使用弱默认值"（fail-open），是已识别但**尚未整改**的风险点。

**本次已做的最小改动**：三处均加了运行时 `console.error` 告警（`LEDGER_HMAC_SECRET` 未配置时打印醒目日志），不改变任何校验行为——因为贸然改成 fail-closed，如果生产环境实际上从未配置过这个环境变量、一直在用默认值盖章，会让历史上所有用默认密钥生成的校验码在改造后集体校验失败，是需要先确认生产环境真实配置状态、再评估切换方案（如按环境变量灰度切换 + 历史数据重新盖章）的变更，风险级别不适合在本次顺带处理。

**开源前必须完成的动作**（人工确认，非代码可自动完成）：
1. 登录微信云开发控制台，确认 `LEDGER_HMAC_SECRET` 环境变量是否已在生产环境配置为真实随机值（而非默认值）。
2. 若已配置：移除代码里的硬编码默认值，改为 `wxPayCore` 同款 fail-closed（未配置直接拒绝执行）。
3. 若未配置：先补配置一个强随机密钥，评估历史校验码是否需要用旧密钥批量重新验证一遍再切换，避免误报"全库数据被篡改"。

### ✅ 已核查、无污染

- `miniprogram/utils/dataService.ts`（`saveReport`）、`utils/core/privacy.ts`：grep 确认未引用任何 `PLAN_STORE_LIMITS`/`planType`/`tenant_subscriptions`/`checkTenantPermission` 等商业概念。
- `cloudfunctions/manageVolunteerCheckIn`、`stampReportChecksum`、`publicVerifyReport`、`getReports`、`getSunshineLedger`：grep 确认未引用任何订阅/套餐相关标识符。
- `cloudfunctions/wxPayCore` 的支付凭证读取（`lib/payConfig.js`）：所有真实商户凭证（`WXPAY_APPID`/`WXPAY_MCHID`/`WXPAY_MCH_PRIVATE_KEY`/`WXPAY_API_V3_KEY` 等）已经严格走环境变量 + 缺失时抛错拒绝，是本仓库里"密钥管理"的正面范例，无需整改。
- `WXPAY_INTERNAL_TOKEN`/`LIVE_FACTORY_INTERNAL_TOKEN` 等内部调用令牌：默认值均为空字符串（未配置时 fail-closed 拒绝），无硬编码弱默认值问题。

### 📋 商业配置（非密钥，但需保持在 Enterprise 侧）

平台客服联系方式（`SUPER_ADMIN_CONTACT`/`PLATFORM_SUPPORT_CONTACT`，手机号+微信号）、`PLAN_STORE_LIMITS`、定价文案（`¥1,688/年`/`¥3,688/年`）：均只出现在 `profile.ts`/`statistics.ts`/订阅相关云函数里，未泄漏进任何 Core 候选文件，物理拆库时随所在文件自然留在 Enterprise 侧，无需额外处理。

## 6. 待办：混合文件清单（后续阶段，本次未处理）

以下文件目前同时包含 Core 与 Enterprise 逻辑，是"能不能干净物理拆库"的主要阻碍，本次评估已识别但未拆分（拆分需要更大改动、更高回归测试成本，超出第一阶段范围）：

- **`cloudfunctions/exportAccountExcel`**：`isNationalExport:false`（Core，单店导出）与 `isNationalExport:true`（Enterprise，合并导出）共用一个云函数文件、共享 `addRecordsSheet()` 等辅助函数。物理拆分方案：Core 保留单店导出逻辑；Enterprise 新建独立云函数（如 `exportNationalLedger`），复制一份 `addRecordsSheet()`（本仓库既有的"跨函数手工同步拷贝"惯例）。
- **`pages/statistics/statistics.ts`/`.wxml`/`.wxss`**：单店历史统计（Core）与全国大屏（Enterprise：`loadNationalDashboard`/`formatNationalMatrixData`/`deriveSupportNeededStores`/SaaS 权益看板等）在同一文件里按 `isAllStoresMode`/`isAdmin` 等条件分支交织。这是全仓库里 Core/Enterprise 耦合最深的单一文件，物理拆分需要把页面本身拆成两个（如 `pages/statistics/statistics` 保留单店视图 + 一个仅 Enterprise 构建才包含的 `pages/enterprise-dashboard/dashboard`），影响面大，需要单独立项评估。

## 7. 部署与生效状态

本阶段代码改动：`miniprogram/utils/core/privacy.ts`（含 2 处历史 import 路径更新）、`miniprogram/utils/enterpriseCapabilities.ts`（新增）、`miniprogram/utils/enterpriseSpi.ts`（新增，纯类型定义）、`pages/statistics/statistics.ts`/`.wxml`（改走新封装，行为不变）、三处云函数的 HMAC 告警日志。均为前端/纯新增文件或不改变运行时行为的重构，重新编译/预览小程序、重新部署三个云函数（仅为了让告警日志生效，不影响现有校验逻辑）即可，不涉及数据迁移。
