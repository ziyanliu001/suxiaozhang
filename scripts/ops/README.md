# 应急运维脚本（scripts/ops/）

本目录下的脚本是"紧急逃生舱"四道防线里的**第三道**——完全脱离微信小程序/云函数运行时，直接用 [`@cloudbase/node-sdk`](https://docs.cloudbase.net/api-reference/node-sdk/introduction) + 腾讯云 API 密钥连接数据库。与其余两道应用层防线（`cloudfunctions/emergencyClaimSuperAdmin` 微信内密钥自助接管、`web-admin/` + `cloudfunctions/adminWebConsole` 独立 Web 管理中台）完全独立，互不依赖——即使小程序/云函数整体不可用，只要还能访问腾讯云控制台，本目录下的脚本永远可用。

## ⚠️ 安全须知（务必先读）

- `TENCENTCLOUD_SECRETID`/`TENCENTCLOUD_SECRETKEY` 是**账号级** API 密钥，能做的事远不止"授予超级管理员"——建议专门为运维场景申请一个**权限收窄过的子账号密钥**（腾讯云 CAM 子用户，只授予云开发相关的最小必要权限），不要直接用主账号根密钥。
- 密钥只通过环境变量传入，绝不作为命令行参数（会留在 shell 历史记录/进程列表里）。
- 用完建议立即 `unset TENCENTCLOUD_SECRETID TENCENTCLOUD_SECRETKEY`，不要长期挂在 `~/.bashrc` 等会话默认环境里。
- 与本仓库其余所有凭证同等对待：绝不提交进版本库、绝不写进任何 commit message/文档/日志。

## 安装依赖

```bash
cd scripts/ops
npm install
```

这里的依赖树与仓库根目录、各云函数完全独立（见本目录自己的 `package.json`），不会污染主依赖树，也不会被 Open-Core 构建流程扫描到。

## 环境变量

| 变量名 | 说明 | 获取方式 |
|---|---|---|
| `CLOUDBASE_ENV_ID` | 云开发环境 ID | 微信云开发控制台首页；与本仓库各云函数 `config.json` 里 `permissions.cloudbase.env` 是同一个值（如 `cloudbase-d8g7hg2bf851750ab`） |
| `TENCENTCLOUD_SECRETID` | 腾讯云 API 密钥 SecretId | [腾讯云 CAM 控制台 - API 密钥管理](https://console.cloud.tencent.com/cam/capi) |
| `TENCENTCLOUD_SECRETKEY` | 腾讯云 API 密钥 SecretKey | 同上，与 SecretId 成对生成 |

## `grant-super-admin.js`：紧急授予超级管理员

唯一超级管理员微信账号被封/丢失/失联，且另外两道防线（微信内密钥、Web 管理中台）也都无法使用时的最后手段。

```bash
export CLOUDBASE_ENV_ID=cloudbase-xxxxxxxx
export TENCENTCLOUD_SECRETID=xxxxxx
export TENCENTCLOUD_SECRETKEY=xxxxxx

node scripts/ops/grant-super-admin.js --openid <NEW_OPENID> --name "应急管理员"
```

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `--openid` | 是 | 要授权的新超管微信 openid（需要对方先打开一次小程序，从云开发控制台的 `users`/`user_roles` 集合里查到自己的 `_openid`） |
| `--name` | 否 | 接管人真实姓名，默认"应急管理员" |
| `--phone` | 否 | 接管人手机号，供后续核实身份用（这条通道的真正身份验证是"是否持有腾讯云 API 密钥"，手机号只是留痕信息，不强制填写） |
| `--tenant-id` | 视情况 | 要接管的机构 ID。系统里只有一家机构时可省略（自动关联）；有多家机构时必须显式指定，脚本不会替你猜 |
| `--yes` | 否 | 跳过交互式二次确认，供 CI/自动化场景使用 |

脚本会：
1. 写入/升级 `user_roles` 集合的 `super_admin` 记录（与 `setupSuperAdmin`/`emergencyClaimSuperAdmin` 同一套字段口径）。
2. 写入一条 `audit_logs` 高危审计记录（`action: 'EMERGENCY_SUPER_ADMIN_CLAIM'`，`channel: 'cli_script'`）。

## `init-web-admin.js`：初始化/重置 Web 管理中台账密

`web-admin/` 独立管理中台第一次使用前，或忘记密码需要重置时用这个脚本。

```bash
node scripts/ops/init-web-admin.js --username admin
# 之后会交互式提示输入两次密码（不回显），密码不接受命令行参数传入
```

密码要求：≥12 位，建议包含大小写字母/数字/符号。同一 `--username` 已存在时会重置密码（不会重复创建账号）。

> 💡 不方便配置 `TENCENTCLOUD_SECRETID`/`SECRETKEY` 时，也可以在微信开发者工具的云函数"云端测试"面板直接调用 `adminWebAuth` 的 `init_first_admin` 动作（`{ action: 'init_first_admin', username: 'admin', password: '...' }`），门槛更低——**仅在 `platform_web_admins` 集合当前完全为空时可用**，一旦系统里已存在任意一条管理员记录，这条自举豁免会永久失效，此后只能走本脚本重置密码。两条路径产生的账号记录完全等价。

## 为什么不用 `wx-server-sdk`

`wx-server-sdk` 的 `cloud.init()` 依赖云函数运行时环境隐式注入的凭据，本地脚本环境里用不了——本仓库 `scripts/seedActivationCodes.ts` 早就记录过这个结论。`@cloudbase/node-sdk` 是腾讯云 CloudBase 专门给"外部服务器/本地脚本"场景设计的另一个 SDK，走显式的 SecretId/SecretKey 鉴权，这正是本目录脚本存在的意义。
