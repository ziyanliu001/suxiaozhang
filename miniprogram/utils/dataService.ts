import { AuthService } from './authService';
import { generateReportText } from './reportGenerator';
import { isStoreNameFuzzyMatch } from './constants';
import { getPrevDayIsoString, formatDateToCnShort, isValidIsoDate } from './dateUtils';
import { isCloudAvailable, reportCloudSdkErrorIfCorrupted } from './cloudGuard';
import { callFunctionWithTimeout } from './withTimeout';

const STORAGE_KEY = 'local_report_logs';

// 🛡️ "云不可用，本轮跳过整批同步" 这条路径此前完全没有节流：MAX_OFFLINE_SYNC_RETRIES
// 熔断只统计【单条记录真正打了云函数请求但失败】的次数，而 isCloudAvailable() 为 false
// 时函数在打请求之前就直接 return，根本不会走到那段计数逻辑——如果设备持续离线/云初始化
// 迟迟未就绪，index/history/statistics 任一页面每次 onLoad/onShow 都会重新命中这条
// "跳过"分支并打一条 console.warn，天数越长、访问越频繁，控制台里就越像"疯狂刷屏"。
// 这里给这条路径单独加一个轻量节流：同一个冷却窗口内只打印一次警告，但不影响实际
// 跳过同步这个行为本身——云一旦恢复可用，下一次调用仍会正常继续同步，不是被拦死。
const CLOUD_UNAVAILABLE_WARN_COOLDOWN_MS = 30 * 1000;
let lastCloudUnavailableWarnAt = 0;

// 🛡️ 防抖锁：同一 {tenantId, storeId, openid} 维度的 saveReport 调用若仍在途中，
// 拒绝并发发起第二次云端写入——网络延迟下连续点击提交按钮曾经可能触发两次几乎
// 同时的 upsert 查重（查重本身有竞态窗口：两次调用都查到"尚不存在"再各自 add()，
// 产生两条重复餐报）。与 report_logs 新增的 {tenantId, storeId, _openid} 复合索引
// 配合，同一维度内天然只应有一条"进行中"的提交
const reportSaveLocks = new Map<string, boolean>();

function buildReportSaveLockKey(tenantId: string, storeId: string, openid: string): string {
  return `${tenantId || 'no_tenant'}|${storeId || 'no_store'}|${openid || 'no_openid'}`;
}

// 🐛（2026-08-31 紧急修复："allReports.filter is not a function"）根因：本函数
// 此前恒定假设 STORAGE_KEY 存的是 JSON.stringify 过的字符串，无条件 JSON.parse；
// 但 pages/index/index.ts、pages/statistics/statistics.ts 里另外七八处直接
// `wx.getStorageSync('local_report_logs') || []` 读取同一个 key 时，从来没
// 手动 JSON.stringify 过（wx.setStorageSync 原生就支持直接存数组/对象，不需要
// 手动序列化），写入的是原生数组。同一个 storage key 被两种不兼容的读写约定
// 交替写入/读取——哪种约定"最后写入"，下一次用另一种约定读取就会拿到错误
// 形状：字符串遇上 .filter()/.find() 直接抛 TypeError，数组遇上 JSON.parse()
// 也会因为非字符串入参被隐式 toString 成 "[object Object]" 而抛 SyntaxError。
// 现在两种形状都识别：已经是数组直接用，是字符串才 JSON.parse，两者都不是
// （或解析失败）时兜底空数组——不管上一次是被哪种约定写入的，都能正确读出。
export function getLocalReports(): any[] {
  try {
    const data = wx.getStorageSync(STORAGE_KEY);
    if (Array.isArray(data)) return data;
    if (typeof data === 'string' && data) return JSON.parse(data);
    return [];
  } catch {
    return [];
  }
}

// 🐛 配套修复：写入侧同步改成原生数组直接存（不再手动 JSON.stringify）——
// wx.setStorageSync 本身就会正确序列化数组/对象，手动 stringify 只是徒增一层
// 不必要的转换，还正是上面读取端形状不一致 bug 的根源。此后无论走本文件这条
// 写入路径，还是 statistics.ts 里另外几处直接 wx.setStorageSync('local_report_logs', ...)
// 的本地缓存补丁写入，存的都统一是原生数组，两边收敛成同一套约定。
function saveLocalReports(reports: any[]): void {
  try {
    wx.setStorageSync(STORAGE_KEY, reports);
  } catch (error) {
    console.error('[DataService] 本地缓存写入失败:', error);
  }
}

function parseAnyDateFormat(dateStr: string): { year: number; month: number; day: number } | null {
  if (!dateStr) return null;
  let str = String(dateStr).trim();

  if (/^\d{2}年/.test(str)) {
    str = '20' + str;
  }

  const matches = str.match(/(\d{4})[\-\/年\.](\d{1,2})[\-\/月\.](\d{1,2})/);
  if (matches) {
    return {
      year: parseInt(matches[1], 10),
      month: parseInt(matches[2], 10),
      day: parseInt(matches[3], 10)
    };
  }
  return null;
}

function formatDateToISO(dateObj: { year: number; month: number; day: number }): string {
  const mm = String(dateObj.month).padStart(2, '0');
  const dd = String(dateObj.day).padStart(2, '0');
  return `${dateObj.year}-${mm}-${dd}`;
}

function formatNumber(value: number): string {
  const num = parseFloat(String(value)) || 0;
  return num === 0 ? "0.00" : num.toFixed(2);
}

function parseNumber(value: any): number {
  return parseFloat(value) || 0;
}

export function formatMoney(value: any): string {
  const num = parseFloat(value) || 0;
  const positiveNum = Math.max(0, num);
  return positiveNum === 0 ? "0.00" : positiveNum.toFixed(2);
}

const VOLUNTEER_MASK_TEXT = '***（仅店长可见）';

// 财务/运营敏感字段黑名单：覆盖单条 report_logs 记录字段名，以及全国大屏
// 门店矩阵/汇总对象的字段名，两类数据结构共用同一份脱敏逻辑
const SENSITIVE_FIELD_KEYS = [
  'singleMealCost', 'costPerMeal',
  'totalIncome', 'totalExpense', 'ingredientExpense',
  'nationalTotalIncome', 'nationalTotalExpense', 'nationalNetAccumulation',
  'listDonationTotal', 'otherDonation', 'expenseAmount', 'nationalOfflineIncome',
  'dailyExpenseTotal', 'fixedExpenseTotal',
  // 🆕 阳善/阴德统计看板：金额维度与 nationalOfflineIncome 同一档财务隐私，
  // 志工脱敏（云函数出口处已同步脱敏，这里是第二层防线）；人次/占比
  // （yangshanCount/yindeCount/totalSupportCount/yangshanRatioPct/yindeRatioPct）
  // 不涉及绝对金额，不在此黑名单内，志工也能看到
  'yangshanAmount', 'yindeAmount',
  'latestBalance', 'balance', 'todayBalance', 'yesterdayBalance',
  'systemBalance', 'adjustedBalance', 'balanceDiff',
  // 精确续航天数可反推资金余额，属于财务隐私，志工只保留 healthStatus 状态标签
  'runwayDays'
];

/**
 * 🛡️ 统一数据脱敏处理函数：分层开放、数据脱敏
 *
 * 志工（VOLUNTEER）视角只应看到"集体荣誉"类服务成果（服务人次、开餐天数、续航状态标签），
 * 单餐成本、收支金额、结余、精确续航天数等运营/财务隐私字段一律清除，而不是仅在 UI 上隐藏。
 *
 * 注意：这是客户端第二层防线（防止已拿到数据后被二次转发/落盘时仍带敏感字段）。
 * 真正杜绝"抓包泄露"必须在云函数出口处（服务端）同步调用等价的脱敏逻辑，
 * 数据从服务端下发时就已经不包含这些字段 —— 参见 cloudfunctions/getNationalDashboard
 * 中的同名 sanitizeReportForVolunteer 实现。
 *
 * @param data 单条记录对象，或记录数组（如 storeMatrix / report_logs 列表）
 * @param userRole 当前用户角色（'volunteer' 触发脱敏，其余角色原样返回）
 */
export function sanitizeReportForVolunteer<T = any>(data: T, userRole: string): T {
  const isVolunteer = String(userRole || '').toLowerCase() === 'volunteer';
  if (!isVolunteer || !data) {
    return data;
  }

  const maskOne = (item: any): any => {
    if (!item || typeof item !== 'object') return item;
    const masked: any = { ...item };
    SENSITIVE_FIELD_KEYS.forEach((key) => {
      if (key in masked) {
        masked[key] = null;
      }
    });
    if ('costPerMeal' in item || 'costPerMealStr' in item) {
      masked.costPerMealStr = VOLUNTEER_MASK_TEXT;
    }
    masked.isCostRestricted = true;
    return masked;
  };

  if (Array.isArray(data)) {
    return (data as any[]).map(maskOne) as any;
  }
  return maskOne(data);
}

// 🆕（2026-08-31 OCR 智能记账数据结构规范）票据 OCR 元数据协议：见
// saveReport() 内 formattedData.ocrMetadata 处注释，目前没有任何前端入口
// 真正产出这份数据，纯粹是为"拍照识别小票自动填单"预留的落库结构。
// 🆕（2026-08-31 生态演进第三步）新增 ocrRawText——cloudfunctions/
// ocrExpenseReceipt 已经在返回体里带上了 rawTextList（OCR 原始识别文本行，
// 见该云函数注释），这里补一个字段位置把它落进 report_logs，供日后需要
// 核对"AI 到底认出了什么字"时回溯，仍是纯字段预留，同样没有任何调用方
// 真正传值
export interface OcrMetadata {
  sourceImageUrl?: string;
  parsedItemCount?: number;
  isAutoFilled?: boolean;
  ocrRawText?: string;
}

export const DataService = {
  async saveReport(reportData: any): Promise<{ success: boolean; message: string; data?: any; errorDetail?: string }> {
    // 🌟 云开发 SDK 可用性防护：wx.cloud.database() 曾在个别环境（wx.cloud.init 内部
    // 致命错误后）抛出 "Cannot read property 'getCloudAPI' of undefined"。
    // 这行调用原本在 try/catch 保护范围之外，此处先做能力探测再决定是否调用，
    // 不可用时用本地时间戳代替 db.serverDate()，稍后交由下方 try/catch 统一走本地兜底。
    const cloudReady = isCloudAvailable();
    const db = cloudReady ? wx.cloud.database() : null;

    const openid = AuthService.getOpenid();
    // 🏢 多租户：写入时随手带上调用者所属机构 ID（来自登录时缓存的角色信息）
    const cachedRoleInfoForTenant = AuthService.getCachedRoleInfo();
    const tenantId = (cachedRoleInfoForTenant && cachedRoleInfoForTenant.tenantId) || '';
    const formattedData = {
      dateString: reportData.dateString || '',
      reportDate: reportData.reportDate || '',
      shopName: reportData.shopName || '',
      storeId: reportData.storeId || wx.getStorageSync('current_store_id') || '',
      tenantId,
      mpAccount: reportData.mpAccount || '',
      yesterdayBalance: parseNumber(reportData.yesterdayBalance),
      otherDonation: parseNumber(reportData.otherDonation),
      listDonationTotal: parseNumber(reportData.listDonationTotal),
      expenseAmount: parseNumber(reportData.expenseAmount),
      expenses: reportData.expenses || '',
      dailyExpenseText: reportData.dailyExpenseText || '',
      fixedExpenseText: reportData.fixedExpenseText || '',
      dailyExpenseTotal: parseNumber(reportData.dailyExpenseTotal),
      fixedExpenseTotal: parseNumber(reportData.fixedExpenseTotal),
      // 🔒 大额专项行级独立凭证：白名单里必须显式列出，否则会被这层 formattedData
      // 静默丢弃（本对象只转发列出的字段，不是透传 reportData 原样对象）
      fixedExpenseItems: reportData.fixedExpenseItems || [],
      majorExpenseItems: reportData.majorExpenseItems || [],
      dailyIngredientItems: reportData.dailyIngredientItems || [],
      donationItems: reportData.donationItems || [],
      todayBalance: parseNumber(reportData.todayBalance),
      reportText: reportData.reportText || '',
      receiptImages: reportData.receiptImages || [],
      isManualAdjust: reportData.isManualAdjust || false,
      systemBalance: parseNumber(reportData.systemBalance),
      adjustedBalance: parseNumber(reportData.adjustedBalance),
      balanceDiff: parseNumber(reportData.balanceDiff),
      adjustReason: reportData.adjustReason || '',
      materials: reportData.materials || [],
      volunteerCount: parseFloat(reportData.volunteerCount) || 0,
      volunteerHours: parseFloat(reportData.volunteerHours) || 0,
      diningCount: parseFloat(reportData.diningCount) || 0,
      // 🍱 用餐/义工细分统计（堂食/送餐/打包），totalDineCount/totalVolunteers 由前端
      // recalcDiningStats() 算好传入，这里只做落库，不重复计算（与 diningCount/volunteerCount
      // 保持同源，避免两套计算口径漂移）
      dineInSeniors: parseFloat(reportData.dineInSeniors) || 0,
      deliverySeniors: parseFloat(reportData.deliverySeniors) || 0,
      dineInVolunteers: parseFloat(reportData.dineInVolunteers) || 0,
      deliveryVolunteers: parseFloat(reportData.deliveryVolunteers) || 0,
      takeawayCount: parseFloat(reportData.takeawayCount) || 0,
      // 🐛 根因修复（数据丢失）：pages/index/index.ts 的提交表单一直在收集并
      // 传入 listeningSeniors（倾听陪伴/关怀长者人次），但这份 formattedData
      // 白名单此前一直没有列出这个字段——saveReport() 是客户端直连数据库写入
      // （见下方注释"没有云函数中转"），不在这份白名单里的字段会被静默丢弃，
      // 从未真正落库过。history.ts/statistics.ts 展示层与本轮新增的
      // getSunshineLedger accompanyCount 聚合读到的都会是这个字段的默认值，
      // 不是真实数据——与本文件其余"字段值域变化后要审计所有按该字段建的表"
      // 同一类教训，只是这次是从源头就没写进去
      listeningSeniors: parseFloat(reportData.listeningSeniors) || 0,
      totalDineCount: parseFloat(reportData.totalDineCount) || 0,
      totalVolunteers: parseFloat(reportData.totalVolunteers) || 0,
      stapleRiceStatus: reportData.stapleRiceStatus || 'normal',
      stapleOilStatus: reportData.stapleOilStatus || 'sufficient',
      // 🌿 了凡四训·积阴德：匿名护持标记，true 表示本条餐报所有捐款人姓名在公开展示时脱敏为"爱心善士"
      isAnonymous: !!(reportData.isAnonymous),
      // 🆕（2026-08-31 OCR 智能记账数据结构规范）票据 OCR 元数据：目前没有任何
      // 前端入口会真正填充这个字段（尚未接入智能拍照识别），这里只是为"后续
      // 接入拍照记账自动识别小票/手写单据"预留底层协议——一旦有 OCR 解析结果，
      // 直接按这个结构传入 reportData.ocrMetadata 即可落库，不需要再改一次
      // formattedData 白名单。不存在时落 null 而不是空对象，与本对象其余
      // "未提供即默认值"字段的空值口径保持一致，也方便前端简单判断"这条记录
      // 是不是 OCR 辅助录入的"
      ocrMetadata: (reportData.ocrMetadata && typeof reportData.ocrMetadata === 'object') ? {
        sourceImageUrl: reportData.ocrMetadata.sourceImageUrl || '',
        parsedItemCount: parseInt(reportData.ocrMetadata.parsedItemCount, 10) || 0,
        isAutoFilled: !!reportData.ocrMetadata.isAutoFilled,
        // 🛡️ 截断到 500 字：只是留痕供人工回溯核对"AI 当时认出了什么"，不是
        // 完整存档小票原文的场所（原图本身已经存在 sourceImageUrl 指向的云存储
        // 文件里），report_logs 单条文档没必要为这份辅助信息无限膨胀
        ocrRawText: String(reportData.ocrMetadata.ocrRawText || '').slice(0, 500)
      } : null,
      updateTime: db ? db.serverDate() : Date.now(),
      isSynced: false,
      // 🛡️ 六大角色餐报提交对齐：无论提交者角色是什么，新记录一律从 PENDING 起步，
      // 不存在"店长/家长/财务/超管提交即自动审核通过"的捷径——真正的审核通过/稽核
      // 封账只能经 manageReportApproval 云函数由他人（非本人）执行。此前这里完全没有
      // 写这个字段，新记录的 approvalStatus 是 undefined，虽然大多数状态判断用
      // "=== 'AUDITED_LOCKED'"这类显式比较所以不会误判，但任何按 === 'PENDING'
      // 精确匹配的查询/展示逻辑（包括本轮新加的"我的待审核记录可编辑"判断）都会漏判
      approvalStatus: 'PENDING'
    };

    // 🛡️ 防抖锁：同一提交人在同一门店的上一次 saveReport 尚未落地前，拒绝本次并发调用
    const lockKey = buildReportSaveLockKey(tenantId, formattedData.storeId, openid || '');
    if (reportSaveLocks.get(lockKey)) {
      console.warn('[DataService] 检测到并发重复提交，已拒绝本次调用:', lockKey);
      return {
        success: false,
        message: '正在提交中，请勿重复点击',
        errorDetail: 'concurrent_submit_blocked'
      };
    }
    reportSaveLocks.set(lockKey, true);

    try {
      // 前置校验：阻止全 0 且无物资的无效数据（防止并发产生脏数据）
      const allZero =
        formattedData.yesterdayBalance === 0 &&
        formattedData.otherDonation === 0 &&
        formattedData.listDonationTotal === 0 &&
        formattedData.expenseAmount === 0 &&
        formattedData.todayBalance === 0 &&
        (!formattedData.materials || formattedData.materials.length === 0);

      if (allZero) {
        console.warn('[DataService] 检测到全0无效数据，已阻止提交');
        return {
          success: false,
          message: '账目各项均为0且无物资赞助，已自动跳过保存',
          errorDetail: 'all_zero_skipped'
        };
      }

      if (!db) {
        throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，saveReport 降级为本地缓存模式');
      }

      // 🔐 停用门店禁止新增记账：门店被机构管理员停用（stores.status === 'inactive'，
      // 见 pages/store-management + updateStoreStatus 云函数）后不应再产生新的
      // 记账数据。停用只在 getStoreList 的"选择服务门店"列表里把它过滤掉，拦不住
      // 已经选中该门店、本地会话尚未刷新的用户继续提交——这里在真正写库前补一道
      // 硬校验。saveReport 是客户端直连数据库写入（没有云函数中转），这是当前唯一
      // 能拦住这条写路径的地方
      if (formattedData.storeId) {
        const storeStatusRes = await db.collection('stores').doc(formattedData.storeId).get().catch(() => null);
        const storeDoc = storeStatusRes && storeStatusRes.data;
        if (storeDoc && storeDoc.status === 'inactive') {
          return {
            success: false,
            message: '该门店已被停用，暂不支持提交新的记账数据，请联系超级管理员重新启用',
            errorDetail: 'store_inactive'
          };
        }
      }

      // 步骤 1: 查询同日期同门店是否已有记录（Upsert 查重，强带 storeId/tenantId 隔离，
      // 与 createIndexes 里新增的 {tenantId, storeId, _openid} 复合索引对齐，避免
      // 控制台弹出【索引建议】警告，也比纯 shopName 字符串匹配更抗门店改名/重名）
      const upsertWhere: any = {
        dateString: formattedData.dateString,
        shopName: formattedData.shopName,
        _openid: openid || ''
      };
      if (formattedData.storeId) {
        upsertWhere.storeId = formattedData.storeId;
      }
      if (formattedData.tenantId) {
        upsertWhere.tenantId = formattedData.tenantId;
      }
      const existingQuery = await db.collection('report_logs')
        .where(upsertWhere)
        .limit(1)
        .get();

      let cloudResult: any;
      let operationType = '';

      if (existingQuery.data && existingQuery.data.length > 0) {
        // 步骤 2a: 已存在 - 提取 _id，调用 doc().update() 覆盖
        const existingRecord = existingQuery.data[0];
        const existingId = existingRecord._id;

        // 🛡️ 状态防护：这条 upsert 路径此前对目标记录的 approvalStatus 完全没有校验——
        // 只要同一账号在同门店同日期再次提交（哪怕只是手滑重复点击），就会直接覆盖一条
        // 已经店长核对确认（APPROVED）甚至财务稽核封账（AUDITED_LOCKED）的记录，等同于
        // 绕开 updateAndRecalculateCascade 里专门加的锁定校验，从首页原始提交表单开了
        // 一个后门。未设置 approvalStatus 的历史记录（本次修复前创建，视为等同 PENDING）
        // 不受影响，仍可正常覆盖保存
        if (existingRecord.approvalStatus === 'APPROVED' || existingRecord.approvalStatus === 'AUDITED_LOCKED') {
          return {
            success: false,
            message: '该日期的餐报已进入审核/封账流程，无法通过重新提交覆盖，如需修改请前往"我的餐报提交记录"使用编辑入口',
            errorDetail: 'record_locked_for_upsert'
          };
        }

        await db.collection('report_logs').doc(existingId).update({
          data: {
            reportDate: formattedData.reportDate,
            mpAccount: formattedData.mpAccount,
            yesterdayBalance: formattedData.yesterdayBalance,
            otherDonation: formattedData.otherDonation,
            listDonationTotal: formattedData.listDonationTotal,
            expenseAmount: formattedData.expenseAmount,
            expenses: formattedData.expenses,
            dailyExpenseText: formattedData.dailyExpenseText,
            fixedExpenseText: formattedData.fixedExpenseText,
            dailyExpenseTotal: formattedData.dailyExpenseTotal,
            fixedExpenseTotal: formattedData.fixedExpenseTotal,
            majorExpenseItems: formattedData.majorExpenseItems,
            dailyIngredientItems: formattedData.dailyIngredientItems,
            todayBalance: formattedData.todayBalance,
            reportText: formattedData.reportText,
            donationItems: formattedData.donationItems,
            receiptImages: formattedData.receiptImages,
            isManualAdjust: formattedData.isManualAdjust,
            systemBalance: formattedData.systemBalance,
            adjustedBalance: formattedData.adjustedBalance,
            balanceDiff: formattedData.balanceDiff,
            adjustReason: formattedData.adjustReason,
            materials: formattedData.materials,
            volunteerCount: formattedData.volunteerCount,
            volunteerHours: formattedData.volunteerHours,
            diningCount: formattedData.diningCount,
            dineInSeniors: formattedData.dineInSeniors,
            deliverySeniors: formattedData.deliverySeniors,
            dineInVolunteers: formattedData.dineInVolunteers,
            deliveryVolunteers: formattedData.deliveryVolunteers,
            takeawayCount: formattedData.takeawayCount,
            listeningSeniors: formattedData.listeningSeniors,
            totalDineCount: formattedData.totalDineCount,
            totalVolunteers: formattedData.totalVolunteers,
            stapleRiceStatus: formattedData.stapleRiceStatus,
            stapleOilStatus: formattedData.stapleOilStatus,
            ocrMetadata: formattedData.ocrMetadata,
            updateTime: db.serverDate()
          }
        });
        cloudResult = { _id: existingId };
        operationType = '已覆盖更新';
      } else {
        // 🌟 重复录入拦截：本人名下没有同日记录，但同门店+同日期维度可能已被他人
        // （另一账号/设备）提交过。若直接新增会产生两条互不关联的同日餐报，
        // 造成"昨日余额+今日结余"资金流水断裂，因此这里按门店+日期（不限定提交人）广义查重。
        if (!reportData.allowDuplicateDateOverride) {
          const duplicateWhere: any = {
            dateString: formattedData.dateString,
            shopName: formattedData.shopName
          };
          if (formattedData.storeId) {
            duplicateWhere.storeId = formattedData.storeId;
          }
          const duplicateQuery = await db.collection('report_logs')
            .where(duplicateWhere)
            .limit(1)
            .get();

          if (duplicateQuery.data && duplicateQuery.data.length > 0) {
            const duplicateId = duplicateQuery.data[0]._id;
            console.warn('[DataService] 检测到同门店同日期已存在他人提交的记录，已阻止重复录入:', duplicateId);
            return {
              success: false,
              message: '该日期已存在餐报记录，请直接在历史记录中编辑或修改，避免重复录入',
              errorDetail: 'duplicate_date_blocked',
              data: { duplicateRecordId: duplicateId } as any
            };
          }
        }

        // 步骤 2b: 不存在 - 新增
        (formattedData as any).createTime = db.serverDate();
        cloudResult = await db.collection('report_logs').add({
          data: formattedData
        });
        operationType = '已新增';
      }

      // 🛡️ 资金流水防篡改：客户端不持有 HMAC 密钥，写入后立即请求云函数在服务端补盖校验码；
      // 该调用不阻塞主提交流程，失败仅记录日志，不影响餐报本身已保存成功的事实
      if (cloudResult && cloudResult._id && isCloudAvailable()) {
        callFunctionWithTimeout({
          name: 'stampReportChecksum',
          data: { id: cloudResult._id }
        }).catch(e => console.warn('[DataService] 校验码补盖调用失败:', e));
      }

      // 步骤 3: 同步本地缓存
      formattedData.isSynced = true;
      (formattedData as any)._id = cloudResult._id;

      const localReports = getLocalReports();
      const localIdx = localReports.findIndex(r =>
        r.dateString === formattedData.dateString && r.shopName === formattedData.shopName
      );
      if (localIdx !== -1) {
        localReports[localIdx] = { ...localReports[localIdx], ...formattedData };
      } else {
        localReports.unshift(formattedData);
      }
      saveLocalReports(localReports);

      try {
        wx.setStorageSync('yuhua_last_balance', formattedData.todayBalance);
        wx.setStorageSync('yuhua_shop_name', formattedData.shopName);
        wx.setStorageSync('yuhua_mp_account', formattedData.mpAccount);
      } catch (storageErr) {
        console.warn('[DataService] 同步全局缓存失败（不影响主流程）:', storageErr);
      }

      return {
        success: true,
        message: `${operationType}记录（${formattedData.dateString}）`,
        data: formattedData
      };
    } catch (error: any) {
      // 强力捕获并暴露真实错误
      const errCode = error.errCode || error.code || 'N/A';
      const errMsg = error.errMsg || error.message || '未知错误';
      const isCloudDown = errMsg.includes('CLOUD_SDK_UNAVAILABLE');
      console.error(
        isCloudDown ? '[DataService] 云开发 SDK 不可用，saveReport 已降级为本地缓存模式' : '[DataService] 云端写入失败:',
        isCloudDown ? '' : error
      );

      // 尝试本地兜底
      try {
        formattedData.isSynced = false;
        (formattedData as any)._localId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
        (formattedData as any).localCreateTime = Date.now();

        const localReports = getLocalReports();
        const localIdx = localReports.findIndex(r =>
          r.dateString === formattedData.dateString && r.shopName === formattedData.shopName
        );
        if (localIdx !== -1) {
          localReports[localIdx] = { ...localReports[localIdx], ...formattedData };
        } else {
          localReports.unshift(formattedData);
        }
        saveLocalReports(localReports);
      } catch (localErr) {
        console.error('[DataService] 本地兜底写入也失败:', localErr);
      }

      // 返回 success: false，让前端能弹窗展示真实错误
      return {
        success: false,
        message: `保存失败: ${errMsg}`,
        data: formattedData,
        errorDetail: `错误码: ${errCode}\n错误信息: ${errMsg}`
      };
    } finally {
      reportSaveLocks.delete(lockKey);
    }
  },

  async getReports(options: {
    startDate?: string;
    endDate?: string;
    shopName?: string;
    storeId?: string;
    mpAccount?: string;
    limit?: number;
    viewMode?: 'all' | 'personal';
    // 🛡️ 二级审核门槛：本参数【默认 false】——getReports 是被 history.ts（店长/
    // 财务待审核列表）、custom-tab-bar/notice.ts（待处理徽标/通知）共用的通用
    // 查询入口，这几处必须能看到 PENDING（未经店长核对）的记录才能完成审核，
    // 默认收紧会直接弄坏审核工作流。只有 statistics.ts 这类"大盘统计"场景，
    // 数据在归档（approvalStatus 至少达到 APPROVED）前不该计入统计，才显式传
    // true——与 cloudfunctions/getSunshineLedger 的 approvalStatus 过滤同一条口径
    approvedOnly?: boolean;
  } = {}): Promise<{ success: boolean; data: any[]; source: 'cloud' | 'local'; error?: string }> {
    const { startDate, endDate, shopName, storeId, mpAccount, limit = 100, viewMode, approvedOnly = false } = options;
    const isApproved = (r: any) => r && (r.approvalStatus === 'APPROVED' || r.approvalStatus === 'AUDITED_LOCKED');

    try {
      if (!isCloudAvailable()) {
        throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端查询');
      }

      // 云端查询传 storeId 做强隔离（超管全国总览时 storeId 为空或 ALL_STORES 则不过滤）
      const result = await callFunctionWithTimeout({
        name: 'getReports',
        data: { startDate, endDate, storeId, mpAccount, limit, viewMode, approvedOnly }
      });

      const r = result.result as any;
      if (r && r.success) {
        let cloudData = r.data || [];

        // 前端模糊匹配门店名称（向后兼容历史无 storeId 的数据）
        if (shopName) {
          cloudData = cloudData.filter((item: any) =>
            isStoreNameFuzzyMatch(item.shopName, shopName)
          );
        }

        const localReports = getLocalReports();
        const openid = AuthService.getOpenid();
        // 🛡️ 本地未同步草稿从没经过云函数查询、approvalStatus 过滤对它们完全不生效——
        // 单独在合并前先按同一条件筛掉，避免"我这台设备刚提交、还没同步、还没被
        // 店长确认"的草稿抢先出现在只该展示已归档数据的统计页里
        let unsyncedReports = openid
          ? localReports.filter(r => !r.isSynced && r._openid === openid)
          : localReports.filter(r => !r.isSynced);

        if (shopName) {
          unsyncedReports = unsyncedReports.filter(r =>
            isStoreNameFuzzyMatch(r.shopName, shopName)
          );
        }

        if (approvedOnly) {
          unsyncedReports = unsyncedReports.filter(isApproved);
        }

        const mergedData = [...cloudData];
        const existingKeys = new Set(cloudData.map(c => `${c.dateString}_${c.shopName}`));

        unsyncedReports.forEach(localReport => {
          const key = `${localReport.dateString}_${localReport.shopName}`;
          const cloudIdx = mergedData.findIndex(m => `${m.dateString}_${m.shopName}` === key);
          if (cloudIdx !== -1) {
            mergedData[cloudIdx] = { ...mergedData[cloudIdx], ...localReport };
          } else if (!existingKeys.has(key)) {
            mergedData.unshift(localReport);
            existingKeys.add(key);
          }
        });

        mergedData.sort((a, b) => {
          const dateA = new Date(a.dateString || '');
          const dateB = new Date(b.dateString || '');
          return dateB.getTime() - dateA.getTime();
        });

        return {
          success: true,
          data: mergedData.slice(0, limit),
          source: 'cloud'
        };
      }

      throw new Error((r && r.error) || '云函数调用失败');
    } catch (error: any) {
      const isCloudDown = !!(error && error.message && error.message.includes('CLOUD_SDK_UNAVAILABLE'));
      console.warn(
        isCloudDown ? '[DataService] 云开发 SDK 不可用，getReports 已降级为本地缓存' : '[DataService] 云端查询失败，使用本地缓存:',
        isCloudDown ? '' : error
      );
      // 🛡️ 已经稳妥地降级到本地缓存（不影响这次调用的结果），但如果是 SDK 损坏
      // 特征错误，仍要顺手标记 isCloudReady=false，避免本次会话后续每一次
      // getReports 调用都要重新撞一次同一个已知崩溃、白白多等一轮超时
      reportCloudSdkErrorIfCorrupted(error);

      const openid = AuthService.getOpenid();
      let localReports = getLocalReports();

      if (openid) {
        localReports = localReports.filter(r => r._openid === openid);
      }

      if (startDate && endDate) {
        localReports = localReports.filter(r => 
          r.dateString >= startDate && r.dateString <= endDate
        );
      } else if (startDate) {
        localReports = localReports.filter(r => r.dateString >= startDate);
      } else if (endDate) {
        localReports = localReports.filter(r => r.dateString <= endDate);
      }

      if (shopName) {
        localReports = localReports.filter(r => isStoreNameFuzzyMatch(r.shopName, shopName));
      }

      if (mpAccount) {
        localReports = localReports.filter(r => r.mpAccount === mpAccount);
      }

      if (approvedOnly) {
        localReports = localReports.filter(isApproved);
      }

      localReports.sort((a, b) => {
        const dateA = new Date(a.dateString || '');
        const dateB = new Date(b.dateString || '');
        return dateB.getTime() - dateA.getTime();
      });

      return {
        success: true,
        data: localReports.slice(0, limit),
        source: 'local',
        // 🐛 根因排查：云端调用失败时静默退化为本地缓存，此前这个原始错误信息
        // 彻底丢失——调用方（如 statistics.ts 全国总览）拿到的永远是
        // success:true/data:[]，跟"这个机构真的没有数据"长得一模一样，没法
        // 区分"真空"与"权限/账号数据缺陷（如超管账号缺 tenantId）导致的查询失败"。
        // 只在真是云端报错（非离线降级）时才带上，避免把"设备没网"这种正常
        // 场景也标红
        error: isCloudDown ? undefined : (error && error.message)
      };
    }
  },

  // 🛡️ 熔断阈值：某条离线草稿如果连续同步失败达到这个次数（通常是数据本身有问题，
  // 比如字段校验不通过），说明重试大概率无法自愈。之前这里没有任何计数或上限，
  // 每次 index/history/statistics 任一页面 onLoad/onShow 触发 syncLocalDataToCloud
  // 都会把所有仍然失败的旧记录重新打一遍云函数请求，日积月累在控制台刷出大量
  // "同步单条数据失败"报错、并占用真实的网络请求配额。达到上限后不再自动重试，
  // 本地数据本身不会丢（仍保留在 localStorage，isSynced 仍是 false），只是不再
  // 每次进页面就重新尝试，等到未来这条记录被人工修复/删除后自然不再匹配本条件。
  MAX_OFFLINE_SYNC_RETRIES: 3,

  async syncLocalDataToCloud(): Promise<{ success: boolean; syncedCount: number; failedCount: number }> {
    const openid = AuthService.getOpenid();
    const localReports = getLocalReports();
    let unsyncedReports = localReports.filter(r => !r.isSynced);

    const circuitBrokenCount = unsyncedReports.filter(
      r => (r.syncFailCount || 0) >= this.MAX_OFFLINE_SYNC_RETRIES
    ).length;
    if (circuitBrokenCount > 0) {
      unsyncedReports = unsyncedReports.filter(
        r => (r.syncFailCount || 0) < this.MAX_OFFLINE_SYNC_RETRIES
      );
    }

    if (openid) {
      unsyncedReports = unsyncedReports.filter(r => r._openid === openid);
    }

    unsyncedReports = unsyncedReports.filter(report => {
      const yesterdayBalance = parseFloat(report.yesterdayBalance) || 0;
      const otherDonation = parseFloat(report.otherDonation) || 0;
      const listDonationTotal = parseFloat(report.listDonationTotal) || 0;
      const expenseAmount = parseFloat(report.expenseAmount) || 0;
      const todayBalance = parseFloat(report.todayBalance) || 0;
      const hasMaterials = report.materials && report.materials.length > 0;
      const hasItems = report.items && report.items.length > 0;
      return !(yesterdayBalance === 0 && otherDonation === 0 && listDonationTotal === 0 && expenseAmount === 0 && todayBalance === 0 && !hasMaterials && !hasItems);
    });

    if (unsyncedReports.length === 0) {
      return { success: true, syncedCount: 0, failedCount: 0 };
    }

    // 🌟 云开发 SDK 可用性防护：此调用原本不在任何 try/catch 保护范围内，
    // 一旦 wx.cloud 处于损坏状态会直接抛出未捕获异常。这里改为提前探测，
    // 不可用时跳过本轮同步（本地数据保持 isSynced:false，下次联网/onShow 时会自动重试）。
    if (!isCloudAvailable()) {
      const now = Date.now();
      if (now - lastCloudUnavailableWarnAt > CLOUD_UNAVAILABLE_WARN_COOLDOWN_MS) {
        lastCloudUnavailableWarnAt = now;
        console.warn('[DataService] 云开发 SDK 不可用，本轮跳过本地数据同步，待下次自动重试');
      }
      return { success: false, syncedCount: 0, failedCount: unsyncedReports.length };
    }

    const db = wx.cloud.database();
    let syncedCount = 0;
    let failedCount = 0;

    for (const report of unsyncedReports) {
      try {
        const dataToSync = { ...report };
        delete dataToSync._localId;
        delete dataToSync.localCreateTime;
        dataToSync.isSynced = true;
        dataToSync.updateTime = db.serverDate();
        // 🏢 多租户：补同步的离线草稿若创建于本字段上线之前，此处兜底补齐
        if (!dataToSync.tenantId) {
          const cachedRoleInfoForSync = AuthService.getCachedRoleInfo();
          dataToSync.tenantId = (cachedRoleInfoForSync && cachedRoleInfoForSync.tenantId) || '';
        }

        const syncWhere: any = {
          dateString: dataToSync.dateString,
          shopName: dataToSync.shopName,
          _openid: openid || ''
        };
        if (dataToSync.storeId) {
          syncWhere.storeId = dataToSync.storeId;
        }
        if (dataToSync.tenantId) {
          syncWhere.tenantId = dataToSync.tenantId;
        }
        const existingQuery = await db.collection('report_logs')
          .where(syncWhere)
          .limit(1)
          .get();

        let cloudId: string;

        if (existingQuery.data && existingQuery.data.length > 0) {
          const existingId = existingQuery.data[0]._id;
          await db.collection('report_logs').doc(existingId).update({
            data: dataToSync
          });
          cloudId = String(existingId);
        } else {
          dataToSync.createTime = db.serverDate();
          const result = await db.collection('report_logs').add({
            data: dataToSync
          });
          cloudId = String(result._id);
        }

        // 🛡️ 资金流水防篡改：离线草稿补同步后同样需要服务端补盖 HMAC 校验码
        callFunctionWithTimeout({
          name: 'stampReportChecksum',
          data: { id: cloudId }
        }).catch(e => console.warn('[DataService] 离线同步校验码补盖调用失败:', e));

        const index = localReports.findIndex(r => r._localId === report._localId);
        if (index !== -1) {
          localReports[index].isSynced = true;
          localReports[index]._id = cloudId;
          delete localReports[index]._localId;
          delete localReports[index].localCreateTime;
        }

        syncedCount++;
      } catch (error) {
        console.error('[DataService] 同步单条数据失败:', error);
        failedCount++;

        const failIndex = localReports.findIndex(r => r._localId === report._localId);
        if (failIndex !== -1) {
          const nextCount = (localReports[failIndex].syncFailCount || 0) + 1;
          localReports[failIndex].syncFailCount = nextCount;
          if (nextCount >= this.MAX_OFFLINE_SYNC_RETRIES) {
            console.warn(
              `[DataService] 该条本地数据已连续同步失败 ${nextCount} 次，达到上限，` +
              '本轮起暂停自动重试（数据仍保留在本地，不会丢失）'
            );
          }
        }
      }
    }

    saveLocalReports(localReports);

    if (syncedCount > 0) {
    }

    return {
      success: failedCount === 0,
      syncedCount,
      failedCount
    };
  },

  async deleteReport(id: string, reason: string, reportData?: any): Promise<{ success: boolean; message: string }> {
    if (!id) {
      return { success: false, message: '缺少记录 ID' };
    }

    if (!reason || !reason.trim()) {
      return { success: false, message: '请填写删除原因后再操作，删除历史餐报记录必须留痕' };
    }

    const isCloudRecord = !id.startsWith('local_');
    let cloudDeleted = false;
    let cloudError = '';

    if (isCloudRecord) {
      try {
        if (!isCloudAvailable()) {
          throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端删除');
        }

        const cloudResult = await callFunctionWithTimeout({
          name: 'deleteMealReport',
          data: { id, reason: reason.trim() }
        });
        const r = cloudResult.result as any;
        
        if (r && r.success) {
          cloudDeleted = true;
        } else {
          cloudError = (r && r.error) || '云端删除失败';
          console.warn('[DataService] 云函数删除失败:', cloudError);
        }
      } catch (cloudErr: any) {
        cloudError = cloudErr.message || '云函数调用异常';
        console.warn('[DataService] 云函数调用异常:', cloudErr);
      }
    }

    try {
      const localReports = getLocalReports();
      const beforeLen = localReports.length;
      
      const filteredReports = localReports.filter((item: any) => {
        const itemId = item._id || item._localId;
        if (itemId === id) {
          return false;
        }
        
        if (reportData && reportData.dateString && reportData.shopName) {
          if (item.dateString === reportData.dateString && 
              item.shopName === reportData.shopName) {
            return false;
          }
        }
        
        return true;
      });
      
      const afterLen = filteredReports.length;

      if (afterLen < beforeLen) {
        saveLocalReports(filteredReports);
      }

      if (isCloudRecord) {
        if (cloudDeleted) {
          return {
            success: true,
            message: '云端与本地均已删除'
          };
        } else {
          const localDeleted = afterLen < beforeLen;
          return {
            success: localDeleted,
            message: localDeleted 
              ? `本地已删除（云端删除失败：${cloudError}）`
              : `删除失败：${cloudError}`
          };
        }
      } else {
        const localDeleted = afterLen < beforeLen;
        return {
          success: localDeleted,
          message: localDeleted ? '本地记录已删除' : '未找到该记录'
        };
      }
    } catch (storageErr: any) {
      console.error('[DataService] 本地缓存删除失败:', storageErr);
      return {
        success: isCloudRecord && cloudDeleted,
        message: isCloudRecord && cloudDeleted 
          ? '云端已删除，本地缓存清理失败' 
          : '本地删除失败'
      };
    }
  },

  async clearDirtyReports(): Promise<{ success: boolean; removedCount: number; message: string }> {
    const isRecordValid = (item: any): boolean => {
      const otherDonation = parseNumber(item.otherDonation);
      const listDonationTotal = parseNumber(item.listDonationTotal);
      const expenseAmount = parseNumber(item.expenseAmount);
      const todayBalance = parseNumber(item.todayBalance);
      const diningCount = parseNumber(item.diningCount);
      const volunteerCount = parseNumber(item.volunteerCount);
      const volunteerHours = parseNumber(item.volunteerHours);
      
      const hasAmount = otherDonation > 0 || listDonationTotal > 0 || expenseAmount > 0 || todayBalance !== 0;
      const hasDining = diningCount > 0;
      const hasVolunteer = volunteerCount > 0 || volunteerHours > 0;
      const hasMaterials = item.materials && Array.isArray(item.materials) && item.materials.length > 0;
      const hasDonationItems = item.donationItems && Array.isArray(item.donationItems) && item.donationItems.length > 0;
      
      return hasAmount || hasDining || hasVolunteer || hasMaterials || hasDonationItems;
    };

    try {
      if (!isCloudAvailable()) {
        throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端清理');
      }

      const cloudResult = await callFunctionWithTimeout({
        name: 'clearMealReports',
        data: { mode: 'dirty' }
      });
      const r = cloudResult.result as any;

      const localReports = getLocalReports();
      const cleanedReports = localReports.filter(isRecordValid);
      
      const localRemovedCount = localReports.length - cleanedReports.length;
      saveLocalReports(cleanedReports);

      if (r && r.success) {
        return {
          success: true,
          removedCount: (r.removedCount || 0) + localRemovedCount,
          message: `清理完成，共移除 ${(r.removedCount || 0) + localRemovedCount} 条无效数据`
        };
      }

      return {
        success: localRemovedCount > 0,
        removedCount: localRemovedCount,
        message: localRemovedCount > 0 ? `本地清理完成，移除 ${localRemovedCount} 条无效数据` : '清理失败'
      };
    } catch (err: any) {
      console.error('[DataService] 清理脏数据失败:', err);
      
      const localReports = getLocalReports();
      const cleanedReports = localReports.filter(isRecordValid);
      
      const localRemovedCount = localReports.length - cleanedReports.length;
      saveLocalReports(cleanedReports);

      return {
        success: localRemovedCount > 0,
        removedCount: localRemovedCount,
        message: localRemovedCount > 0 ? `本地清理完成，移除 ${localRemovedCount} 条无效数据` : '清理失败，请检查网络后重试'
      };
    }
  },

  async getLatestReport(shopName?: string, mpAccount?: string, storeId?: string): Promise<{ success: boolean; data?: any; source: 'cloud' | 'local' }> {
    const result = await this.getReports({
      shopName,
      storeId,
      mpAccount,
      limit: 1
    });
    
    if (result.success && result.data.length > 0) {
      return {
        success: true,
        data: result.data[0],
        source: result.source
      };
    }
    
    return {
      success: false,
      source: result.source
    };
  },

  async getPreviousBalance(shopName: string, mpAccount: string, targetDateString: string, storeId?: string): Promise<{ success: boolean; data?: any }> {
    if (!shopName || !targetDateString) {
      return { success: false };
    }

    if (!isValidIsoDate(targetDateString)) {
      return { success: false };
    }

    const targetPrevIso = getPrevDayIsoString(targetDateString);
    const targetPrevCnShort = `${targetPrevIso.substring(2, 4)}年${targetPrevIso.substring(5, 7)}月${targetPrevIso.substring(8, 10)}日`;
    const targetPrevCnFull = `${targetPrevIso.substring(0, 4)}年${targetPrevIso.substring(5, 7)}月${targetPrevIso.substring(8, 10)}日`;

    try {
      if (!isCloudAvailable()) {
        throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端查询');
      }

      const result = await callFunctionWithTimeout({
        name: 'getPreviousBalance',
        data: { shopName, mpAccount, targetDateString, storeId }
      });

      const r = result.result as any;
      if (r && r.success) {
        return {
          success: true,
          data: r.data
        };
      }

      return {
        success: false,
        data: null
      };
    } catch (error) {
      console.error('[getPreviousBalance] 查询失败，降级到本地查询:', error);

      const localReports = getLocalReports();
      const matchedReports = localReports.filter(r => {
        if (!isStoreNameFuzzyMatch(r.shopName, shopName)) return false;
        
        let recordDateStr = '';
        const dateObj = parseAnyDateFormat(r.dateString);
        if (dateObj) {
          recordDateStr = formatDateToISO(dateObj);
        } else if (r.dateString) {
          recordDateStr = String(r.dateString);
        }
        
        return recordDateStr && recordDateStr < targetDateString;
      }).sort((a, b) => {
        let dateA = '';
        let dateB = '';
        const objA = parseAnyDateFormat(a.dateString);
        const objB = parseAnyDateFormat(b.dateString);
        if (objA) dateA = formatDateToISO(objA);
        else if (a.dateString) dateA = String(a.dateString);
        if (objB) dateB = formatDateToISO(objB);
        else if (b.dateString) dateB = String(b.dateString);
        return dateB.localeCompare(dateA);
      });

      if (matchedReports.length > 0) {
        const record = matchedReports[0];

        const balance = record.todayBalance != null && record.todayBalance !== ''
          ? record.todayBalance
          : (record.adjustedBalance != null ? record.adjustedBalance : null);

        return {
          success: true,
          data: {
            balance: balance,
            dateString: record.dateString,
            shopName: record.shopName,
            mpAccount: record.mpAccount
          }
        };
      }

      return { success: false, data: null };
    }
  },

  async getStatistics(startDate: string, endDate: string, shopName?: string, viewMode?: 'all' | 'personal', storeId?: string): Promise<{ success: boolean; data?: any; source: 'cloud' | 'local' }> {
    try {
      if (!isCloudAvailable()) {
        throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端查询');
      }

      const result = await callFunctionWithTimeout({
        name: 'getStatistics',
        data: { startDate, endDate, shopName, viewMode, storeId }
      });

      const r = result.result as any;
      if (r && r.success) {
        return {
          success: true,
          data: r.data,
          source: 'cloud'
        };
      }

      throw new Error((r && r.error) || '云函数调用失败');
    } catch (error) {
      console.warn('[DataService] 云端统计查询失败，使用本地缓存:', error);

      const localResult = await this.getReports({ startDate, endDate, shopName });
      const records = localResult.data || [];

      const statistics = this.calculateStatistics(records, startDate, endDate);

      return {
        success: true,
        data: statistics,
        source: 'local'
      };
    }
  },

  calculateStatistics(records: any[], startDate: string, endDate: string): any {
    const LARGE_EXPENSE_KEYWORDS = ['租金', '房租', '物业', '装修', '设备', '大件', '空调', '冰箱', '冰柜', '冷库', '蒸柜', '桌椅', '改造', '工程', '消防', '维修', '购置'];
    const LARGE_EXPENSE_THRESHOLD = 1000;

    let statistics = {
      totalIncome: 0,
      totalOtherDonation: 0,
      totalListDonation: 0,
      totalExpense: 0,
      dailyExpenseTotal: 0,
      largeExpenseTotal: 0,
      recordCount: records.length,
      netBalance: 0,
      dailyNetCashFlow: 0,
      avgDailyExpense: 0,
      avgPerCapitaCost: 0,
      startDate: startDate,
      endDate: endDate,
      dailyRecords: [] as any[]
    };

    let totalDonorCount = 0;

    records.forEach((item: any) => {
      const otherDonation = parseNumber(item.otherDonation);
      const listDonationTotal = parseNumber(item.listDonationTotal);
      const expenseAmount = parseNumber(item.expenseAmount);
      const expensesText = item.expenses || '';
      const donorCount = (item.donationItems && Array.isArray(item.donationItems)) ? item.donationItems.length : 0;
      totalDonorCount += donorCount;

      const isLargeExpense = LARGE_EXPENSE_KEYWORDS.some(kw => expensesText.includes(kw)) || expenseAmount >= LARGE_EXPENSE_THRESHOLD;
      const dailyExpense = isLargeExpense ? 0 : expenseAmount;
      const largeExpense = isLargeExpense ? expenseAmount : 0;

      statistics.totalOtherDonation += otherDonation;
      statistics.totalListDonation += listDonationTotal;
      statistics.totalExpense += expenseAmount;
      statistics.dailyExpenseTotal += dailyExpense;
      statistics.largeExpenseTotal += largeExpense;

      statistics.dailyRecords.push({
        date: item.dateString,
        otherDonation: otherDonation,
        listDonation: listDonationTotal,
        expense: expenseAmount,
        dailyExpense: dailyExpense,
        largeExpense: largeExpense,
        income: otherDonation + listDonationTotal,
        balance: parseNumber(item.todayBalance),
        donorCount: donorCount,
        perCapitaCost: donorCount > 0 ? Math.round((dailyExpense / donorCount) * 100) / 100 : 0
      });
    });

    statistics.totalIncome = statistics.totalOtherDonation + statistics.totalListDonation;
    statistics.netBalance = statistics.totalIncome - statistics.totalExpense;
    statistics.dailyNetCashFlow = statistics.totalIncome - statistics.dailyExpenseTotal;

    const days = records.length > 0 ? records.length : 1;
    statistics.avgDailyExpense = Math.round((statistics.dailyExpenseTotal / days) * 100) / 100;
    statistics.avgPerCapitaCost = totalDonorCount > 0
      ? Math.round((statistics.dailyExpenseTotal / totalDonorCount) * 100) / 100
      : 0;

    statistics.totalOtherDonation = Math.round(statistics.totalOtherDonation * 100) / 100;
    statistics.totalListDonation = Math.round(statistics.totalListDonation * 100) / 100;
    statistics.totalExpense = Math.round(statistics.totalExpense * 100) / 100;
    statistics.dailyExpenseTotal = Math.round(statistics.dailyExpenseTotal * 100) / 100;
    statistics.largeExpenseTotal = Math.round(statistics.largeExpenseTotal * 100) / 100;
    statistics.totalIncome = Math.round(statistics.totalIncome * 100) / 100;
    statistics.netBalance = Math.round(statistics.netBalance * 100) / 100;
    statistics.dailyNetCashFlow = Math.round(statistics.dailyNetCashFlow * 100) / 100;

    return statistics;
  },

  buildReportText(item: any): string {
    const items = (item.donationItems || item.items || []).map((d: any) => ({
      name: d.name || d.donor || '',
      amount: parseFloat(d.amount) || 0
    }));

    const materials = (item.materials || []).map((m: any) => ({
      donor: m.donor || '匿名爱心人士',
      item: m.item || '',
      quantity: m.quantity || '',
      unit: m.unit || ''
    }));

    const reportData = {
      shopName: item.shopName || '店铺',
      dateString: item.dateString || '',
      reportDate: item.reportDate || '',
      items: items,
      totalAmount: parseFloat(item.listDonationTotal) || 0,
      otherDonation: parseFloat(item.otherDonation) || 0,
      yesterdayBalance: parseFloat(item.yesterdayBalance) || 0,
      expenseAmount: parseFloat(item.expenseAmount) || 0,
      todayBalance: parseFloat(item.todayBalance) || 0,
      expenses: item.expenses || '',
      mpAccount: item.mpAccount || '',
      thankText: item.thankText || '',
      slogan1: item.slogan1 || '',
      slogan2: item.slogan2 || '',
      materials: materials,
      volunteerCount: parseFloat(item.volunteerCount) || 0,
      volunteerHours: parseFloat(item.volunteerHours) || 0,
      diningCount: parseFloat(item.diningCount) || 0,
      stapleRiceStatus: item.stapleRiceStatus || 'normal',
      stapleOilStatus: item.stapleOilStatus || 'sufficient'
    };

    return generateReportText(reportData);
  },

  getLocalReportsCount(): number {
    return getLocalReports().length;
  },

  getUnsyncedCount(): number {
    return getLocalReports().filter(r => !r.isSynced).length;
  }
};