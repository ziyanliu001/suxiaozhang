import { DataService, formatMoney } from '../../utils/dataService';
import { AuthService } from '../../utils/authService';
import { getSelectedStore } from '../../utils/storeManager';
import { getSafeSystemInfo } from '../../utils/util';
import { createNavGuard, NavGuardInstance } from '../../utils/navGuard';
import { parseDonorText, parseMaterials, formatDonationItemsToText, formatMaterialsToText } from '../../utils/parser';
import { getTodayIsoString } from '../../utils/dateUtils';
import { isCloudAvailable } from '../../utils/cloudGuard';
import { getPreviewViewMode, PREVIEW_VIEW_MODE_LABELS } from '../../utils/viewModePreview';
import { checkTenantPermission, FEATURE_KEYS } from '../../utils/tenantPermission';
import { requestOpenSubscription } from '../../utils/subscriptionHandoff';
import { callFunctionWithTimeout } from '../../utils/withTimeout';
import { withLoading } from '../../utils/loadingGuard';
import { isPrivacyMaskEnabled } from '../../utils/userPreferences';
import { maskName } from '../../utils/core/privacy';

// 🌐 全国总览/多店汇总视角的门店 ID 哨兵值集合。此前 history.ts 内三处各自手写了不完整的判断
// （有的漏了 'all'，有的漏了空字符串），导致某些视角下"今日凭证与记账"卡片被错误地展示出来。
// 统一到这一个常量 + isNationalStoreId()，全文件三处判断都改为调用它，杜绝再次出现口径不一致。
// 🆕 图册快捷时间范围：与 cloudfunctions/getPhotoArchive 的 range 参数枚举
// 一一对应，label 供 photo-archive-meta 的下拉胶囊按钮与 wx.showActionSheet
// 菜单展示
const PHOTO_ARCHIVE_RANGE_LABELS: Record<string, string> = {
  '1m': '近 1 个月',
  '3m': '近 3 个月',
  year: '本年度',
  all: '全部历史'
};
const PHOTO_ARCHIVE_RANGE_ORDER: Array<'1m' | '3m' | 'year' | 'all'> = ['1m', '3m', 'year', 'all'];

// 🆕 图册照片分类标签：与 getPhotoArchive 返回的 type 枚举一一对应，文案换成
// 更贴合素食公益语境的说法（报销凭证场景多为食材/物资采购 → 爱心采购；
// 每日食谱场景是门店记录的当日餐食 → 温情就餐），瀑布流网格标签与长按详情
// 弹窗共用同一份，不写两遍
const PHOTO_TYPE_LABELS: Record<string, string> = {
  receipt: '🧾 爱心采购',
  menu: '🍱 温情就餐',
  log: '📸 温情活动'
};

// 🆕 状态 Tab 顺序：与 WXML status-tab-row 的渲染顺序一一对应，statusTabIndex
// 只是这个数组里 statusTab 的下标，驱动滑动指示条的 left 偏移
const STATUS_TAB_ORDER: Array<'all' | 'pending' | 'approved' | 'rejected'> = ['all', 'pending', 'approved', 'rejected'];

const NATIONAL_STORE_IDS = ['national_overview', 'ALL_STORES', 'all', 'ALL'];
function isNationalStoreId(storeId: string): boolean {
  return !storeId || NATIONAL_STORE_IDS.includes(storeId);
}

// 🌟 首页「风控预警日志」弹窗"查看账本明细"精准追溯：与 cloudfunctions/getRiskAlerts
// 同一条判定口径（红字冲销/小票缺失/余额异常），在已加载的账本记录里原样复用一遍，
// 不额外请求云函数。'balance' 需要按门店分组、按日期升序比对相邻两条记录的余额链路，
// 因此不能像另外两类那样逐条独立判断
const BALANCE_JUMP_THRESHOLD = 1000;
function filterByAnomalyType(list: any[], anomalyType: string): any[] {
  if (anomalyType === 'void') {
    return list.filter((item: any) => !!item.isVoid);
  }
  if (anomalyType === 'missing_receipt') {
    return list.filter((item: any) => {
      if (item.isVoid) return false;
      const expenseAmount = parseFloat(item.expenseAmount || 0);
      const hasReceipt = (item.receiptImages && item.receiptImages.length > 0) ||
        (item.receiptImageList && item.receiptImageList.length > 0);
      return expenseAmount > 0 && !hasReceipt;
    });
  }
  if (anomalyType === 'balance') {
    const ascending = list
      .filter((item: any) => !item.isVoid)
      .slice()
      .sort((a: any, b: any) => String(a.dateString || '').localeCompare(String(b.dateString || '')));
    const prevBalanceByStore = new Map<string, number>();
    const matchedKeys = new Set<any>();
    ascending.forEach((item: any) => {
      const storeKey = item.shopName || item.storeId || '';
      const yesterdayBalance = parseFloat(item.yesterdayBalance || 0);
      const todayBalance = parseFloat(item.todayBalance || 0);
      const prevTodayBalance = prevBalanceByStore.has(storeKey) ? prevBalanceByStore.get(storeKey)! : null;
      if (prevTodayBalance !== null && Math.abs(yesterdayBalance - prevTodayBalance) > 0.01) {
        matchedKeys.add(item);
      }
      if (Math.abs(todayBalance - yesterdayBalance) > BALANCE_JUMP_THRESHOLD) {
        matchedKeys.add(item);
      }
      prevBalanceByStore.set(storeKey, todayBalance);
    });
    return list.filter((item: any) => matchedKeys.has(item));
  }
  return list;
}

Page({
  _shareRecord: null as any,
  isNavigating: false,
  _navGuard: null as NavGuardInstance | null,
  _managerAuditInFlight: false,
  _financeAuditInFlight: false,
  _voidInFlight: false,
  _recalibrateInFlight: false,
  _deleteInFlight: false,
  _todayActionInFlight: false,
  _supplementInFlight: false,
  // 🆕 精简 setData payload：本页全部报表记录（可达 DataService 默认上限
  // 100 条，每条都是 30+ 字段的格式化对象），从来没有在 WXML 里直接绑定过
  // ——渲染层只读 filteredReports（applyFilters() 从这份数据筛出的子集）。
  // 放进 data 里的唯一效果是每次 loadReports()/convertReceiptImagesToUrls()/
  // patchReportImagesInPlace() 都要把这一整包数据经 JSBridge 序列化传给渲染层，
  // 白白消耗一次传输开销却没有任何页面在读。改成普通实例字段，this._reports
  // 在纯 JS 逻辑层读写，不再进入 setData
  _reports: [] as any[],

  data: {
    watermarkIdentity: '',
    filteredReports: [],
    loading: true,
    // 🧾 今日凭证与记账（当日+历史一体化：置顶高亮展示当天记录，无需翻找历史列表）
    todayLedger: null as any,
    todayDateStr: '',
    // 📥 今日尚未正式提交餐报时，允许提前拍照/OCR暂存凭证，提交餐报后自动带入
    stagedReceiptImages: [] as string[],
    // 🔍 历史小票稽核详情弹窗：放大原图 + 财务对单 + 补传凭证
    showReceiptDetailModal: false,
    receiptDetailItem: null as any,
    receiptDetailImages: [] as string[],
    statusBarHeight: 20,
    navBarHeight: 44,
    totalHeaderHeight: 150,
    // 🐛 根因修复（标题/右侧图标与胶囊按钮安全边距）：本页导航栏是手搭的
    // .nav-title-bar，不是全站统一的 <navigation-bar> 组件，此前标题用
    // position:absolute + 固定 max-width:420rpx 在整条头部宽度上"数字硬编码
    // 居中"，右侧的 .nav-right-actions（最多 3 个图标）也只留了 24rpx 右
    // padding——两者都没有对齐胶囊按钮的真实坐标，窄屏/长标题下都有与胶囊
    // 重叠的风险。与 calculateNavBarHeight() 同一次 wx.getMenuButtonBoundingClientRect()
    // 调用里顺带算出"胶囊左边缘到屏幕右边缘的安全距离"，绑定给 .nav-title-bar
    // 的 padding-right，标题/右侧图标自然都不会越界
    navCapsuleSafePx: 90,

    isAdmin: false,
    // 🆕 个人视角入口标记：仅当从「我的提交与数据」(?view=mine) 进入时为 true，
    // 用于收敛页面为"专注展示个人提交记录"——隐藏超管视角切换预览 Banner 与
    // 门店切换下拉框/门店-我的 切换栏，避免非管理员用户被一堆管理向控件干扰。
    // 与 viewMode（服务端查询是否按 _openid 收敛）是两个独立维度：viewMode 只
    // 决定查到谁的数据，mineEntryMode 只决定这些管理向 UI 元素是否展示
    mineEntryMode: false,
    viewMode: 'all' as 'all' | 'personal',
    selectedStoreName: '',
    currentStoreId: '',
    isAllStoresView: false,
    selectedMonthStr: '',
    selectedMonthDisplay: '', // 筛选胶囊展示用："2026-07" -> "2026年07月"，不影响 selectedMonthStr 本身的过滤/导出口径
    // 🌟 从首页「风控预警日志」弹窗点击卡片跳转过来时携带的精准追溯筛选：
    // 'void'=红字冲销 / 'missing_receipt'=小票缺失 / 'balance'=余额异常（含链路断裂+单日净变动过大）
    anomalyFilterType: '' as '' | 'void' | 'missing_receipt' | 'balance',
    anomalyFilterLabel: '',
    // 🆕 状态筛选 Tab：全部/待审核/已通过/已驳回，纯客户端过滤（与 anomalyFilterType
    // 同一层级，两者可叠加）。"已驳回"映射到 isVoid===true（红字冲销作废）——
    // report_logs 的审核流转本身只有 PENDING_APPROVAL/APPROVED/AUDITED_LOCKED
    // 三态，没有独立的"驳回"状态字段，isVoid 是这份数据模型里唯一"未能通过、
    // 已被撤销"的语义，是最贴近的既有信号，不新造一个服务端并不产生的状态值
    statusTab: 'all' as 'all' | 'pending' | 'approved' | 'rejected',
    // 🆕 状态 Tab 下标：与 statusTab 一一对应（all=0/pending=1/approved=2/rejected=3），
    // 单独存一份是因为 WXML 里没法对字符串枚举做数组下标查找，滑动指示条的
    // left 偏移量要用这个数字直接乘算（见 status-tab-indicator 的 style 绑定）
    statusTabIndex: 0,
    // 🆕 状态 Tab badge 计数：与 statusTab 同一套过滤口径（叠加门店/月份/风控筛选，
    // 但不含 statusTab 本身），随 applyFilters() 一起重算，供 Tab 角标展示
    statusTabCounts: { all: 0, pending: 0, approved: 0, rejected: 0 },
    // 🆕 空状态智能文案：筛选条件（门店/月份/状态 Tab/风控追溯）导致 0 条结果时，
    // 展示"重置筛选"文字链接；账号/门店本身确实没有任何记录时不展示（重置了也没用）
    hasActiveFilters: false,
    // 🆕 今日未录入提醒 NoticeBar 的一键关闭态：纯会话内展示态，每次 onShow 重置，
    // 不持久化——用户离开页面再回来时提醒应该照常出现，不是永久消失
    todayReminderDismissed: false,
    // 🆕 设置页「隐私与脱敏模式」在本页的落地：开启后经办人姓名（approvedBy/
    // auditedBy）掩码展示、金额默认掩码；每次 onShow 重读一次（用户可能刚从
    // 设置页切换过开关再返回），不缓存过期值。sensitiveRevealed 是纯会话内的
    // "一键眼睛"临时显示态，不写回 Storage，也不影响持久化开关本身。
    // amountsMasked = privacyMaskEnabled && !sensitiveRevealed，随这两个字段
    // 任一变化同步重算（见 onShow/onToggleSensitiveReveal），WXML 只读这一个
    // 派生字段，不在每处金额绑定里重复写一遍布尔表达式
    privacyMaskEnabled: false,
    sensitiveRevealed: false,
    amountsMasked: false,
    showEditModal: false,
    editingRecord: null as any,
    receiptImgCount: 0,
    isManagerOrAdmin: false,
    isFinanceOrAdmin: false,
    showPreviewBanner: false,
    previewBannerText: '',
    // 🐛 修复：placeholder 曾使用 XML 数字字符实体 &#10; 表示换行，微信 WXML 不会对其解码，
    // 会把字面量 "&#10;" 原样展示给用户。这里改为在 TS 层用真实的 \n 换行符拼好，再绑定渲染。
    donationsPlaceholder: '示例：张三 100\n李四 200（支持空格/逗号/冒号分隔，自动识别金额）',

    // 🌟 月度财务审计表导出：月份取自上方已有的月份筛选器（selectedMonthStr），
    // 未筛选时导出默认按钮字面意思——即"本月"
    exportingAudit: false,
    // 🌟「先核对、再确认、后导出」导出预览核对弹窗
    showExportPreviewModal: false,
    exportPreviewSummary: {} as any,
    exportPreviewRecords: [] as any[],
    showAuditExportModal: false,
    auditExportPeriodLabel: '',
    auditExportText: '',
    auditExportFileURL: '',
    auditExportFileName: '',
    // 🔐 专业版功能拦截弹窗（见 components/feature-locked-modal）：月度财务
    // 审计表导出与 statistics.ts 的 Excel 导出复用同一个 exportAccountExcel
    // 云函数、同一档 FEATURE_KEYS.EXCEL_EXPORT 权限，触发拦截时用这两个字段
    showFeatureLockedModal: false,
    featureLockedCanSelfUpgrade: false,

    // 📸 图册模式：切换至照片归档浏览，隐藏账本内容
    photoArchiveMode: false,
    // 照片类型过滤：'all' | 'receipt' | 'menu' | 'log'
    photoTypeFilter: 'all' as string,
    photoArchiveList: [] as Array<{ url: string; type: string; date: string; storeName: string; id?: string }>,
    photoArchiveLoading: false,
    photoArchiveTotal: 0,
    // 🆕 长按照片查看详情：轻量弹窗，复用本页已有的 .modal-backdrop/.modal-card
    // 视觉语言，不新增一套弹窗样式
    showPhotoDetailModal: false,
    photoDetailItem: null as null | { url: string; type: string; date: string; storeName: string; id?: string; typeLabel: string },
    // 🆕 图册专属的快捷时间范围（与账本模式的单月 picker 互不相关——图册模式
    // 下 .unified-filter-row 整块隐藏，selectedMonthStr 在图册模式里从未被
    // 真正赋过值，此前"统计行"右侧的时间文案其实是个只会显示"近 3 个月"的
    // 死态展示，并非真的可切换。这里补一套图册自己的范围状态，与
    // getPhotoArchive 云函数新增的 range 参数一一对应）
    photoArchiveRangeKey: '3m' as '1m' | '3m' | 'year' | 'all',
    photoArchiveRangeLabels: PHOTO_ARCHIVE_RANGE_LABELS,
    // 页面标题随模式 + orgType 动态切换
    pageTitle: '🧾 凭证与账本',
    // 机构类型：从 tenantId 派生（与 index.ts 同款逻辑），驱动图册页面标题文案
    orgType: '' as string
  },

  onLoad(options: any) {
    // 🛡️ 六大角色对齐："我的餐报提交记录"（profile.ts onGoToMySubmissions 跳转的
    // /pages/history/history?view=mine）此前完全没有读取过这个查询参数——onLoad
    // 从来不接收 options，viewMode 一直停留在默认的 'all'，导致"我的记录"入口
    // 实际展示的是全店所有人的记录，而不是严格收敛到 createdBy/_openid === 当前
    // 用户自己。getReports 云函数早就支持 viewMode==='personal' 时按 _openid 收敛
    // （见该函数 shouldFilterByOpenid 判断），只是客户端这里从未真正传过这个值
    if (options && options.view === 'mine') {
      this.setData({ viewMode: 'personal', mineEntryMode: true });
    }
    // 📸 首页图册入口卡跳转：?mode=photo 直接打开图册模式
    // 🐛 根因修复：此前这里写死了雨花斋专属标题，不管当前机构是不是雨花斋都
    // 展示"🏡 雨花温情图册与阳光凭证"，与 computePhotoArchiveTitle() 的机构类型
    // 判断口径不一致（该方法只在 onTogglePhotoArchive 手动切换时才会被调用）。
    // 改为直接调用同一个方法：此时 orgType 尚未从 loadReports() 异步解析出来，
    // 会先给出中性的 🌸 文案，等 orgType 解析完成后如需要可自行刷新（雨花斋
    // 机构场景下差异仅一个 emoji，不影响可读性）
    if (options && options.mode === 'photo') {
      this.setData({ photoArchiveMode: true, pageTitle: this.computePhotoArchiveTitle() });
    }
    // 🌟 首页「风控预警日志」弹窗点击卡片"查看账本明细"跳转过来（携带 anomalyType
    // 查询参数）时，进页面即自动按同一类型精准筛选，不需要用户再手动翻找
    const anomalyLabelMap: Record<string, string> = {
      void: '🔴 红字冲销',
      missing_receipt: '🧾 小票缺失',
      balance: '⚠️ 余额异常'
    };
    if (options && options.anomalyType && anomalyLabelMap[options.anomalyType]) {
      this.setData({
        anomalyFilterType: options.anomalyType,
        anomalyFilterLabel: anomalyLabelMap[options.anomalyType]
      });
    }
    // 🌟 财务个人页「凭证快速复核」入口跳转过来（?statusTab=pending）时，直接
    // 落在"待审批"筛选 Tab 上，不需要财务再自己点一次筛选——与上面 view=mine/
    // mode=photo/anomalyType 同一套"带参进页直接命中目标筛选"的入口设计
    if (options && options.statusTab && ['all', 'pending', 'approved', 'rejected'].includes(options.statusTab)) {
      this.setData({ statusTab: options.statusTab, statusTabIndex: STATUS_TAB_ORDER.indexOf(options.statusTab) });
    }
    this.calculateNavBarHeight();
    this.checkAdminStatus();
    this.initPermissions();
    this.loadReports();
    // 若从首页图册入口直接进入图册模式，立即加载图片档案
    if (options && options.mode === 'photo') {
      this.loadPhotoArchive();
    }
    this.initShareMenu();
    this.initWatermarkIdentity();

    // 注入物理返回键兜底拦截：分享直入此页时，物理返回会跳到首页而非退出
    this._navGuard = createNavGuard({
      homePath: '/pages/index/index',
      alertMessage: '即将退出雨花爱心餐报助手，是否返回首页继续使用？'
    });
    this._navGuard.setupOnLoad();
  },

  onUnload() {
    if (this._navGuard) {
      this._navGuard.teardown();
      this._navGuard = null;
    }
  },

  // 🆕 下拉刷新：账本模式重新拉取报表列表，图册模式重新拉取图片档案；
  // finally 里统一 wx.stopPullDownRefresh()，无论成功/失败都要收起下拉圈，
  // 否则失败时下拉圈会一直转到系统超时才自己消失
  async onPullDownRefresh() {
    try {
      if (this.data.photoArchiveMode) {
        await this.loadPhotoArchive();
      } else {
        await this.loadReports();
      }
    } catch (err) {
      console.warn('[onPullDownRefresh] 刷新失败:', err);
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  initShareMenu() {
    try {
      wx.showShareMenu({
        menus: ['shareAppMessage', 'shareTimeline'],
        withShareTicket: true
      });
    } catch (err) {
      console.error('initShareMenu failed:', err);
    }
  },

  onShow() {
    // 重置路由防重锁
    this.isNavigating = false;

    // navGuard 状态刷新（用户从其他页 navigateBack 回来时重新检测）
    if (this._navGuard) {
      this._navGuard.setupOnShow();
    }

    // 🆕 隐私脱敏模式：每次 onShow 重读一次（用户可能刚从设置页切换过开关
    // 再返回本页），不缓存上一次进页时的旧值；formattedReports 里已经预算好
    // approvedByMasked/auditedByMasked，这里只需要切换 WXML 用哪一份展示。
    // 每次进页重置 sensitiveRevealed=false：临时显示态只在当前这次停留有效，
    // 不应该跨越"离开又回来"继续保持
    const nextPrivacyMaskEnabled = isPrivacyMaskEnabled();
    this.setData({
      privacyMaskEnabled: nextPrivacyMaskEnabled,
      sensitiveRevealed: false,
      amountsMasked: nextPrivacyMaskEnabled,
      // 🆕 今日未录入提醒每次进页重新展示：关闭只是当次停留的临时收起，
      // 不应该在用户下次回到本页时仍然缺席这条提醒
      todayReminderDismissed: false
    });

    const activeStore = getSelectedStore();
    // 🐛 硬性根治："切到全国汇总账本查不出记录"根因：current_store_id/
    // active_store_id 是店铺切换/角色切换各自独立写入的原始 Storage key，可能
    // 互相不同步或残留旧门店的值（例如通过 store-picker 角色切换到"全国总览"
    // 时只写 active_store_id/current_store_name，从不写 current_store_id）。
    // getSelectedStore()（activeStore）汇总了 app.globalData.currentStore/
    // selectedStore 缓存，是全局最新、最权威的"当前选中门店"来源，必须优先采信；
    // 此前这里反过来优先信 currentStoreId 这个原始 Storage key，一旦它残留着
    // 某个具体门店的旧 id，就会用这个不相关的旧 id 覆盖掉 activeStore 里正确的
    // 'national_overview'，导致按错误门店去查询，查出 0 条
    const storedStoreId = wx.getStorageSync('current_store_id') || wx.getStorageSync('active_store_id') || '';
    const storedStoreName = wx.getStorageSync('current_store_name') || '';
    const resolvedStoreName = (activeStore && activeStore.storeName) || storedStoreName || '';
    const resolvedStoreId = (activeStore && activeStore.storeId) || storedStoreId || '';

    // 🐛 修复：此前分支只更新 selectedStoreName/currentStoreId，从未同步过 isAllStoresView，
    // 导致从全国总览/多店视角进入或返回本页时，"今日凭证与记账"卡片仍按上一次的（可能是错的）
    // 视角状态展示，最典型的表现就是全国总览下也照样显示今日记账卡片与 OCR/补传按钮。
    if (resolvedStoreName !== this.data.selectedStoreName || resolvedStoreId !== this.data.currentStoreId) {
      this.setData({
        selectedStoreName: resolvedStoreName,
        currentStoreId: resolvedStoreId,
        isAllStoresView: this.resolveIsAllStoresView(resolvedStoreId)
      });
    } else {
      // 两个信号源都未变化：仍要用当前已知的 storeId 校正一次视角标志，避免过期状态残留
      this.setData({ isAllStoresView: this.resolveIsAllStoresView(resolvedStoreId) });
    }

    // 🛡️ 门店选择 Pill 控件同步：<store-picker> 组件只在自己 attached() 时读一次
    // app.globalData.currentStore，本页作为常驻 tab 页再次 onShow 时组件不会自动
    // 重新挂载——如果门店是在别的页面切换的（例如切到"全国总览"），这里手动催一次
    // loadStoreInfo()，确保 Pill 显示与本页刚解析出的 resolvedStoreName 保持一致，
    // 不会停留在旧门店名
    const historyStorePicker = this.selectComponent('#historyStorePicker') as any;
    if (historyStorePicker && typeof historyStorePicker.loadStoreInfo === 'function') {
      historyStorePicker.loadStoreInfo();
    }
    this.initPermissions();
    this.loadReports();
    DataService.syncLocalDataToCloud();
  },

  // 🛡️ 非超管禁止越权停留在"全国总览"视角：门店 ID 是否命中全国哨兵值只是必要
  // 条件之一，还必须叠加当前真实角色是 super_admin——storage 里缓存的 current_store_id
  // 可能是共享设备上一次超管会话残留、或账号被降级后未清理的旧值，不能仅凭这个
  // 哨兵值本身就判定"可以看全国汇总"。与 activity-log.ts/store-profile.ts 同一套
  // "storage 值需叠加角色校验才生效"的防御口径对齐
  resolveIsAllStoresView(storeId: string): boolean {
    return isNationalStoreId(storeId) && !!this.data.isSuperAdmin;
  },

  // 🌟 切店全局响应：store-picker 触发 storechange 时同步刷新历史记录
  onStoreChange(e: any) {
    const { storeId, storeName } = e.detail || {};

    // 持久化当前门店
    wx.setStorageSync('current_store_id', storeId || '');
    wx.setStorageSync('current_store_name', storeName || '');

    const isAllStores = this.resolveIsAllStoresView(storeId || '');

    this.setData({
      selectedStoreName: storeName || '',
      currentStoreId: storeId || '',
      isAllStoresView: isAllStores
    });

    if (this.data.photoArchiveMode) {
      // 图册模式下切店：重新加载图册
      this.setData({ photoArchiveList: [], photoArchiveTotal: 0 });
      this.loadPhotoArchive();
    } else {
      // 重新拉取新门店的历史餐报列表
      this.loadReports();
    }
  },

  // store-picker 组件绑定的事件
  onStorePickerChange(e: any) {
    this.onStoreChange(e);
  },

  // 🌟 常驻门店切换卡片：点击直接拉起顶部 store-picker 组件的选择面板
  onOpenStorePickerSheet() {
    const picker = this.selectComponent('#historyStorePicker');
    if (picker && typeof picker.onOpenSheet === 'function') {
      picker.onOpenSheet();
    }
  },

  // 🌟 高危功能：一键链式校准全线结余流水
  async onRecalibrateAllBalances() {
    if (!this.data.isManagerRole && !this.data.isFinanceRole && !this.data.isSuperAdmin) {
      wx.showToast({ title: '仅店长与财务拥有校准权限', icon: 'none' });
      return;
    }

    const currentStoreId = this.data.currentStoreId;
    const isAllStoresContext = this.data.isAllStoresView || !currentStoreId || currentStoreId === 'ALL_STORES' || currentStoreId === 'national_overview' || currentStoreId === 'all';

    if (isAllStoresContext) {
      // 🌟 超级管理员在全国总览视角下不再被拦截，改为走"全国所有门店"批量校准；
      // 店长/财务在全国总览视角下依然无法确定校准哪家门店，引导先切换到具体门店
      if (!this.data.isSuperAdmin) {
        wx.showToast({ title: '店长模式下请先选择您管理的具体门店再进行校准', icon: 'none', duration: 2500 });
        return;
      }

      // 🛡️ 临时加固：近期曾发生全库数据异常事故，全国范围校准（影响面最大的一档操作）
      // 现新增一道输入型二次确认，需手动键入"确认校准"四字才会进入下一步弹窗，
      // 防止手滑/误触；云函数本身也已改为逐店事务+失败回滚，仅允许写结余/校验和字段。
      wx.showModal({
        title: '⚠️ 高风险操作二次确认',
        content: '全国范围校准会遍历全部门店的历史账目。请务必确认 recalculateLedger 云函数已部署最新版本（事务+回滚+字段白名单）。请输入"确认校准"以继续：',
        editable: true,
        placeholderText: '请输入：确认校准',
        confirmText: '下一步',
        confirmColor: '#D32F2F',
        success: (res) => {
          if (!res.confirm) return;
          if ((res.content || '').trim() !== '确认校准') {
            wx.showToast({ title: '输入不匹配，已取消操作', icon: 'none' });
            return;
          }

          wx.showModal({
            title: '确认全国范围校准？',
            content: '确认要重新校准【全国所有门店】的全线结余流水账目吗？这可能需要几秒钟。',
            confirmText: '确认校准',
            confirmColor: '#D32F2F',
            cancelText: '我再想想',
            success: async (res2) => {
              if (!res2.confirm) return;
              await this.executeRecalculateLedger('all');
            }
          });
        }
      });
      return;
    }

    // 🛡️ 防误触升级：单店校准此前只有一层普通确认弹窗，现同样加上输入型二次确认，
    // 需手动键入"确认校准"才会进入下一步，与全国范围校准的防护级别保持一致
    const storeLabel = this.data.selectedStoreName || currentStoreId;
    wx.showModal({
      title: '⚠️ 校准操作二次确认',
      content: `即将重新校准【${storeLabel}】的全线结余流水账目。请输入"确认校准"以继续：`,
      editable: true,
      placeholderText: '请输入：确认校准',
      confirmText: '下一步',
      confirmColor: '#E65100',
      success: (res) => {
        if (!res.confirm) return;
        if ((res.content || '').trim() !== '确认校准') {
          wx.showToast({ title: '输入不匹配，已取消操作', icon: 'none' });
          return;
        }

        wx.showModal({
          title: `确认校准【${storeLabel}】？`,
          content: '确认要重新校准该门店的全线结余流水账目吗？',
          confirmText: '确认校准',
          confirmColor: '#E65100',
          cancelText: '我再想想',
          success: async (res2) => {
            if (!res2.confirm) return;
            await this.executeRecalculateLedger(currentStoreId);
          }
        });
      }
    });
  },

  // 🛡️ 入口降级：一键校准从顶部常规区域移出，改为右上角"⚙️ 设置"入口的二次菜单，
  // 降低误触概率；仅门店/超管等具备权限的角色可见该设置图标
  onOpenHistorySettingsMenu() {
    if (!this.data.isManagerRole && !this.data.isFinanceRole && !this.data.isSuperAdmin) {
      return;
    }

    wx.showActionSheet({
      itemList: ['🔄 一键校准全线结余流水'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.onRecalibrateAllBalances();
        }
      }
    });
  },

  // storeId === 'all' 时全国全量重算；否则仅重算该单店，统一走同一个云函数
  async executeRecalculateLedger(storeId: string) {
    if (this._recalibrateInFlight) return;
    this._recalibrateInFlight = true;

    const isAll = storeId === 'all';
    wx.showLoading({ title: isAll ? '全国门店账目重算中...' : '全线账目重算中...', mask: true });

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const res = await callFunctionWithTimeout({
        name: 'recalculateLedger',
        data: { storeId }
      });
      const result = res.result as any;

      wx.hideLoading();

      if (result && result.success) {
        wx.showToast({ title: '✅ 全线结余流水校准完成', icon: 'success', duration: 2500 });
        this.loadReports();
      } else {
        wx.showModal({
          title: '校准失败',
          content: (result && result.errMsg) || '云函数未返回正确结果',
          showCancel: false
        });
      }
    } catch (err: any) {
      wx.hideLoading();
      console.error('[executeRecalculateLedger] 异常:', err);
      // 🛡️ 云函数当前处于紧急熔断状态（会主动 throw），把云端返回的真实错误文案透传给用户，
      // 而不是笼统提示"请确认已部署"——避免维护期间的正常熔断被误判为部署/网络问题
      const cloudErrMsg = err && (err.errMsg || err.message);
      wx.showModal({
        title: '调用失败',
        content: cloudErrMsg || '未成功触发校准，请确认 recalculateLedger 云函数已右键【上传并部署】',
        showCancel: false
      });
    } finally {
      this._recalibrateInFlight = false;
    }
  },

  async initPermissions() {

    const applyRoleFlags = (roleSource: string) => {
      const normalizedRole = (roleSource || 'volunteer').toLowerCase();
      const isSuperAdmin = normalizedRole === 'super_admin';
      // 🏛️ 权限向下继承：大家长天然拥有店长 + 财务的全套日常管理权限
      const isManagerRole = normalizedRole === 'store_manager' || normalizedRole === 'store_patriarch' || isSuperAdmin;
      const isFinanceRole = normalizedRole === 'finance' || normalizedRole === 'store_patriarch' || isSuperAdmin;

      // 🛡️ 仅做提示，不做授权：本页所有权限判断全程只认 normalizedRole（真实身份），
      // 从不接入 viewModePreview 的展示层覆盖——这里读取预览模式仅用于渲染一条
      // 提示 Banner，告知超管"当前正在看店长视角的样子，但本页操作仍按真实的
      // 超管身份执行"，避免误以为预览模式在这个页面上也切换了实际权限。
      const previewMode = isSuperAdmin ? getPreviewViewMode() : 'SUPER_ADMIN';
      const showPreviewBanner = isSuperAdmin && previewMode !== 'SUPER_ADMIN';

      this.setData({
        isManagerOrAdmin: isManagerRole,
        isFinanceOrAdmin: isFinanceRole,
        isManagerRole: isManagerRole,
        isFinanceRole: isFinanceRole,
        isSuperAdmin: isSuperAdmin,
        showPreviewBanner: showPreviewBanner,
        previewBannerText: showPreviewBanner ? `当前正在预览「${PREVIEW_VIEW_MODE_LABELS[previewMode]}」的界面样式，本页操作仍按您的真实身份（超级管理员）执行` : ''
      });

      // 🐛 硬性根治：onShow() 里对 isAllStoresView 的赋值发生在 initPermissions()
      // （本函数）之前，此时用的 isSuperAdmin 还是上一轮渲染的旧值（首次进页时
      // 默认 false）。此前这里只处理"非超管却残留 isAllStoresView=true"这一个
      // 方向的纠偏，遗漏了相反方向——如果这一轮角色查询确认真实身份就是
      // super_admin、且当前门店确实是"全国总览"哨兵值，必须把 isAllStoresView
      // 纠正为 true，否则会一直卡在"🏪 门店完整账本"的错误标签和"今日凭证"卡片
      // 误显示，即使门店选择器里明明选的是全国总览
      const correctedIsAllStoresView = isNationalStoreId(this.data.currentStoreId) && isSuperAdmin;
      if (correctedIsAllStoresView !== this.data.isAllStoresView) {
        this.setData({ isAllStoresView: correctedIsAllStoresView });
      }
    };

    const cached = AuthService.getCachedRoleInfo();
    if (cached && cached.role) {
      applyRoleFlags(cached.role);
    } else {
      const localRole = wx.getStorageSync('current_user_role') || 'volunteer';
      applyRoleFlags(localRole);
    }

    try {
      const rolePromise = AuthService.fetchUserRole();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT')), 2500)
      );

      const result = await Promise.race([rolePromise, timeoutPromise]);

      if (result && result.success && result.roleInfo && result.roleInfo.role) {
        applyRoleFlags(result.roleInfo.role);
        // 派生 orgType：tenantId 以 'yuhuazhai' 开头视为雨花斋机构，否则 generic
        const tenantId: string = result.roleInfo.tenantId || '';
        const orgType = tenantId.startsWith('yuhuazhai') ? 'yuhuazhai' : (tenantId ? 'generic' : '');
        if (orgType !== this.data.orgType) {
          // 🐛 图册模式下 orgType 异步解析出来后，把 onLoad 阶段先给出的中性
          // 🌸 标题刷新成机构类型对应的正确 emoji（见 onLoad ?mode=photo 分支
          // 注释），避免标题在 orgType 解析前后不一致
          const pageTitlePatch = this.data.photoArchiveMode
            ? { pageTitle: orgType === 'yuhuazhai' ? '🏡 温情图册 · 阳光凭证' : '🌸 温情图册 · 阳光凭证' }
            : {};
          this.setData({ orgType, ...pageTitlePatch });
        }
      }
    } catch (err: any) {
      console.warn('⚠️ [history] 云端鉴权超时或异常，启动本地缓存兜底:', err.message);
      const fallbackRole = wx.getStorageSync('current_user_role') || 'volunteer';
      applyRoleFlags(fallbackRole);
    }
  },

  checkAdminStatus() {
    const isAdmin = AuthService.isAdmin();
    this.setData({ isAdmin }, () => {
      this.recalcTotalHeaderHeight();
    });
  },

  // 🛡️ 防截图/防外传水印：叠加当前操作者身份标识，用于追溯截图外传来源
  initWatermarkIdentity() {
    const openid = AuthService.getOpenid() || '';
    const tail = openid ? openid.slice(-6) : '未登录';
    this.setData({ watermarkIdentity: `操作人 ***${tail}` });
  },

  switchViewMode(e: any) {
    const mode = e.currentTarget.dataset.mode as 'all' | 'personal';
    this.setData({ viewMode: mode });
    this.loadReports();
  },

  // 🆕 隐私脱敏模式下的"一键眼睛"：临时显示/隐藏本页所有金额，纯会话内展示态，
  // 不写回 Storage、不影响设置页的持久化开关本身——重进本页或重启小程序后
  // 恢复为默认隐藏
  onToggleSensitiveReveal() {
    const nextRevealed = !this.data.sensitiveRevealed;
    this.setData({
      sensitiveRevealed: nextRevealed,
      amountsMasked: this.data.privacyMaskEnabled && !nextRevealed
    });
  },

  // 🆕 今日未录入提醒 NoticeBar 一键关闭：非阻断式收起，纯会话内展示态（见
  // data.todayReminderDismissed 声明处注释），点击 ✕ 不触发外层整行的跳转
  onDismissTodayReminder() {
    this.setData({ todayReminderDismissed: true });
  },

  // 🆕 状态筛选 Tab：全部/待审核/已通过/已驳回，纯客户端过滤，已加载的
  // reports 里直接筛，不重新请求云函数
  onSwitchStatusTab(e: any) {
    const tab = e.currentTarget.dataset.tab as 'all' | 'pending' | 'approved' | 'rejected';
    if (tab === this.data.statusTab) return;
    this.setData({ statusTab: tab, statusTabIndex: STATUS_TAB_ORDER.indexOf(tab) });
    this.applyFilters();
  },

  calculateNavBarHeight() {
    try {
      const sysInfo = getSafeSystemInfo();
      const statusBarHeight = sysInfo.statusBarHeight || 20;

      const menuButton = wx.getMenuButtonBoundingClientRect();
      let navBarHeight = 44;
      // 🐛 见 data.navCapsuleSafePx 声明处注释：胶囊左边缘到屏幕右边缘的实测
      // 距离 + 8px 缓冲，作为 .nav-title-bar 的 padding-right，标题（flex:1 +
      // ellipsis）与右侧图标行都会自动收窄在这条安全线以内，不再用猜测的固定
      // rpx 数值硬顶
      let navCapsuleSafePx = 90;
      if (menuButton) {
        navBarHeight = (menuButton.top - statusBarHeight) * 2 + menuButton.height;
        navCapsuleSafePx = (sysInfo.screenWidth - menuButton.left) + 8;
      }

      this.setData({
        statusBarHeight,
        navBarHeight: navBarHeight || 44,
        navCapsuleSafePx
      }, () => {
        this.recalcTotalHeaderHeight();
      });
    } catch (e) {
      console.warn('Calc height fallback:', e);
      this.setData({ totalHeaderHeight: 150 });
    }
  },

  recalcTotalHeaderHeight() {
    const { statusBarHeight, navBarHeight, isAdmin } = this.data;
    const filterBarHeight = 50;
    const adminSwitchHeight = isAdmin ? 40 : 0;
    const extraPadding = 8;

    const totalHeaderHeight = statusBarHeight + navBarHeight + adminSwitchHeight + filterBarHeight + extraPadding;
    this.setData({ totalHeaderHeight }, () => {
      this.measureActualHeaderHeight();
    });
  },

  // 🐛 修复顶部固定筛选栏遮挡内容区：手算的 filterBarHeight 硬编码为 50px，
  // 在门店切换胶囊、义工筛选行、管理员工具行等实际渲染更高的场景下会偏小，
  // 导致"今日凭证与记账"卡片被固定栏部分遮挡产生错位重叠。
  // 渲染完成后用 createSelectorQuery 实测真实高度做二次校正，比手算估值更可靠。
  measureActualHeaderHeight() {
    const query = wx.createSelectorQuery();
    query.select('.fixed-top-header').boundingClientRect();
    query.exec((res) => {
      if (res && res[0] && res[0].height) {
        const measuredHeight = Math.ceil(res[0].height) + 8;
        if (Math.abs(measuredHeight - this.data.totalHeaderHeight) > 2) {
          this.setData({ totalHeaderHeight: measuredHeight });
        }
      }
    });
  },

  async loadReports() {
    this.setData({ loading: true });

    const { viewMode, currentStoreId, selectedStoreName } = this.data;
    // 🔑 数据隔离：将 storeId 传给 DataService 做云端强隔离
    // 超管全国总览/多店汇总时（'national_overview' / 'ALL_STORES' / 'all' 等哨兵值）传空，不限制门店
    // 🛡️ 越权修复：此前这里直接用 isNationalStoreId(currentStoreId) 判定"是否全国视角"，
    // 漏掉了角色校验——非超管账号只要 currentStoreId 因共享设备残留旧会话/跨页状态未同步
    // 等原因变成了哨兵值，这里就会把 effectiveStoreId 置空、并把这个未经角色校验的结果
    // 写回下方 setData 的 isAllStoresView，导致顶部"查看视角"标签越权显示成
    // "🌐 全国汇总账本"（即使实际查询已被服务端 getReports 云函数强制收敛回本店，
    // 展示层仍然是错的）。改用与 resolveIsAllStoresView() 完全同一套"哨兵值必须叠加
    // isSuperAdmin 才成立"的判定口径，杜绝这条独立分支再次绕过角色校验
    const isAllStoresView = this.resolveIsAllStoresView(currentStoreId);
    let effectiveStoreId = isAllStoresView ? '' : currentStoreId;
    // 🌟 Bug 修复：全国总览时 shopName 也设为空，避免按 '全国总览' 过滤导致无数据
    let effectiveShopName = (!isAllStoresView && selectedStoreName && selectedStoreName !== '全部门店')
      ? selectedStoreName
      : '';

    // 🛡️ 双重兜底：非超管时哪怕 currentStoreId 本身就是哨兵值（上面已强制
    // isAllStoresView=false，但 effectiveStoreId 此时会原样等于这个哨兵字符串，
    // 既不是空字符串也不是真实门店 id），强制收敛为账号真实绑定的门店，绝不把
    // 哨兵值当门店 id 传给云函数，防止前端绕过切换到全国视角
    if (!this.data.isSuperAdmin && isNationalStoreId(effectiveStoreId)) {
      const roleInfo = AuthService.getCachedRoleInfo();
      effectiveStoreId = (roleInfo && roleInfo.storeId) || '';
      effectiveShopName = '';
    }

    const result = await DataService.getReports({
      viewMode,
      storeId: effectiveStoreId,
      shopName: effectiveShopName
    });
    
    // 🛡️ 六大角色对齐：预先算好"这条记录是不是我自己提交、且还没被审核"，供列表里的
    // 编辑按钮 wx:if 直接读取——WXML 里没法即时比较 item._openid 与当前登录用户，
    // 必须在这一层跟其余展示态字段（hasDiningBreakdown 等）一样预先算好
    const myOpenid = AuthService.getOpenid();

    const formattedReports = result.data.map((item: any) => {
      const yesterdayBalance = parseFloat(item.yesterdayBalance || 0);
      const otherDonation = parseFloat(item.otherDonation || 0);
      const listDonationTotal = parseFloat(item.listDonationTotal || 0);
      const expenseAmount = parseFloat(item.expenseAmount || 0);
      const todayBalance = parseFloat(item.todayBalance || 0);
      const totalIncome = otherDonation + listDonationTotal;
      const netChange = totalIncome - expenseAmount;
      const diningCount = parseInt(item.diningCount || 0);
      const volunteerCount = parseInt(item.volunteerCount || 0);
      // 🍱 用餐/义工细分统计：只有历史记录本身带细分字段（新样式记录，或老记录被
      // 编辑弹窗补录过）才展示细分栅格卡片，否则沿用老式的"结缘/义工"两枚汇总标签
      const hasDiningBreakdown = !!(item.dineInSeniors || item.deliverySeniors || item.dineInVolunteers || item.deliveryVolunteers || item.takeawayCount);

      return {
        ...item,
        yesterdayBalanceStr: formatMoney(yesterdayBalance),
        totalIncomeStr: formatMoney(totalIncome),
        expenseAmountStr: formatMoney(expenseAmount),
        todayBalanceStr: formatMoney(todayBalance),
        todayBalanceClass: todayBalance <= 0 ? 'text-danger' : '',
        netChange: netChange,
        netChangeStr: formatMoney(Math.abs(netChange)),
        netChangeClass: netChange >= 0 ? 'text-success' : 'text-danger',
        netChangeLabel: netChange >= 0 ? '今日净增' : '今日支出',
        diningCount: diningCount,
        volunteerCount: volunteerCount,
        hasDiningBreakdown: hasDiningBreakdown,
        dineInSeniors: parseInt(item.dineInSeniors || 0),
        deliverySeniors: parseInt(item.deliverySeniors || 0),
        dineInVolunteers: parseInt(item.dineInVolunteers || 0),
        deliveryVolunteers: parseInt(item.deliveryVolunteers || 0),
        takeawayCount: parseInt(item.takeawayCount || 0),
        totalDineCount: parseInt(item.totalDineCount || diningCount || 0),
        totalVolunteers: parseInt(item.totalVolunteers || volunteerCount || 0),
        approvalStatus: item.approvalStatus || 'PENDING_APPROVAL',
        isLocked: item.isLocked || false,
        approvedBy: item.approvedBy || '',
        // 🆕 隐私脱敏模式：经办人姓名预先算好脱敏版本（复用全项目统一的
        // utils/core/privacy.ts maskName），WXML 按 privacyMaskEnabled 二选一
        // 展示，不需要在开关状态变化时重新跑一遍 loadReports
        approvedByMasked: maskName(item.approvedBy || ''),
        approveTime: item.approveTime || '',
        auditedBy: item.auditedBy || '',
        auditedByMasked: maskName(item.auditedBy || ''),
        auditTime: item.auditTime || '',
        // 🛡️ 六大角色对齐：义工/家人/财务/店长/家长/超管提交的记录，只要还没被店长
        // 核对确认（APPROVED）或财务稽核封账（AUDITED_LOCKED），提交人本人就能编辑——
        // 用于 WXML 里给"编辑"按钮单独开一个不依赖 isManagerRole/isSuperAdmin 的入口
        isOwnPendingRecord: !!myOpenid && item._openid === myOpenid
          && item.approvalStatus !== 'APPROVED' && item.approvalStatus !== 'AUDITED_LOCKED'
      };
    });

    this._reports = formattedReports;
    this.setData({
      isAllStoresView: isAllStoresView
    }, () => {
      this.convertReceiptImagesToUrls();
    });
  },

  async convertReceiptImagesToUrls() {
    const reports = this._reports;
    const allCloudIds: string[] = [];
    const idMap: Record<string, { reportIdx: number; imgIdx: number }> = {};

    reports.forEach((report: any, reportIdx: number) => {
      const images = report.receiptImages || report.receiptImageList || [];
      images.forEach((img: string, imgIdx: number) => {
        if (img && img.indexOf('cloud://') === 0) {
          if (!idMap[img]) {
            allCloudIds.push(img);
            idMap[img] = { reportIdx, imgIdx };
          }
        }
      });
    });

    if (allCloudIds.length === 0) {
      this.setData({ loading: false });
      this.applyFilters();
      this.computeTodayLedger();
      return;
    }

    try {
      const tempResult: any = await wx.cloud.getTempFileURL({
        fileList: allCloudIds
      });
      
      const urlMap: Record<string, string> = {};
      if (tempResult.fileList) {
        tempResult.fileList.forEach((f: any) => {
          if (f.tempFileURL) {
            urlMap[f.fileID] = f.tempFileURL;
          }
        });
      }

      const updatedReports = [...reports];
      updatedReports.forEach((report: any, reportIdx: number) => {
        const images = report.receiptImages || report.receiptImageList || [];
        const convertedImages = images.map((img: string) => urlMap[img] || img);
        if (report.receiptImages) report.receiptImages = convertedImages;
        if (report.receiptImageList) report.receiptImageList = convertedImages;
      });

      this._reports = updatedReports;
      this.setData({ loading: false }, () => {
        this.applyFilters();
        this.computeTodayLedger();
      });
    } catch (err) {
      console.warn('[convertReceiptImagesToUrls] 图片URL转换失败:', err);
      this.setData({ loading: false });
      this.applyFilters();
      this.computeTodayLedger();
    }
  },

  // 🧾 从已加载的账本记录中取出"今日"这一条，置顶高亮展示（当日+历史一体化，对齐食谱/大事记模块的交互模式）
  computeTodayLedger() {
    const reports = this._reports;
    const { isAllStoresView } = this.data;
    const todayStr = getTodayIsoString();

    // 全国总览视角不针对具体门店，"今日凭证"栏位无从谈起，仅展示历史列表
    if (isAllStoresView) {
      this.setData({ todayLedger: null, todayDateStr: todayStr });
      return;
    }

    const todayItem = (reports || []).find((r: any) => r.dateString === todayStr && !r.isVoid);
    this.setData({
      todayLedger: todayItem ? this.processReportListAudit([todayItem])[0] : null,
      todayDateStr: todayStr
    });

    // 今日尚未正式提交餐报时，读取本地暂存的凭证图片（拍照识别OCR/快捷补传凭证 提前存的）
    if (!todayItem) {
      this.loadStagedReceiptStash();
    } else {
      // 今日记录已存在（已通过首页提交，图片已在正式记录中），清理暂存，避免残留脏数据
      try {
        wx.removeStorageSync(this.getStashKey());
      } catch (err) {
        /* ignore */
      }
      this.setData({ stagedReceiptImages: [] });
    }
  },

  getStashKey(): string {
    const storeId = this.data.currentStoreId || this.data.selectedStoreName || 'default';
    const todayStr = this.data.todayDateStr || getTodayIsoString();
    return `pending_receipt_stash_${storeId}_${todayStr}`;
  },

  loadStagedReceiptStash() {
    try {
      const stash = wx.getStorageSync(this.getStashKey());
      this.setData({ stagedReceiptImages: (stash && Array.isArray(stash.images)) ? stash.images : [] });
    } catch (err) {
      console.warn('[loadStagedReceiptStash] 读取暂存凭证失败:', err);
    }
  },

  // 📥 今日尚未正式提交餐报：先把已上传的凭证图片暂存本地，待用户到首页提交今日餐报时自动带入
  stashReceiptImagesLocally(newUrls: string[]) {
    try {
      const key = this.getStashKey();
      const existing = wx.getStorageSync(key) || { images: [] };
      const mergedImages = [...(existing.images || []), ...newUrls];
      wx.setStorageSync(key, { images: mergedImages, updatedAt: Date.now() });
      this.setData({ stagedReceiptImages: mergedImages });
      wx.showToast({ title: `已暂存 ${newUrls.length} 张凭证，提交今日餐报时将自动带入`, icon: 'none', duration: 2500 });
    } catch (err) {
      console.error('[stashReceiptImagesLocally] 暂存失败:', err);
      wx.showToast({ title: '暂存失败，请重试', icon: 'none' });
    }
  },

  onPreviewStagedReceipt(e: any) {
    const current = e.currentTarget.dataset.url;
    // 🛡️ 防御性过滤：暂存凭证存的是本机 tempFilePath，长时间停留后有概率被系统回收失效，
    // 过滤掉空值/非字符串，避免一张失效路径卡死整个预览画廊
    const validUrls = (this.data.stagedReceiptImages || []).filter((u: any) => u && typeof u === 'string');
    if (!current || typeof current !== 'string') {
      wx.showToast({ title: '该图片已失效，请重新选择', icon: 'none' });
      return;
    }
    wx.previewImage({ current, urls: validUrls.length > 0 ? validUrls : [current] });
  },

  // 📷 拍照识别 OCR：识别今日新增小票金额，累加进今日支出并追加为凭证
  async onTodayOcrScan() {
    if (!this.canOperateVoucherPermission()) return;
    if (!this.ensureSpecificStoreForVoucher()) return;
    const item = this.data.todayLedger;
    if (item && !this.checkTodayNotLocked(item)) return;

    if (!isCloudAvailable()) {
      wx.showToast({ title: '当前环境不支持 OCR 识别，请使用快捷补传凭证', icon: 'none', duration: 2500 });
      return;
    }

    const currentCount = item ? (item.receiptImages || item.receiptImageList || []).length : this.data.stagedReceiptImages.length;
    const remainCount = 9 - currentCount;
    if (remainCount <= 0) {
      wx.showToast({ title: '今日凭证已达 9 张上限', icon: 'none' });
      return;
    }

    let chooseRes: WechatMiniprogram.ChooseMediaSuccessCallbackResult;
    try {
      chooseRes = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed']
      });
    } catch (chooseErr: any) {
      // 用户取消选择 / 拒绝相机相册权限：静默处理或给出友好提示，不抛出未捕获异常
      const errMsg = (chooseErr && chooseErr.errMsg) || '';
      if (errMsg.indexOf('cancel') === -1) {
        if (errMsg.indexOf('auth deny') > -1 || errMsg.indexOf('authorize') > -1) {
          wx.showModal({
            title: '需要相机/相册权限',
            content: '请在设置中允许小程序访问相机或相册，以便拍照识别小票',
            success: (r) => {
              if (r.confirm) wx.openSetting();
            }
          });
        } else {
          wx.showToast({ title: '未能选择图片，请重试', icon: 'none' });
        }
      }
      return;
    }

    if (!chooseRes.tempFiles || chooseRes.tempFiles.length === 0) return;

    try {
      wx.showLoading({ title: '凭证合规性核验中...', mask: true });
      const fs = wx.getFileSystemManager();

      for (const file of chooseRes.tempFiles) {
        try {
          const base64Data = fs.readFileSync(file.tempFilePath, 'base64');
          const checkRes = await callFunctionWithTimeout({
            name: 'checkImageContent',
            data: { imgBuffer: base64Data, contentType: 'image/jpeg' }
          });
          const resultData = checkRes.result as any;
          if (resultData && !resultData.isSafe) {
            wx.hideLoading();
            wx.showModal({
              title: '⚠️ 违规内容拦截',
              content: '系统检测到您选择的小票凭证图片包含不合规、敏感或非法广告内容，已被全量阻断，请重新拍摄上传真实合规小票！',
              showCancel: false,
              confirmColor: '#D32F2F'
            });
            return;
          }
        } catch (checkErr) {
          console.warn('🛡️ 图片安全预读失败，降级进入下一张校验:', checkErr);
        }
      }

      const newUrls: string[] = [];
      let recognizedTotal = 0;
      let recognizedCount = 0;

      for (let i = 0; i < chooseRes.tempFiles.length; i++) {
        wx.showLoading({ title: `AI 识别中 ${i + 1}/${chooseRes.tempFiles.length}`, mask: true });
        const tempFilePath = chooseRes.tempFiles[i].tempFilePath;
        const cloudPath = `receipts/${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`;

        let fileID = '';
        try {
          const uploadRes = await wx.cloud.uploadFile({ cloudPath, filePath: tempFilePath });
          fileID = uploadRes.fileID || '';
        } catch (uploadErr) {
          console.error('[onTodayOcrScan] 图片上传失败:', uploadErr);
          continue;
        }
        if (!fileID) continue;
        newUrls.push(fileID);

        try {
          const ocrRes = await callFunctionWithTimeout({
            name: 'ocrExpenseReceipt',
            data: { fileID }
          });
          const result = ocrRes.result as any;
          if (result && result.success && (result.amount || result.totalAmount)) {
            recognizedTotal += parseFloat(result.amount || result.totalAmount || 0);
            recognizedCount++;
          }
        } catch (ocrErr) {
          console.warn('[onTodayOcrScan] 单张识别失败，仅追加为凭证图片:', ocrErr);
        }
      }

      wx.hideLoading();

      if (newUrls.length === 0) {
        wx.showToast({ title: '上传失败，请重试', icon: 'none' });
        return;
      }

      const doAppend = (extraAmount: number, reasonSuffix: string) => {
        if (item) {
          this.appendReceiptImagesToReport(item, newUrls, extraAmount, `拍照识别OCR追加凭证${reasonSuffix}`, false);
        } else {
          // 今日尚未提交餐报：无处挂载金额，仅将图片暂存本地，识别到的金额只作为提示，不做任何自动写入
          this.stashReceiptImagesLocally(newUrls);
        }
      };

      if (recognizedCount > 0) {
        const content = item
          ? `已识别小票金额 ¥${recognizedTotal.toFixed(2)}，是否直接更新今日餐报记录？`
          : `已识别小票金额 ¥${recognizedTotal.toFixed(2)}，今日餐报尚未提交，是否先暂存凭证，待提交今日餐报时自动带入？`;
        wx.showModal({
          title: '📷 识别完成',
          content,
          confirmText: item ? '确认更新' : '暂存凭证',
          cancelText: item ? '仅存凭证' : '取消',
          success: (res) => {
            if (!res.confirm) {
              if (item) doAppend(0, '（未累加金额）');
              return;
            }
            doAppend(item ? recognizedTotal : 0, item ? `（¥${recognizedTotal.toFixed(2)}）` : '（暂存待提交）');
          }
        });
      } else {
        wx.showModal({
          title: '识别失败',
          content: '未能自动识别出小票金额，是否仅将图片' + (item ? '追加为凭证（不自动调整支出金额）？' : '暂存，稍后随今日餐报一并提交？'),
          confirmText: item ? '仅追加凭证' : '暂存凭证',
          success: (res) => {
            if (res.confirm) {
              doAppend(0, '（识别失败，仅存凭证）');
            }
          }
        });
      }
    } catch (err: any) {
      wx.hideLoading();
      const errMsg = (err && err.message) || (err && err.errMsg) || '';
      if (errMsg && errMsg.indexOf('cancel') === -1) {
        console.error('[onTodayOcrScan] 异常:', err);
        wx.showToast({ title: '识别失败，请重试', icon: 'none' });
      }
    }
  },

  // 权限校验：仅店长/财务/超管可操作今日凭证（拍照识别 OCR / 快捷补传凭证）
  canOperateVoucherPermission(): boolean {
    if (!this.data.isManagerRole && !this.data.isFinanceRole && !this.data.isSuperAdmin) {
      wx.showToast({ title: '仅店长/财务/超管可操作凭证', icon: 'none' });
      return false;
    }
    return true;
  },

  // 门店校验：处于"全部门店/全国总览"汇总视角时，凭证无处可挂载，自动拉起门店选择器引导切换到具体门店
  ensureSpecificStoreForVoucher(): boolean {
    const NATIONAL_IDS = ['national_overview', 'ALL_STORES', 'all'];
    const noSpecificStore = this.data.isAllStoresView
      || !this.data.currentStoreId
      || NATIONAL_IDS.includes(this.data.currentStoreId);

    if (!noSpecificStore) return true;

    wx.showToast({ title: '请先选择具体门店', icon: 'none' });
    this.onOpenStorePickerSheet();
    return false;
  },

  // 今日记录已存在时，若已被财务锁定则拦截（尚未提交时不涉及此项，走本地暂存）
  checkTodayNotLocked(item: any): boolean {
    if (item.isLocked || item.approvalStatus === 'AUDITED_LOCKED') {
      wx.showToast({ title: '今日账目已被财务锁定，请到历史记录中使用"补传凭证"', icon: 'none' });
      return false;
    }
    return true;
  },

  // 🔧 共用：仅追加凭证图片（可选叠加支出金额），复用 updateAndRecalculateCascade 保证审计留痕与校验码一致
  async appendReceiptImagesToReport(item: any, newUrls: string[], extraAmount: number, reason: string, isSupplementAfterLock: boolean) {
    if (this._todayActionInFlight) return;
    this._todayActionInFlight = true;

    try {
      await withLoading('保存中...', async () => {
        // 🐛 根因修复（补传凭证"丢失"）：item.receiptImages/receiptImageList 早在
        // convertReceiptImagesToUrls() 里就已被原地替换成用于展示的 https 临时链接
        // （tempFileURL 有到期时间），不再是持久化用的 cloud:// fileID。此前这里直接
        // 拿这份"展示态"数组拼成 mergedImages 整体提交，云函数又对它照单全收写库，
        // 等于把一个会过期的临时链接当成永久 fileID 存进 report_logs.receiptImageList，
        // 过期后这条记录此前所有凭证图片（不只是这次新传的）都会打不开。
        // 本函数（appendReceiptImagesToReport）语义上只做"追加"，从不删除已有图片
        // ——因此不需要客户端猜一份完整数组再整体提交：改为把新增的 fileID 单独通过
        // appendImagesOnly/newImageIds 传给云函数，由它在事务内基于服务端自己刚读到
        // 的、从未被展示态转换污染过的权威 receiptImageList 追加，保证落库的永远是
        // 可长期使用的 fileID。mergedImages 只作为"云函数暂未部署新版本"时的兼容
        // 回退值，以及本地乐观展示的初始占位
        const existingImages = item.receiptImages || item.receiptImageList || [];
        const mergedImages = [...existingImages, ...newUrls];
        const newExpense = parseFloat(item.expenseAmount || 0) + (extraAmount || 0);

        const res = await callFunctionWithTimeout({
          name: 'updateAndRecalculateCascade',
          data: {
            docId: item._id,
            shopName: item.shopName || '',
            storeId: item.storeId || '',
            reportDate: item.dateString || item.reportDate,
            yesterdayBalance: parseFloat(item.yesterdayBalance || 0),
            listDonationTotal: parseFloat(item.listDonationTotal || 0),
            otherDonation: parseFloat(item.otherDonation || 0),
            expense: newExpense,
            diningPeople: Number(item.diningPeople || item.diningCount || 0),
            volunteers: Number(item.volunteers || item.volunteerCount || 0),
            // 兼容回退：旧版云函数没有 appendImagesOnly 分支时，仍按原逻辑整体采信这份数组
            receiptImageList: mergedImages,
            receiptImages: mergedImages,
            // 新增：仅追加模式，云函数据此改为"服务端权威旧数组 + newImageIds"，忽略上面两个字段
            appendImagesOnly: true,
            newImageIds: newUrls,
            donationItems: item.donationItems || [],
            materials: item.materials || [],
            stapleRiceStatus: item.stapleRiceStatus || 'normal',
            stapleOilStatus: item.stapleOilStatus || 'sufficient',
            modifyReason: reason
          }
        });

        const result = res.result as any;

        if (result && result.success) {
          wx.showToast({ title: '凭证已保存', icon: 'success' });
          this.setData({ showReceiptDetailModal: false });

          // 🛡️ 优先采信云函数返回的 finalReceiptImages（服务端权威追加结果，
          // 从未被展示态 URL 污染）；只有对接旧版本、云函数还没返回这个字段时，
          // 才退回本地 mergedImages 这份"尽力而为"的猜测值
          const authoritativeImages: string[] = Array.isArray(result.finalReceiptImages)
            ? result.finalReceiptImages
            : mergedImages;

          // 🐛 体验闭环修复：此前无论金额是否变化都无条件 loadReports() 全量重载——
          // 该方法会先 setData({loading:true}) 把 history-list-box 整个卸载换成
          // 加载态占位，滚动位置随之丢失。补传凭证（extraAmount===0）不改变任何
          // 金额/结余链路，只需要把这一条记录的图片数组原地 patch 进已渲染的列表；
          // 只有真正改了支出金额（如 OCR 识别追加金额）才会级联影响后续日期的结余，
          // 这种情况下游数据确实变了，仍旧走全量重载保证一致性
          if (extraAmount === 0) {
            await this.patchReportImagesInPlace(item._id || item._localId, authoritativeImages);
          } else {
            this.loadReports();
          }
        } else {
          wx.showModal({
            title: isSupplementAfterLock ? '补传失败' : '保存失败',
            content: (result && result.errMsg) || '云函数未返回正确结果',
            showCancel: false
          });
        }
      });
    } catch (err) {
      console.error('[appendReceiptImagesToReport] 异常:', err);
      wx.showModal({
        title: '调用失败',
        content: '未成功保存凭证，请确认 updateAndRecalculateCascade 云函数已右键【上传并部署】',
        showCancel: false
      });
    } finally {
      this._todayActionInFlight = false;
    }
  },

  // 🆕 局部更新：把补传后的凭证图片数组原地写回 reports/filteredReports 里对应的那
  // 一条记录（按 _id/_localId 匹配），不触碰其余任何字段、不重新拉取云端数据、不
  // 经过 loading 态占位——history-scroll-list 的滚动位置因此不会被打断。
  // mergedImages 由旧的（已转换为可展示 URL 的）图片 + 新上传的 cloud:// fileID
  // 拼接而成，这里只需要把新增部分转换成可展示 URL 再拼回去
  async patchReportImagesInPlace(docId: string, mergedImages: string[]) {
    const cloudIds = mergedImages.filter((u) => u && u.indexOf('cloud://') === 0);
    let displayImages = mergedImages;

    if (cloudIds.length > 0) {
      try {
        const tempResult: any = await wx.cloud.getTempFileURL({ fileList: cloudIds });
        const urlMap: Record<string, string> = {};
        (tempResult.fileList || []).forEach((f: any) => {
          if (f.tempFileURL) urlMap[f.fileID] = f.tempFileURL;
        });
        displayImages = mergedImages.map((u) => urlMap[u] || u);
      } catch (err) {
        console.warn('[patchReportImagesInPlace] 图片URL转换失败，原样展示:', err);
      }
    }

    const patchList = (list: any[]) => list.map((r: any) => {
      if ((r._id || r._localId) !== docId) return r;
      return { ...r, receiptImages: displayImages, receiptImageList: displayImages };
    });

    this._reports = patchList(this._reports);
    const patch: Record<string, any> = {
      filteredReports: patchList(this.data.filteredReports)
    };

    if (this.data.todayLedger && (this.data.todayLedger._id || this.data.todayLedger._localId) === docId) {
      patch.todayLedger = { ...this.data.todayLedger, receiptImages: displayImages, receiptImageList: displayImages };
    }
    if (this.data.receiptDetailItem && (this.data.receiptDetailItem._id || this.data.receiptDetailItem._localId) === docId) {
      patch.receiptDetailImages = displayImages;
    }

    this.setData(patch);
  },

  // 📷 直观预览：点击卡片内 60x60 小票缩略图直接原生放大，不经过稽核详情弹窗
  onPreviewReceiptThumb(e: any) {
    const { index, current } = e.currentTarget.dataset;
    const item = this.data.filteredReports[index];
    if (!item) return;

    const urls = item.receiptImages && item.receiptImages.length > 0 ? item.receiptImages : (item.receiptImageList || []);
    // 🛡️ 防御性过滤：过滤掉空值/非字符串，避免个别异常数据卡住整个预览
    const validUrls = urls.filter((u: any) => u && typeof u === 'string');
    const finalCurrent = (current && typeof current === 'string') ? current : validUrls[0];
    if (!finalCurrent) {
      wx.showToast({ title: '该图片已失效，请重新选择', icon: 'none' });
      return;
    }
    wx.previewImage({
      current: finalCurrent,
      urls: validUrls.length > 0 ? validUrls : [finalCurrent]
    });
  },

  // 🔍 "稽核"/"查看明细"入口：打开稽核详情弹窗（放大原图 / 财务对单 / 补传凭证）
  onOpenReceiptDetail(e: any) {
    const { index } = e.currentTarget.dataset;
    const item = this.data.filteredReports[index];
    if (!item) return;

    // 🆕 轻微触感反馈：卡片点击跳转详情前的即时反馈，覆盖卡片头部/资产看板/
    // "🔍稽核"链接/"🔍查看明细"链接这几个共用本方法的入口，不需要各自重复调用；
    // try/catch 兜底——个别机型或基础库版本可能不支持振动 API，不能因此打断
    // 详情弹窗本身的展示
    try {
      wx.vibrateShort({ type: 'light' });
    } catch (err) {
      /* 静默降级：振动反馈是锦上添花，不是功能前提 */
    }

    const images = item.receiptImages || item.receiptImageList || [];
    this.setData({
      showReceiptDetailModal: true,
      receiptDetailItem: item,
      receiptDetailImages: images
    });
  },

  onCloseReceiptDetail() {
    this.setData({ showReceiptDetailModal: false, receiptDetailItem: null });
  },

  onPreviewFullReceiptFromDetail(e: any) {
    const current = e.currentTarget.dataset.url;
    // 🛡️ 防御性过滤：过滤掉空值/非字符串，避免个别异常数据卡住整个预览
    const validUrls = (this.data.receiptDetailImages || []).filter((u: any) => u && typeof u === 'string');
    if (!current || typeof current !== 'string') {
      wx.showToast({ title: '该图片已失效，请重新选择', icon: 'none' });
      return;
    }
    wx.previewImage({
      current,
      urls: validUrls.length > 0 ? validUrls : [current]
    });
  },

  // ✅ 财务对单：标记该笔账目的小票凭证已与账目金额核对一致，用于稽核留痕（不涉及金额变更）
  async onToggleFinanceReconcile() {
    const item = this.data.receiptDetailItem;
    if (!item || !item._id) return;

    if (!this.data.isFinanceRole && !this.data.isSuperAdmin) {
      wx.showToast({ title: '仅财务与超管可标记对单', icon: 'none' });
      return;
    }

    if (!isCloudAvailable()) {
      wx.showToast({ title: '云服务暂不可用，无法保存对单标记', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中...', mask: true });
    try {
      // 🛡️ 与其它审批动作一致，改为经服务端 manageReportApproval 校验角色/门店归属后再写库，
      // 不再由客户端直接 db.collection('report_logs').update()
      const approvalRes = await callFunctionWithTimeout({
        name: 'manageReportApproval',
        data: { action: 'reconcile', docId: item._id }
      });
      const approvalResult = approvalRes.result as any;
      if (!approvalResult || !approvalResult.success) {
        wx.hideLoading();
        wx.showToast({ title: (approvalResult && approvalResult.errMsg) || '保存失败，请重试', icon: 'none' });
        return;
      }

      const nextState = !!approvalResult.financeReconciled;
      wx.hideLoading();
      wx.showToast({ title: nextState ? '已标记对单' : '已取消对单标记', icon: 'success' });

      const updatedItem = { ...item, financeReconciled: nextState };
      this.setData({ receiptDetailItem: updatedItem });

      const updatedList = this.data.filteredReports.map((r: any) => r._id === item._id ? { ...r, financeReconciled: nextState } : r);
      this.setData({ filteredReports: updatedList });
    } catch (err) {
      wx.hideLoading();
      console.error('[onToggleFinanceReconcile] 异常:', err);
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
  },

  // 📤 补传凭证（稽核详情弹窗内）：即使账本已锁定也允许补充凭证图片，但绝不改动任何金额字段
  async onSupplementReceiptFromDetail() {
    const item = this.data.receiptDetailItem;
    if (!item || !item._id) return;

    const isLocked = item.isLocked || item.approvalStatus === 'AUDITED_LOCKED';
    // 已锁定的账目仅限财务/超管补传（管理员权限过审计边界），未锁定则店长也可操作
    const allowed = isLocked
      ? (this.data.isFinanceRole || this.data.isSuperAdmin)
      : (this.data.isManagerRole || this.data.isFinanceRole || this.data.isSuperAdmin);

    if (!allowed) {
      wx.showToast({ title: isLocked ? '已锁定账目仅限财务/超管补传' : '仅店长/财务/超管可补传凭证', icon: 'none' });
      return;
    }

    if (this._supplementInFlight) return;

    const currentCount = (item.receiptImages || item.receiptImageList || []).length;
    const remainCount = 9 - currentCount;
    if (remainCount <= 0) {
      wx.showToast({ title: '凭证已达 9 张上限', icon: 'none' });
      return;
    }

    let chooseRes: WechatMiniprogram.ChooseMediaSuccessCallbackResult;
    try {
      chooseRes = await wx.chooseMedia({
        count: remainCount,
        mediaType: ['image'],
        sourceType: ['album', 'camera']
      });
    } catch (chooseErr: any) {
      // 🐛 优雅退出修复：用户取消选择/拒绝相册相机权限时，wx.showLoading 根本
      // 还没被调用过——此前这里统一走到下面的 catch 分支无条件 wx.hideLoading()，
      // 在没有对应 showLoading 的情况下多喊一次 hideLoading，正是"必须配对使用"
      // 告警的来源之一，也可能误关掉此刻其他操作正在展示的遮罩。取消/拒绝都只是
      // 静默退出，不残留、也不额外触发任何 loading 相关调用
      const errMsg = (chooseErr && chooseErr.errMsg) || '';
      if (errMsg.indexOf('cancel') === -1) {
        wx.showToast({ title: '未能选择图片，请重试', icon: 'none' });
      }
      return;
    }
    if (!chooseRes.tempFiles || chooseRes.tempFiles.length === 0) return;

    this._supplementInFlight = true;
    try {
      await withLoading('上传凭证中...', async () => {
        const newUrls: string[] = [];
        for (const file of chooseRes.tempFiles) {
          const cloudPath = `receipts/${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`;
          const uploadRes = await wx.cloud.uploadFile({ cloudPath, filePath: file.tempFilePath });
          if (uploadRes.fileID) newUrls.push(uploadRes.fileID);
        }

        if (newUrls.length === 0) {
          wx.showToast({ title: '上传失败，请重试', icon: 'none' });
          return;
        }

        await this.appendReceiptImagesToReport(item, newUrls, 0, `补传凭证（稽核补充材料，不涉及金额变更）`, isLocked);
      });
    } catch (err: any) {
      console.error('[onSupplementReceiptFromDetail] 异常:', err);
      wx.showToast({ title: '补传失败，请重试', icon: 'none' });
    } finally {
      this._supplementInFlight = false;
    }
  },

  applyFilters() {
    const reports = this._reports;
    const { selectedStoreName, selectedMonthStr, anomalyFilterType, statusTab } = this.data;

    let filtered = [...reports];

    // 🌟 Bug 修复：全国总览/全部门店时不按具体门店名过滤
    if (selectedStoreName && selectedStoreName !== '全部门店' && selectedStoreName !== '全国总览') {
      filtered = filtered.filter((item: any) => item.shopName === selectedStoreName);
    }

    if (selectedMonthStr) {
      filtered = filtered.filter((item: any) => {
        const dateStr = item.dateString || item.reportDate;
        if (!dateStr) return false;
        const match = dateStr.match(/(\d{4})[\-\/年\.](\d{1,2})/);
        if (!match) return false;
        const itemMonth = `${match[1]}-${String(match[2]).padStart(2, '0')}`;
        return itemMonth === selectedMonthStr;
      });
    }

    if (anomalyFilterType) {
      filtered = filterByAnomalyType(filtered, anomalyFilterType);
    }

    // 🆕 状态 Tab 角标计数：在 statusTab 本身生效之前，基于门店/月份/风控筛选后的
    // 结果统计各状态数量，与下方 statusTab 过滤复用同一套 pending/approved/rejected
    // 判定口径（见 data.statusTab 注释——"已驳回"映射到 isVoid）
    const statusTabCounts = {
      all: filtered.length,
      pending: filtered.filter((item: any) => !item.isVoid && item.approvalStatus === 'PENDING_APPROVAL').length,
      approved: filtered.filter((item: any) => !item.isVoid && (item.approvalStatus === 'APPROVED' || item.approvalStatus === 'AUDITED_LOCKED')).length,
      rejected: filtered.filter((item: any) => !!item.isVoid).length
    };

    // 🆕 状态筛选 Tab：见 data.statusTab 注释——"已驳回"映射到 isVoid
    if (statusTab === 'pending') {
      filtered = filtered.filter((item: any) => !item.isVoid && item.approvalStatus === 'PENDING_APPROVAL');
    } else if (statusTab === 'approved') {
      filtered = filtered.filter((item: any) => !item.isVoid && (item.approvalStatus === 'APPROVED' || item.approvalStatus === 'AUDITED_LOCKED'));
    } else if (statusTab === 'rejected') {
      filtered = filtered.filter((item: any) => !!item.isVoid);
    }

    filtered.sort((a: any, b: any) => {
      const dateA = a.dateString || a.reportDate || '';
      const dateB = b.dateString || b.reportDate || '';
      return dateB.localeCompare(dateA);
    });

    // 🆕 空状态智能文案：只要门店/月份/状态 Tab/风控追溯任一筛选条件生效，
    // 空列表时就展示"重置筛选"——与账号/门店本身确实没有任何记录（重置了也
    // 无济于事）区分开，不用同一句"暂无相关记录"误导用户
    const hasActiveFilters = !!(
      (selectedStoreName && selectedStoreName !== '全部门店' && selectedStoreName !== '全国总览') ||
      selectedMonthStr ||
      anomalyFilterType ||
      statusTab !== 'all'
    );

    this.setData({ filteredReports: this.processReportListAudit(filtered), statusTabCounts, hasActiveFilters });
  },

  onMonthFilterChange(e: any) {
    const monthStr = e.detail.value;
    const parts = monthStr.split('-');
    const monthDisplay = parts.length === 2 ? `${parts[0]}年${parts[1]}月` : monthStr;
    this.setData({
      selectedMonthStr: monthStr,
      selectedMonthDisplay: monthDisplay
    }, () => {
      if (this.data.photoArchiveMode) {
        // 图册模式下月份变更：重新加载图册
        this.setData({ photoArchiveList: [], photoArchiveTotal: 0 });
        this.loadPhotoArchive();
      } else {
        this.applyFilters();
      }
    });
  },

  onClearMonthFilter() {
    this.setData({ selectedMonthStr: '', selectedMonthDisplay: '' });
    if (this.data.photoArchiveMode) {
      this.setData({ photoArchiveList: [], photoArchiveTotal: 0 });
      this.loadPhotoArchive();
    } else {
      this.applyFilters();
    }
    wx.showToast({ title: '已展示全部月份', icon: 'none' });
  },

  onClearAnomalyFilter() {
    this.setData({ anomalyFilterType: '', anomalyFilterLabel: '' });
    this.applyFilters();
    wx.showToast({ title: '已清除风控筛选', icon: 'none' });
  },

  // 🆕 空状态"重置筛选"：一次性清掉月份/状态 Tab/风控追溯这几项页面本地筛选。
  // 🛡️ 有意不重置门店选择——store-picker 反映的是全局当前门店上下文（其余页面
  // 共享同一份），"重置本页筛选"不该顺带改掉用户在别处也在用的门店选择
  onResetFilters() {
    this.setData({
      selectedMonthStr: '',
      selectedMonthDisplay: '',
      statusTab: 'all',
      statusTabIndex: 0,
      anomalyFilterType: '',
      anomalyFilterLabel: ''
    });
    this.applyFilters();
    wx.showToast({ title: '已重置筛选条件', icon: 'none' });
  },

  // 🌟「先核对、再确认、后导出」安全闭环：复用 exportAccountExcel 云函数
  // （tabType:'month'，已有完整的月度汇总/xlsx 生成/云存储上传/多租户与角色权限
  // 校验逻辑，不重新写一份）。月份优先取上方已有的月份筛选器 selectedMonthStr，
  // 未筛选时按钮字面意思——导出"本月"。点击按钮不再直接生成文件，先用
  // previewOnly 取回同一份明细供核对，确认无误后才在 performMonthlyAuditExport
  // 里发起真正的导出调用
  _pendingAuditParams: null as { shopName: string; selectedYear: string; selectedMonth: string; yearMonth: string } | null,

  async onExportMonthlyAudit() {
    if (this.data.exportingAudit) return;

    // 🔐 根因修复：月度财务审计表导出复用 exportAccountExcel 云函数（仅
    // tabType 传 'month'），与 statistics.ts exportToExcel() 是同一档
    // FEATURE_KEYS.EXCEL_EXPORT 专业版专属能力，但本页此前从未接入过这层
    // 前端权限判定——免费版租户的店长/财务可以无限制生成"审计表"，与统计页
    // 的既有拦截口径不一致，等于给同一个付费功能开了一条后门。这里补齐同款
    // 拦截：不通过时按大家长/超管可自助开通、其余角色需联系大家长两条路径
    // 分流，与 statistics.ts onOpenPlanUpgradeModal() 的既有分流逻辑一致
    const permission = await checkTenantPermission(FEATURE_KEYS.EXCEL_EXPORT);
    if (!permission.allowed) {
      const cachedRole = AuthService.getCachedRoleInfo();
      const canSelfUpgrade = this.data.isSuperAdmin || !!(cachedRole && cachedRole.role === 'store_patriarch');
      if (canSelfUpgrade) {
        // 设交接标记后跳个人中心，profile.onShow 检测到标记会自动唤起
        // 详细的套餐订购/权益对比弹窗，不再弹这个轻量拦截提示
        requestOpenSubscription();
        wx.switchTab({ url: '/pages/profile/profile' });
        return;
      }
      this.setData({ showFeatureLockedModal: true, featureLockedCanSelfUpgrade: false });
      return;
    }

    let yearMonth = this.data.selectedMonthStr;
    if (!yearMonth) {
      const now = new Date();
      yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    const [selectedYear, selectedMonth] = yearMonth.split('-');
    const shopName = this.data.selectedStoreName || '全部门店';

    this.setData({ exportingAudit: true });

    // 🐛 showLoading/hideLoading 配对修复：此前在成功分支、"该月无数据"提前 return
    // 分支、catch 分支各自手写了一次 wx.hideLoading()，任一处日后被误删或新增分支
    // 忘记补上都会导致配对告警。改用 withLoading()（见 utils/loadingGuard.ts）——
    // wx.hideLoading() 只在其内部 finally 里统一调用一次，业务分支只管 return/throw
    try {
      await withLoading('正在核对数据...', async () => {
        if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');

        const res = await callFunctionWithTimeout({
          name: 'exportAccountExcel',
          data: { shopName, tabType: 'month', selectedYear, selectedMonth, previewOnly: true }
        });
        const result = res.result as any;

        if (!result || !result.success) {
          wx.showToast({ title: (result && result.errMsg) || '该月无明细数据可导出', icon: 'none' });
          return;
        }

        this._pendingAuditParams = { shopName, selectedYear, selectedMonth, yearMonth };
        this.setData({
          showExportPreviewModal: true,
          exportPreviewSummary: result.summary || {},
          exportPreviewRecords: result.records || []
        });
      });
    } catch (err: any) {
      console.error('[onExportMonthlyAudit] 核对数据加载失败:', err);
      wx.showToast({ title: '核对数据加载失败，请重试', icon: 'none' });
    } finally {
      this.setData({ exportingAudit: false });
    }
  },

  onCloseExportPreviewModal() {
    this._pendingAuditParams = null;
    this.setData({ showExportPreviewModal: false });
  },

  // 「发现异常，前去处理」：本来就在账本页，直接关闭弹窗让用户往上滚动查看即可
  onExportPreviewGoFix() {
    this._pendingAuditParams = null;
    this.setData({ showExportPreviewModal: false });
  },

  // 「数据无误，确认并导出」：关闭预览弹窗，发起真正的 xlsx 生成
  async onExportPreviewConfirm() {
    this.setData({ showExportPreviewModal: false });
    await this.performMonthlyAuditExport();
  },

  async performMonthlyAuditExport() {
    const params = this._pendingAuditParams;
    if (!params) return;
    this._pendingAuditParams = null;

    if (this.data.exportingAudit) return;
    const { shopName, selectedYear, selectedMonth, yearMonth } = params;

    this.setData({ exportingAudit: true });

    try {
      await withLoading('正在生成审计表...', async () => {
        if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');

        const res = await callFunctionWithTimeout({
          name: 'exportAccountExcel',
          data: { shopName, tabType: 'month', selectedYear, selectedMonth }
        });
        const result = res.result as any;

        if (!result || !result.success) {
          wx.showToast({ title: (result && result.errMsg) || '该月无明细数据可导出', icon: 'none' });
          return;
        }

        this.setData({
          showAuditExportModal: true,
          auditExportPeriodLabel: (result.auditSummary && result.auditSummary.periodLabel) || yearMonth,
          auditExportText: result.auditText || '',
          auditExportFileURL: result.tempFileURL || '',
          auditExportFileName: result.fileName || `财务审计表_${yearMonth}.xlsx`
        });
      });
    } catch (err: any) {
      console.error('[performMonthlyAuditExport] 导出失败:', err);
      wx.showToast({ title: '导出失败，请重试', icon: 'none' });
    } finally {
      this.setData({ exportingAudit: false });
    }
  },

  onCloseAuditExportModal() {
    this.setData({ showAuditExportModal: false });
  },

  onCloseFeatureLockedModal() {
    this.setData({ showFeatureLockedModal: false });
  },

  onCopyAuditText() {
    const { auditExportText } = this.data;
    if (!auditExportText) return;
    wx.setClipboardData({
      data: auditExportText,
      success: () => {
        wx.showToast({ title: '审计文本已复制', icon: 'success' });
      },
      fail: () => {
        wx.showToast({ title: '复制失败', icon: 'none' });
      }
    });
  },

  // 保存/下载报表：下载云存储 xlsx 到本地临时路径后，优先用 shareFileMessage 转发给文件
  // （用户可在聊天列表选择"文件传输助手"保存到手机），不可用时退回 openDocument 直接打开，
  // 与 statistics.ts downloadAndOpenExcel 同一套降级顺序，保持全项目"导出表格"体验一致
  onDownloadAuditExcel() {
    const { auditExportFileURL, auditExportFileName } = this.data;
    if (!auditExportFileURL) {
      wx.showToast({ title: '文件链接为空', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在下载表格...', mask: true });
    wx.downloadFile({
      url: auditExportFileURL,
      success: (downloadRes) => {
        wx.hideLoading();
        const filePath = downloadRes.tempFilePath;

        if ((wx as any).shareFileMessage) {
          (wx as any).shareFileMessage({
            filePath,
            fileName: auditExportFileName,
            success: () => {
              wx.showToast({ title: '表格已导出成功', icon: 'success' });
            },
            fail: (shareErr) => {
              if (!shareErr.errMsg || !shareErr.errMsg.includes('cancel')) {
                this.tryOpenAuditDocumentFallback(filePath);
              }
            }
          });
        } else {
          this.tryOpenAuditDocumentFallback(filePath);
        }
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '下载失败，请重试', icon: 'none' });
      }
    });
  },

  tryOpenAuditDocumentFallback(filePath: string) {
    wx.openDocument({
      filePath,
      fileType: 'xlsx',
      showMenu: true,
      fail: () => {
        wx.showModal({
          title: '已生成表格文件',
          content: '请重新点击"保存/下载报表"，并在弹出的微信列表中选择【文件传输助手】即可保存到手机！',
          showCancel: false
        });
      }
    });
  },

  copyReport(e: any) {
    const index = e.currentTarget.dataset.index;
    const report = this.data.filteredReports[index];
    
    if (!report) {
      wx.showToast({ title: '数据异常', icon: 'none' });
      return;
    }

    const reportText = DataService.buildReportText(report);

    wx.setClipboardData({
      data: reportText,
      success: () => {
        wx.showToast({ title: '复制成功，可直接发群', icon: 'success' });
      },
      fail: () => {
        wx.showToast({ title: '复制失败', icon: 'error' });
      }
    });
  },

  onShareReportToWeChat(e: any) {
    const { id, date } = e.currentTarget.dataset;

    if (!id) {
      wx.showToast({ title: '数据异常', icon: 'none' });
      return;
    }

    const report = this._reports.find((r: any) => (r._id || r._localId) === id);

    if (!report) {
      const filteredReport = this.data.filteredReports.find((r: any) => (r._id || r._localId) === id);
      if (filteredReport) {
        this._shareRecord = filteredReport;
      } else {
        wx.showToast({ title: '未找到记录', icon: 'none' });
        return;
      }
    } else {
      this._shareRecord = report;
    }

    const reportText = DataService.buildReportText(this._shareRecord);
    wx.setClipboardData({
      data: reportText,
      success: () => {
        wx.hideToast();
      },
      fail: (err) => {
        console.error('[Share] 复制文本失败:', err);
      }
    });
  },

  onShareAppMessage(options?: any) {
    const record = this._shareRecord;

    if (!record) {
      console.warn('[Share] 未找到分享记录，返回默认分享');
      return {
        title: '雨花斋餐报助手',
        path: '/pages/index/index'
      };
    }

    const date = record.dateString || record.reportDate || '';
    const store = record.shopName || '雨花斋';
    const balance = parseFloat(record.todayBalance || 0).toFixed(2);

    return {
      title: `${store}·${date}餐报`,
      path: '/pages/index/index',
      imageUrl: '',
      success: (res: any) => {
        wx.showToast({ title: '分享成功', icon: 'success' });
      },
      fail: (err: any) => {
        console.warn('[Share] 分享取消/失败:', err);
      }
    };
  },

  onShareTimeline() {
    const record = this._shareRecord;

    if (!record) {
      return {
        title: '雨花斋餐报助手',
        query: '',
        imageUrl: ''
      };
    }

    const date = record.dateString || record.reportDate || '';
    const store = record.shopName || '雨花斋';
    const income = parseFloat(record.totalIncomeStr || record.listDonationTotal || 0).toFixed(2);
    const balance = parseFloat(record.todayBalance || 0).toFixed(2);

    return {
      title: `${store}·${date} 服务收入¥${income} 结余¥${balance}`,
      query: '',
      imageUrl: ''
    };
  },

  onEditReport(e: any) {
    const { index } = e.currentTarget.dataset;
    const report = this.data.filteredReports[index];

    if (!report) {
      wx.showToast({ title: '数据异常', icon: 'none' });
      return;
    }

    // 🛡️ 六大角色对齐：义工/家人/财务/店长/家长/超管都可能是这条记录的提交人本人——
    // 只要记录还处于 PENDING（未经任何人核对确认），提交人就有权自行修正后重新提交，
    // 不必等店长/超管出面。用 report.approvalStatus !== 'APPROVED'/'AUDITED_LOCKED'
    // 判断"还没进入审核流"，而不是正向匹配字符串 'PENDING'——列表展示层（见上面
    // formattedReports 的映射）会把缺失的 approvalStatus 兜底显示成 'PENDING_APPROVAL'
    // 这个展示态标签，正向匹配 'PENDING' 会漏判老记录
    const myOpenid = AuthService.getOpenid();
    const isOwnRecord = !!myOpenid && report._openid === myOpenid;
    const isStillPending = report.approvalStatus !== 'APPROVED' && report.approvalStatus !== 'AUDITED_LOCKED';
    const isOwnPendingEdit = isOwnRecord && isStillPending;

    if (!this.data.isManagerOrAdmin && !this.data.isSuperAdmin && !isOwnPendingEdit) {
      wx.showToast({ title: '仅店长与超管拥有编辑权限', icon: 'none' });
      return;
    }

    // 🛡️ 职责分离延伸到编辑动作：只要这条记录是"我自己"提交的，一旦店长完成核对确认
    // （APPROVED）就必须锁死，不能等到财务稽核封账（AUDITED_LOCKED）才拦——否则
    // 提交人可以在店长确认之后、财务稽核之前，悄悄改动已经被"确认过"的金额，让店长的
    // 确认名不副实。这条限制不因为"我恰好也是店长/超管"而豁免——职责分离保护的是
    // "对自己提交的记录"这件事本身，不是角色。店长/超管编辑他人（非本人提交）的记录
    // 不受此限制，仍按原逻辑只在 AUDITED_LOCKED 时拦（这是他们履行审核/纠错职责的
    // 正常范围，与自我审批无关）
    if (isOwnRecord && report.approvalStatus === 'APPROVED') {
      wx.showModal({
        title: '记录已核对确认',
        content: '该记录已由店长完成核对确认，提交人不能再自行修改，如有问题请联系店长/家长处理。',
        showCancel: false
      });
      return;
    }

    if (report.isLocked || report.approvalStatus === 'AUDITED_LOCKED') {
      wx.showModal({
        title: '记录已锁定',
        content: '该记录已被财务稽核锁定，如需修改请联系财务人员申请解封。',
        showCancel: false
      });
      return;
    }

    const yesterdayBalance = parseFloat(report.yesterdayBalance || 0);
    const otherDonation = parseFloat(report.otherDonation || 0);
    const expenseAmount = parseFloat(report.expenseAmountStr || report.dailyExpenseTotal || report.expense || report.todayExpense || 0);

    // 🌟 对齐首页录入项：爱心支持明细以可编辑文本形式还原（doc 中仅存结构化 donationItems，需反向拼装为文本）
    const donationsText = formatDonationItemsToText(report.donationItems || []);
    const donationsTotal = parseDonorText(donationsText).totalAmount;
    const calculatedTodayBalance = (yesterdayBalance + donationsTotal + otherDonation - expenseAmount).toFixed(2);

    const editingRecord = {
      ...JSON.parse(JSON.stringify(report)),
      yesterdayBalance: yesterdayBalance.toString(),
      donationsText,
      donationsTotalStr: formatMoney(donationsTotal),
      otherDonation: otherDonation.toString(),
      expenseAmount: expenseAmount.toString(),
      calculatedTodayBalance,
      diningPeople: (report.diningPeople || report.diningCount || '0').toString(),
      volunteers: (report.volunteers || report.volunteerCount || '0').toString(),
      dineInSeniors: report.dineInSeniors != null ? String(report.dineInSeniors) : '',
      deliverySeniors: report.deliverySeniors != null ? String(report.deliverySeniors) : '',
      dineInVolunteers: report.dineInVolunteers != null ? String(report.dineInVolunteers) : '',
      deliveryVolunteers: report.deliveryVolunteers != null ? String(report.deliveryVolunteers) : '',
      takeawayCount: report.takeawayCount != null ? String(report.takeawayCount) : '',
      materialsInput: formatMaterialsToText(report.materials || []),
      stapleRiceStatus: report.stapleRiceStatus || 'normal',
      stapleOilStatus: report.stapleOilStatus || 'sufficient',
      receiptImageList: report.receiptImageList || report.receiptImages || [],
      deletedImageIds: [],
      modifyReason: ''
    };
    this.recalcEditDiningStats(editingRecord);

    const imgCount = (editingRecord.receiptImageList || []).length;
    this.setData({
      showEditModal: true,
      editingRecord,
      receiptImgCount: imgCount
    });
  },

  onCancelEdit() {
    this.setData({
      showEditModal: false,
      editingRecord: null
    });
  },

  stopPropagation() {},

  onEditInput(e: any) {
    const field = e.currentTarget.dataset.field;
    const val = e.detail.value;

    const editingRecord = { ...this.data.editingRecord };
    editingRecord[field] = val;

    const recalced = this.recalcEditBalance(editingRecord);
    this.recalcEditDiningStats(recalced);
    this.setData({ editingRecord: recalced });
  },

  // 🌟 爱心支持明细（对齐首页 allDonations 录入项）：自由文本实时解析为清单 + 合计
  onEditDonationsInput(e: any) {
    const val = e.detail.value;
    const editingRecord = { ...this.data.editingRecord };
    editingRecord.donationsText = val;

    const parsed = parseDonorText(val);
    editingRecord.donationsTotalStr = formatMoney(parsed.totalAmount);

    this.setData({ editingRecord: this.recalcEditBalance(editingRecord) });
  },

  // 🌟 物资赞助明细（对齐首页 materialsInput 录入项）
  onEditMaterialsInput(e: any) {
    const val = e.detail.value;
    const editingRecord = { ...this.data.editingRecord };
    editingRecord.materialsInput = val;
    this.setData({ editingRecord });
  },

  // 🌟 主食物资储备状态（对齐首页 stapleRiceStatus / stapleOilStatus 录入项）
  onEditStapleStatusChange(e: any) {
    const { type, value } = e.currentTarget.dataset;
    const editingRecord = { ...this.data.editingRecord };
    if (type === 'rice') {
      editingRecord.stapleRiceStatus = value;
    } else if (type === 'oil') {
      editingRecord.stapleOilStatus = value;
    }
    this.setData({ editingRecord });
  },

  // 今日结余 = 昨日余额 + 爱心支持明细合计 + 现场赞助/其他支持 - 今日支出
  recalcEditBalance(editingRecord: any) {
    const yest = parseFloat(editingRecord.yesterdayBalance || '0') || 0;
    const donationsTotal = parseDonorText(editingRecord.donationsText || '').totalAmount;
    const other = parseFloat(editingRecord.otherDonation || '0') || 0;
    const exp = parseFloat(editingRecord.expenseAmount || '0') || 0;
    editingRecord.calculatedTodayBalance = (yest + donationsTotal + other - exp).toFixed(2);
    return editingRecord;
  },

  // 🍱 编辑弹窗内的用餐/义工细分统计实时计算：只有本次真的填了细分字段才用细分
  // 重算出 diningPeople/volunteers（用餐总数/志愿者总人次的可编辑镜像字段）；
  // 老记录未曾补录细分统计时，沿用原有汇总值，不因为没碰细分区域就被清零
  recalcEditDiningStats(editingRecord: any) {
    const nDineInSeniors = parseFloat(editingRecord.dineInSeniors) || 0;
    const nDeliverySeniors = parseFloat(editingRecord.deliverySeniors) || 0;
    const nDineInVolunteers = parseFloat(editingRecord.dineInVolunteers) || 0;
    const nDeliveryVolunteers = parseFloat(editingRecord.deliveryVolunteers) || 0;
    const nTakeaway = parseFloat(editingRecord.takeawayCount) || 0;
    const hasBreakdown = !!(editingRecord.dineInSeniors || editingRecord.deliverySeniors || editingRecord.dineInVolunteers || editingRecord.deliveryVolunteers || editingRecord.takeawayCount);

    if (hasBreakdown) {
      const totalDineCount = nDineInSeniors + nDeliverySeniors + nTakeaway + nDineInVolunteers;
      const totalVolunteers = nDeliveryVolunteers + nDineInVolunteers;
      editingRecord.totalDineCount = String(totalDineCount);
      editingRecord.totalVolunteers = String(totalVolunteers);
      editingRecord.diningPeople = String(totalDineCount);
      editingRecord.volunteers = String(totalVolunteers);
    } else {
      editingRecord.totalDineCount = editingRecord.diningPeople || '0';
      editingRecord.totalVolunteers = editingRecord.volunteers || '0';
    }
    return editingRecord;
  },

  onPreviewEditImage(e: any) {
    const current = e.currentTarget.dataset.src;
    // 🛡️ 防御性过滤：过滤掉空值/非字符串，避免个别异常数据卡住整个预览
    const validUrls = (this.data.editingRecord.receiptImageList || []).filter((u: any) => u && typeof u === 'string');
    if (!current || typeof current !== 'string') {
      wx.showToast({ title: '该图片已失效，请重新选择', icon: 'none' });
      return;
    }
    wx.previewImage({ current, urls: validUrls.length > 0 ? validUrls : [current] });
  },

  onRemoveEditImage(e: any) {
    const index = e.currentTarget.dataset.index;
    const editingRecord = { ...this.data.editingRecord };
    const imageList = [...(editingRecord.receiptImageList || [])];
    const deletedImageIds = [...(editingRecord.deletedImageIds || [])];

    const removedUrl = imageList.splice(index, 1)[0];
    if (removedUrl && removedUrl.startsWith('cloud://')) {
      deletedImageIds.push(removedUrl);
    }

    editingRecord.receiptImageList = imageList;
    editingRecord.deletedImageIds = deletedImageIds;
    this.setData({
      editingRecord,
      receiptImgCount: imageList.length
    });

    wx.showToast({ title: '已移除凭证', icon: 'none' });
  },

  async onChooseNewEditImage() {
    try {
      const currentCount = (this.data.editingRecord.receiptImageList || []).length;
      const remainCount = 9 - currentCount;
      if (remainCount <= 0) {
        wx.showToast({ title: '最多上传 9 张小票凭证', icon: 'none' });
        return;
      }

      const res = await wx.chooseMedia({
        count: remainCount,
        mediaType: ['image'],
        sourceType: ['album', 'camera']
      });

      if (!res.tempFiles || res.tempFiles.length === 0) return;

      wx.showLoading({ title: '凭证合规性核验中...', mask: true });

      const fs = wx.getFileSystemManager();

      for (const file of res.tempFiles) {
        try {
          const base64Data = fs.readFileSync(file.tempFilePath, 'base64');
          const checkRes = await callFunctionWithTimeout({
            name: 'checkImageContent',
            data: { imgBuffer: base64Data, contentType: 'image/jpeg' }
          });
          const resultData = checkRes.result as any;

          if (resultData && !resultData.isSafe) {
            wx.hideLoading();
            wx.showModal({
              title: '⚠️ 违规内容拦截',
              content: '系统检测到您选择的记账小票或凭证图片包含不合规、敏感或非法广告内容，已被全量阻断，请重新拍摄上传真实合规小票！',
              showCancel: false,
              confirmColor: '#D32F2F'
            });
            return;
          }
        } catch (checkErr) {
          console.warn('🛡️ 图片安全预读失败，降级进入下一张校验:', checkErr);
        }
      }

      wx.showLoading({ title: '上传凭证中...', mask: true });

      const newUrls: string[] = [];
      for (const file of res.tempFiles) {
        const cloudPath = `receipts/${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`;
        const uploadRes = await wx.cloud.uploadFile({
          cloudPath,
          filePath: file.tempFilePath
        });
        if (uploadRes.fileID) {
          newUrls.push(uploadRes.fileID);
        }
      }

      wx.hideLoading();

      const editingRecord = { ...this.data.editingRecord };
      editingRecord.receiptImageList = [...(editingRecord.receiptImageList || []), ...newUrls];
      const newCount = editingRecord.receiptImageList.length;
      this.setData({
        editingRecord,
        receiptImgCount: newCount
      });

    } catch (err) {
      wx.hideLoading();
      console.error('上传凭证失败:', err);
    }
  },

  async onConfirmEditHistory() {
    const editForm = this.data.editingRecord;

    if (!editForm || !editForm._id) {
      wx.showToast({ title: '未找到编辑记录 ID', icon: 'none' });
      return;
    }

    if (!editForm.modifyReason || !String(editForm.modifyReason).trim()) {
      wx.showToast({ title: '请填写修改说明后再保存', icon: 'none' });
      return;
    }

    const yesterdayBalance = parseFloat(editForm.yesterdayBalance || 0);
    const donationParseResult = parseDonorText(editForm.donationsText || '');
    const listDonationTotal = donationParseResult.totalAmount;
    const otherDonation = parseFloat(editForm.otherDonation || 0);
    const expense = parseFloat(editForm.expenseAmount || 0);
    const materials = parseMaterials(editForm.materialsInput || '');

    wx.showLoading({ title: '正在保存并级联重算...', mask: true });

    try {
      if (editForm.deletedImageIds && editForm.deletedImageIds.length > 0) {
        try {
          await wx.cloud.deleteFile({ fileList: editForm.deletedImageIds });
        } catch (delErr) {
          console.warn('清理旧图文件警告:', delErr);
        }
      }

      const res = await callFunctionWithTimeout({
        name: 'updateAndRecalculateCascade',
        data: {
          docId: editForm._id,
          shopName: editForm.shopName || '',
          storeId: editForm.storeId || '',
          reportDate: editForm.dateString || editForm.reportDate,
          yesterdayBalance: yesterdayBalance,
          listDonationTotal: listDonationTotal,
          otherDonation: otherDonation,
          expense: expense,
          diningPeople: Number(editForm.diningPeople || 0),
          volunteers: Number(editForm.volunteers || 0),
          dineInSeniors: editForm.dineInSeniors,
          deliverySeniors: editForm.deliverySeniors,
          dineInVolunteers: editForm.dineInVolunteers,
          deliveryVolunteers: editForm.deliveryVolunteers,
          takeawayCount: editForm.takeawayCount,
          receiptImageList: editForm.receiptImageList || [],
          receiptImages: editForm.receiptImageList || [],
          donationItems: donationParseResult.items,
          materials: materials,
          stapleRiceStatus: editForm.stapleRiceStatus || 'normal',
          stapleOilStatus: editForm.stapleOilStatus || 'sufficient',
          modifyReason: editForm.modifyReason || ''
        }
      });

      wx.hideLoading();

      const r1 = res.result as any;
      if (r1 && r1.success) {
        this.setData({
          showEditModal: false,
          editingRecord: null
        });

        wx.showToast({
          title: `已成功校正 ${r1.updatedCount || 1} 天账目`,
          icon: 'success',
          duration: 2000
        });

        this.loadReports();
      } else {
        wx.showModal({
          title: '重算失败',
          content: r1 ? r1.errMsg : '云函数未返回正确结果',
          showCancel: false
        });
      }

    } catch (err) {
      wx.hideLoading();
      console.error('❌ [History] 调用 updateAndRecalculateCascade 异常:', err);
      wx.showModal({
        title: '调用失败',
        content: '未成功触发重算，请确认 updateAndRecalculateCascade 云函数已右键【上传并部署】',
        showCancel: false
      });
    }
  },

  // 🌟 删除该条记录：解决重复录入同一日期餐报时无法清理多余记录的问题
  // 二次弹窗确认防误删；删除成功后云函数会自动触发级联重算，保持资金流水连贯
  onDeleteEditRecord() {
    const editForm = this.data.editingRecord;

    if (!editForm || !editForm._id) {
      wx.showToast({ title: '未找到记录 ID，无法删除', icon: 'none' });
      return;
    }

    const dateLabel = editForm.dateString || editForm.reportDate || '该条';
    const shopLabel = editForm.shopName || '';

    wx.showModal({
      title: `⚠️ 确认删除【${shopLabel}】${dateLabel} 记录？`,
      editable: true,
      placeholderText: '请填写删除原因（如：重复录入、录入有误），删除后不可恢复',
      confirmText: '确认删除',
      confirmColor: '#D32F2F',
      cancelText: '我再想想',
      success: async (res) => {
        if (!res.confirm) return;

        const deleteReason = String(res.content || '').trim();
        if (!deleteReason) {
          wx.showToast({ title: '请填写删除原因后再确认', icon: 'none' });
          return;
        }

        if (this._deleteInFlight) return;
        this._deleteInFlight = true;

        wx.showLoading({ title: '正在删除并重算...', mask: true });

        try {
          const delRes = await callFunctionWithTimeout({
            name: 'deleteMealReport',
            data: { id: editForm._id, reason: deleteReason }
          });
          const result = delRes.result as any;

          wx.hideLoading();

          if (result && result.success) {
            this.setData({
              showEditModal: false,
              editingRecord: null
            });

            wx.showToast({
              title: result.cascadeUpdatedCount > 0
                ? `已删除，联动校正了 ${result.cascadeUpdatedCount} 天账目`
                : '记录已删除',
              icon: 'success',
              duration: 2000
            });

            this.loadReports();
          } else {
            wx.showModal({
              title: '删除失败',
              content: (result && result.error) || '云函数未返回正确结果',
              showCancel: false
            });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('❌ [History] 调用 deleteMealReport 异常:', err);
          wx.showModal({
            title: '调用失败',
            content: '未成功触发删除，请确认 deleteMealReport 云函数已右键【上传并部署】',
            showCancel: false
          });
        } finally {
          this._deleteInFlight = false;
        }
      }
    });
  },

  async onSaveHistoryRecordDirect(e: any) {
    const { item } = e.currentTarget.dataset;
    if (!item || !item._id) {
      wx.showToast({ title: '未找到编辑记录 ID', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在级联更新...', mask: true });

    try {
      const res = await callFunctionWithTimeout({
        name: 'cascadeRecalculator',
        data: {
          action: 'update_and_recalculate',
          docId: item._id,
          shopName: item.shopName || this.data.selectedStoreName,
          dateString: item.dateString || item.reportDate,
          updateData: {
            yesterdayBalance: parseFloat(item.yesterdayBalance) || 0,
            listDonationTotal: parseFloat(item.listDonationTotal || item.income || item.loveIncome) || 0,
            otherDonation: parseFloat(item.otherDonation) || 0,
            dailyExpenseTotal: parseFloat(item.dailyExpenseTotal || item.expense || item.todayExpense) || 0,
            fixedExpenseTotal: parseFloat(item.fixedExpenseTotal) || 0
          }
        }
      });

      wx.hideLoading();

      const r2 = res.result as any;
      if (r2 && r2.success) {
        const alerts = r2.integrityAlerts || [];
        if (alerts.length > 0) {
          wx.showModal({
            title: '🚨 检测到资金流水异常',
            content: `发现 ${alerts.length} 条记录的校验码与存储数据不一致，疑似被直接改库篡改，相关记录已自动锁定，请联系超级管理员核查：\n${alerts.map((a: any) => a.dateString).join('、')}`,
            showCancel: false,
            confirmText: '知道了'
          });
        }

        wx.showToast({
          title: `已成功校正 ${r2.updatedCount || 1} 天数据`,
          icon: 'success',
          duration: 2000
        });

        this.loadReports();
      } else {
        wx.showModal({
          title: '云函数返回错误',
          content: r2 ? r2.errMsg : '未知错误',
          showCancel: false
        });
      }

    } catch (err) {
      wx.hideLoading();
      console.error('❌ 调用 cascadeRecalculator 失败:', err);
      wx.showModal({
        title: '调用失败',
        content: '未成功触发重算云函数，请确认 cascadeRecalculator 云函数已右键【上传并部署】',
        showCancel: false
      });
    }
  },

  onVoidReportModal(e: any) {
    const { id, date } = e.currentTarget.dataset;

    // 🛡️ 权限防线：即使入口按钮被非法暴露，函数内部也拦截非店长/超管的作废请求
    if (!this.data.isManagerRole && !this.data.isSuperAdmin) {
      wx.showToast({ title: '仅店长与超管可执行作废操作', icon: 'none' });
      return;
    }

    const item = this.data.filteredReports.find((r: any) => (r._id || r._localId) === id);
    if (item && item.isVoid) {
      wx.showToast({ title: '该记录已作废，无需重复操作', icon: 'none' });
      return;
    }
    if (item && item.approvalStatus === 'AUDITED_LOCKED') {
      wx.showToast({ title: '该账本已封账锁定，无法作废', icon: 'none' });
      return;
    }

    // 🌟 状态机联动：待店长确认的单据尚未计入正式流水链，作废视为"驳回录入"，不触发冲销重算；
    // 已通过店长审核（APPROVED）的单据已参与流水链计算，作废需级联重算后续日期的昨日余额/今日结余，
    // 否则被排除的这笔记录会让此后每一天的开账余额与实际不符
    const isApprovedStage = !!(item && item.approvalStatus === 'APPROVED');

    wx.showModal({
      title: isApprovedStage ? '⚠️ 已审核账单作废确认' : '驳回/作废此笔录入？',
      content: isApprovedStage
        ? `【${date}】的餐报已通过店长审核，作废将生成红字冲销记录并重新核算后续日期的结余流水，是否继续？`
        : `确定要驳回/作废【${date}】这笔尚未审核确认的录入吗？作废后不会生成冲销流水，仅将该单据标记为已作废。`,
      confirmText: '确认作废',
      confirmColor: '#D32F2F',
      success: async (res) => {
        if (!res.confirm) return;
        if (this._voidInFlight) return;
        this._voidInFlight = true;

        wx.showLoading({ title: isApprovedStage ? '安全冲销中...' : '作废处理中...' });

        try {
          // 🛡️ 状态机与权限判定统一收敛到 manageReportApproval 云函数：此前这里直接
          // 用 wx.cloud.database().doc(id).update({isVoid:true}) 写库，服务端对该动作
          // 完全没有角色/门店/机构/锁定状态的校验，等于把"能否作废"这道关卡完全交给
          // 客户端 JS 判断（可被绕过）。现在改为调用云函数，由服务端重新核验一遍。
          if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
          const approvalRes = await callFunctionWithTimeout({
            name: 'manageReportApproval',
            data: { action: 'void', docId: id }
          });
          const approvalResult = approvalRes.result as any;
          if (!approvalResult || !approvalResult.success) {
            wx.hideLoading();
            wx.showToast({ title: (approvalResult && approvalResult.errMsg) || '作废失败', icon: 'none' });
            this._voidInFlight = false;
            return;
          }

          if (approvalResult.pending) {
            // 🏛️ 家长风控锁：本店已绑定家长/督导，作废未直接生效，已转为待确认状态
            wx.hideLoading();
            wx.showModal({ title: '已提交审批', content: approvalResult.message || '已提交家长/超管审批，确认后生效', showCancel: false });
          } else if (approvalResult.cascadeWarning) {
            wx.hideLoading();
            wx.showModal({ title: '提示', content: approvalResult.cascadeWarning, showCancel: false });
          } else {
            wx.hideLoading();
            wx.showToast({ title: isApprovedStage ? '已成功执行红字冲销' : '已作废该笔录入', icon: 'success' });
          }

          this.loadReports();
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: '冲销提交失败', icon: 'none' });
        } finally {
          this._voidInFlight = false;
        }
      }
    });
  },

  cleanImagePath(img: string): string {
    if (!img) return '';
    
    if (img.startsWith('cloud://') || img.startsWith('http://') || img.startsWith('https://')) {
      return img;
    }
    
    if (img.startsWith('wxfile://') || img.startsWith('tmp_') || img.indexOf('/tmp/') > -1) {
      return img;
    }
    
    if (img.startsWith('/')) {
      return img;
    }
    
    return `/pages/history/${img}`;
  },

  processReportListAudit(list: any[]) {
    return list.map((item: any, index: number) => {
      // 🐛 修复首条记录 Header 渲染缺失：wx:key 原绑定 _id，但当日刚提交、网络暂未同步的
      // 本地草稿记录只有 _localId、没有 _id（排序最新常常正好排在第一位）。
      // wx:key 拿到 undefined 会导致微信列表 diff 算法错乱，表现为首张卡片 header 区域渲染缺失。
      // 统一兜底为稳定且非空的 rowKey，彻底避免 key 缺失/重复。
      item.rowKey = item._id || item._localId || `${item.dateString || 'na'}_${item.shopName || 'na'}_${index}`;

      if (item.receiptImages && Array.isArray(item.receiptImages)) {
        item.receiptImages = item.receiptImages.map((img: string) => this.cleanImagePath(img));
      }
      
      if (item.receiptImageList && Array.isArray(item.receiptImageList)) {
        item.receiptImageList = item.receiptImageList.map((img: string) => this.cleanImagePath(img));
      }

      // 资金平账公式校验：昨日余额 + 服务收入(捐赠清单+其他捐赠) - 今日支出 == 今日结余
      // 🐛 修复：旧逻辑读取的 item.totalIncome / item.todayIn 字段在原始账本文档中并不存在，
      // 导致服务收入恒为 0，几乎所有有收入的记录都被误判为"资金不平"。改为读取真实落库字段。
      const yesterdayBalance = parseFloat(item.yesterdayBalance || '0') || 0;
      const totalIncome = (parseFloat(item.otherDonation || '0') || 0) + (parseFloat(item.listDonationTotal || '0') || 0);
      const expenseAmount = parseFloat(item.expenseAmount || '0') || 0;
      const actualBalance = parseFloat(item.todayBalance || item.calculatedTodayBalance || '0') || 0;

      const expectedBalance = Math.round((yesterdayBalance + totalIncome - expenseAmount) * 100) / 100;
      const roundedActual = Math.round(actualBalance * 100) / 100;
      const diffAmount = Math.round((roundedActual - expectedBalance) * 100) / 100;

      // 浮点误差容忍 1 分钱，避免四舍五入导致的假性不平
      const isMismatch = Math.abs(diffAmount) >= 0.01;

      return {
        ...item,
        isAmountMismatch: isMismatch,
        mismatchExpectedBalance: expectedBalance.toFixed(2),
        mismatchActualBalance: roundedActual.toFixed(2),
        mismatchDiffAmount: diffAmount.toFixed(2)
      };
    });
  },

  // 🌟 点击"资金不平"标签：弹出诊断 Modal，展示理论结余/实际结余/差额与排查建议
  onShowMismatchDiagnosis(e: any) {
    const { index } = e.currentTarget.dataset;
    const item = this.data.filteredReports[index];

    if (!item) {
      wx.showToast({ title: '数据异常', icon: 'none' });
      return;
    }

    const diff = parseFloat(item.mismatchDiffAmount || '0');
    const diffDesc = diff > 0
      ? `实际填报结余比理论值多 ¥${Math.abs(diff).toFixed(2)}，可能存在支出漏记、支出金额录入偏小，或收入被重复计入。`
      : `实际填报结余比理论值少 ¥${Math.abs(diff).toFixed(2)}，可能存在收入漏记、收入金额录入偏小，或支出被重复计入。`;

    wx.showModal({
      title: '⚠️ 资金不平诊断',
      content:
        `【${item.dateString || ''}】${item.shopName || '未命名门店'}\n\n` +
        `理论结余（昨日余额+服务收入-今日支出）：¥${item.mismatchExpectedBalance}\n` +
        `实际填报结余：¥${item.mismatchActualBalance}\n` +
        `差额：${diff >= 0 ? '+' : ''}¥${item.mismatchDiffAmount}\n\n` +
        `排查建议：\n${diffDesc}\n建议核对当日捐赠明细、支出小票凭证是否录入完整；确认无误后，可联系店长/财务使用"一键校准全线结余流水"功能重新链式核算。`,
      showCancel: false,
      confirmText: '知道了'
    });
  },

  async triggerCascadeRecalculation(report: any) {
    try {
      const shopName = report.shopName || this.data.selectedStoreName || '';
      const storeId = report.storeId || '';
      const modifiedDate = report.dateString || '';

      if ((!shopName && !storeId) || !modifiedDate) {
        return;
      }

      wx.showLoading({ title: '正在级联校正后续账目...', mask: true });

      const res = await callFunctionWithTimeout({
        name: 'cascadeRecalculator',
        data: {
          action: 'recalculate_after_delete',
          storeId,
          shopName,
          dateString: modifiedDate
        }
      });

      wx.hideLoading();

      const result = res.result as any;
      const alerts = result && result.integrityAlerts ? result.integrityAlerts : [];
      if (alerts.length > 0) {
        wx.showModal({
          title: '🚨 检测到资金流水异常',
          content: `发现 ${alerts.length} 条记录的校验码与存储数据不一致，疑似被直接改库篡改，相关记录已自动锁定，请联系超级管理员核查：\n${alerts.map((a: any) => a.dateString).join('、')}`,
          showCancel: false,
          confirmText: '知道了',
          success: () => {
            this.loadReports();
          }
        });
      } else if (result && result.success && result.updatedCount && result.updatedCount > 0) {
        wx.showModal({
          title: '级联校正完成',
          content: `已为您自动重算并更新了后续 ${result.updatedCount} 天的账目余额！`,
          showCancel: false,
          confirmText: '我知道了',
          success: () => {
            this.loadReports();
          }
        });
      } else {
        this.loadReports();
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[triggerCascadeRecalculation] 级联重算失败:', err);
      this.loadReports();
    }
  },

  onReportRecord(e: any) {
    const { id, date } = e.currentTarget.dataset;

    if (!id) {
      wx.showToast({ title: '参数传递失效', icon: 'none' });
      return;
    }

    wx.showActionSheet({
      itemList: ['涉嫌违法', '虚假广告', '侵权'],
      itemColor: '#323233',
      success: (res) => {
        const reportTypes = ['涉嫌违法', '虚假广告', '侵权'];
        const selectedType = reportTypes[res.tapIndex];
        
        wx.showModal({
          title: '举报成功',
          content: `已收到您关于 ${date} 的举报（类型：${selectedType}），我们将在24小时内核实处理。`,
          showCancel: false,
          confirmText: '知道了'
        });
      },
      fail: () => {
      }
    });
  },

  onClearDirtyData() {
    wx.showModal({
      title: '【高危操作】',
      content: '确定要清理空记录吗？此操作将删除所有收入/支出/结余均为0的记录，且不可逆！',
      confirmText: '确认清空',
      confirmColor: '#e53935',
      cancelText: '取消',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '正在清理...', mask: true });
        try {
          const result = await DataService.clearDirtyReports();
          wx.hideLoading();

          if (result.success) {
            wx.showToast({
              title: result.message,
              icon: 'success',
              duration: 2000
            });
            this._reports = [];
            this.setData({ filteredReports: [] });
            this.loadReports();
          } else {
            wx.showModal({
              title: '清理失败',
              content: `服务端返回错误：${result.message || '未知错误'}`,
              showCancel: false,
              confirmText: '知道了'
            });
          }
        } catch (err: any) {
          wx.hideLoading();
          const errorDetail = JSON.stringify(err, null, 2);
          console.error('[onClearDirtyData] 清理异常:', err);
          wx.showModal({
            title: '清理失败（详细错误）',
            content: `错误码: ${err.errCode || 'N/A'}\n错误信息: ${err.errMsg || err.message || '未知错误'}\n\n完整详情:\n${errorDetail.substring(0, 500)}`,
            showCancel: false,
            confirmText: '知道了'
          });
        }
      }
    });
  },

  // 店长线上审批确认
  // 店长确认操作
  async onManagerAuditClick(e: any) {
    const docId = e.currentTarget.dataset.id;
    const item = this.data.filteredReports.find((r: any) => r._id === docId);

    if (!docId) {
      wx.showToast({ title: '参数异常', icon: 'none' });
      return;
    }

    // 🛡️ 权限防线：状态胶囊等入口未受角色 wx:if 限制，函数内部需再次校验身份，
    // 避免普通义工点击后误触发店长核对确认，也防止其重复点击造成的并发提交
    if (!this.data.isManagerRole && !this.data.isSuperAdmin) {
      wx.showToast({ title: '仅店长与超管可执行核对确认', icon: 'none' });
      return;
    }

    if (this._managerAuditInFlight) return;

    if (item && item.approvalStatus === 'APPROVED') {
      wx.showToast({ title: '店长已完成该餐报的核对确认', icon: 'none' });
      return;
    }

    if (item && item.approvalStatus === 'AUDITED_LOCKED') {
      wx.showToast({ title: '该账本已封账，无法操作', icon: 'none' });
      return;
    }

    // 🌟 无凭证审核防错拦截：未上传小票凭证时，先提醒店长，避免"无票也能过审"被无意间放行
    const hasReceipt = !!(item && (
      (item.receiptImages && item.receiptImages.length > 0) ||
      (item.receiptImageList && item.receiptImageList.length > 0)
    ));

    if (!hasReceipt) {
      wx.showModal({
        title: '⚠️ 无凭证提醒',
        content: '该笔记录未上传小票凭证，确认要直接审核通过吗？',
        confirmText: '依然通过',
        cancelText: '去补传凭证',
        success: (res) => {
          if (res.confirm) {
            this.proceedManagerAuditConfirm(docId, item);
          } else {
            this.onOpenReceiptDetail(e);
          }
        }
      });
      return;
    }

    this.proceedManagerAuditConfirm(docId, item);
  },

  // 店长核对确认的实际提交逻辑：从 onManagerAuditClick 中抽出，
  // 供"正常有凭证"与"无凭证但依然通过"两条路径共用
  proceedManagerAuditConfirm(docId: string, item: any) {
    wx.showModal({
      title: '👑 店长核对确认',
      content: `确认【${(item && item.dateString) || '该餐报'}】的菜品供应与记账小票核对无误，并提交财务做最终稽核吗？`,
      confirmText: '确认提交',
      confirmColor: '#E65100',
      success: async (res) => {
        if (!res.confirm) return;
        if (this._managerAuditInFlight) return;
        this._managerAuditInFlight = true;

        wx.showLoading({ title: '提交中...' });
        try {
          // 🛡️ 店长核对确认此前是客户端直接 db.collection('report_logs').doc(docId)
          // .update()，服务端对"是否真的是店长/是否本店"没有任何校验。现在改为调用
          // manageReportApproval 云函数，由服务端重新核验角色、门店归属与当前状态。
          if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
          const approvalRes = await callFunctionWithTimeout({
            name: 'manageReportApproval',
            data: { action: 'confirm', docId }
          });
          const approvalResult = approvalRes.result as any;
          if (!approvalResult || !approvalResult.success) {
            wx.hideLoading();
            wx.showToast({ title: (approvalResult && approvalResult.errMsg) || '审批失败，请重试', icon: 'none' });
            return;
          }

          const nowStr = new Date().toLocaleString();
          const updatedList = this.data.filteredReports.map((r: any) => {
            if (r._id === docId) {
              return {
                ...r,
                isManagerConfirmed: true,
                approvalStatus: 'APPROVED',
                approveTime: nowStr
              };
            }
            return r;
          });

          this.setData({
            filteredReports: this.processReportListAudit(updatedList)
          });

          wx.hideLoading();
          wx.showToast({ title: '✅ 已提交财务审核', icon: 'success' });
        } catch (err: any) {
          wx.hideLoading();
          console.error('店长确认失败:', err);
          wx.showToast({ title: '审批失败，请重试', icon: 'none' });
        } finally {
          this._managerAuditInFlight = false;
        }
      }
    });
  },

  // 财务稽核与锁定操作
  async onFinanceAuditClick(e: any) {
    const docId = e.currentTarget.dataset.id;
    const item = this.data.filteredReports.find((r: any) => r._id === docId);

    if (!docId) {
      wx.showToast({ title: '参数异常', icon: 'none' });
      return;
    }

    // 🛡️ 权限防线：状态胶囊等入口未受角色 wx:if 限制，函数内部需再次校验身份，
    // 避免普通义工/店长点击后误触发财务稽核封账
    if (!this.data.isFinanceRole && !this.data.isSuperAdmin) {
      wx.showToast({ title: '仅财务与超管可执行稽核封账', icon: 'none' });
      return;
    }

    if (this._financeAuditInFlight) return;

    if (item && item.approvalStatus !== 'APPROVED') {
      wx.showToast({ title: '请先等待店长完成首轮确认', icon: 'none' });
      return;
    }

    if (item && item.approvalStatus === 'AUDITED_LOCKED') {
      wx.showToast({ title: '该账本已由财务完成稽核锁定，无法篡改', icon: 'none' });
      return;
    }

    let warningMsg = '';
    if (item && item.isAmountMismatch) {
      warningMsg = '⚠️ 警告：该餐报资金试算不平！\n\n';
    }

    wx.showModal({
      title: '🔒 确认稽核并封账？',
      content: warningMsg + `您正在对【${(item && item.dateString) || '该餐报'}】的餐报进行终审。封账后，该记录将永久归档，任何人（包括店长与财务）将无法再修改其中数据。`,
      confirmText: '确认封账',
      confirmColor: '#2E7D32',
      success: async (res) => {
        if (!res.confirm) return;
        if (this._financeAuditInFlight) return;
        this._financeAuditInFlight = true;

        wx.showLoading({ title: '安全封账中...' });
        try {
          // 🛡️ 财务稽核封账此前是客户端直接 db.collection('report_logs').doc(docId)
          // .update()，服务端对"是否真的是财务/是否本店"没有任何校验——这是整套
          // RBAC 体系里最敏感的一步（封账后声称"任何人都无法再修改"），必须服务端把关。
          if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
          const approvalRes = await callFunctionWithTimeout({
            name: 'manageReportApproval',
            data: { action: 'financeAudit', docId }
          });
          const approvalResult = approvalRes.result as any;
          if (!approvalResult || !approvalResult.success) {
            wx.hideLoading();
            wx.showToast({ title: (approvalResult && approvalResult.errMsg) || '锁定失败，请重试', icon: 'none' });
            return;
          }

          const nowStr = new Date().toLocaleString();
          const updatedList = this.data.filteredReports.map((r: any) => {
            if (r._id === docId) {
              return {
                ...r,
                isFinanceAudited: true,
                isLocked: true,
                approvalStatus: 'AUDITED_LOCKED',
                auditTime: nowStr
              };
            }
            return r;
          });

          this.setData({
            filteredReports: this.processReportListAudit(updatedList)
          });

          wx.hideLoading();
          wx.showToast({ title: '🛡️ 账本已安全锁定', icon: 'success' });
        } catch (err: any) {
          wx.hideLoading();
          console.error('稽核锁定失败:', err);
          wx.showToast({ title: '锁定失败，请重试', icon: 'none' });
        } finally {
          this._financeAuditInFlight = false;
        }
      }
    });
  },

  // 财务解锁已锁定记录
  // 🛡️ 此前本函数没有任何角色判断（连客户端 UI 层的 isFinanceRole/isSuperAdmin 检查都没有），
  // 且直接 db.collection('report_logs').doc(docId).update() 写库——服务端完全没有校验
  // "谁能解封"，理论上任何登录用户都能就地解封任意一条已封账记录。补上客户端判断的同时，
  // 真正的把关全部收敛到 manageReportApproval 云函数（unlock action 仅 finance/super_admin）。
  onUnlockRecord(e: any) {
    if (!this.data.isFinanceRole && !this.data.isSuperAdmin) {
      wx.showToast({ title: '仅财务与超管可执行解封', icon: 'none' });
      return;
    }

    const docId = e.currentTarget.dataset.id;
    if (!docId) {
      wx.showToast({ title: '参数异常', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '解封历史账目',
      content: '请输入申请解封或修改的原因（存证备查）：',
      editable: true,
      placeholderText: '例如：补录遗漏的小票发票',
      success: async (res) => {
        if (!res.confirm) return;
        if (!res.content || res.content.trim().length === 0) {
          wx.showToast({ title: '请填写解封原因', icon: 'none' });
          return;
        }

        wx.showLoading({ title: '解封中...' });
        try {
          if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
          const approvalRes = await callFunctionWithTimeout({
            name: 'manageReportApproval',
            data: { action: 'unlock', docId, reason: res.content.trim() }
          });
          const approvalResult = approvalRes.result as any;
          if (!approvalResult || !approvalResult.success) {
            wx.hideLoading();
            wx.showToast({ title: (approvalResult && approvalResult.errMsg) || '解封失败，请重试', icon: 'none' });
            return;
          }

          wx.hideLoading();
          wx.showToast({ title: '已解封，可重新编辑', icon: 'success' });
          this.loadReports();
        } catch (err: any) {
          wx.hideLoading();
          console.error('解封失败:', err);
          wx.showToast({ title: '解封失败，请重试', icon: 'none' });
        }
      }
    });
  },

  // 🛡️ 全局返回逻辑排查统一：与其余二级页面对齐为同一套直接判断 pages.length 的
  // 写法，不再依赖 navGuard.isDeepLinkEntry() 这个在 onLoad/onShow 时刻缓存、
  // 点击时可能已经不是最新状态的标记
  goBack() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({
        delta: 1,
        fail: () => {
          this.isNavigating = false;
        }
      });
    } else {
      wx.switchTab({ url: '/pages/index/index' });
      this.isNavigating = false;
    }
  },

  previewReceipt(e: any) {
    const images = e.currentTarget.dataset.images;
    const index = e.currentTarget.dataset.index;

    if (!images || !Array.isArray(images) || images.length === 0) {
      wx.showToast({ title: '图片数据异常', icon: 'none' });
      return;
    }

    // 🛡️ 防御性过滤：过滤掉空值/非字符串，避免个别异常数据卡住整个预览；
    // current 优先取用户实际点的那张，它被过滤掉了才退回第一张有效图
    const rawCurrent = images[index];
    const validUrls = images.filter((u: any) => u && typeof u === 'string');
    const current = (rawCurrent && typeof rawCurrent === 'string') ? rawCurrent : validUrls[0];
    if (!current) {
      wx.showToast({ title: '图片数据异常', icon: 'none' });
      return;
    }

    wx.previewImage({
      current,
      urls: validUrls
    });
  },

  // ─── 图册模式 ────────────────────────────────────────────────────────────────

  // 切换"账本 ⟺ 图册"模式；图册首次进入时自动加载
  onTogglePhotoArchive() {
    const next = !this.data.photoArchiveMode;
    const newTitle = next ? this.computePhotoArchiveTitle() : '🧾 凭证与账本';
    this.setData({ photoArchiveMode: next, pageTitle: newTitle }, () => {
      if (next && this.data.photoArchiveList.length === 0) {
        this.loadPhotoArchive();
      }
    });
  },

  // 派生图册页标题：与 index.ts computePhotoArchiveTitle() 同一套口径，仅
  // emoji 按机构类型区分（雨花斋 🏡 / 其余机构 🌸），文案本身统一精简为
  // "温情图册 · 阳光凭证"。
  // 🐛 根因修复（标题截断）：旧文案"🏡 雨花温情图册与阳光凭证"长达 11 个汉字+
  // emoji，配合 .page-title-txt 此前 max-width:420rpx 的硬编码上限，在窄屏
  // 机型上非常接近甚至触发省略号截断。精简后的文案 + 上面 navCapsuleSafePx
  // 的真实胶囊边距双重保障，任何机型下都能单行完整展示。
  // 🐛 orgType 为空时不再用 `|| !this.data.orgType` 兜底当作"雨花斋"，与
  // profile.ts 修过的"严禁在非雨花斋机构展示雨花斋品牌"同一类问题——orgType
  // 尚未解析出来的窗口期应展示中性文案，不能提前假定是雨花斋
  computePhotoArchiveTitle(): string {
    const isYuhuazhai = this.data.orgType === 'yuhuazhai';
    return isYuhuazhai ? '🏡 温情图册 · 阳光凭证' : '🌸 温情图册 · 阳光凭证';
  },

  // 切换照片类型过滤标签；重新从云端加载
  onPhotoTypeTabChange(e: any) {
    const filter = e.currentTarget.dataset.type as string;
    this.setData({ photoTypeFilter: filter, photoArchiveList: [], photoArchiveTotal: 0 }, () => {
      this.loadPhotoArchive();
    });
  },

  // 🆕 统计行右侧的"近 3 个月 ▾"下拉胶囊：用原生 ActionSheet 承载 4 个快捷
  // 选项，不额外搭一套自定义下拉浮层（避免引入新的 z-index/点击外部收起
  // 等边界情况，ActionSheet 本身就是"从几个选项里选一个"场景最贴合的原生控件）
  onTogglePhotoArchiveRangeMenu() {
    if (this.data.photoArchiveLoading) return;
    wx.showActionSheet({
      itemList: PHOTO_ARCHIVE_RANGE_ORDER.map((key) => PHOTO_ARCHIVE_RANGE_LABELS[key]),
      success: (res) => {
        const key = PHOTO_ARCHIVE_RANGE_ORDER[res.tapIndex];
        if (!key || key === this.data.photoArchiveRangeKey) return;
        this.setData({ photoArchiveRangeKey: key, photoArchiveList: [], photoArchiveTotal: 0 }, () => {
          this.loadPhotoArchive();
        });
      },
      fail: () => { /* 用户取消选择，不需要任何提示 */ }
    });
  },

  async loadPhotoArchive() {
    if (!isCloudAvailable()) {
      wx.showToast({ title: '云服务暂不可用', icon: 'none' });
      return;
    }
    this.setData({ photoArchiveLoading: true });

    const { currentStoreId, photoTypeFilter, photoArchiveRangeKey } = this.data;
    const isAllStores = this.resolveIsAllStoresView(currentStoreId);
    const queryStoreId = isAllStores ? '' : (currentStoreId || '');

    try {
      const res = await callFunctionWithTimeout({
        name: 'getPhotoArchive',
        data: {
          storeId: queryStoreId,
          photoType: photoTypeFilter || 'all',
          // 🐛 根因修复：此前传的是账本模式的 selectedMonthStr——图册模式下
          // 月份 picker 整块隐藏，用户压根没有入口设置它，但如果用户是"先在
          // 账本模式选了某个月，再切到图册模式"，这个残留值会静默把图册过滤
          // 到那个月，而右上角的范围文案却还显示"近 3 个月"，两者对不上。
          // 图册改用自己独立的 photoArchiveRangeKey（见 onTogglePhotoArchiveRangeMenu），
          // 与账本的月份筛选彻底解耦
          range: photoArchiveRangeKey || '3m',
          limit: 60
        }
      });
      const result = res.result as any;
      if (result && result.success) {
        this.setData({
          photoArchiveList: result.photos || [],
          photoArchiveTotal: result.total || 0
        });
      } else {
        wx.showToast({ title: '加载图册失败', icon: 'none' });
      }
    } catch (err: any) {
      console.error('[loadPhotoArchive] 异常:', err);
      wx.showToast({ title: '加载图册失败', icon: 'none' });
    } finally {
      this.setData({ photoArchiveLoading: false });
    }
  },

  // 预览单张照片（支持当前集合内左右滑动）
  onPreviewPhotoItem(e: any) {
    const index = e.currentTarget.dataset.index as number;
    const list = this.data.photoArchiveList;
    if (!list || list.length === 0) return;
    const urls = list.map(p => p.url).filter(u => u && typeof u === 'string');
    const current = urls[index] || urls[0];
    if (!current) return;
    wx.previewImage({ current, urls });
  },

  // 🆕 长按照片：打开详情弹窗（拍摄/上报日期、分类、所属门店 + 查看大图 /
  // 报销凭证类型额外提供"查看当月账本"入口）
  onLongPressPhotoItem(e: any) {
    const index = e.currentTarget.dataset.index as number;
    const item = this.data.photoArchiveList[index];
    if (!item) return;
    this.setData({
      showPhotoDetailModal: true,
      photoDetailItem: { ...item, typeLabel: PHOTO_TYPE_LABELS[item.type] || item.type }
    });
  },

  onClosePhotoDetailModal() {
    this.setData({ showPhotoDetailModal: false });
  },

  onPreviewPhotoDetailImage() {
    const item = this.data.photoDetailItem;
    if (!item || !item.url) return;
    wx.previewImage({ current: item.url, urls: [item.url] });
  },

  // 🆕 报销凭证类型专属：退出图册模式、切到账本模式，并按该凭证所在月份筛选，
  // 让用户直接看到这笔支出对应的完整账本记录（reports 已在 onLoad 里无条件
  // 加载过，见 loadReports() 调用处，不需要在这里另外发起云函数请求）
  onGoToLedgerFromPhotoDetail() {
    const item = this.data.photoDetailItem;
    if (!item || !item.date) return;
    const match = /^(\d{4})-(\d{2})/.exec(item.date);
    const monthStr = match ? `${match[1]}-${match[2]}` : '';
    const monthDisplay = match ? `${match[1]}年${match[2]}月` : '';

    this.setData({
      showPhotoDetailModal: false,
      photoArchiveMode: false,
      pageTitle: '🧾 凭证与账本',
      selectedMonthStr: monthStr,
      selectedMonthDisplay: monthDisplay
    }, () => {
      this.applyFilters();
    });
  },

  // ─────────────────────────────────────────────────────────────────────────────

  goToHome() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({
        fail: () => {
          this.isNavigating = false;
        }
      });
    } else {
      wx.reLaunch({
        url: '/pages/index/index',
        fail: () => {
          this.isNavigating = false;
        }
      });
    }
  }
});
