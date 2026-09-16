# 2026-09 六阶段 Vibe Coding 重构复盘：并发 / 弱网 / 资金安全加固

> **文档定位**：与本目录其余编号文档（目标设计 vs 现状差距）不同，本文档是一次**已完成重构的事后复盘**——六个阶段依次对云调用防护、页面并发、海报临时文件、义工打卡并发、支付退款、Excel 导出做了加固。每一节固定按 **场景 → 踩的坑（根因）→ 解法（代码落点）→ 验证** 四段展开，末尾附一份"审查后确认无需改动"的清单——过程中多次发现任务描述的隐患在代码里其实已经被修过或从不存在，如实记录这些"假阳性"本身也是本轮复盘的价值之一，避免下次重复排查同一个已经关闭的问题。
>
> 对应 commit（`master` 分支，按时间顺序）：
> `70f2e5f` 云网关 → `a732b0c` 并发/离线 → `76c1235` Canvas 临时文件 → `06b2388` 打卡并发 → `db2ea04` 支付退款 → `d20da6f` Excel 导出

---

## 一、云端调用高阶网关 + 越权探测审计

**场景**：`miniprogram/utils/cloudGuard.ts` 只有 SDK 可用性探测（`isCloudAvailable`），没有统一的调用耗时监控/降级提示；`checkTenantPermission` 云函数的租户判定逻辑分散在多处。

**踩的坑（根因）**：
- 全仓库 200+ 处 `wx.cloud.callFunction` 调用点各自处理超时/报错，没有一个可复用的"调用即监控"入口——不是没写超时（`utils/withTimeout.ts` 早就统一了），而是缺一层**耗时打点 + 出错自动降级提示**的高阶封装。
- `checkTenantPermission` 审查后发现**并不存在**"信任客户端传入 tenantId"的口子——`tenantId` 全程由服务端按 `OPENID` 反查 `user_roles` 得到。真正的风险不是"越权拿到数据"，而是**抓包篡改请求体、塞一个 `tenantId`/`_openid` 字段进去试探服务端会不会误采信**——这种探测行为即使注定失败，也应该被记录，而不是无声无息地被忽略掉。

**解法（代码落点）**：
- `cloudGuard.ts` 新增 `callCloudFunctionGuarded()`：**不重新发明超时逻辑**，而是在已有的 `callFunctionWithTimeout` 外面叠一层 `try/catch` + 耗时日志 + 可选 `wx.showToast` 降级提示。刻意设计成**可选、非侵入式**——不批量迁移现有 200+ 调用点（很多调用点是"失败静默走本地缓存"的既定设计，强行弹 toast 反而是体验倒退，尤其 careMode 长者模式明确排斥 toast）。
- `checkTenantPermission/index.js` 新增 `auditSuspiciousIdentityOverrideAttempt()`：命中 `event.tenantId`/`event._openid`/`event.OPENID` 这类"本不该由客户端传入"的字段时，写一条 `audit_logs` 记录（`action: 'SUSPICIOUS_TENANT_ID_OVERRIDE_ATTEMPT'`），**不阻断正常请求**，只是留痕供事后排查。这是"轻量诱饵"式设计——不是构造一个假数据陷阱，而是把"本来就无效的输入"变成一个可观测信号。

**验证**：`npm run typecheck` + `npm test`（1013 用例）全绿；`cloudGuard.ts` 的新函数没有历史调用点依赖，属于纯增量。

> **踩坑教训**：不要看到"某个安全需求"就默认代码里一定有对应漏洞——`checkTenantPermission` 这次审查证明它早就是"服务端强校验、客户端不可信"的正确写法，真正该做的是补一层可观测性，不是重写一遍已经正确的鉴权逻辑。

---

## 二、Promise.all 并发请求 + 断网离线缓存兜底

**场景**：`subpackages/admin/pages/daily-menu/daily-menu.ts` 的 `onLoad()` 初始化拉取；`pages/index/index.ts` 的义工打卡云端同步。

**踩的坑（根因）**：
1. **看似串行，实则已并发，但缺加载反馈**：`loadSelectedMenu()`（今日食谱）与 `fetchList(true)`（历史列表）两次调用本来就没有互相 `await`，已经是隐式并发——真正的坑不是"没用 Promise.all"，而是这段并发过程**完全没有加载态 UI**（`todayLoading`/`loading` 两个 data 字段从未绑定到任何骨架屏/spinner），用户看到的是数据到达前的空白页面。
2. **真正的串行瀑布流藏在更深处**：`applyRolePermissions()` 内部两次独立的 `await getStorageAsync(...)`（读 `current_store_id`/`current_store_name`）是彼此不依赖的本地存储读取，却被写成顺序 `await`。
3. **离线队列存在但有死角**：`onConfirmShiftCheckIn` 的云端打卡同步只在"已经发起调用、调用中途抛异常"时才会把打卡计入 `pendingMeritCheckinQueue` 待补录队列——如果 `isCloudAvailable()` 从一开始就是 `false`（云 SDK 尚未就绪），整个分支被跳过，**既不尝试也不入队**，这笔打卡从此变成永远无法自愈的纯本地记录。

**解法（代码落点）**：
- `daily-menu.ts`：`applyRolePermissions()` 里两次 `getStorageAsync` 改成按需 `Promise.all`；`onLoad()` 里给 `loadSelectedMenu()+fetchList(true)` 包一层 `wx.showLoading/hideLoading`，让已经存在的并发过程对用户可见。
- `loadSelectedMenu`/`fetchList` 新增离线缓存兜底：云端成功后覆盖写入本地快照，请求失败时优先展示上一次缓存并提示"网络异常，已展示上次缓存内容"——复用本文件里 `onGeneratePurchasePlan` 已有的同一套"缓存-兜底"手法，不是另起一套。
- `pages/index/index.ts` 的 `onConfirmShiftCheckIn`：把"云调用异常"和"云能力压根不可用"两种"没能完成云端同步"的场景统一收口成 `queueForOfflineMeritSync()`，都会入队 + 弹一句轻量提示"打卡已离线记录，联网后自动同步 🌸"。自动重试入口（`onShow()` + `app.globalData.onNetworkReconnected`）本来就存在，这次只是把"该入队却没入队"的漏网场景补上。

**验证**：`npm run typecheck` + `npm test`（1016 用例）全绿。

> **踩坑教训**：审查"并发瀑布流"问题时，先确认瀑布流是不是真的存在——很多时候真正缺的是加载态反馈，而不是并发本身；审查"离线队列是否可靠"时，要重点看**入队条件的分支覆盖**是否完整，而不是只看队列数据结构本身的读写是否正确。

---

## 三、Canvas 生成临时图片的 `try/finally` 强制内存回收

**场景**：`miniprogram/utils/posterGenerator.ts` 的 `drawStoryPoster()`/`drawVolunteerHonorCard()` 会调用 `resolveHeroImageLocalPath()` 下载 + 压缩门店首图/义工头像。

**踩的坑（根因）**：
- "下载原图 → `wx.compressImage` 压缩"两步会在设备本地磁盘产生**两份临时文件**（原始下载文件 + 压缩后的新文件），实际绘制只用得上压缩后的那份，**原始下载文件从未被清理**。海报生成是高频操作（每次打卡、每次发布食谱都可能触发），长期运行会在 `wx.env.USER_DATA_PATH` 下堆积垃圾文件。
- 陷阱在于**不能无脑加 `unlink`**：`resolveHeroImageLocalPath` 的输入路径有两种截然不同的归属——一种是本函数自己下载/压缩产生的（可以删），另一种是调用方自己持有、还在走自己上传流程的本地路径（如活动照片压缩上传未完成时的 `tempFilePath`）——删错了会反过来破坏调用方的上传逻辑。

**解法（代码落点）**：
- `resolveHeroImageLocalPath()` 返回值从裸字符串改为 `{ path, ownedByThisModule }`，显式标记这份路径"是不是本模块自己创建的"。
- 压缩产生新文件后立即清理被取代的原始下载文件；最终用于绘制的文件在 `drawImage()` 成功或失败后，用 `try { ... } finally { if (ownedByThisModule) safeUnlinkTempFile(path); }` 保证无论绘制成功还是抛异常都会被清理。
- 新增 `safeUnlinkTempFile()`：`wx.getFileSystemManager().unlink()` 包一层 best-effort 异步调用，删除失败只打日志不影响主流程（清理是资源卫生，不是关键路径）。
- 顺带清理了 3 处重复实现（`drawRoundedRectPath`/`drawImageCover`/`truncateText`/`wrapText` 在 `posterGenerator.ts`、`drawDailyMenuPoster.ts`、`drawActivityPoster.ts` 里各写一份），收敛进已有的 `utils/canvasShapes.ts`。

**验证**：`npm run typecheck` + `npm test`（1013 用例）全绿。

> **踩坑教训**：清理临时文件前先想清楚"这份资源是谁创建的"——`try/finally` 保证的是"执行一定会发生"，但**清理条件的判断逻辑（该不该删）**才是真正容易出错的地方，尤其在"下载+二次处理"这种会产生多份中间文件的链路里。
>
> **如实标注（评估后未做）**：Excel 导出/其余海报函数最终 `canvasToTempFilePath` 产出的**成品**文件由调用页面（如 `daily-menu.ts`）决定何时清理，这 5 个纯绘图文件本身不掌握"用户什么时候看完/分享完"这个生命周期，删自己的返回值反而是 bug。

---

## 四、志愿者打卡防并发：TOCTOU 竞态 + 确定性唯一 ID

**场景**：`cloudfunctions/manageVolunteerCheckIn/index.js` 的 `handleCheckin`——同工种去重 + 单日 12h 工时上限校验。

**踩的坑（根因，经典 TOCTOU）**：
```js
// 步骤1：查询"今天是否已打这个班次的卡"
const existingLogs = await db.collection(COLLECTION).where({ tenantId, storeId, _openid, dateString, status:'active' }).get();
if (existingLogs.some(l => l.shiftKey === shiftKey)) return 拒绝;
// —— 竞态窗口在这里：另一个几乎同时到达的相同请求，也会在这一步读到"尚未打卡" ——
await db.collection(COLLECTION).add({ data: doc }); // 步骤2：插入
```
"先查是否存在，再决定要不要插入"这个模式**永远存在竞态窗口**——两个几乎同时到达的相同班次打卡请求，都可能在查询这一步看到"尚未打卡"，于是都执行插入，产生重复记账、并绕过单日工时上限。这不是"积分先查后加"那种教科书式 bug（本项目按查设计里根本没有可累加的积分字段，是 append-only 事件日志 + 读时聚合），而是**同一类问题的另一种表现形式：check-then-insert 竞态**。

**解法（代码落点）**：
- 新增 `lib/buildCheckinLogId.js`：用 `{tenantId, storeId, _openid, dateString, shiftKey}` 五元组拼出确定性 `_id`（`checkin_${tenantId}_${storeId}_${openid}_${dateString}_${shiftKey}`），与 `liveFactoryCore.buildSettlement`/`manageDailyMenu.createPurchasePlan` 同一套"确定性主键 + 数据库唯一约束天然互斥"手法。
- `add({ data: { _id: 确定性ID, ...doc } })`：两个并发请求即使都通过了预读校验，也只有一个能拿到这个 `_id`，另一个会撞主键冲突——**真正的互斥发生在数据库层面，不依赖任何一次预读的时效性**。
- **子坑**：撤销打卡（`handleRevoke`）是 `update` 成 `status:'revoked'`，文档本身不删除——这意味着"当天撤销后重新打卡同一班次"会撞上自己刚才那条 `revoked` 记录的 `_id`。处理方式：`add()` 冲突后按 `_id` 重新读一次，`status==='active'` 才当真冲突拒绝；`status==='revoked'` 则用条件更新（`where({_id, status:'revoked'}).update(...)`）把记录原地复活，避免把合法的"改主意重打卡"流程也一并堵死。
- 顺手修了一个数据丢失点：原来"重复打卡"报错不带 `_id`，客户端 `pendingMeritCheckinQueue` 补录时明知打卡云端其实成功了却因为拿不到 `_id` 只能丢弃、连带丢失用户已选的善行标签——现在错误响应里带上 `logId`，客户端可以继续补挂标签。

**验证**：`lib/buildCheckinLogId.test.js` 覆盖"相同五元组产出相同 ID / 任一字段不同则 ID 不同"；`npm run typecheck` + `npm test`（1018 用例）全绿。

> **踩坑教训**：判断"是否存在并发重复写入风险"，不要只搜索"先查再算再写"的字面模式——**任何"先查是否存在、再决定要不要插入"的逻辑都是同一类竞态**，解法通用：把业务上"本该唯一"的字段组合拼成确定性主键，让数据库的唯一约束做真正的互斥，而不是信任一次内存里的预读判断。同时要考虑"允许撤销重来"这类正常业务流程与"确定性主键天然拒绝重复插入"之间的冲突，不能顾此失彼。

---

## 五、支付退款：乐观锁 CAS 更新 + 金额二次核验双重防线

**场景**：`cloudfunctions/wxPayCore/`——订单状态机（`PENDING_PAY→PAID→REFUNDED`）、退款发起。

**审查结论（先说好消息）**：`orderService.markPaidIdempotent`/`markClosed`/`markRefunded`、`refundService.markRefundStatus` **早就是**条件更新写法：
```js
// orderService.markPaidIdempotent —— 已经是正确的 CAS 写法，本轮未改动
const res = await db.collection(ORDERS_COLLECTION)
  .where({ outTradeNo, status: STATUS.PENDING_PAY })   // 乐观锁条件
  .update({ data: { status: STATUS.PAID, ... } });
const transitioned = res.stats && res.stats.updated === 1;  // 只有真正抢到这次迁移的调用才是 true
```
退款侧还有一把基于 `refundLockedAt` 字段的函数级 CAS 并发锁（`acquireRefundLock`），以及 `getCommittedRefundedTotal` 把 `PROCESSING`（微信侧尚未回执终态）也计入已占用退款额度——这些都是 2026-09-05 那轮加固的既有成果，本轮复核确认依然生效。

**踩的坑（本轮真正发现的漏洞）**：
`createPendingOrder`/`createPendingRefund` 为了防抖动重试，会在 10 分钟窗口内**复用**同一笔未终结的旧记录——但复用判断**只按 `{openid/outTradeNo, 状态}` 匹配，从未校验金额是否一致**！如果同一笔支付/退款在短时间内被以不同金额发起两次（价格变化、参数错误），代码会复用旧记录的单号，却拿**当次请求的新金额**提交给微信网关：
```js
// 复用到了旧记录（金额可能是旧的），但下面用的是 event 传入的新 refundAmount
const refundRecord = await refundService.createPendingRefund({ outTradeNo, refundAmount, ... });
await wxPayClient.createRefund({ outRefundNo: refundRecord.outRefundNo, refundAmount, ... }); // ⚠️ 用的是新金额，单号却是旧记录的
```
本地账本记的金额，和实际提交给微信网关的金额，从此**分叉**。

**解法（代码落点）**：
- `orderService.createPendingOrder` / `refundService.createPendingRefund`：复用旧记录前新增金额一致性校验（`reusable.amount === amount`），不一致时**拒绝复用**，视为全新的下单/退款意图，旧记录不受影响、按自身生命周期自然过期。
- `refundValidation.js` 新增纯函数 `validateReusableRefundAmount()` + 单测，`index.js` 新增 `REFUND_AMOUNT_CONFLICT` 错误码分支。
- **双重防线**：提交给微信网关的金额，一律从"已持久化的账本记录"读取（`order.amount`/`refundRecord.refundAmount`），不再直接用请求里的临时值——即使未来校验逻辑出现遗漏，实际打给微信的钱也始终和本地账本一致。
- 深度审查 `wxPayClient.js`/`certCache.js`/全部 `console.*` 调用：**未发现**明文密钥（`mchPrivateKey`/`apiV3Key`）或用户隐私字段（`openid`、完整解密回调载荷）被打印——这条如实报告为"审查后确认无问题"，没有强行制造一个不存在的修复。

**验证**：`refundService.test.js` 新增两个用例（金额一致/不一致）；`npm run typecheck` + `npm test`（1018 用例）全绿；`npm run security-audit` 确认无新增敏感信息泄露。

> **踩坑教训**：CAS/乐观锁解决的是"状态迁移"的并发安全，但**"防抖动复用旧记录"这类去重逻辑本身也需要校验业务关键字段（这里是金额）是否一致**——两者是两个独立的正确性维度，CAS 做对了不代表复用逻辑也天然正确。

---

## 六、云开发 `.get()` 1000 条硬限制的分批拉取绕过 + Excel 导出超时优雅降级

**场景**：`cloudfunctions/exportAccountExcel/`、`cloudfunctions/exportSettlementExcel/`——多租户 Excel 报表导出。

**踩的坑（根因，本轮最严重的发现）**：
微信云开发数据库单次 `.get()` **硬性上限 1000 条**——无论 `.limit()` 传多大，超过部分被**静默截断**，不报错、不警告。而这两个云函数里遍地都是这种写法：
```js
// exportAccountExcel/index.js —— MAX_LIMIT 为 5000 时，这行代码从未真正拿到超过 1000 条的数据
const recordRes = await db.collection('report_logs').where(whereConditions).orderBy('dateString','asc').limit(MAX_LIMIT).get();
```
`lib/auditLedgerExcel.js` 三处二次查询（`material_logs`/`report_logs` 基线、`daily_menus`，`limit(3000)`/`limit(2000)`）、`exportSettlementExcel/index.js` 两处查询（`production_orders`/`order_settlements`，`limit(2000)`）全部中招。**这是一个正在发生的静默数据丢失 bug**：机构记录一旦超过 1000 条，"阳光台账"审计导出表格里会凭空少数据，财务/理事会毫无察觉。

**解法（代码落点）**：
- 新增 `lib/batchFetchPlan.js`（纯逻辑，`nextBatchSize`/`isPastDeadline` + 单测）+ `lib/batchQuery.js`（`fetchAllInBatches`：按 `skip/limit` 循环，每批不超过 1000 条硬上限，直到拿满 `maxTotal` 或没有更多数据），两个云函数各自独立维护一份副本（无共享模块机制）。
- 所有受影响查询改为分批拉取，并补齐**确定性排序**（`orderBy`）——`skip/limit` 分页依赖稳定排序才能保证跨批次不重复不遗漏，这是容易被忽略的第二个坑。
- **执行超时阻断**：`exportAccountExcel`（原来没配 `timeout`，默认 3 秒）、`exportSettlementExcel`（原来**完全没有 `config.json`**）均补 `timeout: 20`；分批拉取循环里传入 `deadline`（配置超时减 5 秒安全余量），接近截止时间时安全中断，返回"数据量过大，请缩短日期范围"的友好错误，而不是被平台在超时边缘强制杀死、前端只收到无意义的网络错误。`deadline` 从 `index.js` 一路透传到 `exportNationalExcel.js`/`auditLedgerExcel.js` 的二次查询，不各自为政重新起算。
- **优雅降级细节**：`auditLedgerExcel.js` 的历史基线查询如果因超时被提前中断，**不让整个导出失败**——照旧生成报表，只在附注里如实标注"期初结存数可能不完整"，与该文件已有的"数据不完整时如实披露，不编造"原则一致。

**验证**：`batchFetchPlan.test.js`（两个云函数各一份）覆盖批次边界值/超时判断；`npm run typecheck` + `npm test`（1031 用例）全绿。

**评估但未落地：流式写入（`exceljs` streaming）**——`exportNationalExcel.js` 的"总览 Sheet"需要等所有门店明细算完汇总数、且必须排在第一个 Tab，这个设计要求工作簿能在内存里整体重排，与流式写入"边生成边落盘、写完不能回头改"的模型直接冲突。若未来数据规模继续增长到需要流式写入，需要先把总览 Sheet 重做成"两遍扫描"架构（先轻量聚合算总计，再流式写明细），不是能顺手做的小改动，原因已记录在代码注释里。

**临时文件清理**：如实确认——两个函数全程 `workbook.xlsx.writeBuffer()`（内存 Buffer）直传 `cloud.uploadFile`，从未写过本地 `/tmp` 文件，这一条在当前实现里不适用，不是遗漏。

> **踩坑教训**：`.limit(N)` 里的 `N` 不代表"一定能拿到 N 条"——凡是跨云函数看到 `.limit()` 传入大于 1000 的字面量，都要默认它是一个**尚未被发现的静默截断 bug**，不是"性能优化的可选项"。分批拉取本身也要注意"稳定排序"这个隐藏前提，否则 skip/limit 分页在没有显式排序时不保证跨批次数据一致。

---

## 附：本轮"审查后确认无需改动"清单

如实记录几处任务描述里怀疑存在、但实际审查后确认**不存在**或**已经是正确写法**的情况，避免后续排查重复踩同一个已经关闭的坑：

| 怀疑点 | 审查结论 |
|---|---|
| `manageVolunteerCheckIn` 存在"先查积分再内存相加再 update"的非原子写法 | 不存在——本项目按设计是 append-only 事件日志 + 读时聚合，没有可累加的积分/功德值字段（`meritTags` 是纯展示字段，CLAUDE.md 明确禁止其参与任何权益判断）。真正的风险是 check-then-insert 竞态（见第四节） |
| `checkTenantPermission` 信任客户端传入的 `tenantId` | 不存在——`tenantId` 全程服务端反查，`event` 里根本没有会被采信的 `tenantId` 字段 |
| `volunteer-merit-dialog` 存在"全量覆写数组导致掉帧"的多志愿者列表 | 不存在——该组件只是 4 项固定微善标签的单人选择弹窗，且现有的"每次 `.map()` 重建数组"写法是代码里明确记录过的**故意**设计（保证 wx:for 差异检测稳定），4 个元素也谈不上性能问题，未强行改成路径更新推翻已有的合理决策 |
| `wxPayCore` 存在明文密钥/隐私字段被打印到日志 | 未发现——`index.js`/`lib/*.js` 全部 `console.*` 调用逐一审查，没有整体打印 `realConfig`、`openid`、解密后完整回调载荷的情况 |
| `payCallback` 云函数处理真实支付回调 | 该目录是空目录（未被 git 跟踪），真正的回调逻辑在 `wxPayCore/index.js` 的 `handleHttpNotify()` |

---

## 回写提醒

本文档已存入仓库 `docs/architecture/04_vibe_coding_refactor_2026.md`，按 CLAUDE.md 第 0 节"落地与回写"约定，**这份技术决策沉淀建议同步一份到 Obsidian 知识库**（`/home/ziyan/文档/Obsidian Vault/01-Projects/素小账/`），并在 `00-素小账-MOC.md` 补一条双链引用，与 `02-技术与契约/微信小程序工业级Vibe_Coding方法论.md` 互相呼应——那份文档讲的是协同方法论本身，这份讲的是这一轮方法论落地时具体踩过的坑与解法，两者互补。
