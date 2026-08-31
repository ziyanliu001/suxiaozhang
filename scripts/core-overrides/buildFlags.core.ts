// 🏛️（2026-08-31 Open-Core 第三阶段构建产物）scripts/build-open-core.js 打包
// suxiaozhang-core 时，用本文件整体覆盖 miniprogram/utils/buildFlags.ts——
// 唯一的差异是 ENTERPRISE_BUILD_ENABLED 改为 false，强制关闭 pages/profile
// 里所有 SaaS 订阅弹窗入口（见该文件与 miniprogram/utils/buildFlags.ts 的
// 头部注释）。除这一行常量取值外，不应再有任何其它差异。
export const ENTERPRISE_BUILD_ENABLED = false;
