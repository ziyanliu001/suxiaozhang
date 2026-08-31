# 素小账 · Core（开源核心版）

单店 / 单机构公益记账小程序：透明账目、义工打卡、防篡改存证核验、阳光台账导出。本包由主仓库的 `scripts/build-open-core.js` 自动生成，是从完整版仓库里过滤掉商业化（Enterprise）能力后的开源发布包，可直接用于自托管私有化部署。

## 这份包里有什么

- 单店/同机构内多店记账、日报、义工打卡与爱心护持榜、阳光账本、公开核验（`publicVerifyReport`）、单店 Excel 台账导出。
- 通用支付基础设施（`wxPayCore`）：默认模拟模式（`PAYMENT_MOCK_MODE=true`）即可跑通产销工坊等内置业务的下单/支付/退款全流程，无需真实微信支付商户号。

## 这份包里没有什么（以及为什么）

以下能力是主仓库的 Enterprise（商业专有）部分，本包不包含对应云函数/页面：

- 全国大屏跨机构聚合、跨店调拨撮合、防篡改存证徽章（原 `getNationalDashboard`）
- SaaS 订阅套餐配额鉴权与开通/续费下单（原 `checkTenantPermission` / `activateTenantSubscription` / `manageTenantSubscription` / `createSubscriptionOrder`）
- 多店合并阳光台账导出（`exportAccountExcel` 已替换为纯单店版本）
- SaaS 平台运维方专属大盘（原 `subpackages/admin/pages/platform-admin` 页面及其云函数）

这不是功能阉割，而是"公益信任基础设施要不要开源"和"要不要收费"两条正交的判断轴——详见主仓库 `docs/OPEN_CORE_ARCHITECTURE.md`（本包不含此文档，因为它本身记录的就是"哪些代码故意不开源"，不适合随开源包分发）。

### 已知遗留（诚实说明，不回避）

`pages/profile/profile.ts` 里仍然保留了 SaaS 订阅弹窗的源码，但通过 `utils/buildFlags.ts` 里的 `ENTERPRISE_BUILD_ENABLED = false` 在运行时**完全隐藏并禁用**了所有入口（三处按钮 + 自动唤起逻辑）——用户在这份 Core 包构建出的小程序里绝对看不到、点不开任何购买/续费弹窗，但源码文本本身还在文件里（物理拆分成独立页面/组件是更大的独立工作量，尚未进行）。`pages/statistics/` 同理保留了全国大屏相关渲染代码，实际调用会因为对应云函数已被排除而优雅失败，不影响单店统计功能。

## 快速开始（微信开发者工具）

1. 用微信开发者工具打开本目录，`project.config.json` 里的 `appid` 已替换为 `touristappid`（无账号预览占位值）——正式使用请换成你自己申请的小程序 AppID。
2. 在微信云开发控制台新建/绑定一个云环境，`miniprogram/app.ts` 中的云环境 ID 需要改成你自己的。
3. 逐个上传并部署 `cloudfunctions/` 目录下的云函数（右键「上传并部署：云端安装依赖」）。
4. 参考 `env.example.json`，在云开发控制台「云函数 > 环境变量」中配置每个云函数需要的变量（至少需要 `LEDGER_HMAC_SECRET`，见该文件说明）。
5. 首次运行任意角色相关云函数前，建议先调用一次 `createIndexes` 云函数，为常用查询字段建立数据库索引。
6. 通过 `createTenant` 云函数（或对应前端入口）创建你自己的机构账套，即可开始使用。

## License

见主仓库 License 说明（本模板未内置具体协议文本，发布前请自行补充）。
