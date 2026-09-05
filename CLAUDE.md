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
  - **金额存储口径（⚠️ 按业务线区分，不是单一全局规则）**：
    - **支付类金额**（微信支付订单，如 `cloudfunctions/createSubscriptionOrder`）以“分”为单位整型存储（如 `totalFee: 168800` 即 1688.00 元），前端展示除以 100 并格式化——这条规则只在支付链路真正落地。
    - **公益记账流水**（`report_logs` 集合，唯一写入入口是 `dataService.ts` 的 `saveReport()`）历史上一直以“元”为单位的浮点数存储（`parseNumber = (v) => parseFloat(v) || 0`），展示层 `formatMoney()` 直接 `.toFixed(2)`，**没有除以 100 的动作**。新增/修改记账相关金额字段时延续现有“元”浮点口径，不要擅自改成“分”整型，否则会与存量数据混算出错；如确需推行统一分化改造，需要专项迁移方案，不能顺手改。
    - 两套口径的代码位置与字段清单详见 [`SCHEMA.md`](docs/SCHEMA.md) 第 4 节。
- **样式与适配**：
  - 严格使用 `rpx` 布局，保障各机型无缝适配；核心卡片与文字遵守项目主视觉调性。
- **SEO/GEO 与搜一搜收录**：
  - 新增公开页面（如爱心公式页、公开大屏）必须同步检查并提醒更新根目录 `sitemap.json` 的爬虫放行规则；严禁在未登录页出现死锁阻断。

---

## 4. 终端常用命令

> ⚠️ 2026-09-05 核实修正：根目录 `package.json` 里并不存在 `lint` 这个 script（此前本节写的 `npm run lint` 会直接报 `Missing script: "lint"`），以下是 `package.json` 里真实存在的四个 script。

- 类型校验：`npm run typecheck`（即 `tsc --noEmit -p tsconfig.json`，前端 TS 代码改动后必须跑一遍）
- 云函数单元测试：`npm test`（即 `node --test cloudfunctions/*/lib/*.test.js`，只覆盖各云函数 `lib/*.test.js` 下的纯函数单测，不是端到端/集成测试，且只有部分云函数有对应测试文件）
- Open-Core 安全审计：`npm run security-audit`（`scripts/security-audit.js`，配合 [`OPEN_CORE_ARCHITECTURE.md`](docs/OPEN_CORE_ARCHITECTURE.md) 的敏感信息审计标准使用）
- Open-Core 拆分构建：`npm run build:core`（`scripts/build-open-core.js`，生成开源 Core 代码产物）
- 云函数本地调试/部署：在对应云函数目录下执行 `npm install`
- Obsidian 知识库链接检查：`ls -l ./docs`

---

## 5. 远端同步与代码/商业机密安全红线

- 本仓库（`suxiaozhang`）是产品**唯一真源代码**，含完整业务逻辑（分账费率、订阅套餐规则等商业敏感实现，见 [`OPEN_CORE_ARCHITECTURE.md`](docs/OPEN_CORE_ARCHITECTURE.md) 的 Enterprise 分级），必须始终保持 **Private** 属性：GitHub `suxiaozhang` 与 Gitee `yuhua-zhushou` 两个远程仓库都不得改为公开，改动仓库可见性前必须先经用户明确同意。
- 远端推送**只允许**走已配置好的 `origin`（单一 remote 名、双 push URL：GitHub SSH `git@github.com:ziyanliu001/suxiaozhang.git` + Gitee HTTPS `https://gitee.com/zeng-qingliang/yuhua-zhushou.git`）。`git push origin master` 一条命令即完成双发，**严禁**新增指向其他托管服务、公开仓库、或权限属性未经确认的第三方 remote（2026-09-05 已移除一个冗余且缺凭证的独立 `github` HTTPS remote，不要重新添加）。
- **严禁**任何形式的对外公开发布——不得把本仓库代码/文档复制、粘贴或推送到任何公开可访问的位置（公开 Gist、公开 Pages、未加访问控制的分享链接、聊天工具的公开频道等），`scripts/build-open-core.js` 产出的开源 Core 构建物如需对外发布，须走独立评审流程，不等同于直接公开本仓库。
- **严禁在代码、注释、commit message 或任何文档里明文记录私钥、access token、密码、云开发密钥等凭证**。本仓库已有的既定防线：`.gitignore` 里 `private.*.key`/`*.pem`/`project.private.config.json` 三类规则专门拦截小程序上传密钥与本地私有配置——新增任何凭证类文件时，必须先补齐对应的 `.gitignore` 规则再落盘，不能先写文件再补规则（存在"补规则前那个 commit 窗口"意外提交的风险，先加规则再建文件）。一旦发现已提交的明文凭证，视为需要立即撤销/轮换该凭证的安全事件处理，删除文件/改写内容不能让已泄露的凭证重新变安全（git 历史仍会留痕）。