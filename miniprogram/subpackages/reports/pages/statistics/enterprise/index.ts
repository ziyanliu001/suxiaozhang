// 🏛️ Open-Core 架构拆分 · 终局阶段：pages/statistics 的 Enterprise 扩展包
// 统一汇合点。
//
// statistics.ts 只从这一个文件 import，不直接 import 三个子模块——这是刻意
// 设计的唯一入口：scripts/build-open-core.js 打包开源 Core 包时，只需要用
// 一份 stub（core-overrides/statistics.enterprise.index.ts，导出结构相同、
// 方法体全部改成安全的空操作）整份覆盖这一个文件，就能让 statistics.ts 在
// 完全不感知 Open-Core 构建流程的情况下正常编译——三个真实实现文件
// （nationalDashboardService.ts/drillDownHandler.ts/procurementHandler.ts）
// 在 Core 包里直接物理删除，不随包分发。
export { nationalDashboardHandlers } from './nationalDashboardService';
export { drillDownHandlers } from './drillDownHandler';
export { procurementHandlers } from './procurementHandler';
