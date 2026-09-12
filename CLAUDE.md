# 素小账项目开发核心规范与 Agent 宪法 (CLAUDE.md)

## 0. 核心宪法与开发工作流 (The Golden Rules)
- **知识库唯一真源**：本项目的一切业务规则、需求边界及设计哲学受控于 `./docs/`（对应 Obsidian 智慧库）。严禁脱离文档主观臆测、擅自扩张未授权功能或过度设计。
- **任务三步执行法**：
  1. **对齐**：接手任务先核查 `./docs/` 相关文档，并在动手前明确本任务属于【轨道一：业务工作空间】还是【轨道二：全国大屏】。
  2. **提审**：修改多文件或核心逻辑前，向我简短阐述实现思路、受影响的租户边界与文件清单。
  3. **落地与回写**：完成编码与自测。如遇文档未定义的边界或新的技术决策，完成编码后主动提示我回写更新 Obsidian。
- **克制原则**：严禁自行引入未经许可的第三方 npm 包、重型组件库；严禁私自修改现有全局样式或数据结构协议。

---

## 1. 相关文档索引 (Obsidian 知识库映射)

- [平台商业化战略与盈利模型体系](docs/BUSINESS_MODEL.md) —— 公益专区（免费/公信力）与商业专区（付费/盈利）两阶段商业模式；本文件「双轨制设计」是其中“全国大屏必须免费查看”这条原则在具体功能上的落地判例，做权限/定价相关改动前先对照该文档定位战略象限。
- [Open-Core 架构拆分方案](docs/OPEN_CORE_ARCHITECTURE.md) —— 开源 Core / 商业 Enterprise 的代码边界定义、SPI 契约、敏感信息审计结论与混合文件待办清单；这是与“双轨制设计”不同的另一根轴（双轨制回答“能不能免费看”，本文档回答“代码要不要开源”），新增 Core 候选文件前先核对第 5 节的审计标准，不要引入商业概念污染。
- [业务数据字典与接口契约](docs/SCHEMA.md) —— 租户字段、流水模型、大家长/财务/志工权限角色映射。
- [微信小程序 GEO 与外网引流策略](docs/GEO_STRATEGY.md) —— 公开大屏与落地页的外网 AI 引用与搜一搜收录规则。

> ⚠️ 本地 Obsidian 知识库的真实磁盘路径是 `/home/ziyan/文档/Obsidian Vault/01-Projects/素小账/`（入口 `00-素小账-MOC.md`），不是仓库内 `docs/`——`docs/*.md` 是从这个 vault 手动同步过来的快照副本，两边不会自动保持一致。查阅历史设计决策/排查过往故障时优先去 vault 原文（尤其是 `02-技术与契约/踩坑记录与性能调优.md` 这类持续追加的踩坑记录，`docs/` 快照通常没有同步这么细），改动完成后按第 0 节"落地与回写"提示用户同步回 vault，而不是想当然地认为 `docs/` 已经是最新的。

---

## 2. 多租户隔离与全国公信力大屏双轨制设计 (最高业务准则)

本项目的数据展示分两条彻底解耦的轨道，任何新功能在落地前先判断自己属于哪一条，不要混用两边的权限逻辑。

### 轨道一：业务工作空间（Workspace / 生产台）
- **定位**：私有业务生产与记账工具，数据严格按 `tenantId` 隔离。
- **⚠️ 术语澄清（原“`workspaceType`”表述已废止）**：本节曾用「`workspaceType`：雨花公益食堂专区 / 通用素食记账 / 素食直播产销工坊」描述三种工作空间，但**代码中不存在名为 `workspaceType` 的字段**（全仓库 grep 零命中，详见 [`SCHEMA.md`](docs/SCHEMA.md) 1.1 节）。真实机制是 `tenants.businessType === 'live_factory'`——产销工坊租户以此标记，且不创建 `stores` 文档（一个租户即一个生产工作室，无多门店语义）；雨花公益食堂专区与通用素食记账**目前在数据模型层面没有区分字段**，两者共享同一套 `stores` + `user_roles` 体系，区分仅停留在产品文案层面。新功能若需要“雨花 vs 通用记账”的租户级判断，当前无可用字段，需先补充设计，不要凭空引用 `workspaceType`。
- **套餐升级逻辑**：`tenant_subscriptions`（`basic`/`pro`/`enterprise`）购买的是**私有功能深度**——多店连锁管理的深度操作（如 Excel 批量导出、进销存排单、多角色协同），而不是“能不能看自己机构的基础数据”。绝不可跨空间查看其他商业租户的私密流水（`makeTenantFilter(tenantId)` 是唯一真源，任何查询都不能因为筛选条件而退化成跨租户全量聚合）。
- **代码入口**：`utils/tenantPermission.ts` 的 `FEATURE_KEYS`（`MULTI_STORE_DASHBOARD`、`EXCEL_EXPORT`）+ `checkTenantPermission()`。

### 轨道二：全国大屏（Dashboard / 透视台）
**全国大屏维度**：全网爱心与公益公信力总览。
- **定位**：社会公信力、透明公开账目与爱心公示，服务于“让所有人看见善意”这一目标。
- **权限逻辑**：**查看权限完全不挂钩商业套餐**——角色卡口（`ALLOWED_ROLES`）+ 租户隔离仍然生效（不跨租户），但不因为租户是 `basic` 套餐就拒绝查看。财务类敏感字段（收支金额、结余）继续按角色脱敏展示（`sanitizeReportForVolunteer`、前端 `isManager` 判断），这是**角色**维度的隐私保护，不是**套餐**维度的功能锁，两者不要混为一谈。⚠️ `ALLOWED_ROLES` 中的 `hq_finance`/`regional_finance` 是历史死值，`checkUserRole` 永远不会下发这两个值，角色枚举以 [`SCHEMA.md`](docs/SCHEMA.md) 2.1 节的六值权威枚举（`super_admin`/`store_manager`/`store_patriarch`/`finance`/`volunteer`/`platform_admin`）为准。
- **代码入口**：`cloudfunctions/getNationalDashboard`、`pages/statistics/statistics.ts` 的 `loadNationalDashboard()`/`_triggerPatriarchNationalView()`。

### 三条业务线各自的关键技术护栏（2026-09-11 补充）
轨道一内部按 `businessType`/共享的 `stores`+`user_roles` 体系实际运行着三条产品形态（见上方"⚠️ 术语澄清"，三者不是靠一个独立字段区分，而是各自散落在不同代码入口），各自有一条不可绕过的技术护栏：
- **雨花公益食堂专区**：`report_logs` 流水的防篡改签名依赖 `LEDGER_HMAC_SECRET` 环境变量——`cloudfunctions/stampReportChecksum`/`cascadeRecalculator`/`updateAndRecalculateCascade` 三个云函数均已实现 **fail-closed**（环境变量缺失时直接抛错拒绝签名/重算，绝不回退到弱默认密钥）。新增任何涉及流水签名/级联重算的云函数必须延续这个口径，宁可拒绝执行也不能签一个不安全的假签名。
  - **阳光账本四态审批流**（`cloudfunctions/manageReportApproval/index.js`，服务端集中管控，不允许小程序端直接 `wx.cloud.database()` 改 `approvalStatus`）：`PENDING`（待确认）→ `APPROVED`（店长/大家长 `confirm` 核对确认）→ `AUDITED_LOCKED`（财务 `financeAudit` 稽核封账，仅能通过 `unlock` 并填写理由退回 `APPROVED`）；`isVoid`/`voidPending` 是与上述状态机并行的作废（红字冲销）分支——店长发起作废需大家长/超管二次确认才真正生效，确认后触发 `cascadeRecalculator` 级联重算后续结余。
  - **自审自批熔断（硬约束）**：`SELF_ACTION_BLOCKED_ACTIONS = ['confirm', 'financeAudit', 'unlock']`——提交人本人**禁止**对自己提交的记录执行这三个动作，必须由同店其他店长/财务/大家长处理，服务端强制校验、不是前端隐藏按钮那种软限制。新增任何审批类动作时，先问一句"这个动作要不要也加进自审自批熔断名单"，不要默认继承旧逻辑就以为已经覆盖。
- **通用素食/门店记账（SaaS 订阅）**：配额门禁见上文"轨道一"小节；iOS 端因平台审核规则，购买/续费入口必须**物理隐藏**（`utils/util.ts` 的 `isIOSDevice()` 判断，代码入口 `pages/profile/enterprise/saasSubscriptionHandler.ts`），改为引导走企业授权码/兑换卡自助开通，不能让 iOS 用户看到任何应用内支付按钮。
- **素食直播产销工坊**：`subpackages/factory`，产能占用/分账快照/退款红冲这类"改数据"操作全部收敛进 `cloudfunctions/liveFactoryCore`（纯基础设施层），与雨花斋记账体系无交叉引用。

⚠️ **善款支付红线**：`report_logs`（公益记账流水）**绝不接入任何在线支付**，捐赠/随喜均为线下录入。`cloudfunctions/wxPayCore` 本身是与具体业务解耦的通用支付基础设施（`bizType`/`bizId` 由调用方自定义，不是写死的枚举），当前只被 `createSubscriptionOrder`（SaaS 订阅）与 `createProductionOrder`/`processProductionRefund`/`completeProductionOrder`（工坊订单）四个云函数调用——这是"目前只有这两条业务线在用"的事实状态，不是 `wxPayCore` 内部有硬编码的白名单校验，新增业务线要接入支付时代码层面不会自动拦截，需要人工确认这笔钱是否属于"善款"范畴。

### 数据分类口径正交独立
- **`businessType`**（原表述为 `workspaceType`，该术语已废止）：决定业务表单与流程流转的粗粒度租户类型，目前唯一有落地区分力的取值是 `'live_factory'`（产销工坊）；雨花公益食堂专区/通用素食记账无独立取值，共享同一套数据模型。
- **`orgType`**（组织类型，权威枚举见 [`SCHEMA.md`](docs/SCHEMA.md) 1.2 节，当前代码真实取值为 `yuhuazhai`/`elderly_canteen`/`volunteer_station`/`rescue_team`/`tongxin_children`/`tongxin_cancer_care`/`other`——本节此前记录的 `children_home` 不存在，`all` 只是前端“全部平台”筛选态的 UI 语义、不是存储值）：用于全国大屏横向分类聚合（如“全部平台/雨花斋/助老食堂/救援队”Tab），是租户内部门店的业态标签，**不受当前所在工作空间上下文的租户 ID 强制截断**——同一租户下可以同时存在多个 `orgType` 的门店，全国大屏据此做横向分组，而不是反过来用 `orgType` 去圈定或替代 `tenantId` 隔离边界。`getNationalDashboard` 另有一个与 `orgType` 筛选互斥的“品牌矩阵”（`platformFamily`）维度，详见 SCHEMA.md 1.2 节末尾。

### 判断新功能该走哪条轨道的经验法则
问自己：“这个功能是在回答『我的机构做得怎么样』（工作空间），还是『整个爱心网络的公开成果是什么』（全国大屏）？” 前者可以合理地挂订阅套餐，后者原则上应该始终可查看（导出/深度筛选等衍生能力仍可单独挂套餐，但“能不能看基础数据”本身不应该挂）。

> **历史教训**：`getNationalDashboard` 曾经把“查看全国大屏”和“`tenant_subscriptions` 是否为 pro/enterprise”耦合在一起（`PLAN_UPGRADE_REQUIRED` 拦截），导致基础版租户的大家长/财务/志工角色切换组织类型 Tab 时每次请求都被服务端拒绝，界面表现为“点了没反应”——这正是把两条轨道的权限逻辑混在一起导致的典型问题。修复见 2026-08-30 的 commit。
>
> **✅ 已修复（2026-09-05，commit 648a303）**：`getNationalDashboard` 曾经要求用调用者 `OPENID` 反查出 `tenantId`，反查失败直接 `success:false` 拒绝，导致从未加入任何机构的纯匿名访客（例如搜一搜/外部 AI 引荐进来的陌生人）即便通过了角色卡口也无法查看全国大屏，与本节"全国大屏应始终可查看"的战略目标存在缺口。现已改为：`tenantId` 反查为空时分流到 `buildPublicAggregateSummary()`（与本机构大屏彻底独立的只读聚合分支，只返回机构数/门店数/服务人次/义工工时等非金额指标，不读取任何原始文档或财务字段），纯匿名访客也能看到脱敏后的全国聚合数据。详见 [`GEO_STRATEGY.md`](docs/GEO_STRATEGY.md) 第 4.2 节。

---

## 3. 微信小程序与云开发工程军规 (Strict Constraints)

- **性能与 setData 铁律**：
  - 严禁全量更新页面 `data`（严禁 `this.setData(this.data)`），必须采用具体路径更新（如 `this.setData({ ['list[' + index + '].status']: 1 })`）。
  - 与视图渲染无关的临时变量（防抖定时器、锁、临时请求缓存）必须挂载在页面实例 `this` 上，严禁写入 `data` 占用通讯通道。
- **云函数与数据安全**：
  - 云函数查询数据库时，业务工作空间查询必须强校验 `tenantId`，严禁未经过滤直接执行全表 scan。
  - **云函数超时配置**：涉及图像/OCR/批量导出这类真实网络往返较长的云函数，`config.json` 必须显式配置 `timeout: 20`（秒）以上——不写这个字段会静默走平台默认的 3 秒，历史上 `-504003 FUNCTIONS_TIME_LIMIT_EXCEEDED` 报错的真实根因几乎都是这个默认值太短，不是业务逻辑本身慢。配套前端调用等待上限（`callFunctionWithTimeout` 的超时参数）要显式提到 `25000`ms 左右（比云端 20s 上限再留 5s 网络往返余量），两端超时预算必须一起调，只改一边等于没修。
  - **小程序码 `scene` 参数 32 字符硬顶**：`wxacode.getUnlimited` 的 `scene` 字段有官方 32 字符硬限制，拼任何业务标识（如 `storeId` 这类 32 位十六进制 Mongo `_id`）进 `scene` 前必须先做 Base36 压缩（`cloudfunctions/getStoreQRCode` 的 `hexToBase36()` 是现成实现，不要重新发明一套），并在拼接后显式校验 `scene.length <= 32`、超限时返回明确错误而不是让微信接口报一个不好排查的业务错误码。生成二维码时同时传 `check_path: false`（官方文档记录的必要参数，跳过路径存在性校验）。
  - **金额存储口径（⚠️ 按业务线区分，不是单一全局规则）**：
    - **支付类金额**（微信支付订单，如 `cloudfunctions/createSubscriptionOrder`）以“分”为单位整型存储（如 `totalFee: 168800` 即 1688.00 元），前端展示除以 100 并格式化——这条规则只在支付链路真正落地。
    - **公益记账流水**（`report_logs` 集合，唯一写入入口是 `dataService.ts` 的 `saveReport()`）历史上一直以“元”为单位的浮点数存储（`parseNumber = (v) => parseFloat(v) || 0`），展示层 `formatMoney()` 直接 `.toFixed(2)`，**没有除以 100 的动作**。新增/修改记账相关金额字段时延续现有“元”浮点口径，不要擅自改成“分”整型，否则会与存量数据混算出错；如确需推行统一分化改造，需要专项迁移方案，不能顺手改。
    - 两套口径的代码位置与字段清单详见 [`SCHEMA.md`](docs/SCHEMA.md) 第 4 节。
- **样式与适配**：
  - 严格使用 `rpx` 布局，保障各机型无缝适配；核心卡片与文字遵守项目主视觉调性。
  - **长者模式（`careMode`）**：`app.globalData.careMode` + 本地存储镜像（见 `pages/index/index.ts`）。适老化交互优先用大字号覆盖层/放大触控热区 + `wx.vibrateShort` 物理震动反馈（已有先例：`{type:'heavy'}` 用于强确认场景、`{type:'light'}` 用于轻量成功反馈），不要依赖 `wx.showToast`——它的字号/时长不受小程序自定义控制，对老花眼/弱视用户不够醒目可靠。
- **Open-Core 单向依赖**：新增/改动任何可能落入 Core 候选范围的文件前，先确认依赖方向——**Enterprise 可以 `require`/`import` Core，Core 绝不能反向依赖 Enterprise**（这是 [`OPEN_CORE_ARCHITECTURE.md`](docs/OPEN_CORE_ARCHITECTURE.md) 验证"拆分是否干净"的核心判据）。视图层同理：Enterprise 专属的 WXML 区块用 `<include>` 物理拆出到独立文件，Core 构建下这些 `<include>` 目标需要一份"空 stub"文件顶替（而不是让 Core 包里出现一条指向不存在文件的死引用），具体手法见该文档第 9/10 节已经落地的真实案例（`pages/statistics`/`pages/profile`）。
- **SEO/GEO 与搜一搜收录**：
  - 新增公开页面（如爱心公式页、公开大屏）必须同步检查并提醒更新根目录 `sitemap.json` 的爬虫放行规则；严禁在未登录页出现死锁阻断。

---

## 4. 终端常用命令

> ⚠️ 2026-09-05 核实修正：根目录 `package.json` 里并不存在 `lint` 这个 script（此前本节写的 `npm run lint` 会直接报 `Missing script: "lint"`），以下是 `package.json` 里真实存在的四个 script。

- 类型校验：`npm run typecheck`（即 `tsc --noEmit -p tsconfig.json`，前端 TS 代码改动后必须跑一遍）
- 单元测试：`npm test`（即 `node --test cloudfunctions/*/lib/*.test.js miniprogram/subpackages/admin/pages/store-profile/lib/*.test.js`），只覆盖各 `lib/*.test.js` 下的纯函数单测，不是端到端/集成测试，且只有部分云函数/页面有对应测试文件。⚠️ 2026-09-10 起不再是"只测云函数"——`miniprogram/` 页面如果按同款"纯逻辑拆 `lib/*.js` + 配套 `*.test.js`"的写法（见 `store-profile/lib/qualificationPhotoActions.js` 首个先例）新增测试，需要手动把对应 glob 加进这行 script，`node --test` 不做递归通配，新增一个页面的 `lib/` 目录就要在这里显式追加一段路径。
- Open-Core 安全审计：`npm run security-audit`（`scripts/security-audit.js`，配合 [`OPEN_CORE_ARCHITECTURE.md`](docs/OPEN_CORE_ARCHITECTURE.md) 的敏感信息审计标准使用）
- Open-Core 拆分构建：`npm run build:core`（`scripts/build-open-core.js`，生成开源 Core 代码产物）
- Open-Core 产物独立编译校验（更硬的验证，CI 里同样跑）：先 `npm run build:core` 生成 `dist/suxiaozhang-core`，再 `cd dist/suxiaozhang-core && node ../../node_modules/typescript/bin/tsc --noEmit && cd ../..`——**不要用 `npx tsc`**，`dist/suxiaozhang-core` 是从 `git ls-files` 拷贝出的纯源码目录、不带自己的 `node_modules`，裸 `npx tsc` 会去 npm 现拉最新版 TypeScript，版本一旦更新引入了破坏性变更（如某版本移除了 `alwaysStrict` 选项）会被误判成"Core 包编译失败"，其实只是编译器版本对不上；显式指定仓库 `npm ci` 装好、`package.json` pin 住的那份编译器才是在验证"用实际会用的版本能不能编译"。完整 CI 门禁序列见 [`OPEN_CORE_ARCHITECTURE.md`](docs/OPEN_CORE_ARCHITECTURE.md) 与 `.github/workflows/open-core-ci.yml`。
- 本地自闭环校验：`npm run agent:check`（`scripts/agent-check.js`，typecheck→test→通知开发者工具重新编译三步，见 CLAUDE.md 第 8 节 Autonomous Engineering Rules 第 4 条）
- 视觉快照：`npm run visual:check`（`scripts/visual-check.js`，需要 `miniprogram-automator`，见第 8 节第 5 条——用真实开发者工具渲染截图，不是靠读代码猜视觉效果；默认截 `platform-admin` 页面首屏+上滑 400px 两张图存到 `.agent/snapshots/`，可传参数指定其它页面路径）
- 云函数本地调试/部署：在对应云函数目录下执行 `npm install`
- Obsidian 知识库链接检查：`ls -l ./docs`

---

## 5. 远端同步与代码/商业机密安全红线

- 本仓库（`suxiaozhang`）是产品**唯一真源代码**，含完整业务逻辑（分账费率、订阅套餐规则等商业敏感实现，见 [`OPEN_CORE_ARCHITECTURE.md`](docs/OPEN_CORE_ARCHITECTURE.md) 的 Enterprise 分级），必须始终保持 **Private** 属性：GitHub `suxiaozhang` 与 Gitee `yuhua-zhushou` 两个远程仓库都不得改为公开，改动仓库可见性前必须先经用户明确同意。
- 远端推送**只允许**走已配置好的 `origin`（单一 remote 名、双 push URL：GitHub SSH `git@github.com:ziyanliu001/suxiaozhang.git` + Gitee HTTPS `https://gitee.com/zeng-qingliang/yuhua-zhushou.git`）。`git push origin master` 一条命令即完成双发，**严禁**新增指向其他托管服务、公开仓库、或权限属性未经确认的第三方 remote（2026-09-05 已移除一个冗余且缺凭证的独立 `github` HTTPS remote，不要重新添加）。
- **严禁**任何形式的对外公开发布——不得把本仓库代码/文档复制、粘贴或推送到任何公开可访问的位置（公开 Gist、公开 Pages、未加访问控制的分享链接、聊天工具的公开频道等），`scripts/build-open-core.js` 产出的开源 Core 构建物如需对外发布，须走独立评审流程，不等同于直接公开本仓库。
- **严禁在代码、注释、commit message 或任何文档里明文记录私钥、access token、密码、云开发密钥等凭证**。本仓库已有的既定防线：`.gitignore` 里 `private.*.key`/`*.pem`/`project.private.config.json` 三类规则专门拦截小程序上传密钥与本地私有配置——新增任何凭证类文件时，必须先补齐对应的 `.gitignore` 规则再落盘，不能先写文件再补规则（存在"补规则前那个 commit 窗口"意外提交的风险，先加规则再建文件）。一旦发现已提交的明文凭证，视为需要立即撤销/轮换该凭证的安全事件处理，删除文件/改写内容不能让已泄露的凭证重新变安全（git 历史仍会留痕）。
  > ⚠️ **2026-09-05 发现的存量违规**：根目录 `project.private.config.json` 早于 `.gitignore` 规则落地前就已被 `git add`，规则只挡"未来新增"，不会retroactively 补挡已跟踪文件，目前该文件仍在版本库里（`git ls-files` 可见）。核实过内容本身不含真实凭证（只是 DevTools 本地调试场景配置 + 一个内部测试 `tenantId`），不构成本条"明文凭证"意义上的安全事件，但违反了本条防线的初衷，建议 `git rm --cached project.private.config.json`（只停止跟踪、不删本地文件）——因涉及改变已跟踪文件集，需用户确认后再执行。
- **`EMERGENCY_RECOVERY_SECRET`**（2026-09-13 新增，见第 9 节"紧急逃生舱"）与 `WXPAY_INTERNAL_TOKEN`/`LIVE_FACTORY_INTERNAL_TOKEN` 一样，只存在于云开发控制台环境变量，绝不允许出现在代码/注释/commit message/文档里——且这一个比另外两个更敏感（另外两个只是"云函数之间的内部调用令牌"，泄露只能让人冒充内部服务调用；这个一旦泄露，任何人都能把自己的微信账号直接提权成 `super_admin`）。建议使用与其余任何令牌都不同的独立高强度随机值，且只告知极少数受信任的人。
- **`ADMIN_CONSOLE_INTERNAL_TOKEN`**（2026-09-13 新增，见第 9.6 节）：`cloudfunctions/adminWebConsole` 转发调用 `activateTenantSubscription` 的内部令牌，必须两侧配置完全一致的同一个值，敏感级别与 `WXPAY_INTERNAL_TOKEN` 同档（云函数间内部调用令牌，不是直接的权限提升密钥）。
- **`TENCENTCLOUD_SECRETID`/`TENCENTCLOUD_SECRETKEY`**（2026-09-13 新增，见第 9.5 节）：`scripts/ops/` 目录下应急脚本使用的腾讯云 API 密钥，**只通过环境变量传入本地终端，绝不作为命令行参数**（会留在 shell 历史记录里），也绝不提交进版本库/写进任何文档。这是本项目安全模型里权限最高的一把钥匙——建议专门申请一个权限收窄过的 CAM 子账号密钥，不要直接用主账号根密钥。

---

## 6. 商业级上线准备度体检记录（2026-09-05）

本节记录一轮完整的"审计 → 加固 → 回归核验"闭环，供后续排期/复盘时直接查阅，不必重新翻 commit 历史还原上下文。

**审计范围与结论**：多租户隔离（`verifyTenantAccess`/角色反查模式抽查 11 个云函数，未发现可利用越权）、结算与订单状态机幂等性（发现 4 处 read-then-write 竞态）、微信合规（隐私授权配置正常；`sitemap.json` 全放行不符合"轨道一/二"分离原则）。

**已落地的加固**（详见对应文件内注释，均已通过 `npm run typecheck`）：
- `cloudfunctions/completeProductionOrder/index.js`：`tryAutoProfitSharing` 加 `profitSharingLockedAt` 字段 CAS 领单，防止并发/重试触发重复分账。
- `cloudfunctions/processProductionRefund/index.js`：发起退款前加 `refundClaimedAt` 字段 CAS 领单，防止重复退款请求；分账冲销失败时故意不放开占位，逼人工核对。
- `cloudfunctions/wxPayCore/lib/refundService.js` + `index.js`：`createPendingRefund` 加函数级退款锁；`getCommittedRefundedTotal` 把 `PROCESSING` 状态并入已占用退款额度校验（原来只算 `SUCCESS`，存在"旧退款未到终态又发起新退款"导致超额退款的口子）。
- `cloudfunctions/liveFactoryCore/index.js`：`buildSettlement`/`reverseSettlement` 改用确定性 `_id`（`settle_${tenantId}_${orderId}` / `settle_reversal_${settlementId}`）+ 数据库主键唯一性兜底防重复插入；`mark_refunded` 分支改条件更新（CAS）。
- `miniprogram/sitemap.json`：收敛为仅 `allow` 全国大屏（`pages/statistics/statistics`）与公开核验页（`subpackages/admin/pages/public-verify/index`），其余 `disallow: "*"` 兜底，详见 [`GEO_STRATEGY.md`](docs/GEO_STRATEGY.md)。
- 「常用支出项目」大额专项分类补齐 `店铺租金`（`miniprogram/pages/index/index.ts` + 本地兜底统计关键词表 `miniprogram/utils/dataService.ts` 同步补齐 `租金` 关键词）。

**已知残留风险（本轮未解决，如实标注）**：
- "结算已完成"与"退款红冲"仍是跨函数竞速（`tryAutoProfitSharing` 写 `settled` 与 `processProductionRefund`→`reverseSettlement` 读旧状态之间没有互斥），本轮 CAS 只保证"同一操作不会被自己重复触发"，不解决两个不同操作互相抢跑的业务级竞态——这与 `processProductionRefund` 文件头一直标注的"分账已完成后再退款"残余风险是同一类问题，需要专项设计（如引入乐观锁版本号或状态机加锁范围扩大到跨函数）才能根治。
- `PAYMENT_MOCK_MODE` 等生产环境变量清单以 [`cloudfunctions/wxPayCore/lib/payConfig.js`](cloudfunctions/wxPayCore/lib/payConfig.js) 文件头注释为唯一真源（`WXPAY_APPID`/`WXPAY_MCHID`/`WXPAY_MCH_SERIAL_NO`/`WXPAY_MCH_PRIVATE_KEY`/`WXPAY_API_V3_KEY`/`WXPAY_NOTIFY_URL`/`WXPAY_INTERNAL_TOKEN`），本文档不重复抄写以免日后再次drift；上线前额外要确认 `WXPAY_INTERNAL_TOKEN` 与 `LIVE_FACTORY_INTERNAL_TOKEN` 分别在各自的"内部调用方"云函数（前者：`createSubscriptionOrder`/`createProductionOrder`/`processProductionRefund`/`completeProductionOrder`；后者：`liveFactoryCore`/`createProductionOrder`/`processProductionRefund`）里配了同一份值，这两个令牌不在 `payConfig.js` 的校验范围内，配错不会报错、只会静默拒绝调用。
- 敏感控制台日志扫描（前端 + 云函数）未发现明文密钥/手机号/未脱敏用户信息打印；`cloudfunctions/createSubscriptionOrder/index.js` 里有一处打印整个 `event` 对象（参数缺失分支），当前该路径的 `event` 只含 `action`/`outTradeNo`/`bizId`/`bizType`，不含 PII，风险低，可作为后续代码卫生的小优化项，不阻塞上线。

---

## 7. 义工修心积善打卡模块与去宗教化合规基线（2026-09-06）

### 7.1 模块定位

「今日微善记录」是义工到岗服务打卡（`onConfirmShiftCheckIn`，`pages/index/index.ts`）成功后追加的一层**纯精神修持与文化激励**记录：打卡本身已经落地成功，用户可选择性地勾选当日做到的几件小事（微善标签），不选也可直接跳过，不影响打卡记录的有效性。

**不可突破的红线**：本模块的一切展示与激励**严禁**与资金、门店 SaaS 订阅套餐、任何形式的可兑换/可交易商业积分挂钩——`meritTags` 是纯展示型的自我记录字段，不参与任何 `checkTenantPermission`/`tenant_subscriptions` 的权益判断，不产生任何形式的抵扣、兑换或排名奖励（爱心护持榜按工时排名，与本模块彻底独立，见 `cloudfunctions/manageVolunteerCheckIn/index.js` 的 `handleLeaderboard`）。新增任何与本模块相关的功能前，先确认没有违反这条边界。

### 7.2 去宗教化合规基线（历史上首次统一成文档）

⚠️ 本项目此前从未把"去宗教化"写成过成文规则，全部相关工作散落在 7 处代码/wxml 注释里（`pages/index/index.wxml`/`.ts`、`components/yangshan-wall/yangshan-wall.ts`、`utils/drawVolunteerCertificate.ts`），且执行口径并不统一——已放行的措辞（"护持"「感恩」「福慧双增」，以及 `utils/cultureData.ts` 里"长时熏修""一门深入""圣贤教育""常生惭愧""离苦得乐"等更浓的佛教修行术语）比历次被要求清洗的词（"愿心"/"发心"/"随喜"/"供养"/"同修"/"功德主"/"因果"/"轮回"）尺度更大。本节把口径第一次统一下来，后续新增文案按此执行：

- **一律不使用**（无论新旧功能）：愿心、发心、随喜、供养、同修、因果、轮回、功德主、**功过格**（道教/佛教传统修行语境里特指记善恶、算报应的修行记数法，是比上述已清洗词更具体指向宗教修行体系的专有名词，本模块的产品设计灵感虽然来自"功过格"这一传统文化概念，但用户可见文案一律不出现这三个字，一律用"修心积善打卡"/"德行手账"/"今日微善记录"等中性表述）。
- **允许保留、且已有先例**：引用《了凡四训》作为传统文化短句——本仓库已有先例并已上线（`nationalDashboardView.wxml` 的"了凡四训 · 阳善积德"、`pages/index/index.ts`/`.wxml` 的"阳善/阴德"捐赠分类），问题不在于"能不能引用《了凡四训》"，而在于引用**哪一句**。本模块固定只用"命由我作，福自己求"这一句——这是全篇里最不涉及因果轮回教义、最接近"自我承担/主观能动性"的一句，不做多句轮换池（避免后续为了凑轮换库无意中引入更偏教义的句子）。"善"字印章、阳善/阴德标签延续既有产品决策，不算新增风险。
- 任何新增文化引用/激励文案，落笔前先对照这份清单，拿不准时按"更保守"的方向选词，不要现造一个新的宽松标准。

### 7.3 `meritTags` 字典与扩展规约

| value（存库值） | label（展示文案） | emoji |
| --- | --- | --- |
| `almsgiving` | 行堂布施 | 🤲 |
| `kindwords` | 和颜柔语 | 😊 |
| `thrift` | 惜福护物 | 🍚 |
| `cleaning` | 清扫庄严 | 🧹 |

两处独立维护同一份字典（`cloudfunctions/manageVolunteerCheckIn/index.js` 的 `MERIT_TAGS` 白名单 + `components/volunteer-merit-dialog/volunteer-merit-dialog.ts` 的 `MERIT_TAG_OPTIONS`），无共享模块机制，改动需手动同步。

**扩展规约**：后续如需推出"百善/千善"电子证书之类的里程碑激励，应该新增一个**读取 `meritTags` 历史累计次数的门槛值配置**（如 `MERIT_MILESTONES = [{count:100,label:'百善'},{count:1000,label:'千善'}]`），而不是扩充 `meritTags` 枚举本身——枚举值一旦扩大，旧记录里从未出现过的新值会让"累计次数"统计口径产生歧义（新老用户能选的标签种类不一致，历史数据也无法回填新标签）。里程碑证书本身仍需先过 7.1/7.2 两节的红线检查，证书文案不得暗示可兑换任何实物/资金/商业权益。

### 7.4 架构状态

| 文件 | 变更 |
| --- | --- |
| `cloudfunctions/manageVolunteerCheckIn/index.js` | 新增 `MERIT_TAGS`/`sanitizeMeritTags`；`handleCheckin` 的 `doc` 新增 `meritTags: []`；新增 `action: 'updateMeritTags'`（`handleUpdateMeritTags`），仅记录本人打卡记录，无门店/角色权限校验 |
| `components/volunteer-merit-dialog/`（新增） | 打卡成功后的微善标签弹窗，两段式界面（选择态/确认态），确认态可选生成日签海报 |
| `pages/index/index.ts`/`.wxml`/`.json` | `onConfirmShiftCheckIn` 成功分支改为先弹 `showMeritDialog`，关闭后再进入原有 `showPosterModal` 流程；新增 `onMeritDialogClose`/`onMeritDialogSubmitted`/`onMeritDialogGeneratePoster`；`volunteer-hero-card` 新增轻量"善"字印记（`.merit-seal-mini`，纯 CSS，非 canvas） |
| `subpackages/admin/pages/journey/journey.wxml`/`.wxss`（德行手账卡片） | 新增 `.merit-passbook-card`：善字印章 + 累计护持天数 + 固定引用《了凡四训》短句，复用本页已有的 `computeMyCheckInStats` 结果，不新增云调用 |
| `utils/drawVolunteerCertificate.ts` | `drawSealStamp()` 新增可选 `lines` 参数（默认值与原调用点完全一致），支持单行文字印章，供水墨日签复用 |
| `utils/posterGenerator.ts` | 新增 `MeritTagPosterData` 接口 + `drawMeritTagPoster()`，复用 `showMeritPosterModal`/`meritPosterTempPath` 既有全屏预览基础设施（新增 `meritPosterModalTitle` 字段区分"善行卡"/"今日善行日签"两种标题，避免标题残留串场） |

**测试覆盖（2026-09-06 已补齐）**：`sanitizeMeritTags` 已拆到 `cloudfunctions/manageVolunteerCheckIn/lib/sanitizeMeritTags.js`（纯逻辑，不依赖 `wx-server-sdk`），`index.js` 通过 `require('./lib/sanitizeMeritTags')` 引入，与本仓库 `wxPayCore`/`getSettlementSummary` 等云函数已有的 `index.js` + `lib/*.js` + `lib/*.test.js` 拆分写法保持一致；配套 `lib/sanitizeMeritTags.test.js` 共 10 个用例（非数组/null/undefined 兜底、白名单过滤、重复值不去重、白名单本身逐值反向校验），随 `npm test` 一并跑。

### 7.5 验证命令

同第 4 节，本模块未引入新的终端命令：`npm run typecheck`、`npm test`。

---

## 8. Autonomous Engineering Rules（自主工程闭环，2026-09-10）

以下五条规则来自同一天连续几轮真实排查/返工（platform-admin 巡检面板与
store-profile 门店档案），每条都对应一次具体故障，不是泛泛的最佳实践清单。
Agent 接手这两块相关代码前必须先读这一节。

1. **单字段修改严禁把 `editing` 置为 `true`，事件绑定必须用 `catchtap` 而不是 `bindtap`。**
   `store-profile.ts` 的行级/单字段轻量编辑入口只允许弹出半屏卡片弹窗
   （`sp-modal-card`），绝不能连带触发整页长表单编辑态——`bindtap` 会向上
   冒泡，如果父级容器上还挂着别的 `bindtap`（哪怕当时看起来"没有关联"），
   点击单字段编辑图标就可能被外层监听器一并捕获、连带切到 `editing:true`。
   `catchtap` 阻止冒泡，是本页"点击单字段图标只弹半屏卡片、绝不触发整页
   编辑"这条交互契约的唯一保障，不能图省事换回 `bindtap`。`editing:true`
   目前全仓库只允许由页面顶部"✏️ 修改档案"这一个入口触发（`onEditProfile`），
   其余任何行级/图标级点击事件都不允许写这行 `setData`。

2. **巡检漫游（`authorizedTenants`）签发必须按 `storeId` 覆盖历史记录，
   消费端命中多条有效记录时必须取 `grantedAt` 最新的一条，不能取数组第
   一条。** 根因：`grantTenantAuthorization/lib/grantAuthorizationRules.js`
   的 `mergeGrant()` 曾经只按 `tenantId` 去重——如果同一家门店因历史数据
   问题（机构被重建等）在数组里残留一条 `tenantId` 不同但 `storeId` 命中
   同一家店的旧授权，再次对这家店授权新角色时旧记录不会被替换，导致数组
   里同时存在两条"生效中"的授权。`resolveCaller.js` 的
   `resolveEffectiveCaller()` 与 `store-profile.ts` 的 `grantedEntry` 计算
   如果只取"第一条匹配的记录"，会稳定复现"选了大家长，权限却按义工生效"
   这类离奇 bug。正确写法：签发端按 `stores` 数组是否与新授权重叠判定"应
   被取代"（而不是只比 `tenantId`）；消费端过滤 `isGrantStillValid()` 后，
   在全部有效匹配里取 `grantedAt` 最大的一条。两端必须保持同一套挑选逻辑，
   否则会出现"服务端已经认可新授权、客户端却按旧数据把编辑按钮全部隐藏"
   的双重标准。

3. **自定义导航栏（`<navigation-bar>` 组件）的总高度严格等于
   `statusBarHeight + navBarHeight`（组件内部 `_layout()` 按
   `wx.getMenuButtonBoundingClientRect()` 实测胶囊坐标算出），禁止在此基础
   上叠加任何额外的纯色 padding/margin 去"撑高"或"留白"顶栏本身。** 需要
   首屏呼吸感时，去调整顶栏**之下**的内容区（如 `pa-content` 自己的
   `padding-top`），不要通过放大顶栏色块面积或叠加 `margin-top` 实现——那
   会造成"色块过厚/胶囊漂浮"的视觉压迫感（2026-09-10 platform-admin 巡检
   面板两轮视觉迭代都踩过这个坑：先是误以为需要改高度，后来定位到真正问题
   其实是背景色饱和度太高，纯色越深越大越显得"压"，与高度本身无关）。改
   顶栏视觉时优先调背景色/描边这类"轻"手段，不要动高度计算。

4. **每次改动后必须自主执行 `npm run agent:check` 跑通全流程，不要等人类
   手动切到微信开发者工具按 Ctrl+B 确认编译。** 该脚本（`scripts/agent-check.js`）
   顺序执行 `typecheck` → `test` → 通知开发者工具重新加载编译，任一环节
   失败都会以非零退出码终止并打印可诊断的原始输出。⚠️ 如实说明其边界：
   微信开发者工具官方 HTTP/CLI 接口没有"编译并返回语法错误列表"这种能力，
   第三步只是触发 IDE 重新加载/编译（`/v2/open`），编译是否有 WXML/WXSS
   语法错误仍然只会体现在 IDE 图形界面里，看不到就默认信任 `typecheck`/
   `test` 两道真正的结构化校验；开发者工具未启动/端口未开时可用
   `AGENT_CHECK_SKIP_DEVTOOLS=1` 豁免第三步，但 `typecheck`/`test` 永远是
   不可跳过的硬性门禁。

5. **对"视觉表现"类问题（布局错位、遮挡、层级、居中）不要只凭代码审计下结论——`npm run visual:check` 能拉起真实开发者工具截图，用得上就用。**
   根因：2026-09-10 同一个导航栏问题被现场反馈"代码明明已经是标准结构、
   模拟器里还是错位"，逐行审计代码（WXML 结构、WXSS 属性、JSON 配置、TS
   数据注入）确认完全正确后，用 `scripts/visual-check.js`（`miniprogram-automator`
   拉起独立自动化开发者工具实例，实测截图）证实渲染结果和代码审计的结论
   一致——问题出在别处（编译缓存/查看的实例不一致），不是代码错。**教训不是
   "代码审计不可靠"，而是"当事人已经明确表示不接受纯代码审计的结论时，
   有能截图的工具就应该截图，不要重复用同一种方法论去说服对方"**。
   `automator.connect({wsEndpoint})` 需要专门用 `--auto-port` 启动的
   WebSocket 端口，与 `agent-check.js` 用的服务端口（HTTP 调用）是两个不
   同机制，手动打开的开发者工具窗口连不上；`automator.launch()` 会另开
   一个独立的自动化专用实例，`cliPath` 在 Linux 下必须显式指定（SDK 的
   `resolveCliPath()` 只认 macOS/Windows 默认路径）。冷启动的自动化实例
   第一次 `reLaunch` 到子包页面会被 app 自身的登录/角色拉取流程静默改写
   回首页，需要重试几次等冷启动跑完（脚本内已处理，不是环境不稳定）。

---

## 9. 紧急逃生舱（Break-Glass）应急接管机制（2026-09-13）

**四道独立防线**，任意一道仍可用，运营方就不会被彻底锁死：
- **第一道**（既有）：`setupSuperAdmin`——要求调用者已经是 `platform_admin`（或系统里一个都没有时自举）。
- **第二道**：`cloudfunctions/emergencyClaimSuperAdmin`——微信小程序内，凭 `EMERGENCY_RECOVERY_SECRET` 密钥自助接管，见 9.1~9.4。
- **第三道**：`scripts/ops/grant-super-admin.js`——完全脱离微信/云函数，本地或 CI 用 `@cloudbase/node-sdk` + 腾讯云 API 密钥直连数据库，见 9.5。
- **第四道**：`web-admin/` + `cloudfunctions/adminWebAuth`/`adminWebConsole`——独立于微信生态的 Web 管理中台，普通浏览器 + 独立账密登录，见 9.6。

### 9.1 定位与触发场景（第二道防线：微信内密钥自助接管）

唯一超级管理员的微信账号被封禁/丢失/失联时的最后手段——`cloudfunctions/emergencyClaimSuperAdmin`。与本仓库其余管理类云函数（`setupSuperAdmin`/`processRoleAudit` 的 `superAdminForceUnbind` 等）根本不同的一点：那些函数都要求"调用者已经是 `super_admin`/`platform_admin`"才能继续操作，一旦唯一的超管账号失效，没有任何账号有资格调用它们来恢复权限，后台会永久锁死。本函数因此故意不做任何"调用者当前角色"层面的前置校验，**唯一的防线是 `EMERGENCY_RECOVERY_SECRET` 这个只存在于云开发控制台环境变量里的密钥**——必须持有物理访问云开发控制台权限的人才能配置/得知这个值，这是安全模型的信任根，日常绝不通过任何应用内 UI 暴露这个函数的存在或入口。

### 9.2 安全加固清单

1. **fail-closed**：`EMERGENCY_RECOVERY_SECRET` 未配置时拒绝一切调用，与 `cascadeRecalculator` 的 `LEDGER_HMAC_SECRET`、`wxPayCore` 的 `WXPAY_INTERNAL_TOKEN` 同一条既定原则。
2. **常量时间密钥比较**（`lib/secretGuard.js` 的 `secretsMatch`）：用 `crypto.timingSafeEqual` 而不是普通 `===`——本函数的 `secret` 参数是小程序客户端可直接控制的输入，存在被暴力枚举/侧信道猜测的现实风险，比云函数间内部调用令牌（那些只在云函数之间传递，不会被公网客户端直接尝试）要更谨慎。
3. **失败锁定**：同一 `openid` 连续失败达到 5 次后锁定 30 分钟（`lib/secretGuard.js` 的 `evaluateLockout`/`computeNextAttemptRecord`），记录在独立的 `emergency_claim_attempts` 集合（`_id` 由 `openid` 的 md5 确定性派生，`set()` 覆写天然幂等）。
4. **高危审计日志**：无论成功/失败都写入 `audit_logs`（`action: 'EMERGENCY_SUPER_ADMIN_CLAIM'`）——这是本仓库已有的、专门给"账号/权限级"高危操作用的审计集合（`processRoleAudit` 的 `superAdminForceUnbind`/`releaseSelf` 等已在用，与 `report_audit_logs` 这个"报表数据级"审计集合是两条不同的审计轨道，不要混用）。**绝不记录密钥明文本身**（无论对错），只记录"是否匹配"这个布尔结果；成功时额外记录接管人姓名/手机号/归属机构，供事后人工核实。本仓库目前没有任何云函数会更新/删除 `audit_logs` 里的记录，天然只增不改，未引入额外的加密防篡改机制（如同类日志一贯的做法，见第 6 节体检记录的既定标准）。
5. **多 `super_admin` 并行**：写入的 `user_roles` 文档与 `setupSuperAdmin` 生成的记录同一套字段口径（`role='super_admin'`/`status='approved'`/`storeId=''`/`storeName='全国总览'`）。**全仓库排查确认**：本项目所有 `super_admin` 判定永远是"按 `_openid` 查 `user_roles` 单文档的 `role` 字段"，不存在任何硬编码单 `openid` 白名单/环境变量（已 grep 全仓库确认零命中），`processRoleAudit` 的 `superAdminForceUnbind` 本身就显式处理"操作者是一个 `super_admin`、目标是另一个 `super_admin`"的场景——多超管并行是本项目一贯的既有设计，本次接管产生的新 `super_admin` 记录与其余账号（包括可能还能正常使用的旧超管账号）完全并行生效，互不冲突、互不覆盖。**这一条本次审计后确认已经满足，未做代码改动。**

### 9.3 部署要求（务必在云开发控制台配置）

- 环境变量 `EMERGENCY_RECOVERY_SECRET`：建议使用高强度随机字符串（≥32 位，含大小写字母/数字/符号），与 `WXPAY_INTERNAL_TOKEN`/`LIVE_FACTORY_INTERNAL_TOKEN` 等其它任何令牌都不复用，只告知极少数受信任的人（见第 5 节安全红线）。
- 上线后建议把本函数的调用日志接入告警（短信/邮件通知机构负责人）——`index.js` 里已经用 🚨 标记打了最高优先级 `console.error`，云开发控制台的日志告警规则可以直接订阅这个关键字。
- 定期（如每半年）核实这个密钥仍然只有受信任的人知道；一旦怀疑泄露，立即在控制台轮换。

### 9.4 已知边界（如实标注）

- `emergency_claim_attempts` 的失败锁定按 `openid` 维度计数，不是按 IP——云函数运行时拿不到公网客户端 IP 这类可靠信号；这个维度足以显著提高攻击成本（需要不同的微信账号，不是简单换个请求头就能绕过），但不是绝对防线，密钥强度本身仍是第一道、也是最重要的一道防线。
- 归属机构（`tenantId`）解析：显式传入时校验存在性；未传入且系统内恰好只有一家机构时自动关联；系统内有多家机构且未显式指定时**拒绝**（不猜测，避免把新超管错误关联到无关机构）——多租户环境下发起应急接管，调用方必须显式知道自己要接管哪一家机构的 `tenantId`。

### 9.5 第三道防线：`scripts/ops/grant-super-admin.js`（本地/CI 直连数据库）

- **为什么不用 `wx-server-sdk`**：`wx-server-sdk` 的 `cloud.init()` 依赖云函数运行时环境隐式注入的凭据，本地脚本环境里用不了——本仓库 `scripts/seedActivationCodes.ts` 早就记录过这个结论。改用 `@cloudbase/node-sdk`，走显式的 `TENCENTCLOUD_SECRETID`/`TENCENTCLOUD_SECRETKEY` 鉴权，完全绕开应用层，只要还能访问腾讯云控制台就永远可用。
- **依赖隔离**：`scripts/ops/` 有自己独立的 `package.json`（`@cloudbase/node-sdk`），不污染仓库根目录或任何云函数的依赖树，也不会被 Open-Core 构建流程扫描到。
- **与第二道防线共用同一套数据字段口径**：直接 `require('../../cloudfunctions/emergencyClaimSuperAdmin/lib/validateClaim')`（纯函数，跨目录 require 在这里是安全的——"云函数间无共享模块机制"这条约束只针对**部署时各自独立打包的云函数**，普通本地 Node 脚本不受此限制），`user_roles`/`audit_logs` 写入的字段形状与前两道防线完全一致，`audit_logs` 的 `channel` 字段固定为 `'cli_script'`，事后审计能一眼分辨走的是哪条通道。
- **信任模型更强，因此校验更松**：这条通道的真正身份验证是"是否持有腾讯云 API 密钥"（比密钥字符串/账密登录的强度都高——密钥泄露的后果也远不止"被授予 super_admin"，见 `scripts/ops/README.md` 安全须知），因此脚本不强制要求填写手机号（另外两道防线的校验器要求非空），默认二次交互确认（`--yes` 跳过，供 CI 用）。
- **配套脚本** `scripts/ops/init-web-admin.js`：初始化/重置第四道防线（Web 管理中台）的账密，同样直连数据库，解决"没有账号就无法登录去创建账号"的鸡生蛋问题。

### 9.6 第四道防线：`web-admin/` 独立 Web 管理中台

- **架构**：纯静态单文件 `web-admin/index.html`（无构建步骤），加载 `@cloudbase/js-sdk`（CDN，固定 `2.28.6` 版本），`cloudbase.init()` 之后**不调用** `auth.signInAnonymously()`——依赖目标环境已开启的"未登录用户访问云资源权限"（微信云开发控制台开关，与腾讯云独立版 CloudBase 的"匿名登录"身份源是两套不同机制，2026-09-13 曾误用后者、被环境直接拒绝"请联系开发者在身份源列表开启匿名登录"）。但每次 `callFunction()` 前仍会先调用一次 `auth.getSession()`（纯查询、失败也吞掉，不依赖任何身份源）——这不是登录，只是绕开 `@cloudbase/js-sdk` 自身一个真机复现过的初始化顺序缺陷（从未碰过 `auth` 模块时 `callFunction()` 会因为内部登录态是 `null` 而直接崩溃在浏览器端，请求发不出去）。真正的操作权限完全由 `cloudfunctions/adminWebAuth` 登录后签发的会话令牌决定。
- **认证**（`cloudfunctions/adminWebAuth`，新增 `platform_web_admins`/`platform_web_sessions`/`platform_web_login_attempts` 三个集合）：用户名 + 密码，密码用 Node 内置 `crypto.scrypt` 加盐哈希存储（CLAUDE.md"克制原则"不允许引入 bcrypt 等第三方包，`scrypt` 是同等强度、零依赖的替代），会话令牌 `crypto.randomBytes(32)`、8 小时有效期，同用户名连续登录失败 5 次锁定 30 分钟——与第二道防线 `emergencyClaimSuperAdmin` 同一套锁定算法的独立镜像（`lib/loginLockout.js`）。首个账号有两条创建路径且完全等价——`scripts/ops/init-web-admin.js` 直连数据库创建，或 `action: 'init_first_admin'`（**仅当 `platform_web_admins` 集合当前完全为空时可用**，与 `setupSuperAdmin` 的 `hasAnyPlatformAdmin()` 自举豁免同一条思路，一旦系统里已存在任意一条管理员记录立刻永久失效，不会退化成可反复调用的"创建管理员"后门；确定性 `_id`（`buildAdminDocId`，按用户名 md5 派生）+ `add()` 主键唯一性兜底并发竞态，与 `liveFactoryCore` 同一套手法）——不提供任何网页自助注册入口。
- **业务动作**（`cloudfunctions/adminWebConsole`，与 `adminWebAuth` 分开部署）：每个 action 第一步都校验 `sessionToken`（查 `platform_web_sessions`，`lib/verifySession.js` 是 `adminWebAuth` 侧同名判定逻辑的独立镜像）。
  - `generateActivationCode`：**不重新实现铸造逻辑**，而是携带新增的 `ADMIN_CONSOLE_INTERNAL_TOKEN`（与 `WXPAY_INTERNAL_TOKEN` 同一条 fail-closed 原则）转发给 `activateTenantSubscription` 的 `generate` 动作——该函数原本要求调用者是携带真实微信身份的 `platform_admin`，`cloud.callFunction()` 服务端到服务端调用不会携带任何 OPENID，因此新增了这道内部令牌作为"平台管理员身份"的平替，只影响 `generate` 这一个动作，不影响 `redeem`/`list`/`revoke`/`getStats` 仍然要求真实微信身份的动作。
  - `grantEmergencySuperAdmin`：与第二/三道防线共用同一套 `user_roles`/`audit_logs` 字段口径（`lib/validateClaim.js` 是又一处独立镜像），区别是接受调用方显式指定的 `targetOpenid`（Web 管理中台没有微信身份上下文，不能像 `emergencyClaimSuperAdmin` 那样"给当前调用者自己"授权），`audit_logs` 的 `channel` 固定为 `'web_console'`，`operator_id` 记录的是 Web 管理员的登录用户名（不是微信 openid）。
  - `getSystemOverview`：全网活跃门店数、机构总数、`daily_tenant_snapshots` 昨日快照生成覆盖率——只读，风险最低，直接查询不经过内部令牌转发。
- **本页面不直接读写数据库**：所有数据访问都通过 `app.callFunction()` 中转，云函数内部做真正的权限校验，浏览器端不持有任何数据库直接访问凭证，与本仓库其余云函数"服务端强校验、客户端不可信"的一贯架构保持一致，不因为是独立于微信生态的页面就降低这条标准。
- **部署前置条件**（无法由代码验证，需在腾讯云开发控制台手动配置，详见 `web-admin/README.md`）：目标环境启用"未登录用户访问云资源权限"、部署域名加入安全域名白名单、两个新云函数已部署且 `ADMIN_CONSOLE_INTERNAL_TOKEN` 与 `activateTenantSubscription` 侧配置的值完全一致。**未做真机/真实浏览器联调测试，如实标注**——本次交付止于代码与文档，`@cloudbase/js-sdk` 与实际云开发环境的兼容性需要你在控制台完成上述配置后自行验证一遍完整登录+三个页面的操作链路。