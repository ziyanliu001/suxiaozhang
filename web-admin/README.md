# 素小账应急管理中台（Web，独立于微信生态）

紧急逃生舱四道防线的**第四道**：一个纯静态单文件页面（`index.html`），通过普通 Chrome/Edge 浏览器 + 独立账密登录，直连云开发 Web SDK 调用 `cloudfunctions/adminWebAuth`（认证）与 `cloudfunctions/adminWebConsole`（业务动作）。彻底不依赖微信登录态，即使唯一超级管理员的微信账号被封，只要这套账密还在，就能通过浏览器继续管理。

## 部署前置条件（需要你在腾讯云开发控制台手动确认/配置，代码本身无法验证）

1. **启用"未登录用户访问云资源权限"**：微信云开发控制台 → 环境 → 权限设置，打开"未登录用户访问云资源权限"（未登录模式）。
   > ⚠️ 这与腾讯云独立版 CloudBase 的"匿名登录"身份源是**两回事**，不要混淆：本页面不调用、也不依赖 `auth.signInAnonymously()`——早期实现误以为需要先匿名登录换取登录态，结果在只开启了"未登录访问权限"（没有开启"匿名登录"身份源）的环境里被直接拒绝："请联系开发者在身份源列表开启匿名登录"。移除这一步之后又暴露出 `@cloudbase/js-sdk` 自身的一个初始化顺序缺陷：如果从未调用过任何 `auth` 相关方法，`callFunction()` 内部会因为读取一个仍是 `null` 的登录态对象而在浏览器端直接抛异常崩溃、请求根本发不出去。现在的写法是每次调用前先 `auth.getSession()`（纯查询"有没有现成会话"，不要求任何身份源已配置，查询结果是"没有"或失败都无所谓）"预热"一下 SDK 内部状态，再调用 `app.callFunction()`——这一步只是绕开 SDK 自身的缺陷，不代表任何业务身份，真正的操作权限完全由 `adminWebAuth` 登录后签发的会话令牌决定。
2. **安全域名白名单**：控制台 → 环境 → 安全配置 → 安全域名，把本页面实际部署后的域名加进去（本地用 `file://` 直接打开通常也需要加 `localhost`/对应端口，具体以控制台报错提示为准）。
3. **部署两个新云函数**：`cloudfunctions/adminWebAuth`、`cloudfunctions/adminWebConsole`（与本仓库其余云函数同样的方式上传部署）。
4. **配置环境变量**：
   - `adminWebConsole` 需要 `ADMIN_CONSOLE_INTERNAL_TOKEN`，且必须与 `activateTenantSubscription` 侧配置的**同一个值**完全一致（两者互为调用方/被调用方，token 不一致会导致铸造授权码功能返回"铸造通道未启用"）。
5. **初始化第一个 Web 管理员账号**（二选一，不能通过网页自助注册——那样等于任何人都能自建管理员账号）：
   - 本地执行 `scripts/ops/init-web-admin.js`（见该目录 `README.md`，需要配置腾讯云 API 密钥）；
   - 或在微信开发者工具的云函数"云端测试"面板直接调用 `adminWebAuth` 的 `init_first_admin` 动作（`{ action: 'init_first_admin', username: 'admin', password: '...' }`），门槛更低，不需要本地配置任何密钥——**仅在 `platform_web_admins` 集合当前完全为空时可用**，一旦系统里已存在任意一条管理员记录，这条自举豁免会永久失效。

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
- 本页面**不直接读写数据库**——所有数据访问都通过云函数中转（`app.callFunction()`），云函数内部做真正的权限校验，浏览器端不持有任何数据库直接访问凭证。这与本仓库其余云函数一贯的"服务端强校验、客户端不可信"架构保持一致。
- 页面顶部 `<meta name="robots" content="noindex, nofollow">`：不希望被搜索引擎收录，但**这不是访问控制**，真正的门槛是账密登录 + 会话令牌校验，部署时仍建议配合安全域名白名单收紧可访问范围。

## 已知边界（如实标注）

- 已在真实浏览器里复现过两轮报错并针对性修复（`ERR_CERT_COMMON_NAME_INVALID` 证书报错 → 匿名登录被拒绝 → `callFunction` 内部 `null.scope` 崩溃），但**尚未有一轮"从头到尾完全跑通"的真机确认**——每一轮都是修复上一轮暴露的问题后交付，下一次真机测试才验证出下一层问题，如实标注这个"修复-复测-发现新问题"的迭代状态，不代表已经端到端验证过。
- **不再做地域自动探测**：早期版本曾经因为怀疑 `region` 参数猜错导致证书报错，加过一套自动依次尝试 `ap-shanghai`/`ap-guangzhou`/`ap-singapore` 三个地域的探测逻辑，且探测过程本身依赖 `auth.signInAnonymously()` 判断连通性。2026-09-13 确认该依赖本身就是错的（见上方部署前置条件的说明）后，探测逻辑随之整体移除——现在 `cloudbase.init()` 只在"连接设置"填了 `region` 时才会传这个参数，留空时使用 SDK 默认行为。至于 `ERR_CERT_COMMON_NAME_INVALID` 这类证书报错和"匿名登录被拒绝"这个报错之间是不是同一个根因的两种表现，还是排查过程中先后遇到的两个独立问题，目前没有足够证据下定论，如实标注这个不确定性。
- **`callFunction` 前仍保留一次 `auth.getSession()`，不是又悄悄依赖登录态**：移除 `signInAnonymously()` 后真机复现出 `TypeError: Cannot read properties of null (reading 'scope')`——`@cloudbase/js-sdk` (v2.28.6) 从未接触过 `auth` 模块时，内部登录态对象是 `null`，`callFunction()` 的请求拦截器直接读它的 `.scope` 字段就会崩溃，请求根本发不出去。`getSession()` 是一次纯查询（不要求任何身份源已配置，返回"没有会话"或直接失败都无所谓，代码里已 `catch` 吞掉），只用来把这个内部状态从 `null` "点亮"成一个正常的默认对象，不构成对登录态/身份源的依赖，与本条"未登录用户访问云资源权限"的部署前提不冲突。这个具体的 SDK 内部行为没有找到公开文档明确佐证，是根据真机报错文本反推的判断，如实标注不确定性。
- **常见排查线索**：若登录报"网络异常或环境配置有误"，先排除环境 ID 是否正确、静态托管是否已开启"未登录用户访问云资源权限"、部署域名是否在安全域名白名单内；若浏览器控制台明确看到 `ERR_CERT_COMMON_NAME_INVALID` 之类的证书报错，再尝试在"连接设置"里手动填一个 `region`；若看到 `Cannot read properties of null (reading 'scope')`，说明命中的正是上一条记录的 SDK 初始化顺序缺陷，需要确认部署的是包含 `getSession()` 预热步骤的最新版本。
