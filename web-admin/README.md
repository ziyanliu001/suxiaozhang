# 素小账应急管理中台（Web，独立于微信生态）

紧急逃生舱四道防线的**第四道**：一个纯静态单文件页面（`index.html`），通过普通 Chrome/Edge 浏览器 + 独立账密登录，调用 `cloudfunctions/adminWebAuth`（认证）与 `cloudfunctions/adminWebConsole`（业务动作）。彻底不依赖微信登录态，即使唯一超级管理员的微信账号被封，只要这套账密还在，就能通过浏览器继续管理。

## 部署前置条件（需要你在腾讯云开发控制台手动确认/配置，代码本身无法验证）

1. **启用"未登录用户访问云资源权限"**：微信云开发控制台 → 环境 → 权限设置，打开"未登录用户访问云资源权限"（未登录模式）。
2. **为 `adminWebAuth`、`adminWebConsole` 各配置一条 HTTP 网关路由**：控制台 → 云函数 → HTTP 网关（官方文档化的标准能力），新增两条路由：
   - `/adminWebAuth` → 映射到 `adminWebAuth` 云函数
   - `/adminWebConsole` → 映射到 `adminWebConsole` 云函数
   两条路由都要**开启 CORS**、**免鉴权**（不要求 `access_token`/登录态）。配置完成后会得到一个形如 `<envId>-<随机数字>.<region>.app.tcloudbase.com` 的网关域名，把这个域名（不含协议前缀、不含路径）填进本页面登录页"连接设置"里的"HTTP 网关域名"字段。
3. **安全域名白名单**：控制台 → 环境 → 安全配置 → 安全域名，把本页面实际部署后的域名加进去（本地用 `file://` 直接打开通常也需要加 `localhost`/对应端口，具体以控制台报错提示为准）；若网关本身对 CORS 来源有限制，还需确认部署域名已被网关的 CORS 配置放行。
4. **部署两个新云函数**：`cloudfunctions/adminWebAuth`、`cloudfunctions/adminWebConsole`（与本仓库其余云函数同样的方式上传部署）。
5. **配置环境变量**：
   - `adminWebConsole` 需要 `ADMIN_CONSOLE_INTERNAL_TOKEN`，且必须与 `activateTenantSubscription` 侧配置的**同一个值**完全一致（两者互为调用方/被调用方，token 不一致会导致铸造授权码功能返回"铸造通道未启用"）。
6. **初始化第一个 Web 管理员账号**（二选一，不能通过网页自助注册——那样等于任何人都能自建管理员账号）：
   - 本地执行 `scripts/ops/init-web-admin.js`（见该目录 `README.md`，需要配置腾讯云 API 密钥）；
   - 或在微信开发者工具的云函数"云端测试"面板直接调用 `adminWebAuth` 的 `init_first_admin` 动作（`{ action: 'init_first_admin', username: 'admin', password: '...' }`），门槛更低，不需要本地配置任何密钥——**仅在 `platform_web_admins` 集合当前完全为空时可用**，一旦系统里已存在任意一条管理员记录，这条自举豁免会永久失效。

## 架构说明：为什么不用 `@cloudbase/js-sdk`，以及为什么最终选了官方 HTTP 网关

历经 2026-09-13 当天多轮真机排查（完整链路见下方「已知边界」），确认 `@cloudbase/js-sdk`（`v2.28.6`）的 `callFunction()` 无论如何都要求客户端本地先有一次成功的登录握手（哪怕是匿名登录）才能构造出凭证，而本项目的环境只开启了"未登录用户访问云资源权限"、没有开启（也不打算开启）"匿名登录"身份源——两者组合下 SDK 从架构上无法工作，任何客户端补丁都无法绕过。中途曾尝试反推 SDK 内部私有网关协议（`tcb-api.tencentcloudapi.com/web`）直连，协议格式本身被真机验证是对的，但该网关仍然要求云函数自身的"安全规则"放行才能免鉴权调用。

最终方案：改用腾讯云开发**官方文档化**的"HTTP 网关"能力——为这两个云函数各配置一条免鉴权、开启 CORS 的路由，本页面用浏览器原生 `fetch()` 直接 POST 到 `https://<网关域名>/<云函数名>`，完全不加载、不依赖 `@cloudbase/js-sdk`：

- **URL**：`https://<网关域名>/adminWebAuth` 或 `https://<网关域名>/adminWebConsole`
- **Method**：`POST`，`Content-Type: application/json`
- **Body**：直接就是业务数据本身（如 `{ action: 'login', username, password }`），不需要任何额外包装字段
- **响应**：云函数的返回值直接就是 HTTP 响应体（JSON），不需要额外解包

⚠️ **触发方式带来的一个必须处理的差异**：通过 HTTP 网关调用时，云函数收到的 `event` 参数里，请求体是被封装在 `event.body`（字符串）里的，不再是业务字段直接平铺在 `event` 上——这与云端测试/`cloud.callFunction()` 直接调用的参数形状不同。`cloudfunctions/adminWebAuth`、`cloudfunctions/adminWebConsole` 都新增了 `lib/normalizeGatewayEvent.js`，在 `exports.main` 入口统一识别两种触发方式并解包，函数体内其余逻辑不需要关心自己是被网关调用还是被直接调用。

## 使用方式

1. 用浏览器直接打开 `index.html`（本地文件或部署到任意静态网站托管均可，包括云开发自带的静态网站托管）。
2. 首次使用先展开登录页的"连接设置"，填写 HTTP 网关域名（见上方部署前置条件第 2 条），保存后刷新页面。
3. 用 `init-web-admin.js` 创建好的账密登录。
4. 登录态保存在浏览器 `sessionStorage`（关闭浏览器标签页即失效），不使用 `localStorage`——这是刻意的安全选择，管理工具的会话不应该无限期持久化。

## 三个功能页面

- **SaaS 授权码生成与管理**：选择套餐/数量/定向门店，一键铸造授权码，服务端实际转发给 `activateTenantSubscription` 的 `generate` 动作（不重新实现铸造逻辑，避免两处代码后续演化出不一致的字段口径）。
- **应急超管换绑中台**：输入目标微信 openid + 姓名 + 手机号，直接授予该账号小程序端的 `super_admin` 权限。**高危操作**，页面会弹二次确认，且每次操作都会写入 `audit_logs`（`channel: 'web_console'`）。
- **系统运行大盘**：全网活跃门店数、机构总数、`daily_tenant_snapshots` 昨日快照生成覆盖率（低于 90% 会用红色高亮，提示 `dailyTenantSnapshotCron` 可能没有正常跑完）。

## 安全说明

- 密码：`adminWebAuth` 用 Node 内置 `crypto.scrypt` 做加盐哈希存储，从不明文落库；连续登录失败 5 次锁定 30 分钟。
- 会话令牌：8 小时有效期，服务端签发（`crypto.randomBytes(32)`），前端只是原样携带，不参与任何签名/校验逻辑本身。
- 本页面**不直接读写数据库**——所有数据访问都通过云函数中转（`fetch()` 直连 HTTP 网关），云函数内部做真正的权限校验，浏览器端不持有任何数据库直接访问凭证。这与本仓库其余云函数一贯的"服务端强校验、客户端不可信"架构保持一致。
- 页面顶部 `<meta name="robots" content="noindex, nofollow">`：不希望被搜索引擎收录，但**这不是访问控制**，真正的门槛是账密登录 + 会话令牌校验，部署时仍建议配合安全域名白名单收紧可访问范围。
- ⚠️ `adminWebAuth`/`adminWebConsole` 的 HTTP 网关路由配置为免鉴权后，这两个函数对**任何知道网关域名的调用方**都是开放的，不再局限于本页面——这本来就是设计上早就承认的现实（"网关层能不能调用"与"业务权限是否放行"是两回事），安全边界从始至终都完全压在 `adminWebAuth` 的密码哈希 + 失败锁定，以及 `adminWebConsole` 每个 action 开头的 `sessionToken` 校验上，不要因为"看起来多加了一层网络限制"而误以为登录接口本身可以放松校验强度。

## 已知边界（如实标注）

- **完整排查链路（2026-09-13 一天内，八轮迭代）**：
  1. `ERR_CERT_COMMON_NAME_INVALID` 证书报错 → 定位为 `region` 参数与环境真实地域不一致；
  2. 改为不调用 `auth.signInAnonymously()` → 真机复现该调用被环境直接拒绝："请联系开发者在身份源列表开启匿名登录"；
  3/4. 先后尝试"预热 `auth.getSession()`""包装 `auth.getLoginState()`" 规避 `TypeError: Cannot read properties of null (reading 'scope')` → 真机（含无痕模式）复测证实崩溃依旧，两版补丁都打在了错误的对象上；
  5. 下载 CDN 上真实的 `cloudbase.full.js@2.28.6`，用 Node 搭桩件直接复现出一模一样的崩溃，字节级定位到 SDK 内部 `_getCredentials()` 的判空顺序颠倒 bug，打补丁消除崩溃后，用同一份复现脚本发现 `callFunction()` 改为得到干净的 `unauthenticated` 拒绝、请求从未真正发出——证实这版 SDK 无论如何都要求先有一次成功的登录才能拿到凭证；
  6. 彻底放弃 js-sdk，从其源码逐层反推出内部私有网关协议（`tcb-api.tencentcloudapi.com/web`），改用原生 `fetch()` 直连 → 真机实测确认协议格式完全正确（请求真实打到了腾讯云网关），但被网关以 `[PERMISSION_DENIED]` 拒绝；
  7. 确认根因是云函数自身独立于环境级开关之外的"安全规则"（`invoke` 规则）默认要求登录，且该规则无法通过任何云函数的 `config.json` 表达，只能在控制台配置；
  8.（本次）改用官方文档化的"HTTP 网关"能力替代第 6 步反推出的私有协议——控制台为两个函数各配置一条免鉴权 + CORS 的网关路由，页面直接 fetch 这个网关域名 + 函数名，协议是官方标准约定（`event.body` 承载请求体），不再依赖任何私有协议细节；云函数侧新增 `lib/normalizeGatewayEvent.js` 兼容两种触发方式的参数形状。
- **尚未有一轮"从头到尾完全跑通"的真机确认**——每一轮都是修复/重构上一轮暴露的问题后交付，如实标注这个状态。本次改用官方标准能力后，理论上不确定性比第 5~7 轮（依赖私有协议反推 + 云函数安全规则手工配置）更低，但仍然需要下一轮真机测试确认完整的登录 + 三个页面操作链路。
- **诊断基础设施**：所有面向用户的报错都会在浏览器控制台打印完整 `err.stack`（前缀 `[WEB_ADMIN_ERROR_STACK]`），界面红框同时展示堆栈前两行——若这次真机测试仍然失败，直接把控制台里这个前缀的完整内容贴出来，能比"页面提示网络异常"更快定位问题。
- **常见排查线索**：若看到 `Failed to fetch` 且没有更多信息，先检查浏览器 Network 面板里这条请求的具体失败原因（CORS 预检失败 / DNS 解析失败），核实"连接设置"里填的网关域名是否正确（不要带 `https://` 前缀或末尾斜杠，页面会自动清洗但最好一开始就填对）；若 HTTP 状态码是 404，说明网关路由没有正确映射到对应的云函数名；若响应体不是合法 JSON，很可能是网关本身返回了一个 HTML 错误页而不是云函数的返回值，多半是路由或 CORS 配置有误。
