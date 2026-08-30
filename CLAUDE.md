# 架构规范

## 多租户隔离与全国公信力大屏双轨制设计

本项目的数据展示分两条彻底解耦的轨道，任何新功能在落地前先判断自己属于哪一条，不要混用两边的权限逻辑。

### 轨道一：业务工作空间（Workspace / 生产台）

**工作空间维度**（`workspaceType`）：雨花公益食堂专区 / 通用素食记账 / 素食直播产销工坊。

- **定位**：私有业务生产与记账工具，数据严格按 `tenantId` 隔离。
- **套餐升级逻辑**：`tenant_subscriptions`（`basic`/`pro`/`enterprise`）购买的是**私有功能深度**——多店连锁管理的深度操作（如 Excel 批量导出、进销存排单、多角色协同），而不是"能不能看自己机构的基础数据"。绝不可跨空间查看其他商业租户的私密流水（`makeTenantFilter(tenantId)` 是唯一真源，任何查询都不能因为筛选条件而退化成跨租户全量聚合）。
- **代码入口**：`utils/tenantPermission.ts` 的 `FEATURE_KEYS`（`MULTI_STORE_DASHBOARD`、`EXCEL_EXPORT`）+ `checkTenantPermission()`。

### 轨道二：全国大屏（Dashboard / 透视台）

**全国大屏维度**：全网爱心与公益公信力总览。

- **定位**：社会公信力、透明公开账目与爱心公示，服务于"让所有人看见善意"这一目标。
- **权限逻辑**：**查看权限完全不挂钩商业套餐**——角色卡口（`ALLOWED_ROLES`）+ 租户隔离仍然生效（不跨租户），但不因为租户是 `basic` 套餐就拒绝查看。财务类敏感字段（收支金额、结余）继续按角色脱敏展示（`sanitizeReportForVolunteer`、前端 `isManager` 判断），这是**角色**维度的隐私保护，不是**套餐**维度的功能锁，两者不要混为一谈。
- **代码入口**：`cloudfunctions/getNationalDashboard`、`pages/statistics/statistics.ts` 的 `loadNationalDashboard()`/`_triggerPatriarchNationalView()`。

### 数据分类口径正交独立

- **`workspaceType`**（空间类型）：决定业务表单与流程流转，是"这个租户在用哪套业务模板"。
- **`orgType`**（组织类型：`all`/`yuhuazhai`/`elderly_canteen`/`rescue_team`/`volunteer_station`/`children_home`/`other`）：用于全国大屏横向分类聚合（如"全部平台/雨花斋/助老食堂/救援队"Tab），是租户内部门店的业态标签，**不受当前所在工作空间上下文的租户 ID 强制截断**——同一租户下可以同时存在多个 `orgType` 的门店，全国大屏据此做横向分组，而不是反过来用 `orgType` 去圈定或替代 `tenantId` 隔离边界。

### 判断新功能该走哪条轨道的经验法则

问自己："这个功能是在回答『我的机构做得怎么样』（工作空间），还是『整个爱心网络的公开成果是什么』（全国大屏）？" 前者可以合理地挂订阅套餐，后者原则上应该始终可查看（导出/深度筛选等衍生能力仍可单独挂套餐，但"能不能看基础数据"本身不应该挂）。

**历史教训**：`getNationalDashboard` 曾经把"查看全国大屏"和"`tenant_subscriptions` 是否为 pro/enterprise"耦合在一起（`PLAN_UPGRADE_REQUIRED` 拦截），导致基础版租户的大家长/财务/志工角色切换组织类型 Tab 时每次请求都被服务端拒绝，界面表现为"点了没反应"——这正是把两条轨道的权限逻辑混在一起导致的典型问题。修复见 2026-08-30 的 commit。
