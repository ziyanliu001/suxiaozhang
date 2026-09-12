# 素小账应急管理中台（Web，独立于微信生态）

紧急逃生舱四道防线的**第四道**：一个纯静态单文件页面（`index.html`），通过普通 Chrome/Edge 浏览器 + 独立账密登录，调用 `cloudfunctions/adminWebAuth`（认证）与 `cloudfunctions/adminWebConsole`（业务动作）。彻底不依赖微信登录态，即使唯一超级管理员的微信账号被封，只要这套账密还在，就能通过浏览器继续管理。

## 部署前置条件（需要你在腾讯云开发控制台手动确认/配置，代码本身无法验证）

1. **启用"未登录用户访问云资源权限"**：微信云开发控制台 → 环境 → 权限设置，打开"未登录用户访问云资源权限"（未登录模式）。
   > ⚠️ 本页面**不加载 `@cloudbase/js-sdk`**，改用浏览器原生 `fetch()` 直连云函数 HTTP 网关（详见下方「架构说明」）——这是历经四轮真机排查后的最终方案，原因见「已知边界」。这一步依然是硬前提：本页面发出的请求完全不带 `access_token`，服务端必须已经开启这个开关才会放行。
2. **安全域名白名单**：控制台 → 环境 → 安全配置 → 安全域名，把本页面实际部署后的域名加进去（本地用 `file://` 直接打开通常也需要加 `localhost`/对应端口，具体以控制台报错提示为准）。
3. **部署两个新云函数**：`cloudfunctions/adminWebAuth`、`cloudfunctions/adminWebConsole`（与本仓库其余云函数同样的方式上传部署）。
4. **配置环境变量**：
   - `adminWebConsole` 需要 `ADMIN_CONSOLE_INTERNAL_TOKEN`，且必须与 `activateTenantSubscription` 侧配置的**同一个值**完全一致（两者互为调用方/被调用方，token 不一致会导致铸造授权码功能返回"铸造通道未启用"）。
5. **初始化第一个 Web 管理员账号**（二选一，不能通过网页自助注册——那样等于任何人都能自建管理员账号）：
   - 本地执行 `scripts/ops/init-web-admin.js`（见该目录 `README.md`，需要配置腾讯云 API 密钥）；
   - 或在微信开发者工具的云函数"云端测试"面板直接调用 `adminWebAuth` 的 `init_first_admin` 动作（`{ action: 'init_first_admin', username: 'admin', password: '...' }`），门槛更低，不需要本地配置任何密钥——**仅在 `platform_web_admins` 集合当前完全为空时可用**，一旦系统里已存在任意一条管理员记录，这条自举豁免会永久失效。

## 架构说明：为什么不用 `@cloudbase/js-sdk`

历经 2026-09-13 当天四轮真机排查（完整链路见下方「已知边界」），确认这个 SDK 版本（`2.28.6`）的 `callFunction()` 无论如何都要求客户端本地先有一次成功的登录握手（哪怕是匿名登录）才能构造出凭证，而本项目的环境只开启了"未登录用户访问云资源权限"、没有开启（也不打算开启）"匿名登录"身份源——两者组合下 SDK 从架构上无法工作，任何客户端补丁都无法绕过。

因此本页面改为用浏览器原生 `fetch()` 直连 SDK 内部实际使用的云函数 HTTP 网关，协议细节是从 `cloudbase.full.js` 源码逐层反推确认的（不是凭空拼一个未文档化的接口）：

- **URL**：`https://<envId>.<region||'ap-shanghai'>.tcb-api.tencentcloudapi.com/web?env=<envId>`
- **Method**：`POST`，`Content-Type: application/json;charset=UTF-8`
- **Body**：
  ```json
  {
    "action": "functions.invokeFunction",
    "dataVersion": "2020-01-10",
    "env": "<envId>",
    "function_name": "<云函数名>",
    "request_data": "<data 参数 JSON.stringify 后的字符串>"
  }
  ```
- **成功响应**：`{ requestId, data: { response_data: "<JSON 字符串>" } }`——`response_data` 需要再 `JSON.parse` 一次才是真正的 `result`。
- **失败响应**：顶层带 `code` 字段，形如 `{ code, message }`。

与官方 SDK 自身实现的唯一区别：SDK 会在请求体里额外带一个 `access_token` 字段（因为 `functions.invokeFunction` 不在 SDK 内部"免鉴权动作白名单"里，一定会先尝试拿 token，这正是它在本项目环境下无法工作的根源）——本页面刻意不带这个字段，赌的是"未登录用户访问云资源权限"这个开关本来就是为完全不带 `access_token` 的请求设计的授权豁免，只是 SDK 客户端自己的实现从未开放过这条路径。⚠️ **这个假设未经真实网络验证**，需要真机测试确认服务端是否真的放行。

## 使用方式

1. 用浏览器直接打开 `index.html`（本地文件或部署到任意静态网站托管均可，包括云开发自带的静态网站托管）。
2. 首次使用先展开登录页的"连接设置"，填写云开发环境 ID（`envId`，与本仓库各云函数 `config.json` 里 `permissions.cloudbase.env` 是同一个值），保存后刷新页面。
3. 用 `init-web-admin.js` 创建好的账密登录。
4. 登录态保存在浏览器 `sessionStorage`（关闭浏览器标签页即失效），不使用 `localStorage`——这是刻意的安全选择，管理工具的会话不应该无限期持久化。

## 三个功能页面

- **SaaS 授权码生成与管理**：选择套餐/数量/定向门店，一键铸造授权码，服务端实际转发给 `activateTenantSubscription` 的 `generate` 动作（不重新实现铸造逻辑，避免两处代码后续演化出不一致的字段口径）。
- **应急超管换绑中台**：输入目标微信 openid + 姓名 + 手机号，直接授予该账号小程序端的 `super_admin` 权限。**高危操作**，页面会弹二次确认，且每次操作都会写入 `audit_logs`（`channel: 'web_console'`）。
- **系统运行大盘**：全网活跃门店数、机构总数、`daily_tenant_snapshots` 昨日快照生成覆盖率（低于 90% 会用红色高亮，提示 `dailyTenantSnapshotCron` 可能没有正常跑完）。

## 安全说明

- 密码：`adminWebAuth` 用 Node 内置 `crypto.scrypt` 做加盐哈希存储，从不明文落库；连续登录失败 5 次锁定 30 分钟。
- 会话令牌：8 小时有效期，服务端签发（`crypto.randomBytes(32)`），前端只是原样携带，不参与任何签名/校验逻辑本身。
- 本页面**不直接读写数据库**——所有数据访问都通过云函数中转（`fetch()` 直连 HTTP 网关触发 `functions.invokeFunction`），云函数内部做真正的权限校验，浏览器端不持有任何数据库直接访问凭证。这与本仓库其余云函数一贯的"服务端强校验、客户端不可信"架构保持一致。
- 页面顶部 `<meta name="robots" content="noindex, nofollow">`：不希望被搜索引擎收录，但**这不是访问控制**，真正的门槛是账密登录 + 会话令牌校验，部署时仍建议配合安全域名白名单收紧可访问范围。

## 已知边界（如实标注）

- **完整排查链路（2026-09-13 一天内四轮真机报错 + 一轮方向性重构）**：
  1. `ERR_CERT_COMMON_NAME_INVALID` 证书报错 → 定位为 `region` 参数与环境真实地域不一致；
  2. 改为不调用 `auth.signInAnonymously()` → 真机复现该调用被环境直接拒绝："请联系开发者在身份源列表开启匿名登录"；
  3/4. 先后尝试"预热 `auth.getSession()`""包装 `auth.getLoginState()`" 规避 `TypeError: Cannot read properties of null (reading 'scope')` → 真机（含无痕模式）复测证实崩溃依旧，两版补丁都打在了错误的对象上；
  5. 下载 CDN 上真实的 `cloudbase.full.js@2.28.6`，用 Node 搭桩件直接复现出一模一样的崩溃，字节级定位到 SDK 内部 `_getCredentials()` 的判空顺序颠倒 bug（`if(t.scope===p)return t;if(!t){...}`），打补丁消除崩溃后，用同一份复现脚本发现 `callFunction()` 改为得到干净的 `unauthenticated` 拒绝、请求从未真正发出——证实这版 SDK 无论如何都要求先有一次成功的登录才能拿到凭证；
  6.（本次）彻底放弃 js-sdk，改用原生 `fetch()` 直连其内部网关，见上方「架构说明」。
- **尚未有一轮"从头到尾完全跑通"的真机确认**——每一轮都是修复/重构上一轮暴露的问题后交付，如实标注这个状态；本次的架构变更（绕开 SDK）在 Node 环境里只验证到"请求 URL/Body 格式与 SDK 源码逐行对应"以及"用本地 mock HTTP server 验证过 `callFn()` 的成功/失败两条分支逻辑正确"这两层，**没有连接过真实的云开发网关**，服务端是否真的放行不带 `access_token` 的请求需要下一轮真机测试确认。
- **诊断基础设施**：所有面向用户的报错都会在浏览器控制台打印完整 `err.stack`（前缀 `[WEB_ADMIN_ERROR_STACK]`），界面红框同时展示堆栈前两行——若这次真机测试仍然失败，直接把控制台里这个前缀的完整内容贴出来，能比"页面提示网络异常"更快定位到底是网关地址错了、CORS 被拦了，还是服务端确实要求 `access_token`。
- **常见排查线索**：若看到 `Failed to fetch` 且没有更多信息，先检查浏览器 Network 面板里这条请求的具体失败原因（CORS 预检失败 / DNS 解析失败 / 证书错误），核实 `envId`/`region` 拼出来的网关地址是否正确；若响应体里有 `code` 字段（如 `ResourceNotFound.FunctionNotFound`、`InvalidParameter`、或与鉴权相关的错误码），说明请求已经发到网关、服务端返回了明确的业务错误，可以直接根据 `code`/`message` 判断下一步。
