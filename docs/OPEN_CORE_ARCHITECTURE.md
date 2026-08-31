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

### ✅ 已整改（2026-08-31 第二阶段）

`cloudfunctions/stampReportChecksum`、`cascadeRecalculator`、`updateAndRecalculateCascade` 三处此前共享同一段代码模式：

```js
const HMAC_SECRET = process.env.LEDGER_HMAC_SECRET || 'yuhua_ledger_default_secret_please_override_in_cloud_env';
```

已改为 `wxPayCore` 同款 fail-closed：

```js
const HMAC_SECRET = process.env.LEDGER_HMAC_SECRET || '';
if (!HMAC_SECRET) {
  console.error('...本云函数拒绝执行任何签名操作（fail-closed）...');
}
// computeChecksum() 内部：!HMAC_SECRET 时直接 throw，不再产出任何基于弱默认值的签名
```

三个文件里所有需要签名的代码路径（`stampReportChecksum` 的盖章、`cascadeRecalculator`/`updateAndRecalculateCascade` 的级联重算与完整性巡检）全部收口经过 `computeChecksum()`，因此在这个函数内部一处 `throw` 即可覆盖所有调用路径，不需要在每个 action 分支里各自加判断。三个文件的 `exports.main` 原本就用 try/catch 包裹全部逻辑并返回 `{success:false, errMsg}`，抛出的异常会被优雅捕获返回给调用方，不会导致云函数进程级崩溃。

**为什么这次判定为安全**：这个改动只影响"环境变量缺失"这一种情形的行为（从"静默用弱默认值签名"变成"拒绝执行并报错"）。只要生产环境已经配置了 `LEDGER_HMAC_SECRET`（不论配置的是什么值），本次改动完全不改变任何运行时行为——密钥值本身没有被本次改动修改或轮换，历史签名的校验结果不受影响。真正会导致历史签名集体失效的操作是"更换密钥的实际取值"，那是一个独立于本次改动的操作决策，不属于本次代码变更的范围。

### ✅ 已核查、无污染

- `miniprogram/utils/dataService.ts`（`saveReport`）、`utils/core/privacy.ts`：grep 确认未引用任何 `PLAN_STORE_LIMITS`/`planType`/`tenant_subscriptions`/`checkTenantPermission` 等商业概念。
- `cloudfunctions/manageVolunteerCheckIn`、`stampReportChecksum`、`publicVerifyReport`、`getReports`、`getSunshineLedger`：grep 确认未引用任何订阅/套餐相关标识符。
- `cloudfunctions/wxPayCore` 的支付凭证读取（`lib/payConfig.js`）：所有真实商户凭证（`WXPAY_APPID`/`WXPAY_MCHID`/`WXPAY_MCH_PRIVATE_KEY`/`WXPAY_API_V3_KEY` 等）已经严格走环境变量 + 缺失时抛错拒绝，是本仓库里"密钥管理"的正面范例，无需整改。
- `WXPAY_INTERNAL_TOKEN`/`LIVE_FACTORY_INTERNAL_TOKEN` 等内部调用令牌：默认值均为空字符串（未配置时 fail-closed 拒绝），无硬编码弱默认值问题。

### 📋 商业配置（非密钥，但需保持在 Enterprise 侧）

平台客服联系方式（`SUPER_ADMIN_CONTACT`/`PLATFORM_SUPPORT_CONTACT`，手机号+微信号）、`PLAN_STORE_LIMITS`、定价文案（`¥1,688/年`/`¥3,688/年`）：均只出现在 `profile.ts`/`statistics.ts`/订阅相关云函数里，未泄漏进任何 Core 候选文件，物理拆库时随所在文件自然留在 Enterprise 侧，无需额外处理。

## 6. 混合文件清单

- **✅ `cloudfunctions/exportAccountExcel`（已于 2026-08-31 第二阶段物理拆分）**：原本 `isNationalExport:false`（Core，单店导出）与 `isNationalExport:true`（Enterprise，合并导出）共用一个 706 行的单文件、共享 `addRecordsSheet()` 等辅助函数。现拆分为：
  - `index.js`（22 行核心逻辑，其余为参数解析/权限校验）：纯路由——解析日期范围、解析调用者身份/权限、收敛查询范围、执行查询、处理 `previewOnly` 预览，最后按 `isNationalExport` 调度到下面两个模块之一。仍是**同一个云函数**（同一个部署单元），不是两个云函数——`isNationalExport` 商业化鉴权（`isAdvancedPlanActive`）与角色鉴权仍在这里做，因为这是"要不要往下走"的前置判断，不属于任何一个导出实现本身。
  - `lib/exportSingleStoreExcel.js`（Core）：`addRecordsSheet()`（单店/单 Sheet 构建器）+ `uploadWorkbookAndRespond()`（工作簿收尾：写 Buffer/上传/取链接/拼审计文本，单店与合并导出共用）+ `buildSingleStoreExport()`（单店导出主流程）。
  - `lib/exportNationalExcel.js`（Enterprise）：`addSummarySheet()`（总览 Sheet）+ `generateVerificationCode()`（存证核验码）+ `isAdvancedPlanActive()`（订阅门禁）+ `buildNationalExport()`（合并导出主流程，`require` 复用 Core 的 `addRecordsSheet`/`uploadWorkbookAndRespond`）。
  - `lib/excelStyles.js`：两侧共用的纯样式常量。
  - **依赖方向**：`exportNationalExcel.js` → `require('./exportSingleStoreExcel')`，反过来不成立——Enterprise 可以依赖 Core，Core 绝不依赖 Enterprise，这是验证"拆分是否干净"的核心判据。未来若要把 Enterprise 部分整个搬进独立仓库/独立云函数，只需要把 `lib/exportNationalExcel.js` 连同 `index.js` 里"`isNationalExport` 商业化鉴权"那几行一起移出去，`lib/exportSingleStoreExcel.js`（连带 `excelStyles.js`）原样留在 Core 仓库继续独立工作。
- **⏳ `pages/statistics/statistics.ts`/`.wxml`/`.wxss`（仍待处理）**：单店历史统计（Core）与全国大屏（Enterprise：`loadNationalDashboard`/`formatNationalMatrixData`/`deriveSupportNeededStores`/SaaS 权益看板等）在同一文件里按 `isAllStoresMode`/`isAdmin` 等条件分支交织。这是全仓库里 Core/Enterprise 耦合最深的单一文件，物理拆分需要把页面本身拆成两个（如 `pages/statistics/statistics` 保留单店视图 + 一个仅 Enterprise 构建才包含的 `pages/enterprise-dashboard/dashboard`），影响面大，需要单独立项评估，本次未处理。

## 7. 部署与生效状态

**第一阶段**（架构规划）：`miniprogram/utils/core/privacy.ts`（含 5 处历史 import 路径更新）、`miniprogram/utils/enterpriseCapabilities.ts`（新增）、`miniprogram/utils/enterpriseSpi.ts`（新增，纯类型定义）、`pages/statistics/statistics.ts`/`.wxml`（改走新封装，行为不变）——纯前端改动，重新编译/预览小程序即可生效。

**第二阶段**（本节，安全收口 + 导出模块拆分）：
- `cloudfunctions/stampReportChecksum`/`cascadeRecalculator`/`updateAndRecalculateCascade`：HMAC 密钥 fail-closed 改造，**功能行为变化**——若生产环境此前从未配置 `LEDGER_HMAC_SECRET`，部署后这三个云函数会立即拒绝执行签名相关操作直至配置该环境变量，需要提前确认生产配置或安排配置窗口。
- `cloudfunctions/exportAccountExcel`：物理拆分为 `index.js` + `lib/*.js` 四个文件，**响应体结构与既有行为完全不变**（`node --check` 通过，函数间调用关系已逐一核对，因本地无 `exceljs` 依赖未做端到端运行时验证，建议部署后跑一次单店导出 + 一次合并导出的真实回归）。
- 均需要重新部署对应云函数（微信开发者工具「上传并部署：云端安装依赖」）才能生效，不涉及数据库结构迁移。
