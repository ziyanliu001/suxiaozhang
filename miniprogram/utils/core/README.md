# `utils/core/`

Open-Core 拆分（2026-08-31）的前端归口目录：只放"拟开源 Core 层"允许直接依赖的工具模块。

## 收录标准

一个模块可以放进这里，当且仅当它满足：

1. **不 import 任何 Enterprise 专属模块**——不引用 `tenant_subscriptions`/`subscriptionQuota`/`checkTenantPermission`/`FEATURE_KEYS` 等 SaaS 订阅概念，不引用全国大屏（`getNationalDashboard`）、跨店调拨、合并导出相关的任何字段或云函数名。
2. **不包含商业计费规则、私有联系方式、定价文案等敏感/私有信息**。
3. **单店视角自洽**——一个只跑单店记账、没有接入任何 Enterprise 云函数的部署，这个模块也应该能正常工作。

## 当前收录

- `privacy.ts`：姓名/手机号/身份证号/银行账号脱敏（`maskName`/`maskPersonName`/`formatDisplayName`/`maskPhone`/`maskIdCard`/`maskBankAccount`）。这是"阳光脱敏规范"的唯一权威实现——`cloudfunctions/manageVolunteerCheckIn`、`cloudfunctions/publicVerifyReport`、`cloudfunctions/getNationalDashboard`、`cloudfunctions/getSunshineLedger`、`pages/index/index.wxs` 等各云函数/WXS 里的同名实现是各自独立部署环境下的手工同步拷贝（无跨云函数共享模块机制），逻辑必须与本文件保持一致，但物理上无法合并成同一份代码。

## 与 Enterprise 层的边界

反方向的耦合点收在 `miniprogram/utils/enterpriseCapabilities.ts`（有意不放进 `core/` 目录）——那是 Core 页面用来"询问商业能力是否可用"的薄封装层，本身依赖 Enterprise 云函数返回的 `subscriptionQuota` 形状，因此不满足上面第 1 条标准，不属于 Core。

完整的 Open-Core 架构拆分方案（Core/Enterprise 文件清单、SPI 接口契约、迁移路线图）见 Obsidian 智慧库 `01-Projects/素小账/雨花公益食堂-架构与业务规范.md` 的「2026-08-31 商业架构演进：Open-Core 模式拆分与代码解耦规划」一节。
