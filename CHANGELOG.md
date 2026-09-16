# Changelog

本文件记录项目的重要变更。版本号遵循语义化版本（[SemVer](https://semver.org/lang/zh-CN/)），格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

## [1.1.0] - 2026-09-16

### 六大核心模块并发 / 弱网 / 资金安全重构

一次跨六个模块的系统性加固，重点是并发安全、弱网韧性与资金正确性，非新功能迭代。详见 `docs/architecture/04_vibe_coding_refactor_2026.md` 完整复盘。

- **云端调用网关**：`cloudGuard.ts` 新增 `callCloudFunctionGuarded()` 高阶封装（耗时监控 + 出错降级提示）；`checkTenantPermission` 新增越权探测审计日志。
- **多租户页面并发/离线**：`daily-menu.ts` 补齐并发加载态与本地缓存兜底；义工打卡云端同步遗漏的入队场景补齐离线队列。
- **Canvas 海报临时文件**：`posterGenerator.ts` 下载/压缩产生的临时文件改用 `try/finally` 强制回收，消除长期运行的存储泄漏；收敛多处重复的绘图基础函数。
- **义工打卡防并发**：`manageVolunteerCheckIn` 改用确定性主键（`{tenantId, storeId, openid, dateString, shiftKey}`）杜绝同班次重复打卡的 TOCTOU 竞态，同时兼容"撤销后重新打卡"的合法流程。
- **支付退款资金安全**：`wxPayCore` 复用下单/退款记录时补齐金额一致性校验，杜绝本地账本与微信网关金额分叉；确认既有的乐观锁 CAS 状态迁移与并发退款锁仍然有效。
- **Excel 导出稳定性**：修复 `exportAccountExcel`/`exportSettlementExcel` 里 `.limit()` 超过云数据库单次 1000 条硬上限被静默截断导致的数据丢失，改为分批拉取；补齐执行超时的安全中断与友好提示。

### 工程巡检

- 全仓库 `.wxml` 扫描确认 `wx:for` 与 `wx:key` 已 1:1 配对，无遗漏。
- 清理 `miniprogram/` 下 16 处遗留的排查性 `console.log`（均带有"临时/排查/DEBUG"性质的注释标注），保留全部 `console.error`/`console.warn` 及具备长期诊断价值的结构化日志。

## [1.0.0]

- 初始版本号基线（历史变更未追溯记录）。
