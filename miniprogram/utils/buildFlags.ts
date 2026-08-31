// 🏛️ Open-Core 构建旗标（第三阶段：物理构建与打包脚本）
//
// 本文件是唯一一处"这次编译出的是完整版（Enterprise）还是开源核心版（Core）"
// 的开关。scripts/build-open-core.js 组装 suxiaozhang-core 发布包时，会用
// 本文件的一份 ENTERPRISE_BUILD_ENABLED = false 覆盖版本替换掉这份源码里的
// 默认值（默认 true，即"仓库里的源码默认按完整版编译，不改代码就不会意外
// 漏发 Core 包"）。
//
// 🐛 为什么用运行时旗标而不是物理删代码：pages/profile/profile.ts 的 SaaS
// 订阅弹窗入口点（onOpenSubscriptionModal 及其在 pro-service-card/
// top-advanced-secondary/sa-dev-tool-row 三处 WXML 里的调用点）排查后发现
// 分散在页面多处、且与免费版账户设置深度交织在同一个文件里——不是像
// cloudfunctions/exportAccountExcel 那样已经物理拆成独立文件的干净边界，
// 贸然用脚本按行删除有真实概率删漏某一处入口或删出语法错误。物理拆分
// pages/profile 需要先把订阅相关 UI 抽成独立组件/页面，是比"写构建脚本"更大的
// 独立工作量，本阶段先用这个旗标实现"运行时完全不可达"（用户在 Core 部署下
// 绝对看不到、点不开任何 SaaS 购买入口），物理层面的源码纯净度作为已知遗留
// 项记录在 docs/OPEN_CORE_ARCHITECTURE.md 第三阶段小节，不在这里假装已经
// 做完物理拆分。
export const ENTERPRISE_BUILD_ENABLED = true;
