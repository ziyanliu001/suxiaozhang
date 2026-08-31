# Open-Core 架构拆分方案（2026-08-31，已推进至终局阶段）

> 本文档回答"如果要把「素小账」拆成开源 Core + 商业 Enterprise 两部分，边界画在哪里、怎么落地"。第一阶段完成规划、SPI 契约定义、一处 Core 工具库的真实抽取（`utils/core/privacy.ts`）与一处前端能力判定层的解耦重构（`utils/enterpriseCapabilities.ts`）；第二阶段完成 HMAC 密钥 fail-closed 安全收口与 `exportAccountExcel` 的物理拆分；第三阶段交付了真正能跑的 `scripts/build-open-core.js`/`scripts/security-audit.js`；终局阶段（见第 9 节）把 `pages/statistics`/`pages/profile` 里此前一直标记为"深度耦合、本阶段未拆分"的 Enterprise 逻辑，物理搬迁进各自的 `enterprise/` 子目录，是本文档目前对 Core/Enterprise 边界落地最彻底的一次。**仍然没有**把仓库拆成两个独立 Git 仓库/发布任何 npm 包——`dist/suxiaozhang-core` 是本地构建产物，尚未真正对外发布；`pages/statistics`/`pages/profile` 的 WXML/WXSS 标记层仍未物理拆分（见第 9.4 节）。

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

## 8. 第三阶段：物理构建与打包脚本 + 安全防泄露门禁（2026-08-31）

本阶段交付两个可执行脚本（`scripts/build-open-core.js` / `scripts/security-audit.js`），把第一、二阶段的规划性结论变成"能跑出一份真实 zip 包"的工程能力，同时排查过程中发现并处理了两个前两阶段文档未覆盖的边界。

### 8.1 `scripts/build-open-core.js`：源文件枚举方式的关键选择

没有用 `fs.cpSync(ROOT, DIST)` 裸拷贝整个工作目录，而是用 `git ls-files --cached --others --exclude-standard` 枚举文件清单再逐个拷贝。这不是代码洁癖，是排查中发现的真实必要性：仓库根目录躺着一份本地开发者工具生成的 `private.wx967852422ebfce48.key`（小程序代码上传私钥，`.gitignore` 已正确排除，从未进入过 Git 历史）——如果构建脚本直接裸拷贝文件系统，这类"只应该存在于开发者本机、绝不应该出现在任何分发产物里"的文件会被原样带进开源包。借道 `git ls-files` 天然复用仓库已经维护好的 `.gitignore` 规则，把"哪些本地文件不能进构建产物"这条判断的权威来源锚定在 `.gitignore` 本身，而不是在构建脚本里重新维护一份可能过时的排除名单。

### 8.2 Enterprise 排除清单：在第一阶段基础上新增两项

排查确认第 3 节"Enterprise 层清单"遗漏了两个同样应该排除、但物理上恰好足够干净可以直接排除的对象：

- **`cloudfunctions/getPlatformOverview`**：SaaS 平台运维方（开发者/运维团队，区别于任何一个机构自己的 `super_admin`）专用的全平台资源消耗大盘，纯 `count()` 聚合。自托管单机构部署天然没有"平台"这个上级概念，这个云函数对 Core 使用者而言既用不上、语义上也不该存在（它意味着"有一个更高权限的第三方在看我的机构数据"，这与自托管的信任模型矛盾）。
- **`miniprogram/subpackages/admin/pages/platform-admin`**：调用上述云函数的前端页面。这是仓库里少见的"物理上已经是独立页面目录、天然干净可以整目录删除"的 Enterprise 前端资产（不像 `pages/profile`/`pages/statistics` 那样和 Core 逻辑揉在同一个文件里）——排除该目录后，脚本还需要联动改写 `miniprogram/app.json` 里 `admin` 分包 `pages` 数组中对应的路由声明，否则基础库加载 `app.json` 时会因为声明的页面路径在磁盘上找不到文件而直接报错（而不是"优雅降级"），这是本次唯一需要真正解析/改写 JSON 内容（而非整份拷贝/整份替换）的一步。

`cloudfunctions/exportAccountExcel` 按第二阶段已经做好的物理拆分，走"文件覆盖"而非"目录删除"：`lib/exportNationalExcel.js` 直接排除，`index.js` 整份替换成 `scripts/core-overrides/exportAccountExcel.index.js`（一份手写维护的 Core-only 路由分发实现，砍掉 `isNationalExport`/`isAdvancedPlanActive` 分支，其余查询范围收敛/`previewOnly` 预览逻辑与原文件保持一致）。

### 8.3 `pages/profile` 的真实排查结果：比预期更深的耦合，改用运行时旗标而非物理删代码

原计划参照 `exportAccountExcel` 的思路，给 SaaS 订阅弹窗相关代码也做"标记区域 → 脚本自动摘除"式的物理拆分。排查 `pages/profile/profile.wxml`/`profile.ts` 后发现这条路走不通：

- 订阅弹窗的入口点**分散在页面三处**（`isFinance` 角色卡片里的 `pro-service-card`、`isPatriarch`/`isManager` 顶部卡片区的 `top-advanced-secondary`、超管 Dev/Debug 专区的 `sa-dev-tool-row`），外加 `onShow` 生命周期里一处"从统计页跳转过来自动唤起弹窗"的逻辑（`takeOpenSubscriptionRequest()`），全部散落调用同一个 `onOpenSubscriptionModal()`方法。
- 弹窗本体（`<view class="subscription-modal-mask">`）虽然在 WXML 里是一段干净、自成一体的区块（`profile.wxml` 2343~2617 行），但四处调用入口分散在文件各处，用脚本按区域标记（`#region`/`#endregion`）自动摘除，漏删任意一处入口就会在 Core 包里留下一个"指向已删除弹窗方法"的死按钮，比不删更差。

因此改用**运行时旗标**：新增 `miniprogram/utils/buildFlags.ts`，导出单一常量 `ENTERPRISE_BUILD_ENABLED`（默认 `true`）。`onOpenSubscriptionModal()`——四处入口的唯一汇合点——开头加一行 `if (!ENTERPRISE_BUILD_ENABLED) return;`，四处 WXML 渲染位置也都加上 `enterpriseBuildEnabled &&` 前缀条件（页面 `data` 里镜像一份 `enterpriseBuildEnabled: ENTERPRISE_BUILD_ENABLED`，WXML 表达式读不到 import 进来的模块变量）。`scripts/build-open-core.js` 打包时用 `scripts/core-overrides/buildFlags.core.ts`（内容只有 `ENTERPRISE_BUILD_ENABLED = false` 这一行取值不同）整份覆盖掉这个文件。

**效果边界要说清楚**：这实现的是"运行时完全不可达"——Core 包编译出的小程序里，用户绝对看不到、点不开任何 SaaS 购买/续费入口，不存在"旗标失效露出弹窗"的可能（四处入口全部显式判断，不是靠某一处兜底）。但**没有**实现"源码文本纯净"——`profile.ts` 里的定价常量（`PLAN_ACTION_META` 里的 `¥1,688/年`/`¥3,688/年`）、平台客服联系方式等，物理上仍然存在于开源包的这个文件里，只是被判定为死代码。要做到源码级纯净，需要先把订阅相关 UI 抽成独立页面/组件——这是比"写构建脚本"更大的一块独立工作量，本阶段不做，如实记录在这里，构建脚本运行时也会把这条"已知遗留"打印在控制台。

`pages/statistics/statistics.ts`/`.wxml`/`.wxss`（第 6 节已经记录的"仍待处理"混合文件）本阶段同样不处理，原样保留在 Core 包里——全国大屏相关调用会因为 `getNationalDashboard` 云函数已被排除而在运行时优雅失败（不是崩溃），不影响单店历史统计功能正常使用。

`miniprogram/utils/tenantPermission.ts`/`enterpriseCapabilities.ts`/`enterpriseSpi.ts` 这三个前两阶段就存在的 Enterprise 前端工具文件，本阶段判定为**保留在 Core 包内、不排除**——排查发现 `pages/history/history.ts`（单店历史页，Core）也在用 `checkTenantPermission(FEATURE_KEYS.EXCEL_EXPORT)` 做导出功能的能力探测，排除这个文件会直接破坏 Core 包的编译。而且 `tenantPermission.ts` 自带的 `FALLBACK_ALLOWED`（云调用失败时保守放行）与 `isCloudAvailable()` 判断，在 Core 部署下（`checkTenantPermission` 云函数已被排除、调用必然失败）恰好自然产生"自托管环境没有订阅系统，默认允许使用"的正确行为，不需要额外写一份 stub 替换——这是排查后确认的一个既有安全设计的正面副作用，不是本次新写的代码。

### 8.4 `scripts/security-audit.js`：规则设计与自测结果

扫描规则覆盖 PEM 私钥块、疑似硬编码微信 AppSecret（32 位十六进制）、疑似硬编码商户号（`mchid` 赋值且同行不含 `process.env`）、密钥类环境变量的非空硬编码兜底值（形如 `process.env.XXX_SECRET || '一个非空字符串'`）、已知历史泄露默认值回归检测（`yuhua_ledger_default_secret_please_override_in_cloud_env` 字面量），以及目录中直接存在 `.key`/`.pem`/`.p12`/`.pfx` 文件本身。

**自测**：用一份包含全部六类违规的合成测试文件跑过一遍，六项全部命中、exit code 1；同一份测试里 `process.env.WXPAY_MCHID || ''`（仓库里真实的 fail-closed 写法）未被误报。对仓库全量源码跑一遍会命中 `docs/OPEN_CORE_ARCHITECTURE.md`（本文档引用历史问题字符串做说明）与本地未纳入 Git 的 `private.wx967852422ebfce48.key`——前者已通过限定"已知历史泄露默认值回归"规则只扫描 `.js`/`.ts` 排除，后者是真实存在于开发者本机磁盘、但从未进入 Git 历史的文件，属于工具按设计正确报告的情况，不是误报。对 `scripts/build-open-core.js` 生成的 `dist/suxiaozhang-core` 产物跑一遍（`docs/`/`scripts/` 均已被排除在外）结果是全绿。

### 8.5 部署状态说明

本节两个脚本均为纯 Node.js 脚本（`node --check` 通过），不依赖任何新增 npm 包，`package.json` 新增 `build:core`/`security-audit` 两条命令。`tsconfig.json` 补充 `exclude: ["dist"]`——否则跑过一次 `build:core` 后本地目录会同时存在 `miniprogram/` 源码与 `dist/suxiaozhang-core/miniprogram/` 副本，`tsc --noEmit` 会报一堆"重复声明"的假阳性错误。`miniprogram/pages/profile/profile.ts`/`.wxml` 新增 `ENTERPRISE_BUILD_ENABLED` 旗标判断，`tsc --noEmit` 与 WXML 标签平衡校验均已通过，重新编译/预览小程序即可生效，不涉及云函数改动、不涉及数据库结构迁移。`dist/` 目录已加入 `.gitignore`，构建产物不进入版本库。

## 9. 终局阶段：pages/statistics 与 pages/profile 的物理模块拆解（2026-08-31）

第 8 节交付的构建脚本证明了"能不能打包出一份 Core 发布包"，但当时 `pages/statistics`/`pages/profile` 两个页面的 Enterprise 逻辑还只是**运行时旗标隔离**——源码文本仍然物理混在一个文件里，只是通过 `ENTERPRISE_BUILD_ENABLED` 判断让它在 Core 构建下"跑不到"。本阶段把这两处真正拆成独立文件，用与 `exportAccountExcel`（第二阶段）完全一致的手法：**真实实现文件（enterprise/ 子目录）+ Core-only stub（core-overrides/）**。

### 9.1 statistics.ts：比预期分散得多，按内容逐个甄别而非按行区间整体切割

原计划参照任务描述的三个模块名字，先入为主以为可以整块搬迁 `loadNationalDashboard`/`onDrillDownStore`/集采直通车三段代码。实际排查后发现全国大屏相关方法**散落在文件的 5 个不连续区间**里（地区/自定义门店筛选、排行榜 Tab、门店健康告警、全国 CSV/Excel 导出、SaaS 权益看板、集采直通车、公示海报……），与 `switchViewMode`/`loadShopList`/`onSuperAdminSelectStore` 等 Core 方法犬牙交错。逐个方法核对调用关系（哪些方法只被 Enterprise 方法调用、哪些被 Core 生命周期方法调用）后确认：

- **移入 `pages/statistics/enterprise/nationalDashboardService.ts`**（1394 行）：全国大屏数据拉取 + SWR 本地快照、地区/自定义门店筛选整套弹窗、超管高阶面板（排行榜/健康告警/离线督导）、全国运营/财务 CSV 报表、机构 SaaS 权益看板与套餐升级引导、多店合并 Excel 导出、全国公示海报。
- **移入 `pages/statistics/enterprise/drillDownHandler.ts`**（59 行）：矩阵行点击下钻单店 + 返回全国大屏。
- **移入 `pages/statistics/enterprise/procurementHandler.ts`**（36 行）：爱心粮油集采直通车弹窗与意向登记。
- **确认保留在 Core（曾经怀疑但排查后判定不该移）**：`stopPropagation`（三处弹窗共用的空操作，非 Enterprise 专属）、`ensureStoreDirectory` 的调用方 `loadShopList`（超管门店选择器构建，本身是 Core 治理能力）、`onSwitchToAllStores`（同租户内"全部门店"聚合视图，与真正跨租户的 `onGoToNationalDashboard` 是两个不同概念，前者留 Core、后者归 Enterprise）、`roundRect`/`getSafeSystemInfo`（Core 海报绘制方法与 Enterprise 全国海报共用的画布工具函数）。
- `statistics.ts` 净减少 **1455 行**（6124 → 4669），Enterprise 侧新增 1394+59+36=1489 行（含约 35 行三文件各自的头部说明注释，比原地略多属正常）。

### 9.2 profile.ts：三个可安全外置的模块级常量 + 一个方法簇

排查确认 SaaS 订阅相关的常量（`PLAN_LABELS`/`PLAN_RANK`/`PLAN_ACTION_META`/`isPerpetualPlan`/`formatTenantExpireText`/`computeIOSPlanActionLabels`/`computeRedundantRenewFlag`）与方法簇（`fetchSubscriptionInfo` 至 `onSubscribeAdvancedFeature` 共 17 个方法）在 profile.ts 里全部只互相引用、不被文件其余部分调用——比 statistics.ts 干净得多，一次性整体移入 `pages/profile/enterprise/saasSubscriptionHandler.ts`（510 行）。`profile.ts` 净减少 **478 行**（6278 → 5800）。

上一阶段已经加在 `onOpenSubscriptionModal()` 开头的 `if (!ENTERPRISE_BUILD_ENABLED) return;` 早退**原样保留、跟着方法一起搬迁**——物理隔离（Core 构建整份删掉这个文件）与运行时旗标（完整版下运营侧可能想临时关闭购买入口）是两件不冲突的事，不需要二选一。

### 9.3 汇合点 + Core-only stub：两页统一同一套模式

`pages/statistics/enterprise/index.ts`、`pages/profile/enterprise/index.ts` 各自作为唯一的 re-export 汇合点——两个页面主文件只 `import ... from './enterprise'`，不直接 import 子模块。`scripts/build-open-core.js` 打包时：

1. 用 `scripts/core-overrides/statistics.enterprise.index.ts` / `profile.enterprise.index.ts` 整份覆盖对应的 `enterprise/index.ts`，导出结构（同名对象/函数）与原文件完全一致，方法体全部改成安全空操作或最基本兜底返回值；
2. 物理删除四个真实实现文件（`nationalDashboardService.ts`/`drillDownHandler.ts`/`procurementHandler.ts`/`saasSubscriptionHandler.ts`）。

Stub 方法覆盖范围**不是只覆盖"字面被外部调用"的那几个**，而是覆盖导出对象里的全部方法名——原因是 `statistics.ts` 里仍有几处 Core 生命周期代码（`applyRolePermissions` 的超管默认视图分支、`loadShopList`、`fetchStatistics`/`loadStatistics`/`onRefreshData`、`exportToExcel` 的订阅拦截兜底）会调用到 `loadNationalDashboard`/`ensureStoreDirectory`/`onOpenPlanUpgradeModal` 这三个"看似纯 Enterprise"的方法，逐一核对确认后：`loadNationalDashboard`/`_triggerPatriarchNationalView` 空操作即可（Core 部署下这些调用点本就不会产生数据）；`ensureStoreDirectory` 的 stub 返回 `true`（让调用方后续流程正常往下走，只是拿不到全国门店目录）；`onOpenPlanUpgradeModal` 空操作是安全的（Core 部署没有 `checkTenantPermission` 云函数，`FALLBACK_ALLOWED` 保守放行机制决定了触发这个方法的分支在 Core 下几乎不可达）。

### 9.4 验证：不只是"tsc 不报错"，而是真的编译了一遍 Core 包

除了常规的 `npx tsc --noEmit`（对完整版源码）与 WXML 标签平衡校验，本次额外做了一步更硬的验证：执行 `npm run build:core` 生成 `dist/suxiaozhang-core` 后，**直接 cd 进这个目录、用项目自己 pin 住的 TypeScript 版本，对着 Core 包自带的 `tsconfig.json` 跑一遍完整的 `tsc --noEmit`**（而不是只对着完整版仓库跑）。结果零报错——这是比"抽象上应该能编译"更强的证据：证明 Core 包的 `import` 图（`statistics.ts`/`profile.ts` → 各自的 `enterprise/index.ts` stub）在物理删除了三/四个真实文件之后依然自洽，不存在任何遗漏的死引用。

`security-audit.js` 对同一份 `dist/suxiaozhang-core` 产物扫描结果全绿。人工核对确认两处预期内的残留（`profile.wxml` 里的 `¥1,688` 定价文案、`profile.ts` 里 `SUPER_ADMIN_CONTACT` 的客服微信号）——前者见 9.5 节"已知遗留"，后者是"联系超级管理员协助权限调整"这一 Core 治理功能真实复用的常量，与 SaaS 无关，留在 Core 属于正确行为，均非 bug。

### 9.5 已知遗留：WXML/WXSS 标记层仍未物理拆分

本阶段拆的是**逻辑层**（.ts 方法/常量），**标记层**（.wxml/.wxss）刻意没有动：

- `statistics.wxml`/`.wxss` 里全国大屏与单店历史统计的 `<view>` 结构仍交织在同一份文件里——对应的 `.ts` 逻辑已经 stub 化、`getNationalDashboard` 云函数也已被排除，Core 部署下这些区块渲染出的是空数据兜底态（不会报错，也不会显示任何真实全国数据），但 WXML 源码文本本身还留在 Core 包里。
- `profile.wxml` 的四处 SaaS 订阅入口（`pro-service-card`/`top-advanced-secondary`/`sa-dev-tool-row`/`subscription-modal-mask`）已有 `enterpriseBuildEnabled &&` 前置条件（上一阶段加的），Core 构建下运行时完全不渲染，但同样是"标记还在、判断为假"而不是"标记被物理删除"。

要做到 WXML 层也物理纯净，需要把这些区块拆成独立的 `.wxml` 片段（`<import>`/`<template>`）或整页拆分（如 `pages/statistics` 拆成 Core 版 + 仅 Enterprise 构建才包含的 `pages/enterprise-dashboard`），是比本次"方法级搬迁"更大的一次页面级重构，本阶段不做，如实记录，不假装已经完成。
