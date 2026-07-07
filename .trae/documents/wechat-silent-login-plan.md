# 微信静默登录功能实施方案

## Context

当前项目是微信云开发小程序（`vegetarian-ledger-assistant`），需要为不同用户准确记录和区分账目数据。现有架构中云函数 `getStatistics` 已通过 `cloud.getWXContext()` 获取 `OPENID` 进行数据过滤，但前端 `dataService.ts` 的 `getReports`/`getStatistics` 未做 `_openid` 过滤，且 `app.ts` 中的 `wx.login()` 仅是占位代码未真正使用。

采用云开发原生方案（而非传统 `code2Session` + 独立后端），因为：
1. 云函数 `cloud.getWXContext()` 可直接获取 openid，更安全且无需管理 AppSecret
2. 与现有云开发架构一致，无需额外维护服务器
3. 云开发自动为每条数据注入 `_openid`，权限规则天然保证数据隔离

## 关键约束（来自用户补充）

1. **时区处理**：云函数运行在 UTC+0，计算时间范围时需转 UTC+8（北京时间）
2. **登录容错与超时**：`ensureLogin()` 需 5s 超时 + 异常捕获，失败时关闭 Loading 并提示重试
3. **新用户初始化**：openid 不存在时自动创建 users 文档
4. **本地缓存加速**：登录成功后写入 Storage，后续优先读缓存实现无感体验
5. **首页严格等待登录完成**：`index.ts` 的 `onLoad` 中 `await AuthService.ensureLogin()` 后再加载数据

## 实施步骤

### 步骤 1：新建 `login` 云函数

**新建文件**：`cloudfunctions/login/package.json`
```json
{
  "name": "login",
  "version": "1.0.0",
  "description": "微信静默登录云函数",
  "main": "index.js",
  "dependencies": { "wx-server-sdk": "~2.6.3" }
}
```

**新建文件**：`cloudfunctions/login/index.js`
- 通过 `cloud.getWXContext()` 获取 `OPENID`
- 在 `users` 集合查找用户：存在则更新 `lastLoginTime`，不存在则创建新记录
- 用户记录包含：`_openid`、`createTime`、`lastLoginTime`、`nickName`（预留）、`avatarUrl`（预留）
- 返回 `{ success, openid, user }`
- 时间字段使用 `db.serverDate()`（已是 UTC+8 服务端时间，无需额外处理）

### 步骤 2：新建前端 `authService.ts`

**新建文件**：`miniprogram/utils/authService.ts`

核心方法：
- `ensureLogin(): Promise<{success, openid?, error?}>`
  - 优先读本地缓存 `auth_openid`，命中直接返回
  - 未命中则 `wx.cloud.callFunction({ name: 'login' })`
  - **5s 超时处理**：用 `Promise.race` 包装，超时返回 `{ success: false, error: '登录超时' }`
  - 成功后写入 `auth_openid` 和 `auth_user`（JSON 字符串）到 Storage
  - 完整 `try...catch`，异常时返回明确错误信息
- `getOpenid(): string | null` — 读缓存
- `getUser(): any | null` — 读用户信息缓存
- `isLoggedIn(): boolean` — 判断登录状态
- `clearAuth(): void` — 清除登录缓存

### 步骤 3：修改 `miniprogram/app.ts`

- 删除占位的 `wx.login()` 代码（第 15-20 行）
- 在 `onLaunch` 中调用 `AuthService.ensureLogin()`（不 await，异步执行作为预热）
- 真正的严格等待在 `index.ts` 的 `onLoad` 中实现

### 步骤 4：修改 `miniprogram/pages/index/index.ts`

- 在 `onLoad` 开头 `await AuthService.ensureLogin()` 严格等待登录完成
- 登录失败时 `wx.showModal` 提示重试，不进入数据加载流程
- 登录成功后再执行 `calculateNavBarHeight()` 和 `loadLastBalance()`

### 步骤 5：修改 `miniprogram/utils/dataService.ts`

**`saveReport`** — 无需修改。CloudBase 写入时自动注入 `_openid`，手动写入会被覆盖。

**`getReports`**（第 106-122 行）— 添加 `_openid` 过滤：
- 读取 `AuthService.getOpenid()`
- 构建 `whereClause` 对象，加入 `_openid` 字段
- 时区处理：日期范围过滤使用前端传入的 `dateString`（已是 YYYY-MM-DD 格式字符串比较，无时区问题）

**`getStatistics`**（前端降级版本，第 260-293 行）— 同样添加 `_openid` 过滤

**`deleteReport`** — 本地缓存降级时按 `_openid` 过滤（云端操作由权限规则保证）

### 步骤 6：数据库配置（手动操作）

1. 云开发控制台 → 数据库 → 新建集合 `users`
2. `users` 集合权限：仅创建者可读写
3. `report_logs` 集合权限：仅创建者可读写（确保数据隔离）
4. 在云控制台为 `users._openid` 创建索引（提升查询性能，预防并发首次登录重复创建）

## 验证步骤

1. 微信开发者工具中右键 `cloudfunctions/login` → "上传并部署：云端安装依赖"
2. 云控制台手动创建 `users` 集合，权限设为"仅创建者可读写"
3. 清除开发者工具 Storage，重新编译
4. **控制台应打印** `[App] 静默登录成功: <openid>`
5. **云控制台 users 集合** 应出现新记录，包含 `_openid`、`createTime`、`lastLoginTime`
6. 再次编译（不清除缓存）— 应命中缓存，不调用云函数（可通过无 `[login]` 云函数日志验证）
7. **首页**：提交一条餐报 → 云控制台 `report_logs` 该记录的 `_openid` 应与 `users` 表一致
8. **历史页**：加载 → 仅看到当前用户的数据
9. **超时测试**：断网状态下编译，应在 5s 后弹出重试提示，UI 不卡死
10. **真机测试**：开发者工具模拟器 OPENID 是测试值，真实数据隔离需在真机验证

## 潜在风险与注意事项

1. **云函数冷启动**：首次调用 `login` 可能有 1-2 秒延迟，配合 5s 超时阈值可接受
2. **并发首次登录**：理论上存在重复创建 users 记录的风险，建议在云控制台为 `users._openid` 创建唯一索引
3. **不要在前端 `add` 时手动写 `_openid`**：CloudBase 自动注入并覆盖手动值，显式写入引发困惑
4. **`getWXContext()` 真机 vs 模拟器**：模拟器返回测试 openid，真实数据隔离需在真机验证
5. **时区**：`db.serverDate()` 返回服务端 UTC+8 时间，`dateString` 是字符串比较无时区问题，但若后续涉及时间戳计算需注意 offset

## 关键文件清单

**新建**：
- `cloudfunctions/login/package.json`
- `cloudfunctions/login/index.js`
- `miniprogram/utils/authService.ts`

**修改**：
- `miniprogram/app.ts`（删除 wx.login 占位，添加预热登录）
- `miniprogram/pages/index/index.ts`（onLoad 中严格等待登录）
- `miniprogram/utils/dataService.ts`（getReports/getStatistics 添加 _openid 过滤）

**参考（无需修改）**：
- `cloudfunctions/getStatistics/index.js`（已正确使用 _openid 过滤，作为模板参考）
