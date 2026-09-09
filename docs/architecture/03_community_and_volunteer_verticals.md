# 长者助餐（elderly_canteen）与义工协同（volunteer_station）垂直深化设计

> **文档定位**：与 `01_sustainable_charity_and_tenant_isolation.md` 同一套阅读规则——**第一部分是尚未实现的目标设计**，**第二部分是已验证的当前真实实现**，**第三部分是差距清单**。本文档最初只覆盖 `elderly_canteen`/`volunteer_station` 两个取值，2026-09-09 追加第四部分覆盖同一专区新增的 `temple_canteen`（寺院斋堂 / 十方过斋）与 `commercial_vegetarian`（商业素餐 / 结缘供斋）。
>
> ⚠️ 不使用 `community`/`workshop` 等术语——`community` 不是真实 `orgType` 取值，其业务含义与本文档讨论的 `elderly_canteen` 是同一件事；`workshop` 对应的是 `tenants.businessType==='live_factory'` 租户，架构上不创建 `stores` 文档，不存在"门店 orgType"这个维度，与本文档讨论的"门店业态垂直深化"是两个不同范畴，不在此处讨论（工坊相关的目标设计见 `01_sustainable_charity_and_tenant_isolation.md`）。

---

## 一、目标设计（尚未实现，规划中）

### 1.1 elderly_canteen：长者助餐与适老核销深水区

#### 场景定位
- **与雨花斋的互补**：雨花斋坚持"就餐不收钱"的纯公益铁律；`elderly_canteen` 吸纳"希望有尊严付费、不愿白吃"的长者，分流纯公益食堂的压力，两者面向不同的长者心态，互不替代。
- **与街道民政协同**：提供透明、可审计的长者就餐凭据，承接政府购买服务与公配用房——这是 `elderly_canteen` 与 `yuhuazhai` 最大的结构性差异：后者原则上不与任何政府补贴账户产生资金往来，前者的核心诉求恰恰是"对接民政补贴"。

#### 适老化降级方案（构想）
- 长者多数不持有或不擅使用智能手机，系统需支持"代建档、代核销、脱机打卡"——义工/店长代长者录入档案，核销时不要求长者本人操作手机。
- 凭据载体：以长者 ID 为主键生成离线可扫的紧凑数字/二维码凭证（物理卡号映射或纯文本 Token 二维码均可），义工手持端扫码即记，不依赖长者自己的微信账号登录态。
- 长者档案字段（构想，非真实已有字段）：`elderlyId`、`name`、`ageCategory`（如 60-79/80+）、`emergencyContact`、`dietaryRestrictions`。

#### 双轨资金流与台账隔离（构想）
- 社区食堂存在微额自付（如 5~8 元）与民政按人头补贴（如 2~4 元）两种资金来源，这笔钱属于社区合作社或民政指定代办账户，**必须与工坊反哺资金（`charity_contributions`）、开发者服务费（`tenant_subscriptions` 相关流水）完全隔离，不可在任何账本集合里混算**。
- 差额核销计算模型（构想）：`totalAmount = elderlyPaid（长者自付）+ governmentSubsidy（政策补贴）+ charityRelief（兜底免单）`，报表按月聚合，生成对齐民政请款格式的字段，包含脱敏身份与就餐时间戳。
- 核销限制：单人单餐段（午餐/晚餐）天然幂等，防止同一位长者同一餐段被重复计入民政补贴（重复核销不只是体验问题，是真实的财务合规风险——重复请款）。

#### 食品安全留样（构想）
- 社区助餐直接面向高龄群体，抗风险能力弱于其他业态。将开餐前的"留样拍照与温控登记"（留样人、留样菜品品名、留样冰箱温度、留样拍照存证）作为系统任务流的前置拦截项，而不是可跳过的选填项，以此规避法律纠纷风险。

### 1.2 volunteer_station：去堂口化与工时互认深水区

#### 场景定位
- `volunteer_station`（义工服务站 / 互助团队）与 `yuhuazhai`/`elderly_canteen` 最本质的区别是**不天然绑定一个固定的餐饮堂口**——巡河队、社区巡逻队、应急互助小组等团队的核心活动是"组织义工做事"，不是"每天开餐"。现有系统里 `daily_menus`（每日食谱）、餐报里的"用餐人次/食材支出"等字段对这类团队而言大多是无意义的空字段，被迫套用同一套以"开餐"为中心的表单，是产品语义上的错配。
- **去堂口化**（构想）：`volunteer_station` 门店的日常记账/统计视图应该弱化或隐藏"开餐/菜品/用餐人次"相关卡片，突出"活动记录 + 义工打卡 + 物资调配"这条主线——与 `activity_logs`（门店大事记）、`volunteer_duty_logs`（义工打卡）两张已存在的集合天然契合，不需要新建数据模型，只需要调整这类门店的前端展示优先级。
- **无后厨模式**（构想）：建店/门店档案配置阶段，`orgType==='volunteer_station'` 的门店可以跳过"门店运营时段/餐别配置"这类只对餐饮堂口有意义的字段，建店表单应按业态分流，而不是不管业态都展示同一套"开餐时间"配置项。

#### 工时互认（构想，当前系统做不到）
- 现实中的义工常常同时服务于多个团队——例如一位义工本周在自己归属的 `volunteer_station` 打卡服务，下周又去临近的 `yuhuazhai` 帮工。目标设计是让这类跨组织的服务时长能够被"互认"，合并计入该义工个人的总工时荣誉（护持榜/证书），而不是分别锁在两个互不相通的门店账本里，各算各的、互不知情。
- 这需要在义工身份维度新增一层"跨租户个人工时视图"，与现有按 `{tenantId, storeId}` 严格隔离的记账隔离原则（本项目反复强调的多租户安全边界）形成一个需要谨慎设计的例外——工时互认涉及的是"义工个人荣誉聚合"，不是"财务/业务数据查看"，两者的隔离要求不同，不能因为要做工时互认就连带放宽真正敏感的财务数据隔离边界。

---

## 二、当前真实实现（已验证，供对照）

### 2.1 elderly_canteen 当前只驱动展示文案，没有任何专属业务逻辑

- 全仓库检索 `elderly_canteen` 的真实用途：`computeOrgDisplayCopy`/`getNoticeMgmtTemplate` 等函数据此切换文化文案措辞（如"助老食堂"相关的问候语/模板），`getNationalDashboard`/`nationalDashboardService.ts` 据此在全国大屏提供一个"👵 助老食堂"分组 Tab——**仅此而已**。
- 不存在任何长者档案集合、差额补贴字段、留样登记流程——`report_logs`/`daily_menus` 的字段对所有 `orgType` 一视同仁，没有为 `elderly_canteen` 单独分化过任何表单字段或校验逻辑。
- 第一部分描述的适老降级、双轨资金流、食品留样，均是全新功能，需要从零设计数据模型与页面流程，不是在已有字段上做增量开关。

### 2.2 volunteer_station 同理，且工时严格按 {tenantId, storeId} 隔离

- `volunteer_station` 同样只驱动展示文案与全国大屏分组 Tab，没有"去堂口化"的专属表单分支——当前建店/门店档案/日常记账表单对所有业态一套模板，`volunteer_station` 门店同样会看到"开餐时间/菜品/用餐人次"这些字段。
- `volunteer_duty_logs`（义工打卡台账，`cloudfunctions/manageVolunteerCheckIn`）的打卡记录与爱心护持榜统计严格按 `{tenantId, storeId, _openid, dateString}` 查询——这是反复修复过的安全边界（见该云函数 `resolveAuthoritativeTenantId` 的历史教训注释），义工在 A 门店的工时与在 B 门店的工时完全是两条独立的记录，当前**没有任何跨门店/跨租户的工时合并视图**，"工时互认"是真正意义上的全新功能，不是放宽某个已有过滤条件就能做到的。

---

## 三、目标设计 vs 现状差距清单

| 目标设计元素 | 当前现状 | 差距 |
|---|---|---|
| 长者档案（ElderlyProfile）+ 离线可扫凭证 | 不存在任何长者身份相关的集合/字段 | 需要新建集合、新建代建档/代核销的义工端录入流程，以及离线二维码生成与核销逻辑 |
| 差额核销计算模型（自付+补贴+免单三段式） | `report_logs` 只有笼统的收支记录，没有"长者个人维度"的核销流水 | 需要新建按长者+餐段维度的核销记录表，以及幂等校验（单人单餐段不可重复核销） |
| 对齐民政请款格式的月度报表 | 不存在；现有导出仅有 Excel 账目/收支报表，不含长者身份字段 | 需要新的报表模板与导出逻辑，且涉及长者个人信息，需要额外的隐私合规评估 |
| 开餐前留样拍照/温控登记前置拦截 | 不存在任何"开餐前任务流"概念，当前记账是开餐后补录为主 | 需要新增开餐前置任务节点，且要设计"未留样是否硬拦截记账"这类产品规则 |
| volunteer_station 去堂口化表单分流 | 建店/记账表单对所有 orgType 一套模板，未按业态分流 | 需要在建店与日常记账表单里新增按 orgType 的字段显隐分支，工作量集中在前端表单重构，不涉及新建集合 |
| 义工跨租户工时互认 | volunteer_duty_logs 严格按 {tenantId, storeId} 隔离查询，无合并视图 | 需要新增"个人工时汇总"查询维度，且要明确这层放宽只用于荣誉聚合展示，不能连带放宽财务/业务数据的租户隔离边界 |

---

## 四、2026-09-09 机构类型扩展：temple_canteen / commercial_vegetarian

### 4.1 已落地范围（与 elderly_canteen/volunteer_station 同等起点）

- `utils/constants.ts` `ORG_TYPES` + 4 个云函数（`createTenant`/`createStore`/`manageStoreProfile`/
  `processRoleAudit`）的白名单同步新增 `temple_canteen`（寺院斋堂 / 十方过斋）、
  `commercial_vegetarian`（商业素餐 / 结缘供斋）；`getNationalDashboard` 的
  `SUPPORTED_ORG_TYPES`（大屏 Tab 筛选白名单，不涉及金额聚合）同步。
- `profile.ts` 组织信息配置弹窗自助编辑枚举（`ORG_CONFIG_CURATED_VALUES`/
  `ORG_CONFIG_TYPE_META`）纳入这两个新值，措辞如实描述使用场景、不编造专属功能——与
  elderly_canteen/volunteer_station 当前"只驱动展示文案，没有专属业务逻辑"完全同一个
  起点（见 2.1/2.2 节），这两个新值目前**同样没有任何专属表单字段/校验逻辑**。
- 文风适配：`computeOrgDisplayCopy`（profile.ts）、`computeConceptCopy`/
  `computeCultureModalTitle`/`getNoticeTemplate`（index.ts）新增 `temple_canteen` 真分支
  （过斋人次/结缘大众、护法义工/居士、过斋清规/仪轨——用词对照 CLAUDE.md 7.2 节"去宗教化
  合规基线"核实过不在一律禁用词清单内）；首页阳光账本 hero 卡与详情弹窗的"就餐人次"
  标签同时支持 `commercial_vegetarian` 的"供斋结缘人次"替换。
- 顶层工作空间"民间爱心食堂"正名为"社区普惠与社会互助专区"——纯前端展示字符串改动
  （`index.wxml` `platform-card-general`），不涉及任何落库字段，因为顶层工作空间从来
  就不落库（选择态完全由 `orgType==='yuhuazhai'` 与否派生，见 01 节文档）。

### 4.2 本轮明确收窄、未落地的部分（如实记录，避免被后续误认为"已支持"）

这一轮改动的范围判断标准，与第三节"elderly_canteen/volunteer_station 目标设计 vs 现状"
差距清单同一套克制原则——**文案/枚举层面的扩展可以做，但"全新业务概念/全新金融聚合逻辑/
针对不存在代码路径的防御性校验"不能在同一批顺手做掉**：

| 诉求 | 为什么本轮没做 |
|---|---|
| "义工"/"志愿者"全仓库文风替换为"护法义工/居士" | 实测 392 处/22 文件，深度嵌入海报绘制/报表格式化等工具函数，不止 wxml 标签；全局替换的风险量级远超本轮改动，只在上面 4.1 列出的既有"文案适配器"函数里新增真分支 |
| `statistics.ts`/`statistics.wxml` 层"就餐统计区分子项" | 该文件 4900+ 行/1700+ 行，是独立的大文件，"突出供斋结缘人次"已在首页阳光账本卡片实现同等语义，不在这个大文件上二次改动 |
| "定向托斋履约登记"（commercial_vegetarian） | 全新业务概念（赞助人↔具体斋期履约关系追踪），现有 schema 没有可复用字段，需要专项设计新集合，不是文案/枚举层面的改动 |
| commercial_vegetarian 收支"不纳入公共爱心收支审计链" | `getNationalDashboard` 是 1800+ 行、多维度交织聚合的金融计算云函数，服务真实付费租户，安全地把某个 orgType 的收支从"总额"里摘出是独立的金融逻辑改动，需要单独"提审"，不与本轮文案/枚举改动混在一起 |
| 寺院"禁止调用商业链路"后端断言 | 逐一核实 `liveFactoryCore`/`createProductionOrder`/`completeProductionOrder`/`processProductionRefund`/`wxPayCore` 后发现零个 orgType/businessType 引用——产销工坊是完全独立的租户类型（`businessType==='live_factory'`，且这类租户从不创建 `stores` 文档），今天没有任何代码路径能让一个 temple_canteen 门店的上下文触达这些云函数，前端"产销工坊"入口也统一挂 `hasProductionSpaceAccess`（基于独立的 `tenant_members` 成员关系，与 orgType 无关）对所有 orgType 一视同仁默认隐藏。未新增针对不存在代码路径的防御性断言（避免死代码）。真正的潜在缺口——寺院身份自然人理论上仍可单独兑换产销工坊邀请码加入 `tenant_members`——是桥接两个"物理隔离"设计的独立系统，属于更大的设计决策，留作后续专项 |
