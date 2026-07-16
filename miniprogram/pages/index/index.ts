import { DataService, formatMoney } from '../../utils/dataService';
import { AuthService, ROLE_LABELS, getPermissionFlags, PermissionFlags } from '../../utils/authService';
import { parseDonorText } from '../../utils/parser';
import { generateReportText } from '../../utils/reportGenerator';
import { drawMeritPoster } from '../../utils/posterGenerator';
import { drawStoreInvitationPoster } from '../../utils/drawStorePoster';
import { saveToQueue, getQueue, removeFromQueue, getQueueCount } from '../../utils/offlineQueue';
import { STORE_PRESETS, STORE_PICKER_LIST, CUSTOM_STORE_LABEL, findStorePreset } from '../../utils/constants';
import { getSafeSystemInfo } from '../../utils/util';
import { getPrevDayIsoString, formatDateToCnShort, isValidIsoDate, getTodayIsoString } from '../../utils/dateUtils';
import { getSelectedStore, setSelectedStore } from '../../utils/storeManager';
import { validateReportGuardrails, GuardrailResult, recordSuccessfulSubmit, recordWarningConfirmed, canSubmitNow, cleanExpiredFrequencyRecords } from '../../utils/validateReportGuardrails';

const PRESET_NOTICES = {
  opening: {
    tag: '喜讯通报',
    title: '喜讯通报：三源弘雨花敬老家园试营业',
    content: '喜讯通报：三源弘雨花敬老家园，14号正式开启试营业。秉承恭敬生命、敬老行善，为长者提供健康公益素食午餐。欢迎长辈们前来用餐，也欢迎爱心家人抽空回家做义工，一起践行孝道，传递善意❤️。感恩大家支持！'
  },
  volunteer: {
    tag: '义工招募',
    title: '爱心义工招募',
    content: '【爱心义工招募】雨花斋的运转离不开义工家人的倾情护持！现急需择菜、洗碗、行堂义工数名，服务时间：每天上午 8:30 - 12:30。期待您的回家护持，共修福慧！❤️'
  },
  supplies: {
    tag: '物资呼吁',
    title: '爱心物资接力',
    content: '【爱心物资接力】感恩各位善士大众的护持！当前小店大米/食用油储备临界，特向社会呼吁爱心物资接力。每一粒米、每一滴油都是满满的慈悲。恭敬感恩您的倾心付出！🙏'
  },
  weather_closure: {
    tag: '暂停营业',
    title: '恶劣天气暂停开餐告示',
    content: '【暂停开餐通知】受恶劣天气影响，为保障各位长者及义工家人的出行安全，本斋将于明日暂停开餐一天。请大家互相转告，切勿空跑。待天气好转后恢复正常开餐。恭敬感恩大家的理解与支持！❤️'
  },
  renovation_closure: {
    tag: '暂停营业',
    title: '内部整修/例行消杀停业通知',
    content: '【例行维护通知】为给长者们提供更加干净、卫生的用餐环境，本斋将于近期进行全店深度清洁消杀与设备整修，期间暂停开餐一天。恢复供餐后欢迎长辈们回家用餐。感恩大家的体谅与护持！🙏'
  },
  festival: {
    tag: '日常温馨提醒',
    title: '节日特别结缘活动通知',
    content: '【节日欢聚通知】值此佳节到来之际，本斋将于明天中午举办节日特别供餐活动，并为到店用餐的长者准备了一份心意。欢迎长辈们互相转告、欢喜回家用餐！祝大家吉祥安康！🏮'
  },
  thanks: {
    tag: '感恩致谢',
    title: '专项爱心致谢',
    content: '【感恩致谢】特别感谢爱心企业/善士对本斋的慷慨支持，您的善举让更多长者感受到了社会的温暖。恭敬感恩您的无私奉献，愿善有善报，福慧双增！🙏❤️'
  }
};

const debounce = <T extends (...args: any[]) => any>(fn: T, delay: number): T => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: any[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  }) as T;
};

const DRAFT_KEY = 'REPORT_FORM_DRAFT';
const SETTINGS_KEY = 'SHOP_SETTINGS';

function getDraftKeyForDate(dateStr: string, shopName: string): string {
  const cleanShop = (shopName || 'default').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
  return `DRAFT_${cleanShop}_${dateStr}`;
}

function deriveDateString(reportDateValue: string, reportDate: string): string {
  if (reportDateValue && /^\d{4}-\d{2}-\d{2}$/.test(reportDateValue)) {
    return reportDateValue;
  }
  const m = reportDate.match(/(\d{2,4})年(\d{2})月(\d{2})日/);
  if (m) {
    let year = m[1];
    if (year.length === 2) year = '20' + year;
    return `${year}-${m[2]}-${m[3]}`;
  }
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function toStandardIsoDate(dateStr: string): string {
  if (!dateStr) return '';
  let str = String(dateStr).trim();
  if (/^\d{2}年/.test(str)) str = '20' + str;
  const match = str.match(/(\d{4})[\-\/年\.](\d{1,2})[\-\/月\.](\d{1,2})/);
  if (match) {
    return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  }
  return str;
}

Page({
  isSubmitting: false,
  debouncedSaveDraft: null as any,
  _shopNameTimer: null as any,
  _balanceReqSeq: 0,
  isNavigating: false,
  // 任务C：待执行的锚点滚动目标（onLoad 解析后暂存，onShow 中触发滚动）
  _pendingScrollTarget: '' as string,
  _highlightTimer: null as any,

  data: {
    reportDate: '',
    reportDateValue: '',
    prevBalance: '0.00',
    yesterdayBalance: '0.00',
    isBalanceLocked: true,
    isTodaySelected: true,
    isYesterdaySelected: false,
    balanceFocus: false,
    isEditMode: false,
    balanceMatchTip: '',
    parsedTotalIncome: 0,
    totalExpense: 0,
    computedTodayBalance: '0.00',
    inputMode: 'text',
    yesterdayBalDisplay: '0.00',
    totalIncomeDisplay: '0.00',
    totalExpenseDisplay: '0.00',
    previewTodayBalanceDisplay: '0.00',
    singleName: '',
    singleAmount: '',
    allDonations: '',
    otherDonation: '',
    expenses: '',
    dailyExpenseText: '',
    fixedExpenseText: '',
    reportResult: '',
    showResult: false,
    isResultExpanded: false,
    showSettings: false,
    shopName: '海沧区雨花斋',
    mpAccount: '厦门海沧雨花斋！',
    thankText: '感谢各位爱心人士的鼎力支持，感恩默默付出的义工团队！',
    slogan1: '吃素一日  健康一天',
    slogan2: '清晰记账  透明运行',
    donationPlaceholder: '可以直接把所有支持名单一次性全部贴在这里。例如：\n黄玉珍 16\n周瑞德 2\n吴建平 3\n邢善积德 2\n',
    headerSafeTop: 85,
    modalSafeTop: 0,
    isSubmitting: false,
    hasDraft: false,
    parseResult: {
      items: [],
      unrecognizedLines: [],
      totalAmount: 0,
      totalCount: 0
    },
    totalParsedAmount: '0.00',
    calculationFormulaText: '',
    receiptImages: [] as string[],
    // 物资赞助数据结构
    materials: [] as { donor: string; item: string; quantity: string; unit: string }[],
    materialsInput: '', // 自由文本输入（如："张三：大米50斤；李四：食用油2箱"）
    // 义工时间统计
    volunteerCount: '', // 今日到岗义工人数
    volunteerHours: '', // 今日义工总工时
    // 用餐人次
    diningCount: '', // 今日用餐人次
    // 主食物资储备状态
    stapleRiceStatus: 'normal', // 大米/面粉: sufficient/normal/urgent
    stapleOilStatus: 'sufficient', // 食用油: sufficient/normal/urgent
    systemBalance: 0,
    isManualAdjust: false,
    balanceDiff: 0,
    adjustReason: '',
    isGeneratingPoster: false,
    showPoster: false,
    posterImage: '',
    showPosterModal: false,
    qrCodeUrl: 'https://7a65-zeng-yuhua-cloud-123.tcb.qcloud.la/assets/yuhua_sun_code.png',
    todayInAmount: '0.00',
    todayOutAmount: '0.00',
    todayTotalBalance: '0.00',
    lastBalance: '0.00',
    donorCount: 0,
    riceStatus: '充足',
    oilStatus: '充足',
    offlineQueueCount: 0,
    // 任务C：锚点聚焦 - 控制打卡卡片的高亮动画
    highlightCheckInCard: false,
    // 档案弹窗
    showArchiveModal: false,
    archiveUserInfo: {
      totalDays: 0,
      totalCheckInCount: 0,
      totalHours: 0
    },
    showAgreement: false,
    canvasHeight: 667,
    showAdjustModal: false,
    adjustInput: '',
    adjustModalInfo: {
      systemBalance: '0.00',
      adjustedBalance: '0.00',
      balanceDiff: '0.00',
      balanceDiffSign: '-'
    },
    showOcrConfirmModal: false,
    ocrReceiptList: [],
    ocrSuccessCount: 0,
    ocrFailCount: 0,
    ocrTotalAmount: '0.00',
    showHistoryBalanceModal: false,
    historyBalanceList: [] as { date: string; store: string; balance: string }[],
    showBalanceHistoryModal: false,
    recentBalanceHistoryList: [] as any[],
    storePickerList: STORE_PICKER_LIST,
    selectedStoreIndex: 0,
    isCustomStore: false,
    announcement: null as {
      id: string;
      tag: string;
      title: string;
      content: string;
      is_top: boolean;
      create_time: string;
    } | null,
    showAnnouncementModal: false,
    showNoticeEditModal: false,
    noticeEditTag: '喜讯通报',
    noticeEditTitle: '',
    noticeEditContent: '',
    mergeToReportText: false,
    noticeHidden: false,
    showApplyModal: false,
    applyForm: {
      storeId: '',
      storeName: '',
      realName: '',
      phone: '',
      requestedRole: 'volunteer'
    } as any,
    showAuditModal: false,
    auditActiveTab: 'pending' as 'pending' | 'approved',
    pendingApplyList: [] as any[],
    approvedVolunteerList: [] as any[],
    currentUserRole: '' as string,
    permissions: {} as PermissionFlags,
    isVolunteer: false,
    isManager: false,
    isFinance: false,
    isSuperAdmin: false,
    currentRole: 'VOLUNTEER' as 'VOLUNTEER' | 'MANAGER' | 'FINANCE',
    pendingAuditCount: 0,
    roleLabelMap: ROLE_LABELS,
    currentStoreName: '' as string,
    currentStoreId: '' as string,
    allStoresList: [] as any[],
    showStorePosterModal: false,
    storePosterTempFilePath: '',
    currentSponsorInfo: null as any,
    isReadOnlyByLock: false,
    lockOwnerName: '',
    lockRemainingSec: 0,
    lockRemainingFormatted: '',
    _heartbeatTimer: null as any,
    _lockPollingTimer: null as any,
    _lockActiveKey: '',
    _heartbeatRetryCount: 0,
    showShiftSelectModal: false,
    selectedShift: 'LUNCH',
    selectedShiftHours: 3.0,
    customHoursInput: '4.0',
    willEatLunch: true,
    checkInLogs: [] as any[],
    todayAccumulatedHours: 0,
    allShiftsCompleted: false,
    todayLogs: [] as any[],
    myCheckInDays: 0,
    myCheckInCount: 0,
    myServiceHours: 0,
    shiftDefinitions: [
      { shiftKey: 'EARLY_MORNING', name: '🌌 凌晨熬粥与备菜班', hours: 4.0, timeDesc: '04:00 - 08:00 · 蒸饭煲汤' },
      { shiftKey: 'MORNING', name: '🥗 早间准备与洗切班', hours: 2.5, timeDesc: '08:00 - 10:30 · 洗菜配菜' },
      { shiftKey: 'LUNCH', name: '🍲 午餐打饭与引导班', hours: 3.0, timeDesc: '10:30 - 13:30 · 堂食引导' },
      { shiftKey: 'CLEAN', name: '🧹 后厨洗碗与收尾班', hours: 1.5, timeDesc: '13:30 - 15:00 · 消毒整理' },
      { shiftKey: 'NIGHT', name: '🌙 夜间整理与盘点班', hours: 3.0, timeDesc: '18:00 - 21:00 · 物资盘点' }
    ] as any[],
    availableShifts: [] as any[],
    showGenCodeModal: false,
    genTargetRole: 'MANAGER',
    generatedCode: '',
    targetGenStoreId: '',
    targetGenStoreName: '',
    showDevClearModal: false,
    clearConfirmInput: '',
    clearOptions: {
      reports: true,
      requests: true,
      cache: true
    }
  },

  _adjustResolve: null as (() => void) | null,

  async onLoad(options: any) {
    this.debouncedSaveDraft = debounce(() => this.saveDraft(), 500);

    // 任务C：解析锚点聚焦参数
    // 支持 action=checkInCard 或 targetElement=checkInCard 两种参数名
    if (options) {
      const action = options.action || '';
      const target = options.targetElement || '';
      if (action === 'checkInCard' || target === 'checkInCard') {
        this._pendingScrollTarget = 'checkInCard';
      }
    }

    // 扫码进入时捕获 scene 参数 (支持格式: s=store_haicang)
    if (options && options.scene) {
      const sceneStr = decodeURIComponent(options.scene);
      let storeId = '';

      try {
        const params = new URLSearchParams(sceneStr);
        storeId = params.get('s') || '';
      } catch (e) {
        storeId = sceneStr.replace('s=', '');
      }

      if (storeId) {
        this.fetchStoreInfoAndPromptApply(storeId);
      }
    }

    const loginRes = await AuthService.ensureLogin();
    if (loginRes.isTemp) {
      console.warn('[Index] 使用临时 openid，数据将暂存本地');
    }

    try {
      const rect = wx.getMenuButtonBoundingClientRect();
      const capsuleBottom = rect.bottom;
      this.setData({
        headerSafeTop: capsuleBottom + 15
      });
    } catch (error) {
      this.setData({
        headerSafeTop: 85
      });
    }

    try {
      const sysInfo = getSafeSystemInfo();
      this.setData({
        modalSafeTop: sysInfo.statusBarHeight
      });
    } catch (error) {
      this.setData({
        modalSafeTop: 44
      });
    }

    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    
    this.setData({
      reportDate: `${yyyy}年${mm}月${dd}日`,
      reportDateValue: `${yyyy}-${mm}-${dd}`,
      isTodaySelected: true,
      isYesterdaySelected: false
    });
    
    this.initStorePresetFromCache();
    this.loadSettings();
    await this.loadLastBalance();
    this.loadAnnouncement();
    DataService.syncLocalDataToCloud();
    await this.initCurrentUserRole();

    const storeId = this.data.currentStoreId || 'store_haicang_001';
    this.fetchStoreSponsor(storeId);

    const hasDraft = await this.loadDraft();
    if (hasDraft) {
      wx.showToast({ 
        title: '已为您自动恢复上次未提交的草稿 ✍️', 
        icon: 'none',
        duration: 3000 
      });
    }
  },

  async initCurrentUserRole() {
    const computeRoleState = (roleStr: string) => {
      const rawRole = (roleStr || 'VOLUNTEER').toUpperCase();
      const isVolunteer = rawRole === 'VOLUNTEER';
      const isManager = ['MANAGER', 'STORE_MANAGER', 'ADMIN', 'SUPER_ADMIN'].includes(rawRole);
      const isFinance = ['FINANCE', 'ADMIN', 'SUPER_ADMIN'].includes(rawRole);
      const isSuperAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(rawRole);
      const roleMap: Record<string, string> = {
        'VOLUNTEER': 'volunteer',
        'MANAGER': 'store_manager',
        'STORE_MANAGER': 'store_manager',
        'FINANCE': 'finance',
        'ADMIN': 'super_admin',
        'SUPER_ADMIN': 'super_admin'
      };
      const normalizedRole = roleMap[rawRole] || 'volunteer';
      const flags = getPermissionFlags({ role: normalizedRole });
      return { rawRole, normalizedRole, isVolunteer, isManager, isFinance, isSuperAdmin, flags };
    };

    const syncStorePicker = (storeId: string, storeName: string, rawRole: string) => {
      wx.nextTick(() => {
        const picker = this.selectComponent('#storePicker');
        if (picker && (picker as any).updateCurrentStore) {
          (picker as any).updateCurrentStore({ storeId, storeName, role: rawRole });
          console.log('📡 [Role Sync] 已通知 store-picker 更新徽章:', rawRole);
        }
      });
    };

    const cached = AuthService.getCachedRoleInfo();
    if (cached) {
      const { rawRole, normalizedRole, isVolunteer, isManager, isFinance, isSuperAdmin, flags } = computeRoleState(cached.role);
      const storeName = cached.storeName || this.data.shopName;
      const storeId = cached.storeId || '';

      this.setData({
        currentUserRole: normalizedRole,
        currentRole: rawRole,
        permissions: flags,
        isVolunteer: isVolunteer,
        isManager: isManager,
        isFinance: isFinance,
        isSuperAdmin: isSuperAdmin,
        currentStoreName: storeName,
        currentStoreId: storeId
      });
      console.log('🚀 [Page Init] 缓存角色初始化完成, isVolunteer =', isVolunteer, ', isSuperAdmin =', isSuperAdmin);

      syncStorePicker(storeId, storeName, rawRole);

      if (flags.canAuditUser && cached.storeId) {
        this.fetchPendingAuditCount(cached.storeId);
      }
      if (flags.canSwitchStore) {
        this.fetchAllStoresList();
      }
    }

    const result = await AuthService.fetchUserRole();
    if (result.success && result.roleInfo) {
      const info = result.roleInfo;
      const { rawRole, normalizedRole, isVolunteer, isManager, isFinance, isSuperAdmin, flags } = computeRoleState(info.role);
      const storeName = info.storeName || this.data.shopName;
      const storeId = info.storeId || '';

      this.setData({
        currentUserRole: normalizedRole,
        currentRole: rawRole,
        permissions: flags,
        isVolunteer: isVolunteer,
        isManager: isManager,
        isFinance: isFinance,
        isSuperAdmin: isSuperAdmin,
        currentStoreName: storeName,
        currentStoreId: storeId
      });
      console.log('✅ [Page Init] 云端角色初始化完成, isVolunteer =', isVolunteer, ', isSuperAdmin =', isSuperAdmin);

      syncStorePicker(storeId, storeName, rawRole);

      if (flags.canAuditUser && info.storeId) {
        this.fetchPendingAuditCount(info.storeId);
      }
      if (flags.canSwitchStore) {
        this.fetchAllStoresList();
      }
    }

    const storeId = this.data.currentStoreId || '';
    const reportDate = this.data.reportDateRaw || '';
    if (storeId && reportDate && this.data.permissions?.canEditBalance) {
      this.checkAndAcquireLock(storeId, reportDate);
    }
  },

  async fetchPendingAuditCount(storeId: string) {
    try {
      const db = wx.cloud.database();
      const res = await db.collection('user_roles')
        .where({ storeId: storeId, status: 'pending' })
        .count();
      this.setData({ pendingAuditCount: res.total || 0 });
    } catch (e) {
      console.error('[fetchPendingAuditCount] 查询失败:', e);
    }
  },

  async fetchAllStoresList() {
    try {
      // 优先读取本地缓存（有效期5分钟）
      const cached = wx.getStorageSync('all_stores_list_cache');
      const cacheTime = wx.getStorageSync('all_stores_list_cache_time');
      if (cached && cacheTime && (Date.now() - cacheTime) < 300000) {
        this.setData({ allStoresList: JSON.parse(cached) });
        return;
      }

      const db = wx.cloud.database();
      // 添加 orderBy 避免全表扫描，使用 storeName 索引
      const res = await db.collection('stores').orderBy('storeName', 'asc').limit(100).get();
      const list = (res.data || []).map((s: any) => ({
        storeId: s._id,
        storeName: s.storeName || '未命名门店'
      }));
      this.setData({ allStoresList: list });

      // 缓存到本地
      wx.setStorageSync('all_stores_list_cache', JSON.stringify(list));
      wx.setStorageSync('all_stores_list_cache_time', Date.now());
    } catch (e) {
      console.error('[fetchAllStoresList] 查询失败:', e);
    }
  },

  async fetchStoreSponsor(storeId: string) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'getStoreSponsor',
        data: { storeId }
      });
      const result = res.result as any;
      if (result && result.success && result.data) {
        this.setData({ currentSponsorInfo: result.data });
      } else {
        this.setData({ currentSponsorInfo: null });
      }
    } catch (e) {
      console.error('[fetchStoreSponsor] 查询失败:', e);
      this.setData({ currentSponsorInfo: null });
    }
  },

  _isAdminRole(): boolean {
    const role = this.data.currentUserRole || 'volunteer';
    return role === 'super_admin' || role === 'store_manager';
  },

  _lockKey(storeId: string, dateStr: string): string {
    return `${storeId}_${dateStr}`;
  },

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  },

  _startHeartbeat(storeId: string, dateStr: string) {
    this._stopHeartbeat();
    this._lockActiveKey = this._lockKey(storeId, dateStr);
    this._heartbeatRetryCount = 0;
    this._heartbeatTimer = setInterval(() => {
      if (this._lockActiveKey !== this._lockKey(storeId, dateStr)) {
        this._stopHeartbeat();
        return;
      }
      this._doRenew(storeId, dateStr);
    }, 5 * 60 * 1000);
  },

  _doRenew(storeId: string, dateStr: string) {
    wx.cloud.callFunction({
      name: 'manageDraftLock',
      data: {
        action: 'RENEW',
        storeId: storeId,
        reportDate: dateStr
      }
    }).then((res: any) => {
      if (res.result && res.result.success) {
        this._heartbeatRetryCount = 0;
        const remain = Math.floor((res.result.remainingMs || 0) / 1000);
        this.setData({
          lockRemainingSec: remain,
          lockRemainingFormatted: this._formatRemainTime(remain)
        });
      } else if (res.result && res.result.errMsg === '锁不存在') {
        // 锁被意外删除，重新获取
        this.checkAndAcquireLock(storeId, dateStr);
      }
    }).catch(() => {
      // 续期失败时重试（最多3次）
      this._heartbeatRetryCount++;
      if (this._heartbeatRetryCount <= 3) {
        setTimeout(() => this._doRenew(storeId, dateStr), 5000 * this._heartbeatRetryCount);
      }
    });
  },

  _stopLockPolling() {
    if (this._lockPollingTimer) {
      clearInterval(this._lockPollingTimer);
      this._lockPollingTimer = null;
    }
  },

  _startLockPolling(storeId: string, dateStr: string) {
    this._stopLockPolling();
    this._lockPollingTimer = setInterval(() => {
      wx.cloud.callFunction({
        name: 'manageDraftLock',
        data: {
          action: 'QUERY',
          storeId: storeId,
          reportDate: dateStr
        }
      }).then((res: any) => {
        const r = res.result;
        if (r && !r.isLocked) {
          this._stopLockPolling();
          this.checkAndAcquireLock(storeId, dateStr);
        } else if (r && r.remainingMs) {
          const remain = Math.floor(r.remainingMs / 1000);
          this.setData({
            lockRemainingSec: remain,
            lockRemainingFormatted: this._formatRemainTime(remain)
          });
        }
      }).catch(() => {});
    }, 3000);
  },

  async checkAndAcquireLock(storeId: string, dateStr: string) {
    this._stopLockPolling();

    if (!storeId || !dateStr) {
      this.setData({ isReadOnlyByLock: false, lockOwnerName: '', lockRemainingSec: 0 });
      return;
    }

    try {
      const res = await wx.cloud.callFunction({
        name: 'manageDraftLock',
        data: {
          action: 'ACQUIRE',
          storeId: storeId,
          reportDate: dateStr
        }
      });

      const result = res.result as any;
      if (result && !result.success && result.isLocked) {
        this._stopHeartbeat();
        const remainSec = Math.floor((result.remainingMs || 0) / 1000);
        this.setData({
          isReadOnlyByLock: true,
          lockOwnerName: result.lockedBy || '其他义工',
          lockRemainingSec: remainSec,
          lockRemainingFormatted: this._formatRemainTime(remainSec)
        });
        this._startLockPolling(storeId, dateStr);
      } else {
        this.setData({
          isReadOnlyByLock: false,
          lockOwnerName: '',
          lockRemainingSec: 0,
          lockRemainingFormatted: ''
        });
        this._startHeartbeat(storeId, dateStr);
      }
    } catch (e) {
      console.error('[checkAndAcquireLock] 加锁失败:', e);
      this.setData({ isReadOnlyByLock: false, lockOwnerName: '', lockRemainingSec: 0, lockRemainingFormatted: '' });
    }
  },

  releaseDraftLock() {
    const storeId = this.data.currentStoreId || '';
    const reportDate = this.data.reportDateRaw || '';
    if (!storeId || !reportDate) return;

    this._stopHeartbeat();
    this._stopLockPolling();
    this._lockActiveKey = '';

    wx.cloud.callFunction({
      name: 'manageDraftLock',
      data: {
        action: 'RELEASE',
        storeId: storeId,
        reportDate: reportDate
      }
    }).catch(() => {});
  },

  onForceUnlock() {
    const storeId = this.data.currentStoreId || '';
    const reportDate = this.data.reportDateRaw || '';
    if (!this._isAdminRole()) {
      wx.showToast({ title: '仅管理员可强制解锁', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '强制解锁',
      content: `确定要强制释放【${this.data.lockOwnerName}】持有的编辑锁吗？`,
      confirmText: '强制解锁',
      confirmColor: '#E03131',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const result = await wx.cloud.callFunction({
            name: 'manageDraftLock',
            data: {
              action: 'FORCE_RELEASE',
              storeId: storeId,
              reportDate: reportDate
            }
          });
          if (result.result && result.result.success) {
            wx.showToast({ title: '已强制解锁', icon: 'success' });
            this.checkAndAcquireLock(storeId, reportDate);
          } else {
            wx.showToast({ title: '解锁失败', icon: 'none' });
          }
        } catch (e) {
          wx.showToast({ title: '解锁失败', icon: 'none' });
        }
      }
    });
  },

  _formatRemainTime(sec: number): string {
    if (sec <= 0) return '';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m > 0) return `${m}分${s}秒`;
    return `${s}秒`;
  },

  onSuperAdminSwitchStore() {
    const itemList = [
      '👑 视角：超级管理员 (全权限)',
      '🏪 视角：店长 (可审核与发海报)',
      '🔑 视角：财务记账义工',
      '❤️ 视角：志工/大众家人 (仅查看)',
      '📍 切换门店：海沧区雨花斋',
      '📍 切换门店：全国总览'
    ];

    wx.showActionSheet({
      title: '切换体验视角或管辖门店',
      itemList: itemList,
      itemColor: '#212529',
      success: (res) => {
        const tapIndex = res.tapIndex;

        switch (tapIndex) {
          case 0:
            this.switchRolePerspective('super_admin');
            break;
          case 1:
            this.switchRolePerspective('store_manager');
            break;
          case 2:
            this.switchRolePerspective('finance');
            break;
          case 3:
            this.switchRolePerspective('volunteer');
            break;
          case 4:
            this.switchStoreTarget('store_haicang', '海沧区雨花斋');
            break;
          case 5:
            this.switchStoreTarget('all', '全国总览');
            break;
        }
      }
    });
  },

  onStoreChanged(e: any) {
    const detail = e.detail || {};
    const rawRole = (detail.role || detail.currentRole || wx.getStorageSync('active_role') || 'VOLUNTEER').toUpperCase();
    const storeName = detail.storeName || detail.name || this.data.currentStoreName || '海沧区雨花斋';
    const storeId = detail.storeId || detail.id || this.data.currentStoreId || '';

    // 防循环：门店和角色均未改变则直接中断
    if (
      this.data.currentStoreId === storeId &&
      this.data.currentRole === rawRole
    ) {
      console.log('🛑 [Prevent Loop] 选中的门店与角色未发生改变，忽略响应');
      return;
    }

    console.log('🔄 [onStoreChanged] 收到切换事件:', { storeName, storeId, rawRole });

    const isVolunteer = rawRole === 'VOLUNTEER';
    const isManager = ['MANAGER', 'STORE_MANAGER', 'ADMIN', 'SUPER_ADMIN'].includes(rawRole);
    const isFinance = ['FINANCE', 'ADMIN', 'SUPER_ADMIN'].includes(rawRole);
    const isSuperAdmin = rawRole === 'ADMIN' || rawRole === 'SUPER_ADMIN';

    const roleMap: Record<string, string> = {
      'VOLUNTEER': 'volunteer',
      'MANAGER': 'store_manager',
      'STORE_MANAGER': 'store_manager',
      'FINANCE': 'finance',
      'ADMIN': 'super_admin',
      'SUPER_ADMIN': 'super_admin'
    };
    const normalizedRole = roleMap[rawRole] || 'volunteer';
    const flags = getPermissionFlags({ role: normalizedRole });

    console.log('⚡ [Role State] 重新计算后的状态:', { isVolunteer, isManager, isFinance, isSuperAdmin, normalizedRole });

    // 🌟 切店全局持久化：同步 storeId / storeName / role 到本地存储
    wx.setStorageSync('current_store_id', storeId);
    wx.setStorageSync('current_store_name', storeName);
    wx.setStorageSync('current_user_role', normalizedRole);
    wx.setStorageSync('active_store_id', storeId);
    wx.setStorageSync('active_role', normalizedRole);

    this.setData({
      currentStoreId: storeId,
      currentStoreName: storeName,
      // 🔑 关键修复：同步更新 shopName 字段，确保 loadBalanceForDate 等函数使用新门店名
      shopName: storeName,
      currentRole: rawRole,
      currentUserRole: normalizedRole,
      isVolunteer: isVolunteer,
      isManager: isManager,
      isFinance: isFinance,
      isSuperAdmin: isSuperAdmin,
      permissions: flags
    }, () => {
      console.log('✅ [Page Data Set] 页面 UI 状态已更新，当前 isVolunteer =', this.data.isVolunteer);
    });

    wx.showToast({
      title: `已切至 ${storeName} (${isVolunteer ? '义工视角' : (isFinance ? '财务视角' : '店长视角')})`,
      icon: 'none'
    });

    this.fetchStoreSponsor(storeId);

    // 🌟 切店后立即重新加载新门店的看板数据与义工统计
    this.loadBalanceForDate(this.data.reportDate || this.data.reportDateValue || '');
    if (typeof (this as any).loadVolunteerStats === 'function') {
      (this as any).loadVolunteerStats();
    }

    // 安全调用数据加载函数，防止 TypeError 崩溃
    const self = this as any;
    if (typeof self.loadPageDataByRole === 'function') {
      self.loadPageDataByRole();
    } else if (typeof self.loadBalanceForDate === 'function') {
      self.loadBalanceForDate(this.data.reportDate || this.data.reportDateValue || '');
    } else if (typeof self.loadPageData === 'function') {
      self.loadPageData();
    } else {
      console.log('✅ [Role Changed] 页面模式已成功切换为:', rawRole);
    }
  },

  switchRolePerspective(role: string) {
    const flags = getPermissionFlags({ role });
    this.setData({
      currentUserRole: role,
      permissions: flags
    });

    wx.showToast({
      title: `已切换至：${ROLE_LABELS[role as keyof typeof ROLE_LABELS] || role}`,
      icon: 'none'
    });
  },

  switchStoreTarget(storeId: string, storeName: string) {
    this.setData({
      currentStoreId: storeId,
      currentStoreName: storeName
    });

    setSelectedStore({ storeId, storeName });

    if (typeof this.autoFetchPreviousBalance === 'function') {
      this.autoFetchPreviousBalance(this.data.reportDateRaw);
    }

    this.fetchStoreSponsor(storeId);

    wx.showToast({
      title: `当前门店：${storeName}`,
      icon: 'success'
    });
  },

  onNavigateToHelp() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    const role = this.data.currentUserRole || 'volunteer';
    let targetTab = 'volunteer';
    if (role === 'store_manager' || role === 'super_admin') {
      targetTab = 'manager';
    } else if (role === 'finance') {
      targetTab = 'finance';
    }
    wx.navigateTo({
      url: `/pages/help/help?tab=${targetTab}`,
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  onNavigateToMine() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/mine/mine',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  async onGenerateStorePoster() {
    if (!this.data.permissions.canAuditUser) {
      wx.showToast({ title: '仅店长/管理员可生成', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在合成精美海报...', mask: true });

    try {
      const storeId = this.data.currentStoreId || 'store_haicang_001';
      const storeName = this.data.currentStoreName || this.data.shopName || '海沧区雨花斋';

      let qrCodeLocalPath = '';
      try {
        const qrRes = await wx.cloud.callFunction({
          name: 'getStoreQRCode',
          data: { storeId, storeName }
        });
        const qrResult = qrRes.result as any;
        if (qrResult && qrResult.success && qrResult.fileID) {
          const downRes = await wx.cloud.downloadFile({ fileID: qrResult.fileID });
          qrCodeLocalPath = downRes.tempFilePath;
        }
      } catch (qrErr) {
        console.warn('[onGenerateStorePoster] 二维码获取失败，使用占位:', qrErr);
      }

      this.setData({ showStorePosterModal: true, storePosterTempFilePath: '' });

      setTimeout(() => {
        const query = wx.createSelectorQuery();
        query.select('#storePosterCanvas')
          .fields({ node: true, size: true })
          .exec(async (res) => {
            if (!res[0] || !res[0].node) {
              wx.hideLoading();
              wx.showToast({ title: 'Canvas 初始化失败', icon: 'none' });
              return;
            }
            const canvas = res[0].node;

            try {
              const sponsorInfo = this.data.currentSponsorInfo;
              await drawStoreInvitationPoster({
                canvas,
                storeName,
                sponsorInfo,
                qrCodeTempPath: qrCodeLocalPath,
                width: 320,
                height: 500
              });

              wx.canvasToTempFilePath({
                canvas,
                success: (tempRes) => {
                  this.setData({ storePosterTempFilePath: tempRes.tempFilePath });
                  wx.hideLoading();
                },
                fail: (err) => {
                  wx.hideLoading();
                  console.error('[onGenerateStorePoster] canvasToTempFilePath 失败:', err);
                  wx.showToast({ title: '海报生成失败', icon: 'none' });
                }
              });
            } catch (drawErr) {
              wx.hideLoading();
              console.error('[onGenerateStorePoster] 绘制失败:', drawErr);
              wx.showToast({ title: '海报绘制失败', icon: 'none' });
            }
          });
      }, 300);
    } catch (e) {
      wx.hideLoading();
      console.error('[onGenerateStorePoster] 异常:', e);
      wx.showToast({ title: '海报生成失败', icon: 'none' });
    }
  },

  onCloseStorePosterModal() {
    this.setData({ showStorePosterModal: false });
  },

  onSaveStorePosterToAlbum() {
    const filePath = this.data.storePosterTempFilePath;
    if (!filePath) {
      wx.showToast({ title: '海报尚未绘制完成', icon: 'none' });
      return;
    }

    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => {
        wx.showToast({ title: '海报已保存至相册', icon: 'success' });
        this.setData({ showStorePosterModal: false });
      },
      fail: (err) => {
        if (err.errMsg && err.errMsg.indexOf('auth deny') >= 0) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中允许小程序保存图片到您的相册',
            success: (res) => {
              if (res.confirm) {
                wx.openSetting();
              }
            }
          });
        } else {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      }
    });
  },

  initStorePresetFromCache() {
    try {
      const cached = wx.getStorageSync('last_selected_store_config') as any;
      if (cached && cached.storeName) {
        const preset = findStorePreset(cached.storeName);
        const index = STORE_PICKER_LIST.indexOf(cached.storeName);
        if (preset && index >= 0) {
          this.setData({
            selectedStoreIndex: index,
            shopName: preset.storeName,
            mpAccount: preset.officialAccount,
            thankText: preset.thanksWord,
            slogan1: preset.slogan1,
            slogan2: preset.slogan2,
            isCustomStore: false
          });
          return;
        }
        // 缓存为自定义门店，保留用户配置
        this.setData({
          selectedStoreIndex: STORE_PRESETS.length,
          isCustomStore: true,
          shopName: cached.storeName,
          mpAccount: cached.mpAccount || this.data.mpAccount
        });
        return;
      }
      this.applyStorePreset(0);
    } catch (error) {
      console.error('[门店预设] 读取缓存失败:', error);
      this.applyStorePreset(0);
    }
  },

  onStorePickerChange(e: any) {
    const index = parseInt(e.detail.value, 10);
    if (index === STORE_PRESETS.length) {
      this.setData({
        selectedStoreIndex: index,
        isCustomStore: true,
        shopName: '',
        mpAccount: ''
      });
    } else {
      this.applyStorePreset(index);
    }
  },

  applyStorePreset(index: number) {
    const preset = STORE_PRESETS[index];
    if (!preset) return;
    this.setData({
      selectedStoreIndex: index,
      isCustomStore: false,
      shopName: preset.storeName,
      mpAccount: preset.officialAccount,
      thankText: preset.thanksWord,
      slogan1: preset.slogan1,
      slogan2: preset.slogan2
    });
    try {
      wx.setStorageSync('last_selected_store_config', preset);
    } catch (error) {
      console.error('[门店预设] 保存缓存失败:', error);
    }
    
    setSelectedStore({ storeId: preset.storeId || '', storeName: preset.storeName });
    
    const dateValue = this.data.reportDateValue;
    if (dateValue && /^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
      this.loadBalanceForDate(dateValue);
      this.checkExistingRecord(dateValue);
    }
  },

  async loadLastBalance() {
    if (this.data.isEditMode) return;
    
    const result = await DataService.getLatestReport(this.data.shopName, this.data.mpAccount);
    
    if (result.success && result.data) {
      // 核心修复：优先取 todayBalance（今日结余），绝对不要取 yesterdayBalance！
      const balanceValue = result.data.todayBalance != null && result.data.todayBalance !== ''
        ? result.data.todayBalance
        : (result.data.adjustedBalance != null ? result.data.adjustedBalance : null);
      const balance = this.validateBalance(balanceValue);
      const systemBalanceNum = parseFloat(balanceValue) || 0;
      this.setData({
        prevBalance: balance,
        yesterdayBalance: balance,
        systemBalance: systemBalanceNum,
        isManualAdjust: false,
        balanceDiff: 0,
        adjustReason: '',
        yesterdayBalDisplay: systemBalanceNum.toFixed(2)
      });
      this.updateRealTimeBalance();
    } else {
      this.loadFromLocal();
    }
  },

  loadFromLocal() {
    const cachedBalance = wx.getStorageSync('yuhua_last_balance') || wx.getStorageSync('last_shop_balance');
    
    const balance = this.validateBalance(cachedBalance);
    const systemBalanceNum = parseFloat(cachedBalance) || 0;
    this.setData({
      prevBalance: balance,
      yesterdayBalance: balance,
      systemBalance: systemBalanceNum,
      isManualAdjust: false,
      balanceDiff: 0,
      adjustReason: '',
      yesterdayBalDisplay: systemBalanceNum.toFixed(2)
    });
    this.updateRealTimeBalance();
  },

  validateBalance(value: any): string {
    return formatMoney(value);
  },

  // 解析食材/支出文本框中的实际支出总额，自动过滤小票合计、总计、虚线等总结行，避免重复相加
  calculateTodayExpenseFromText(text: string): number {
    if (!text || !text.trim()) return 0;

    const lines = text.split('\n');
    let total = 0;

    lines.forEach(line => {
      const trimmed = line.trim();
      // 核心防重守卫：跳过含有合计、虚线等总结行
      if (
        trimmed.includes('小票合计') ||
        trimmed.includes('合计') ||
        trimmed.includes('总计') ||
        trimmed.includes('----') ||
        trimmed.includes('====') ||
        trimmed.startsWith('----------------')
      ) {
        return;
      }

      // 匹配金额，优先提取 ¥ 或 元 后面的数字
      const match = trimmed.match(/[¥￥]\s*(\d+\.?\d*)|(\d+\.?\d*)\s*元/);
      if (match) {
        const amount = parseFloat(match[1] || match[2] || '0');
        if (!isNaN(amount)) {
          total += amount;
        }
      }
    });

    return parseFloat(total.toFixed(2));
  },

  parseExpenseTextToItems(textStr: string, fallbackAmount: number, dateStr: string): any[] {
    if (!textStr || !String(textStr).trim()) {
      if (fallbackAmount > 0) {
        return [{ date: dateStr, title: '专项大额开支', amount: fallbackAmount.toFixed(2) }];
      }
      return [];
    }

    const rawLines = String(textStr)
      .split(/[\r\n;；,，、]+/)
      .map(s => s.trim())
      .filter(Boolean);

    let parsedResults: any[] = [];

    rawLines.forEach(line => {
      // 跳过合计/虚线等总结行，避免数据库明细重复
      if (/小票合计|合计|总计|----|====/.test(line)) return;

      const match = line.match(/^[\u4e00-\u9fa5a-zA-Z0-9\(\)\（\）\s]+?[\s:：等于=]*(\d+(?:\.\d+)?)\s*元?$/);

      if (match) {
        let titleName = match[1].replace(/[\d\s]/g, '').trim();
        let numVal = parseFloat(match[2]);

        if (titleName && !isNaN(numVal) && numVal > 0) {
          parsedResults.push({
            date: dateStr,
            title: titleName,
            amount: numVal.toFixed(2)
          });
        }
      } else {
        const innerRegex = /([\u4e00-\u9fa5a-zA-Z]+)[\s:：]*(\d+(?:\.\d+)?)/g;
        let innerMatch;
        let foundInner = false;
        while ((innerMatch = innerRegex.exec(line)) !== null) {
          let tName = innerMatch[1].trim();
          let nVal = parseFloat(innerMatch[2]);
          if (tName && !isNaN(nVal) && nVal > 0) {
            parsedResults.push({
              date: dateStr,
              title: tName,
              amount: nVal.toFixed(2)
            });
            foundInner = true;
          }
        }
        if (!foundInner && line.length > 0 && fallbackAmount > 0) {
          parsedResults.push({
            date: dateStr,
            title: line,
            amount: fallbackAmount.toFixed(2)
          });
        }
      }
    });

    if (parsedResults.length === 0 && fallbackAmount > 0) {
      parsedResults.push({
        date: dateStr,
        title: String(textStr).trim() || '专项大额开支',
        amount: fallbackAmount.toFixed(2)
      });
    }

    return parsedResults;
  },

  saveDraft() {
    const { reportDate, reportDateValue, yesterdayBalance, allDonations, otherDonation, expenses, dailyExpenseText, fixedExpenseText, shopName, mpAccount, thankText, slogan1, slogan2, volunteerCount, volunteerHours, diningCount, stapleRiceStatus, stapleOilStatus, materialsInput } = this.data;
    
    const draftData = {
      reportDate,
      reportDateValue,
      yesterdayBalance,
      allDonations,
      otherDonation,
      expenses,
      dailyExpenseText,
      fixedExpenseText,
      shopName,
      mpAccount,
      thankText,
      slogan1,
      slogan2,
      volunteerCount,
      volunteerHours,
      diningCount,
      stapleRiceStatus,
      stapleOilStatus,
      materialsInput,
      saveTime: Date.now()
    };

    const draftKey = getDraftKeyForDate(reportDateValue, shopName);

    wx.setStorage({
      key: draftKey,
      data: draftData,
      success: () => {
        console.log('[草稿箱] 日期草稿已保存:', draftKey);
      },
      fail: (err) => {
        console.error('[草稿箱] 草稿保存失败:', err);
      }
    });

    wx.setStorage({
      key: DRAFT_KEY,
      data: draftData,
      success: () => {},
      fail: () => {}
    });
  },

  async loadDraftByDate(dateStr: string, shopName: string): Promise<boolean> {
    try {
      const draftKey = getDraftKeyForDate(dateStr, shopName);
      const draftData = wx.getStorageSync(draftKey);
      if (!draftData) return false;

      const hasContent = draftData.allDonations || draftData.expenses || 
                        draftData.otherDonation || draftData.yesterdayBalance !== '0.00';
      
      if (!hasContent) return false;

      this.setData({
        reportDate: draftData.reportDate || this.data.reportDate,
        reportDateValue: draftData.reportDateValue || dateStr,
        allDonations: draftData.allDonations || '',
        otherDonation: draftData.otherDonation || '',
        expenses: draftData.expenses || '',
        dailyExpenseText: draftData.dailyExpenseText || '',
        fixedExpenseText: draftData.fixedExpenseText || '',
        shopName: draftData.shopName || shopName,
        mpAccount: draftData.mpAccount || this.data.mpAccount,
        thankText: draftData.thankText || this.data.thankText,
        slogan1: draftData.slogan1 || this.data.slogan1,
        slogan2: draftData.slogan2 || this.data.slogan2,
        volunteerCount: draftData.volunteerCount || '',
        volunteerHours: draftData.volunteerHours || '',
        diningCount: draftData.diningCount || '',
        stapleRiceStatus: draftData.stapleRiceStatus || 'normal',
        stapleOilStatus: draftData.stapleOilStatus || 'sufficient',
        materialsInput: draftData.materialsInput || '',
        hasDraft: true
      });

      if (draftData.allDonations) {
        this.updateParseResult(draftData.allDonations);
      }
      if (draftData.materialsInput) {
        this.updateMaterialsParse(draftData.materialsInput);
      }

      await this.loadBalanceForDate(dateStr);
      this.updateRealTimeBalance();

      console.log('[草稿箱] 已载入', dateStr, '草稿');
      wx.showToast({ title: `已载入 ${dateStr} 草稿`, icon: 'none', duration: 1200 });
      return true;
    } catch (error) {
      console.error('[草稿箱] 加载日期草稿失败:', error);
      return false;
    }
  },

  async loadDraft(): Promise<boolean> {
    try {
      const draftData = wx.getStorageSync(DRAFT_KEY);
      if (!draftData) return false;

      const hasContent = draftData.allDonations || draftData.expenses || 
                        draftData.otherDonation || draftData.yesterdayBalance !== '0.00';
      
      if (!hasContent) return false;

      const draftDate = draftData.reportDateValue || this.data.reportDateValue;
      const draftShop = draftData.shopName || this.data.shopName;

      if (draftDate && draftShop) {
        const loaded = await this.loadDraftByDate(draftDate, draftShop);
        if (loaded) return true;
      }

      this.setData({
        reportDate: draftData.reportDate || this.data.reportDate,
        reportDateValue: draftData.reportDateValue || this.data.reportDateValue,
        allDonations: draftData.allDonations || '',
        otherDonation: draftData.otherDonation || '',
        expenses: draftData.expenses || '',
        dailyExpenseText: draftData.dailyExpenseText || '',
        fixedExpenseText: draftData.fixedExpenseText || '',
        shopName: draftData.shopName || this.data.shopName,
        mpAccount: draftData.mpAccount || this.data.mpAccount,
        thankText: draftData.thankText || this.data.thankText,
        slogan1: draftData.slogan1 || this.data.slogan1,
        slogan2: draftData.slogan2 || this.data.slogan2,
        volunteerCount: draftData.volunteerCount || '',
        volunteerHours: draftData.volunteerHours || '',
        diningCount: draftData.diningCount || '',
        stapleRiceStatus: draftData.stapleRiceStatus || 'normal',
        stapleOilStatus: draftData.stapleOilStatus || 'sufficient',
        materialsInput: draftData.materialsInput || '',
        hasDraft: true
      });

      if (draftData.allDonations) {
        this.updateParseResult(draftData.allDonations);
      }
      if (draftData.materialsInput) {
        this.updateMaterialsParse(draftData.materialsInput);
      }

      await this.loadBalanceForDate(this.data.reportDateValue);
      this.updateRealTimeBalance();

      console.log('[草稿箱] 已恢复上次未提交的草稿');
      return true;
    } catch (error) {
      console.error('[草稿箱] 加载草稿失败:', error);
      return false;
    }
  },

  clearDraft() {
    try {
      const { reportDateValue, shopName } = this.data;
      const draftKey = getDraftKeyForDate(reportDateValue, shopName);
      wx.removeStorageSync(draftKey);
      wx.removeStorageSync(DRAFT_KEY);
      this.setData({ hasDraft: false });
      console.log('[草稿箱] 草稿已清空');
    } catch (error) {
      console.error('[草稿箱] 清空草稿失败:', error);
    }
  },

  loadSettings() {
    try {
      const settingsData = wx.getStorageSync(SETTINGS_KEY);
      if (!settingsData) return;

      this.setData({
        shopName: settingsData.shopName || this.data.shopName,
        mpAccount: settingsData.mpAccount || this.data.mpAccount,
        thankText: settingsData.thankText || this.data.thankText,
        slogan1: settingsData.slogan1 || this.data.slogan1,
        slogan2: settingsData.slogan2 || this.data.slogan2
      });
      console.log('[设置] 已加载用户自定义设置');
    } catch (error) {
      console.error('[设置] 加载设置失败:', error);
    }
  },

  saveSettings() {
    try {
      const { shopName, mpAccount, thankText, slogan1, slogan2, isCustomStore } = this.data;
      const settingsData = {
        shopName,
        mpAccount,
        thankText,
        slogan1,
        slogan2,
        saveTime: Date.now()
      };
      wx.setStorageSync(SETTINGS_KEY, settingsData);

      const storeConfig = isCustomStore
        ? { storeName: shopName, mpAccount }
        : findStorePreset(shopName);
      if (storeConfig) {
        wx.setStorageSync('last_selected_store_config', storeConfig);
        setSelectedStore({ storeId: '', storeName: shopName });
      }

      console.log('[设置] 已保存用户自定义设置');
    } catch (error) {
      console.error('[设置] 保存设置失败:', error);
    }
  },

  discardDraft() {
    wx.showModal({
      title: '提示',
      content: '确定要丢弃当前草稿吗？',
      success: (res) => {
        if (res.confirm) {
          this.clearDraft();
          wx.showToast({ title: '已丢弃草稿', icon: 'none' });
        }
      }
    });
  },

  toggleSettings() {
    this.setData({
      showSettings: !this.data.showSettings
    });
  },

  toggleBalanceLock() {
    const newLockState = !this.data.isBalanceLocked;
    this.setData({
      isBalanceLocked: newLockState,
      balanceFocus: !newLockState
    });
    
    if (!newLockState) {
      wx.vibrateShort && wx.vibrateShort({ type: 'light' });
      wx.showToast({ title: '已解锁，可手动修改余额', icon: 'none', duration: 1500 });
    } else {
      wx.showToast({ title: '余额已锁定', icon: 'none', duration: 1000 });
    }
  },

  onResetToAutoBalance() {
    this.setData({ isBalanceLocked: true });
    this.loadBalanceForDate(this.data.reportDateValue);
    wx.showToast({ title: '已恢复系统自动匹配', icon: 'success', duration: 1500 });
  },

  onForceRefreshBalance() {
    this.setData({ isBalanceLocked: true });
    this.loadBalanceForDate(this.data.reportDateValue);
  },

  // === 扫码绑定与义工审核 ===

  async fetchStoreInfoAndPromptApply(storeId: string) {
    wx.showLoading({ title: '正在获取门店信息...' });
    
    const storeNameMap: Record<string, string> = {
      'store_haicang': '海沧区雨花斋',
      'store_haicang_001': '海沧区雨花斋',
      'all': '全国总览'
    };

    try {
      const db = wx.cloud.database();
      const res = await db.collection('stores').doc(storeId).get();
      wx.hideLoading();

      if (res.data) {
        this.setData({
          'applyForm.storeId': storeId,
          'applyForm.storeName': (res.data as any).storeName || '未知门店',
          showApplyModal: true
        });
      } else {
        throw new Error('store not found');
      }
    } catch (e) {
      wx.hideLoading();
      const fallbackName = storeNameMap[storeId] || '雨花斋';
      this.setData({
        'applyForm.storeId': storeId,
        'applyForm.storeName': fallbackName,
        showApplyModal: true
      });
    }
  },

  onOpenRoleApplyModal() {
    const storeName = this.data.currentStoreName || this.data.shopName;
    this.setData({
      'applyForm.storeId': this.data.currentStoreId,
      'applyForm.storeName': storeName,
      showApplyModal: true
    });
  },

  onApplyRealNameInput(e: any) {
    this.setData({ 'applyForm.realName': e.detail.value });
  },

  onApplyPhoneInput(e: any) {
    this.setData({ 'applyForm.phone': e.detail.value });
  },

  onApplyRoleChange(e: any) {
    this.setData({ 'applyForm.requestedRole': e.detail.value });
  },

  onCloseApplyModal() {
    this.setData({ showApplyModal: false });
  },

  async onSubmitRoleApply() {
    const { storeId, storeName, realName, phone, requestedRole } = this.data.applyForm;

    if (!realName || !realName.trim()) {
      wx.showToast({ title: '请填写真实姓名', icon: 'none' });
      return;
    }
    if (!phone || !phone.trim()) {
      wx.showToast({ title: '请填写手机号', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '提交申请中...', mask: true });

    try {
      const db = wx.cloud.database();
      await db.collection('user_roles').add({
        data: {
          realName: realName.trim(),
          phone: phone.trim(),
          storeId,
          storeName,
          requestedRole,
          role: 'volunteer',
          status: 'pending',
          applyTime: db.serverDate()
        }
      });

      wx.hideLoading();
      this.setData({ showApplyModal: false });

      wx.showModal({
        title: '申请已提交',
        content: `您已成功申请加入【${storeName}】，请联系店长或财务负责人完成身份审核！`,
        showCancel: false,
        confirmText: '我知道了'
      });
    } catch (e) {
      wx.hideLoading();
      console.error('[onSubmitRoleApply] 提交失败:', e);
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
    }
  },

  // === 店长审核管理 ===

  async onOpenAuditModal() {
    this.setData({
      showAuditModal: true,
      auditActiveTab: 'pending'
    });
    await this.fetchPendingAuditList();
  },

  onCloseAuditModal() {
    this.setData({ showAuditModal: false });
  },

  // ================= 🔑 生成动态邀请码 =================
  onOpenGenCodeModal() {
    const storeList = this.data.allStoresList || [];
    const firstStore = storeList.length > 0 ? storeList[0] : null;
    
    this.setData({ 
      showGenCodeModal: true, 
      generatedCode: '',
      genTargetRole: 'MANAGER',
      targetGenStoreId: firstStore ? firstStore.storeId : this.data.currentStoreId || '',
      targetGenStoreName: firstStore ? firstStore.storeName : this.data.currentStoreName || '海沧区雨花斋'
    });
  },

  onCloseGenCodeModal() {
    this.setData({ showGenCodeModal: false });
  },

  onOpenDevClearModal() {
    this.setData({ showDevClearModal: true, clearConfirmInput: '' });
  },

  onCloseDevClearModal() {
    this.setData({ showDevClearModal: false });
  },

  onDevOptionChange(e: any) {
    const values = e.detail.value;
    this.setData({
      clearOptions: {
        reports: values.includes('REPORTS'),
        requests: values.includes('REQUESTS'),
        cache: values.includes('CACHE')
      }
    });
  },

  onClearInput(e: any) {
    this.setData({ clearConfirmInput: e.detail.value.trim() });
  },

  async onExecuteDevClear() {
    if (this.data.clearConfirmInput !== 'CLEAR') {
      wx.showToast({ title: '请输入大写 CLEAR 确认', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '全量环境清洗中...' });
    const opts = this.data.clearOptions;

    try {
      if (opts.reports || opts.requests) {
        await wx.cloud.callFunction({
          name: 'cleanDevData',
          data: {
            clearReports: opts.reports,
            clearRequests: opts.requests,
            clearInvites: opts.requests
          }
        });
      }

      if (opts.cache) {
        wx.removeStorageSync('my_authorized_roles');
        wx.removeStorageSync('current_store_id');
        wx.removeStorageSync('current_user_role');
      }

      wx.hideLoading();
      this.setData({ showDevClearModal: false });

      wx.showModal({
        title: '🎉 测试数据已全量清洗',
        content: '云端多账号测试数据与本地缓存已彻底归零，环境已恢复纯净。',
        showCancel: false,
        confirmText: '重启应用',
        success: () => {
          this.isNavigating = true;
          setTimeout(() => {
            wx.reLaunch({
              url: '/pages/index/index',
              fail: (err) => {
                console.error('重启失败', err);
                this.isNavigating = false;
              }
            });
          }, 100);
        }
      });

    } catch (err) {
      wx.hideLoading();
      console.error('清洗失败：', err);
      wx.showToast({ title: '云函数清洗失败，请检查是否部署', icon: 'none' });
    }
  },

  onSelectGenRole(e: any) {
    this.setData({ genTargetRole: e.currentTarget.dataset.role, generatedCode: '' });
  },

  onSelectGenStore(e: any) {
    const index = e.detail.value;
    const selected = (this.data.allStoresList || [])[index];
    if (selected) {
      this.setData({
        targetGenStoreId: selected.storeId,
        targetGenStoreName: selected.storeName,
        generatedCode: ''
      });
    }
  },

  async onGenerateInviteCode() {
    const storeId = this.data.targetGenStoreId;
    const storeName = this.data.targetGenStoreName;
    const role = this.data.genTargetRole;

    if (!storeId) {
      wx.showToast({ title: '请先选择目标门店', icon: 'none' });
      return;
    }

    const randomCode = Math.floor(100000 + Math.random() * 900000).toString();

    wx.showLoading({ title: '邀请码安全生成中...' });

    try {
      const db = wx.cloud.database();
      await db.collection('store_invites').add({
        data: {
          inviteCode: randomCode,
          storeId: storeId,
          storeName: storeName,
          role: role,
          isUsed: false,
          createdAt: db.serverDate(),
          creatorOpenId: wx.getStorageSync('my_openid') || 'ADMIN'
        }
      });

      wx.hideLoading();
      this.setData({ generatedCode: randomCode });
      wx.showToast({ title: '生成成功', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      console.warn('⚠️ [GenCode] 云端写入失败，启用离线模式:', err);
      this.setData({ generatedCode: randomCode });
      wx.showToast({ title: '邀请码生成成功(离线模式)', icon: 'none' });
    }
  },

  onCopyGeneratedCode() {
    const roleName = this.data.genTargetRole === 'FINANCE' ? '财务' : '店长';
    const copyText = `🌸【雨花爱心餐报助手】\n恭请您护持【${this.data.targetGenStoreName || '雨花斋'}】！您的专属【${roleName}】激活码为：${this.data.generatedCode} 。请打开小程序，选择该门店并输入此码激活绑定。合十感恩！`;

    wx.setClipboardData({
      data: copyText,
      success: () => {
        wx.showToast({ title: '邀请信息已复制！', icon: 'success' });
        this.setData({ showGenCodeModal: false });
      }
    });
  },

  onSwitchAuditTab(e: any) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ auditActiveTab: tab });
    if (tab === 'approved' && this.data.approvedVolunteerList.length === 0) {
      this.fetchApprovedVolunteerList();
    }
  },

  async fetchPendingAuditList() {
    try {
      const roleInfo = AuthService.getCachedRoleInfo();
      const storeId = roleInfo?.storeId || '';
      const storeName = roleInfo?.storeName || this.data.shopName;

      const db = wx.cloud.database();

      let query: any;
      if (storeId) {
        query = db.collection('user_roles').where({
          status: 'pending',
          storeId: storeId
        });
      } else {
        query = db.collection('user_roles').where({
          status: 'pending',
          storeName: storeName
        });
      }

      const res = await query.orderBy('applyTime', 'desc').limit(50).get();

      const formattedList = (res.data || []).map((item: any) => ({
        ...item,
        applyTimeStr: item.applyTime ? this.formatApplyTime(item.applyTime) : '近期'
      }));

      this.setData({ pendingApplyList: formattedList });
    } catch (e) {
      console.error('[fetchPendingAuditList] 加载失败:', e);
      wx.showToast({ title: '加载申请列表失败', icon: 'none' });
    }
  },

  async fetchApprovedVolunteerList() {
    wx.showLoading({ title: '加载已绑定列表...' });
    try {
      const roleInfo = AuthService.getCachedRoleInfo();
      const storeId = roleInfo?.storeId || '';
      const storeName = roleInfo?.storeName || this.data.shopName;

      const db = wx.cloud.database();

      let query: any;
      if (storeId) {
        query = db.collection('user_roles').where({
          status: 'approved',
          storeId: storeId
        });
      } else {
        query = db.collection('user_roles').where({
          status: 'approved',
          storeName: storeName
        });
      }

      const res = await query.orderBy('approveTime', 'desc').limit(50).get();

      wx.hideLoading();
      this.setData({ approvedVolunteerList: res.data || [] });
    } catch (e) {
      wx.hideLoading();
      console.error('[fetchApprovedVolunteerList] 加载失败:', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  formatApplyTime(time: any): string {
    if (!time) return '近期';
    const date = time instanceof Date ? time : new Date(time);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return '刚刚';
    if (diffMins < 60) return diffMins + '分钟前';
    if (diffHours < 24) return diffHours + '小时前';
    if (diffDays < 7) return diffDays + '天前';

    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hour = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return month + '月' + day + '日 ' + hour + ':' + min;
  },

  async onProcessAudit(e: any) {
    const { id, action } = e.currentTarget.dataset;
    const applyItem = this.data.pendingApplyList.find((r: any) => r._id === id);

    if (!applyItem) {
      wx.showToast({ title: '申请记录不存在', icon: 'none' });
      return;
    }

    const storeId = applyItem.storeId;
    const loadingTitle = action === 'approve' ? '正在授权...' : '正在处理...';

    wx.showLoading({ title: loadingTitle, mask: true });

    try {
      const result = await wx.cloud.callFunction({
        name: 'processRoleAudit',
        data: { applyId: id, action, storeId }
      });

      const res = result.result as any;

      if (res && res.success) {
        wx.hideLoading();
        wx.showToast({ 
          title: action === 'approve' ? '已授权通过' : '已拒绝申请', 
          icon: action === 'approve' ? 'success' : 'none' 
        });

        const newList = this.data.pendingApplyList.filter((r: any) => r._id !== id);
        this.setData({ pendingApplyList: newList });
      } else {
        wx.hideLoading();
        wx.showToast({ title: res?.error || '操作失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[onProcessAudit] 审核失败:', err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  async onOpenBalanceHistoryModal() {
    wx.showLoading({ title: '正在调取账目流水...', mask: true });

    let rawList: any[] = [];
    const currentDate = this.data.reportDateValue;
    const shopName = this.data.shopName;

    try {
      const db = wx.cloud.database();
      const _ = db.command;
      // 🔑 数据隔离修复：强带 storeId / shopName 过滤，防止跨门店数据混淆
      const currentStoreId = this.data.currentStoreId || wx.getStorageSync('current_store_id') || '';
      const balanceHistoryWhere: any = {
        dateString: _.lt(currentDate)
      };
      // 超管全国总览时不加门店过滤
      if (currentStoreId && currentStoreId !== 'national_overview' && currentStoreId !== 'ALL_STORES') {
        balanceHistoryWhere.storeId = currentStoreId;
      } else if (shopName && shopName !== '全部门店') {
        balanceHistoryWhere.shopName = shopName;
      }
      const res = await db.collection('report_logs')
        .where(balanceHistoryWhere)
        .orderBy('dateString', 'desc')
        .limit(15)
        .get();

      if (res.data && res.data.length > 0) {
        rawList = res.data;
      }
    } catch (err) {
      console.warn('云端调取失败，转入本地缓存:', err);
    }

    if (rawList.length === 0) {
      const localRecords = wx.getStorageSync('local_report_logs') || [];
      rawList = localRecords.filter((r: any) => {
        const rDate = r.dateString || r.reportDate || r.date || '';
        return rDate && rDate < currentDate;
      }).sort((a: any, b: any) => {
        const da = a.dateString || a.reportDate || a.date || '';
        const db = b.dateString || b.reportDate || b.date || '';
        return db.localeCompare(da);
      }).slice(0, 15);
    }

    const currentBal = parseFloat(this.data.yesterdayBalance || 0).toFixed(2);

    const formattedList = rawList.map((item: any) => {
      const yBal = parseFloat(item.yesterdayBalance || item.prevBalance || 0);
      const inc = parseFloat(item.income || item.loveIncome || item.totalDonation || 0);
      const exp = parseFloat(item.expense || item.todayExpense || item.totalExpense || 0);
      const endBal = parseFloat(item.todayBalance || item.closingBalance || item.endBalance || (yBal + inc - exp));
      const endBalStr = endBal.toFixed(2);

      return {
        reportDate: item.dateString || item.reportDate || item.date || '未知日期',
        yesterdayBal: yBal.toFixed(2),
        income: inc.toFixed(2),
        expense: exp.toFixed(2),
        endingBalance: endBalStr,
        isCurrentMatched: endBalStr === currentBal
      };
    });

    wx.hideLoading();

    this.setData({
      recentBalanceHistoryList: formattedList,
      showBalanceHistoryModal: true
    });
  },

  onCloseBalanceHistoryModal() {
    this.setData({ showBalanceHistoryModal: false });
  },

  onApplyHistoryBalance(e: any) {
    const item = e.currentTarget.dataset.item;
    const selectedBal = item.endingBalance;
    const selectedDate = item.reportDate;

    let displayLabel = selectedDate;
    if (/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
      displayLabel = `${selectedDate.substring(5, 7)}月${selectedDate.substring(8, 10)}日`;
    }

    this.setData({
      yesterdayBalance: selectedBal,
      isBalanceLocked: false,
      isManualAdjust: true,
      balanceDiff: parseFloat(selectedBal) - this.data.systemBalance,
      balanceMatchTip: `已一键代入 ${displayLabel} 期末结余 ¥${selectedBal}`,
      showBalanceHistoryModal: false
    });

    this.updateRealTimeBalance();

    wx.showToast({
      title: `已成功代入 ${displayLabel} 结余`,
      icon: 'success',
      duration: 1500
    });
  },

  onYesterdayBalanceInput(e: any) {
    const value = e.detail.value;
    const displayBalance = parseFloat(value) || 0;
    const { systemBalance } = this.data;
    
    const isManualAdjust = displayBalance !== systemBalance;
    const balanceDiff = isManualAdjust ? displayBalance - systemBalance : 0;
    
    this.setData({
      yesterdayBalance: value,
      isManualAdjust: isManualAdjust,
      balanceDiff: balanceDiff,
      adjustReason: isManualAdjust ? this.data.adjustReason : ''
    });

    this.updateRealTimeBalance();
    this.debouncedSaveDraft();
  },

  onDateChange(e: any) {
    const dateValue = e.detail.value;
    const parts = dateValue.split('-');
    const yy = parts[0];
    const mm = parts[1];
    const dd = parts[2];

    const todayStr = this.getFormattedDateStr(0);
    const yesterdayStr = this.getFormattedDateStr(-1);

    const storeId = this.data.currentStoreId || '';
    const hasEditPerm = this.data.permissions?.canEditBalance;

    if (storeId && hasEditPerm) {
      this.releaseDraftLock();
    }

    this.setData({
      reportDateValue: dateValue,
      reportDate: `${yy}年${mm}月${dd}日`,
      isTodaySelected: dateValue === todayStr,
      isYesterdaySelected: dateValue === yesterdayStr
    });
    this.checkExistingRecord(dateValue);
    this.loadBalanceForDate(dateValue);
    this.loadDraftByDate(dateValue, this.data.shopName);
    this.debouncedSaveDraft();

    if (storeId && hasEditPerm) {
      this.checkAndAcquireLock(storeId, dateValue);
    }
  },

  onSelectQuickDate(e: any) {
    const type = e.currentTarget.dataset.type;
    const dateStr = this.getFormattedDateStr(type === 'today' ? 0 : -1);
    const parts = dateStr.split('-');
    const yy = parts[0];
    const mm = parts[1];
    const dd = parts[2];

    this.setData({
      reportDateValue: dateStr,
      reportDate: `${yy}年${mm}月${dd}日`,
      isTodaySelected: type === 'today',
      isYesterdaySelected: type === 'yesterday'
    });
    this.checkExistingRecord(dateStr);
    this.loadBalanceForDate(dateStr);
    this.debouncedSaveDraft();

    const storeId = this.data.currentStoreId || '';
    if (storeId && this.data.permissions?.canEditBalance) {
      this.releaseDraftLock();
      this.checkAndAcquireLock(storeId, dateStr);
    }
  },

  checkExistingRecord(dateString: string) {
    const allRecords = wx.getStorageSync('local_report_logs') || [];
    const normalizeStore = (str: string) => (str || '').replace(/[区市省店\s]/g, '').trim();
    const cleanCurrentStore = normalizeStore(this.data.shopName);

    const parseDateToTuple = (dateStr: string): { y: number; m: number; d: number } | null => {
      if (!dateStr) return null;
      let str = String(dateStr).trim();
      if (/^\d{2}年/.test(str)) str = '20' + str;
      const match = str.match(/(\d{4})[\-\/年\.](\d{1,2})[\-\/月\.](\d{1,2})/);
      if (match) {
        return {
          y: parseInt(match[1], 10),
          m: parseInt(match[2], 10),
          d: parseInt(match[3], 10)
        };
      }
      return null;
    };

    const curTuple = parseDateToTuple(dateString);
    if (!curTuple) return;

    const exactRecord = allRecords.find((item: any) => {
      const recordStore = normalizeStore(item.shopName);
      const isStoreMatch = recordStore.includes(cleanCurrentStore) || cleanCurrentStore.includes(recordStore);
      const recTuple = parseDateToTuple(item.dateString || item.reportDate);
      return isStoreMatch && recTuple && recTuple.y === curTuple.y && recTuple.m === curTuple.m && recTuple.d === curTuple.d;
    });

    if (exactRecord) {
      wx.showModal({
        title: '已存在当日餐报',
        content: `检测到【${this.data.shopName}】在 ${curTuple.m}月${curTuple.d}日 已有餐报记录，是否直接载入修改？`,
        confirmText: '载入修改',
        cancelText: '新建覆盖',
        success: (res) => {
          if (res.confirm) {
            this.loadRecordIntoForm(exactRecord);
          }
        }
      });
    }
  },

  getFormattedDateStr(offsetDays: number = 0): string {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  async loadBalanceForDate(dateString: string) {
    if (this.data.isEditMode) return;
    
    const shopName = this.data.shopName;
    const mpAccount = this.data.mpAccount;

    if (!shopName || !dateString || !isValidIsoDate(dateString)) {
      return;
    }

    const targetPrevDate = getPrevDayIsoString(dateString);
    const shortPrevLabel = formatDateToCnShort(targetPrevDate);

    const reqSeq = ++this._balanceReqSeq;

    try {
      const result = await DataService.getPreviousBalance(shopName, mpAccount, dateString);

      if (reqSeq !== this._balanceReqSeq) {
        return;
      }

      if (result.success && result.data && result.data.balance != null) {
        const balance = this.validateBalance(result.data.balance);
        const systemBalanceNum = parseFloat(result.data.balance) || 0;
        
        const matchedDate = result.data.dateString;
        let tipDate = shortPrevLabel;
        if (matchedDate && isValidIsoDate(matchedDate)) {
          tipDate = formatDateToCnShort(matchedDate);
        }

        const matchType = result.data.matchType || '';
        let tipMsg = '';
        
        if (matchType === 'exact' || matchType === 'exact_date') {
          tipMsg = `✓ 已自动匹配 ${tipDate} 结余`;
        } else {
          tipMsg = `✓ 已自动代入 ${tipDate} 结余`;
        }

        console.log(`[loadBalanceForDate] ${tipMsg}, 金额: ¥${systemBalanceNum}`);

        this.setData({
          prevBalance: balance,
          yesterdayBalance: balance,
          systemBalance: systemBalanceNum,
          isManualAdjust: false,
          balanceDiff: 0,
          adjustReason: '',
          balanceMatchTip: tipMsg,
          yesterdayBalDisplay: systemBalanceNum.toFixed(2)
        });
        this.updateRealTimeBalance();
      } else {
        this.setData({
          prevBalance: '0.00',
          yesterdayBalance: '0.00',
          systemBalance: 0,
          isManualAdjust: false,
          balanceDiff: 0,
          adjustReason: '',
          balanceMatchTip: `💡 首次记账，请输入初始余额`,
          yesterdayBalDisplay: '0.00'
        });
        this.updateRealTimeBalance();
      }
    } catch (error) {
      console.error('[loadBalanceForDate] 查询失败:', error);
      if (reqSeq !== this._balanceReqSeq) return;
      this.setData({
        balanceMatchTip: `⚠️ 查询失败，请手动输入 ${shortPrevLabel} 余额`
      });
    }
  },

  formatToStandardIsoDate(dateStr: string): string {
    if (!dateStr) return '';
    let str = String(dateStr).trim();

    if (/^\d{2}年/.test(str)) {
      str = '20' + str;
    }

    const matches = str.match(/(\d{4})[\-\/年\.](\d{1,2})[\-\/月\.](\d{1,2})/);
    if (matches) {
      const mm = String(parseInt(matches[2], 10)).padStart(2, '0');
      const dd = String(parseInt(matches[3], 10)).padStart(2, '0');
      return `${matches[1]}-${mm}-${dd}`;
    }
    return str;
  },

  findAndFillYesterdayBalance(curTuple: { y: number; m: number; d: number }, prevTuple: { y: number; m: number; d: number }) {
    const allRecords = wx.getStorageSync('local_report_logs') || [];
    const normalizeStore = (str: string) => (str || '').replace(/[区市省店\s]/g, '').trim();
    const cleanCurrentStore = normalizeStore(this.data.shopName);

    const parseDateToTuple = (dateStr: string): { y: number; m: number; d: number } | null => {
      if (!dateStr) return null;
      let str = String(dateStr).trim();
      if (/^\d{2}年/.test(str)) str = '20' + str;
      const match = str.match(/(\d{4})[\-\/年\.](\d{1,2})[\-\/月\.](\d{1,2})/);
      if (match) {
        return {
          y: parseInt(match[1], 10),
          m: parseInt(match[2], 10),
          d: parseInt(match[3], 10)
        };
      }
      return null;
    };

    const findRecordByTuple = (y: number, m: number, d: number) => {
      return allRecords.find((item: any) => {
        const recordStore = normalizeStore(item.shopName);
        const isStoreMatch = recordStore.includes(cleanCurrentStore) || cleanCurrentStore.includes(recordStore);
        const recTuple = parseDateToTuple(item.dateString || item.reportDate);
        return isStoreMatch && recTuple && recTuple.y === y && recTuple.m === m && recTuple.d === d;
      });
    };

    const yesterdayRecord = findRecordByTuple(prevTuple.y, prevTuple.m, prevTuple.d);

    if (yesterdayRecord) {
      const matchedBalance = yesterdayRecord.todayBalance != null ? yesterdayRecord.todayBalance : (yesterdayRecord.closingBalance || yesterdayRecord.endBalance || '0.00');
      this.setData({
        yesterdayBalance: String(matchedBalance),
        balanceMatchTip: `已自动载入 ${prevTuple.m}月${prevTuple.d}日 结余 ¥${matchedBalance}`
      });
      return;
    }

    const sortedStoreRecords = allRecords
      .filter((item: any) => {
        const recordStore = normalizeStore(item.shopName);
        return recordStore.includes(cleanCurrentStore) || cleanCurrentStore.includes(recordStore);
      })
      .filter((item: any) => {
        const recTuple = parseDateToTuple(item.dateString || item.reportDate);
        return recTuple && (recTuple.y < curTuple.y || 
          (recTuple.y === curTuple.y && recTuple.m < curTuple.m) || 
          (recTuple.y === curTuple.y && recTuple.m === curTuple.m && recTuple.d < curTuple.d));
      })
      .sort((a: any, b: any) => {
        const ta = parseDateToTuple(a.dateString || a.reportDate);
        const tb = parseDateToTuple(b.dateString || b.reportDate);
        if (!ta || !tb) return 0;
        if (ta.y !== tb.y) return tb.y - ta.y;
        if (ta.m !== tb.m) return tb.m - ta.m;
        return tb.d - ta.d;
      });

    if (sortedStoreRecords.length > 0) {
      const lastRecord = sortedStoreRecords[0];
      const lastBalance = lastRecord.todayBalance != null ? lastRecord.todayBalance : (lastRecord.closingBalance || lastRecord.endBalance || '0.00');
      const lastTuple = parseDateToTuple(lastRecord.dateString || lastRecord.reportDate);
      const lastDateStr = lastTuple ? `${lastTuple.m}月${lastTuple.d}日` : '历史';
      this.setData({
        yesterdayBalance: String(lastBalance),
        balanceMatchTip: `⚠️ 未找到前一天记录，已套用 ${lastDateStr} 末次结余 ¥${lastBalance}`
      });
    } else {
      this.setData({
        yesterdayBalance: '',
        balanceMatchTip: `⚠️ 未匹配到 ${prevTuple.m}月${prevTuple.d}日 记录，请手动确认`
      });
    }
  },

  loadRecordIntoForm(record: any) {
    this.setData({
      isEditMode: true,
      reportDate: record.reportDate || '',
      reportDateValue: record.dateString || '',
      yesterdayBalance: record.yesterdayBalance != null ? String(record.yesterdayBalance) : '',
      otherDonation: record.otherDonation != null ? String(record.otherDonation) : '',
      expenses: record.expenses || '',
      dailyExpenseText: record.dailyExpenseText || '',
      fixedExpenseText: record.fixedExpenseText || '',
      volunteerCount: record.volunteerCount != null ? String(record.volunteerCount) : '',
      volunteerHours: record.volunteerHours != null ? String(record.volunteerHours) : '',
      diningCount: record.diningCount != null ? String(record.diningCount) : '',
      materialsInput: record.materialsInput || '',
      balanceMatchTip: '已载入历史记录'
    });

    if (record.donationItems && record.donationItems.length > 0) {
      const text = record.donationItems.map((item: any) => `${item.name} ${item.amount}`).join('\n');
      this.setData({ allDonations: text });
      this.updateParseResult(text);
    }

    if (record.materials && record.materials.length > 0) {
      const text = record.materials.map((m: any) => `${m.donor}：${m.item}${m.quantity}${m.unit}`).join('；');
      this.setData({ materialsInput: text });
      this.updateMaterialsParse(text);
    }
  },

  updateRealTimeBalance() {
    const { yesterdayBalance, otherDonation, parseResult, expenses, dailyExpenseText, fixedExpenseText } = this.data;

    const yesterdayBalanceNum = parseFloat(yesterdayBalance) || 0;
    const otherDonationNum = parseFloat(otherDonation) || 0;
    const donationsTotal = parseResult?.totalAmount || 0;
    const parsedTotalIncome = otherDonationNum + donationsTotal;

    const expensesNum = parseFloat(expenses) || 0;
    // 使用文本解析函数分别计算，避免小票合计重复累加
    const dailyExpenseNum = this.calculateTodayExpenseFromText(dailyExpenseText);
    const fixedExpenseNum = this.calculateTodayExpenseFromText(fixedExpenseText);
    const totalExpense = expensesNum + dailyExpenseNum + fixedExpenseNum;

    const todayBalance = yesterdayBalanceNum + parsedTotalIncome - totalExpense;
    const computedTodayBalance = todayBalance.toFixed(2);

    // 生成算式校验字符串
    const calculationFormulaText = `${yesterdayBalanceNum.toFixed(2)} + ${parsedTotalIncome.toFixed(2)} - ${totalExpense.toFixed(2)} = ${computedTodayBalance}`;

    this.setData({
      parsedTotalIncome,
      totalExpense,
      computedTodayBalance,
      yesterdayBalDisplay: yesterdayBalanceNum.toFixed(2),
      totalIncomeDisplay: parsedTotalIncome.toFixed(2),
      totalExpenseDisplay: totalExpense.toFixed(2),
      previewTodayBalanceDisplay: computedTodayBalance,
      calculationFormulaText
    });
  },

  validateBeforeSubmit(): Promise<boolean> {
    const { yesterdayBalance, diningCount, expenses, dailyExpenseText, fixedExpenseText } = this.data;

    const totalExpense = (parseFloat(expenses) || 0) + 
                        (parseFloat(dailyExpenseText) || 0) + 
                        (parseFloat(fixedExpenseText) || 0);

    return new Promise((resolve) => {
      if (!yesterdayBalance || parseFloat(yesterdayBalance) === 0) {
        wx.showModal({
          title: '昨日余额未填写',
          content: '当前“昨日店铺余额”为 0 或为空，生成的报表结余可能会有误，确定要继续吗？',
          confirmText: '继续生成',
          cancelText: '去填写',
          success: (res) => {
            if (res.confirm) {
              if (totalExpense > 0 && (!diningCount || parseInt(diningCount) === 0)) {
                wx.showModal({
                  title: '用餐人数未填写',
                  content: '检测到今日有开餐支出，但“今日结缘用餐人次”为 0，是否补充？',
                  confirmText: '仍要生成',
                  cancelText: '补充人数',
                  success: (res2) => resolve(res2.confirm)
                });
              } else {
                resolve(true);
              }
            } else {
              resolve(false);
            }
          }
        });
      } else if (totalExpense > 0 && (!diningCount || parseInt(diningCount) === 0)) {
        wx.showModal({
          title: '用餐人数未填写',
          content: '检测到今日有开餐支出，但“今日结缘用餐人次”为 0，是否补充？',
          confirmText: '仍要生成',
          cancelText: '补充人数',
          success: (res) => resolve(res.confirm)
        });
      } else {
        resolve(true);
      }
    });
  },

  resetForm() {
    wx.showModal({
      title: '提示',
      content: '确定要清空当前输入的名单、赞助金额和支出说明吗？',
      success: (res) => {
        if (res.confirm) {
          const now = new Date();
          const yyyy = String(now.getFullYear());
          const mm = String(now.getMonth() + 1).padStart(2, '0');
          const dd = String(now.getDate()).padStart(2, '0');
          
          this.setData({
            allDonations: '',
            otherDonation: '',
            expenses: '',
            dailyExpenseText: '',
            fixedExpenseText: '',
            reportResult: '',
            showResult: false,
            calculationFormulaText: '',
            reportDate: `${yyyy}年${mm}月${dd}日`,
            reportDateValue: `${yyyy}-${mm}-${dd}`,
            hasDraft: false
          });
          this.updateRealTimeBalance();
          
          this.clearDraft();
          wx.showToast({ title: '已清空', icon: 'success' });
        }
      }
    });
  },

  onInput(e: any) {
    const { field } = e.currentTarget.dataset;
    const value = e.detail.value;
    this.setData({ [field]: value });
    
    if (field === 'allDonations') {
      this.updateParseResult(value);
    }

    if (field === 'otherDonation' || field === 'expenses' || field === 'dailyExpenseText' || field === 'fixedExpenseText') {
      this.updateRealTimeBalance();
    }

    if (field === 'shopName' || field === 'mpAccount') {
      this.saveSettings();
    }

    if ((field === 'shopName' || field === 'mpAccount') && value.trim()) {
      // 防抖：店铺名称或公众号名称变更后延迟查询余额
      if (this._shopNameTimer) clearTimeout(this._shopNameTimer);
      this._shopNameTimer = setTimeout(() => {
        this.loadBalanceForDate(this.data.reportDateValue);
      }, 800);
    }

    this.debouncedSaveDraft();
  },

  onMaterialsInput(e: any) {
    const value = e.detail.value;
    this.updateMaterialsParse(value);
    this.debouncedSaveDraft();
  },

  onStapleStatusChange(e: any) {
    const { type, value } = e.currentTarget.dataset;
    if (type === 'rice') {
      this.setData({ stapleRiceStatus: value });
    } else if (type === 'oil') {
      this.setData({ stapleOilStatus: value });
    }
    this.debouncedSaveDraft();
  },

  updateParseResult(text: string) {
    const result = parseDonorText(text);
    this.setData({
      parseResult: result,
      totalParsedAmount: result.totalAmount.toFixed(2)
    });
    this.updateRealTimeBalance();
  },

  onChangeInputMode(e: any) {
    const mode = e.currentTarget.dataset.mode;
    const { parseResult, allDonations } = this.data;
    if (mode === 'form' && allDonations) {
      this.updateParseResult(allDonations);
    }
    this.setData({ inputMode: mode });
  },

  onSelectQuickAmount(e: any) {
    const amount = e.currentTarget.dataset.amount;
    this.setData({ singleAmount: String(amount) });
  },

  onInputSingleName(e: any) {
    this.setData({ singleName: e.detail.value });
  },

  onInputSingleAmount(e: any) {
    this.setData({ singleAmount: e.detail.value });
  },

  onAddSingleSupportItem() {
    const { singleName, singleAmount, allDonations, parseResult } = this.data;
    if (!singleName.trim()) {
      wx.showToast({ title: '请输入姓名', icon: 'none' });
      return;
    }
    const parsedAmount = parseFloat(singleAmount) || 0;
    if (parsedAmount <= 0) {
      wx.showToast({ title: '请输入有效金额', icon: 'none' });
      return;
    }

    const newLine = `${singleName.trim()} ${parsedAmount.toFixed(2)}`;
    const newText = allDonations ? `${allDonations}\n${newLine}` : newLine;
    
    this.setData({
      allDonations: newText,
      singleName: '',
      singleAmount: ''
    });
    this.updateParseResult(newText);
    this.debouncedSaveDraft();
  },

  onDeleteSupportItem(e: any) {
    const index = e.currentTarget.dataset.index;
    const { allDonations, parseResult } = this.data;
    
    if (parseResult.items && parseResult.items[index]) {
      const lines = allDonations.split('\n');
      const itemToDelete = parseResult.items[index];
      const targetAmount = parseFloat(itemToDelete.amount) || itemToDelete.amount;
      
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.includes(itemToDelete.name) && trimmed.includes(String(targetAmount))) {
          lines.splice(i, 1);
          break;
        }
      }
      
      const newText = lines.join('\n').replace(/\n{2,}/g, '\n').trim();
      this.setData({ allDonations: newText });
      this.updateParseResult(newText);
      this.debouncedSaveDraft();
    }
  },

  parseMaterials(text: string): { donor: string; item: string; quantity: string; unit: string }[] {
    if (!text || text.trim() === '') return [];

    const lines = text.split(/[;；\n]/).filter(l => l.trim());
    const materials: { donor: string; item: string; quantity: string; unit: string }[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 格式匹配：支持 "张三：大米50斤" / "李四：赞助食用油2箱" / "匿名：面粉100公斤"
      const match = trimmed.match(/^(.+?)[：:]\s*(?:赞助\s*)?(.+?)$/);
      if (match) {
        const donor = match[1].trim();
        const itemPart = match[2].trim();

        // 从物资描述中提取数量和单位
        const qtyMatch = itemPart.match(/^(.+?)\s*(\d+(?:\.\d+)?)\s*(斤|公斤|kg|箱|袋|桶|瓶|份|个)?$/i);
        if (qtyMatch) {
          materials.push({
            donor,
            item: qtyMatch[1].trim(),
            quantity: qtyMatch[2],
            unit: qtyMatch[3] || '份'
          });
        } else {
          // 无法解析数量时，整段作为物资描述
          materials.push({
            donor,
            item: itemPart,
            quantity: '1',
            unit: '份'
          });
        }
      } else {
        // 尝试简单格式：直接"大米50斤"（匿名服务记录）
        const simpleMatch = trimmed.match(/^(?:赞助\s*)?(.+?)\s*(\d+(?:\.\d+)?)\s*(斤|公斤|kg|箱|袋|桶|瓶|份|个)?$/i);
        if (simpleMatch) {
          materials.push({
            donor: '匿名爱心人士',
            item: simpleMatch[1].trim(),
            quantity: simpleMatch[2],
            unit: simpleMatch[3] || '份'
          });
        }
      }
    }

    return materials;
  },

  updateMaterialsParse(text: string) {
    const materials = this.parseMaterials(text);
    this.setData({ materials, materialsInput: text });
  },

  async chooseReceiptImages() {
    const remainingCount = 9 - this.data.receiptImages.length;
    if (remainingCount <= 0) {
      wx.showToast({ title: '已达 9 张上限，无法继续添加', icon: 'none' });
      return;
    }

    try {
      const res = await wx.chooseMedia({
        count: remainingCount,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed']
      });

      if (!res.tempFiles || res.tempFiles.length === 0) return;

      wx.showLoading({ title: '图片合规核验中...', mask: true });

      const fs = wx.getFileSystemManager();

      for (const file of res.tempFiles) {
        try {
          const base64Data = fs.readFileSync(file.tempFilePath, 'base64');
          const checkRes = await wx.cloud.callFunction({
            name: 'checkImageContent',
            data: { imgBuffer: base64Data, contentType: 'image/jpeg' }
          });
          const resultData = checkRes.result as any;

          if (resultData && !resultData.isSafe) {
            wx.hideLoading();
            wx.showModal({
              title: '⚠️ 违规内容拦截',
              content: '系统检测到您选择的小票图片包含不合规、敏感或非法广告内容，已被全量阻断，请重新拍摄上传真实合规小票！',
              showCancel: false,
              confirmColor: '#D32F2F'
            });
            return;
          }
        } catch (checkErr) {
          console.warn('🛡️ 图片安全预读失败，降级进入下一张校验:', checkErr);
        }
      }

      wx.hideLoading();

      const newImages = res.tempFiles.map(file => file.tempFilePath);
      const updatedImages = [...this.data.receiptImages, ...newImages];
      this.setData({ receiptImages: updatedImages });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '选择图片失败', icon: 'none' });
    }
  },

  previewReceipt(e: any) {
    const index = e.currentTarget.dataset.index;
    const images = this.data.receiptImages;
    if (images.length === 0 || index >= images.length) return;

    wx.previewImage({
      current: images[index],
      urls: images
    });
  },

  deleteReceipt(e: any) {
    const index = e.currentTarget.dataset.index;
    const images = [...this.data.receiptImages];
    images.splice(index, 1);
    this.setData({ receiptImages: images });
  },

  async uploadReceiptImages(): Promise<string[]> {
    const { receiptImages } = this.data;
    if (receiptImages.length === 0) {
      return [];
    }

    const now = new Date();
    const dateFolder = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const fileIDs: string[] = [];

    for (let i = 0; i < receiptImages.length; i++) {
      const tempFilePath = receiptImages[i];

      // 已是云存储文件地址，无需重复上传
      if (tempFilePath.indexOf('cloud://') === 0 || tempFilePath.indexOf('https://') === 0) {
        fileIDs.push(tempFilePath);
        continue;
      }

      const fileName = `${Date.now()}_${i}.jpg`;
      const cloudPath = `expenses/${dateFolder}/${fileName}`;

      try {
        const uploadResult = await wx.cloud.uploadFile({
          cloudPath: cloudPath,
          filePath: tempFilePath
        });
        fileIDs.push(uploadResult.fileID);
      } catch (error) {
        console.error('[uploadReceiptImages] 上传图片失败:', error);
        wx.showToast({ title: `图片${i + 1}上传失败`, icon: 'none' });
      }
    }

    return fileIDs;
  },

  showAdjustReasonModal(systemBalance: number, adjustedBalance: number, balanceDiff: number): Promise<void> {
    return new Promise((resolve) => {
      this._adjustResolve = resolve;
      this.setData({
        showAdjustModal: true,
        adjustModalInfo: {
          systemBalance: systemBalance.toFixed(2),
          adjustedBalance: adjustedBalance.toFixed(2),
          balanceDiff: Math.abs(balanceDiff).toFixed(2),
          balanceDiffSign: balanceDiff >= 0 ? '+' : '-'
        },
        adjustInput: this.data.adjustReason || ''
      });
    });
  },

  onOpenHistoryBalanceModal() {
    const allRecords = wx.getStorageSync('local_report_logs') || [];
    const normalizeStore = (str: string) => (str || '').replace(/[区市省店\s]/g, '').trim();
    const cleanCurrentStore = normalizeStore(this.data.shopName);

    const filteredRecords = allRecords
      .filter((item: any) => {
        const recordStore = normalizeStore(item.shopName);
        return recordStore.includes(cleanCurrentStore) || cleanCurrentStore.includes(recordStore);
      })
      .sort((a: any, b: any) => {
        const dateA = toStandardIsoDate(a.reportDate || a.dateString);
        const dateB = toStandardIsoDate(b.reportDate || b.dateString);
        return dateB.localeCompare(dateA);
      })
      .slice(0, 30)
      .map((item: any) => ({
        date: toStandardIsoDate(item.reportDate || item.dateString),
        store: item.shopName || '',
        balance: item.todayBalance || item.closingBalance || item.endBalance || '0.00'
      }));

    this.setData({
      showHistoryBalanceModal: true,
      historyBalanceList: filteredRecords
    });
  },

  closeHistoryBalanceModal() {
    this.setData({
      showHistoryBalanceModal: false
    });
  },

  onSelectHistoryBalance(e: any) {
    const { balance, date } = e.currentTarget.dataset;
    if (!balance) return;

    this.setData({
      yesterdayBalance: String(balance),
      systemBalance: parseFloat(balance) || 0,
      isManualAdjust: false,
      balanceDiff: 0,
      adjustReason: '',
      balanceMatchTip: `已手动选择 ${date} 结余 ¥${balance}`,
      showHistoryBalanceModal: false
    });

    this.updateRealTimeBalance();
    this.debouncedSaveDraft();
  },

  onAdjustInput(e: any) {
    this.setData({ adjustInput: e.detail.value });
  },

  onAdjustConfirm() {
    const reason = this.data.adjustInput.trim();
    this.setData({ adjustReason: reason, showAdjustModal: false });
    if (this._adjustResolve) {
      this._adjustResolve();
      this._adjustResolve = null;
    }
  },

  onAdjustCancel() {
    this.setData({ adjustReason: '', showAdjustModal: false });
    if (this._adjustResolve) {
      this._adjustResolve();
      this._adjustResolve = null;
    }
  },

  async onScanReceiptPhoto() {
    try {
      // #10 支持多张图片批量识别（最多5张）
      const chooseRes = await wx.chooseMedia({
        count: 5,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed']
      });

      if (!chooseRes.tempFiles || chooseRes.tempFiles.length === 0) {
        return;
      }

      const totalFiles = chooseRes.tempFiles.length;
      const results = [];
      const uploadedFileIds = [];

      wx.showLoading({ title: '图片合规核验中...', mask: true });

      const fs = wx.getFileSystemManager();

      for (let i = 0; i < totalFiles; i++) {
        try {
          const tempFilePath = chooseRes.tempFiles[i].tempFilePath;
          const base64Data = fs.readFileSync(tempFilePath, 'base64');
          const checkRes = await wx.cloud.callFunction({
            name: 'checkImageContent',
            data: { imgBuffer: base64Data, contentType: 'image/jpeg' }
          });
          const resultData = checkRes.result as any;

          if (resultData && !resultData.isSafe) {
            wx.hideLoading();
            wx.showModal({
              title: '⚠️ 违规内容拦截',
              content: '系统检测到您选择的图片包含不合规、敏感或非法广告内容，已被全量阻断，请重新拍摄上传真实合规小票！',
              showCancel: false,
              confirmColor: '#D32F2F'
            });
            return;
          }
        } catch (checkErr) {
          console.warn('🛡️ 图片安全预读失败，降级进入下一张校验:', checkErr);
        }
      }

      wx.showLoading({ title: 'AI 识别中 0/' + totalFiles, mask: true });

      // 批量识别
      for (let i = 0; i < totalFiles; i++) {
        try {
          const tempFilePath = chooseRes.tempFiles[i].tempFilePath;

          // 更新进度
          wx.showLoading({ title: 'AI 识别中 ' + (i + 1) + '/' + totalFiles, mask: true });

          const fileName = 'receipts/' + Date.now() + '_' + Math.random().toString(36).substr(2, 9) + '.jpg';
          const uploadRes = await wx.cloud.uploadFile({
            cloudPath: fileName,
            filePath: tempFilePath
          });
          uploadedFileIds.push(uploadRes.fileID);

          const ocrRes = await wx.cloud.callFunction({
            name: 'ocrExpenseReceipt',
            data: { fileID: uploadRes.fileID }
          });

          console.log('📄 [Debug] 云函数返回原始数据:', ocrRes);

          const result = ocrRes.result as any;
          if (result && result.success && (result.amount || result.totalAmount)) {
            const amount = parseFloat(result.amount || result.totalAmount || 0);
            results.push({ ...result, totalAmount: amount });
          } else {
            const realErrMsg = result?.errMsg || result?.message || result?.error || '云函数返回数据异常';
            console.error('❌ [OCR] 单张识别失败:', realErrMsg);
            results.push({ success: false, errMsg: realErrMsg, fileID: uploadRes.fileID });
          }
        } catch (e: any) {
          console.error('❌ [onScanReceiptPhoto] 单张识别捕获到异常:', e);
          const errStr = e.message || JSON.stringify(e);
          results.push({ success: false, errMsg: '调用异常: ' + errStr });
        }
      }

      wx.hideLoading();

      const successCount = results.filter(r => r.success).length;
      const failCount = results.length - successCount;

      if (successCount === 0) {
        // 全部失败
        const firstFail = results.find(r => !r.success);
        wx.showModal({
          title: '云函数返回错误诊断',
          content: '【诊断原因】:\n' + (firstFail?.errMsg || '未能识别票据信息') + '\n\n请手动填写或重新拍摄清晰的小票。',
          showCancel: false,
          confirmText: '知道了'
        });
        // 清理上传的图片
        this._cleanupReceiptImages(uploadedFileIds);
        return;
      }

      // 构建展示列表
      const receiptList = [];
      let totalAmount = 0;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r.success) continue;
        const amt = parseFloat(r.amount || r.totalAmount || 0);
        totalAmount += amt;
        receiptList.push({
          merchantName: r.merchant || ('第' + (i + 1) + '张'),
          amount: amt.toFixed(2),
          itemList: r.itemList || [],
          formattedText: r.formattedText || `小票金额：¥${amt.toFixed(2)}`
        });
      }

      this._ocrPendingResults = results.filter(r => r.success);
      this._ocrPendingFileIds = uploadedFileIds;

      this.setData({
        showOcrConfirmModal: true,
        ocrReceiptList: receiptList,
        ocrSuccessCount: successCount,
        ocrFailCount: failCount,
        ocrTotalAmount: totalAmount.toFixed(2)
      });
    } catch (e: any) {
      wx.hideLoading();
      console.error('❌ [Debug] 捕获到前端/网络异常:', e);
      
      const errMsg = e.message || JSON.stringify(e);
      if (errMsg && !errMsg.includes('cancel')) {
        wx.showModal({
          title: '调用过程崩溃',
          content: '【错误信息】:\n' + errMsg,
          showCancel: false,
          confirmText: '知道了'
        });
      }
    }
  },

  _pendingOcrResults: [],
  _pendingOcrFileIds: [],
  _ocrPendingResults: [],
  _ocrPendingFileIds: [],

  onOcrConfirmCancel() {
    this.setData({ showOcrConfirmModal: false });
    this._cleanupReceiptImages(this._ocrPendingFileIds);
    this._ocrPendingResults = [];
    this._ocrPendingFileIds = [];
  },

  onOcrAdjustCategory() {
    const results = this._ocrPendingResults || [];
    if (results.length === 0) return;

    this._pendingOcrResults = results;
    this._pendingOcrFileIds = this._ocrPendingFileIds;
    this.setData({ showOcrConfirmModal: false });
    this._showCategoryAdjust();
  },

  onEditOcrItemName(e: any) {
    const receiptIdx = e.currentTarget.dataset.receiptIndex;
    const itemIdx = e.currentTarget.dataset.itemIndex;
    const val = e.detail.value;
    const list = [...this.data.ocrReceiptList];
    list[receiptIdx].itemList[itemIdx].name = val;
    this.setData({ ocrReceiptList: list });
  },

  onEditOcrItemPrice(e: any) {
    const receiptIdx = e.currentTarget.dataset.receiptIndex;
    const itemIdx = e.currentTarget.dataset.itemIndex;
    const val = e.detail.value;
    const list = [...this.data.ocrReceiptList];
    list[receiptIdx].itemList[itemIdx].price = val;

    // 动态重新计算该小票总金额
    const newTotal = list[receiptIdx].itemList.reduce((sum: number, item: any) => sum + (parseFloat(item.price) || 0), 0);
    list[receiptIdx].amount = newTotal.toFixed(2);

    // 重新计算所有小票合计
    const ocrTotalAmount = list.reduce((sum: number, r: any) => sum + parseFloat(r.amount || 0), 0).toFixed(2);

    this.setData({ ocrReceiptList: list, ocrTotalAmount });
  },

  onOcrAutoFill() {
    const results = this._ocrPendingResults || [];
    if (results.length === 0) {
      this.setData({ showOcrConfirmModal: false });
      return;
    }

    // 用弹窗中编辑后的最新数据更新 pending results
    const editedList = this.data.ocrReceiptList || [];
    for (let i = 0; i < editedList.length; i++) {
      const edited = editedList[i];
      const pending = results.find((r: any) => r.success && (r.merchant || ('第' + (i + 1) + '张')) === edited.merchantName);
      if (pending && edited.itemList) {
        pending.itemList = edited.itemList;
        pending.amount = edited.amount;
        pending.formattedText = edited.itemList.map((item: any) => `• ${item.name}：¥${item.price}`).join('\n');
      }
    }

    let dailyItemsText = '';
    let fixedItemsText = '';
    let otherItemsText = '';
    let dailyTotal = 0;
    let fixedTotal = 0;
    let otherTotal = 0;

    for (const r of results) {
      if (!r.success) continue;

      const cat = r.category || 'daily_food';
      const amount = parseFloat(r.amount || r.totalAmount || 0);

      let detailText = '';
      if (r.itemList && r.itemList.length > 0) {
        const lines = r.itemList.map((item: any) => `• ${item.name}：¥${item.price}`);
        detailText = lines.join('\n');
      } else {
        detailText = r.formattedText || r.detailText || `食材采购小票：¥${amount.toFixed(2)}`;
      }

      if (cat === 'daily_food') {
        dailyItemsText += (dailyItemsText ? '\n\n' : '') + detailText;
        dailyTotal += amount;
      } else if (cat === 'major_expense') {
        fixedItemsText += (fixedItemsText ? '\n\n' : '') + detailText;
        fixedTotal += amount;
      } else {
        otherItemsText += (otherItemsText ? '\n\n' : '') + detailText;
        otherTotal += amount;
      }
    }

    if (dailyItemsText) {
      const current = this.data.dailyExpenseText || '';
      this.setData({ dailyExpenseText: current ? (current + '\n\n' + dailyItemsText) : dailyItemsText });
    }
    if (fixedItemsText) {
      const current = this.data.fixedExpenseText || '';
      this.setData({ fixedExpenseText: current ? (current + '\n\n' + fixedItemsText) : fixedItemsText });
    }
    if (otherItemsText) {
      const current = this.data.dailyExpenseText || '';
      this.setData({ dailyExpenseText: current ? (current + '\n\n' + otherItemsText) : current });
    }

    this._saveReceiptHistory(results.filter(r => r.success).map(r => ({
      amount: r.totalAmount,
      category: r.category,
      merchant: r.merchant || '',
      receiptDate: r.receiptDate || '',
      timestamp: Date.now()
    })));

    this.setData({ showOcrConfirmModal: false });

    wx.showToast({
      title: '已填入商品明细 ¥' + (dailyTotal + fixedTotal + otherTotal).toFixed(2),
      icon: 'success',
      duration: 2000
    });

    this.updateRealTimeBalance();

    this._ocrPendingResults = [];
    this._ocrPendingFileIds = [];
  },

  _showCategoryAdjust() {
    const results = this._pendingOcrResults || [];
    if (results.length === 0) return;

    wx.showActionSheet({
      itemList: ['全部归入食材餐饮', '全部归入大额专项', '手动逐张调整'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this._applyOcrCategory('daily_food');
        } else if (res.tapIndex === 1) {
          this._applyOcrCategory('major_expense');
        } else {
          this._adjustOcrCategoryOneByOne(0);
        }
      },
      fail: () => {
        this._cleanupReceiptImages(this._pendingOcrFileIds);
      }
    });
  },

  _applyOcrCategory(category) {
    const results = this._pendingOcrResults || [];
    let total = 0;
    let itemsText = '';

    for (const r of results) {
      let detail = '';
      if (r.itemList && r.itemList.length > 0) {
        detail = r.itemList.map(item => `• ${item.name}：¥${item.price}`).join('\n');
      } else {
        detail = r.formattedText || r.detailText || `食材采购小票：¥${r.totalAmount}`;
      }
      itemsText += (itemsText ? '\n\n' : '') + detail;
      total += r.totalAmount;
    }

    if (category === 'daily_food') {
      const current = this.data.dailyExpenseText || '';
      this.setData({ dailyExpenseText: current ? (current + '\n' + itemsText) : itemsText });
    } else if (category === 'major_expense') {
      const current = this.data.fixedExpenseText || '';
      this.setData({ fixedExpenseText: current ? (current + '\n' + itemsText) : itemsText });
    }

    this._cleanupReceiptImages(this._pendingOcrFileIds);
    this._pendingOcrResults = [];
    this._pendingOcrFileIds = [];

    wx.showToast({ title: '已填入 ¥' + total.toFixed(2), icon: 'success', duration: 2000 });

    this.updateRealTimeBalance();
  },

  _adjustOcrCategoryOneByOne(index) {
    const results = this._pendingOcrResults || [];
    if (index >= results.length) {
      this._cleanupReceiptImages(this._pendingOcrFileIds);
      this._pendingOcrResults = [];
      this._pendingOcrFileIds = [];
      return;
    }

    const r = results[index];
    const title = (r.merchant || '第' + (index + 1) + '张') + ' ¥' + r.totalAmount;

    wx.showActionSheet({
      itemList: ['归入食材餐饮', '归入大额专项', '跳过不记录'],
      success: (res) => {
        let detail = '';
        if (r.itemList && r.itemList.length > 0) {
          detail = r.itemList.map(item => item.name + ' ¥' + item.price).join('\n');
        } else {
          detail = r.formattedText || r.detailText || (r.merchant || '小票') + r.totalAmount;
        }
        if (res.tapIndex === 0) {
          const current = this.data.dailyExpenseText || '';
          this.setData({ dailyExpenseText: current ? (current + ' ' + detail) : detail });
        } else if (res.tapIndex === 1) {
          const current = this.data.fixedExpenseText || '';
          this.setData({ fixedExpenseText: current ? (current + ' ' + detail) : detail });
        }
        // 继续下一张
        this._adjustOcrCategoryOneByOne(index + 1);
      },
      fail: () => {
        // 用户取消，跳过
        this._adjustOcrCategoryOneByOne(index + 1);
      }
    });
  },

  _cleanupReceiptImages(fileIds) {
    // #5 清理上传的小票图片（避免占用云存储）
    if (!fileIds || fileIds.length === 0) return;
    try {
      wx.cloud.deleteFile({
        fileList: fileIds
      }).catch(e => console.warn('[清理小票图片失败:', e));
    } catch (e) {
      console.warn('[清理小票图片失败:', e);
    }
  },

  _saveReceiptHistory(items) {
    // #9 保存识别历史（最近20条）
    try {
      const key = 'receipt_ocr_history';
      const existing = wx.getStorageSync(key);
      const history = existing ? JSON.parse(existing) : [];
      history.push(...items);
      const trimmed = history.length > 20 ? history.slice(-20) : history;
      wx.setStorageSync(key, JSON.stringify(trimmed));
    } catch (e) {
      console.warn('[保存识别历史失败:', e);
    }
  },

  async generateReport() {
    console.log('[generateReport] 函数被调用，开始执行');

    if (this.isSubmitting) {
      console.log('[防重刷] 正在提交中，拦截重复点击');
      wx.showToast({ title: '请稍候...', icon: 'none', duration: 1000 });
      return;
    }

    const isValid = await this.validateBeforeSubmit();
    if (!isValid) {
      return;
    }

    try {
      const { isManualAdjust, systemBalance, yesterdayBalance, balanceDiff, parseResult, shopName } = this.data;

      console.log('[generateReport] data 状态:', {
        isManualAdjust,
        parseResultItems: parseResult?.items?.length || 0,
        allDonations: this.data.allDonations?.length || 0
      });

      // 检查 parseResult 是否存在
      if (!parseResult) {
        console.error('[generateReport] parseResult 未初始化');
        wx.showModal({
          title: '数据异常',
          content: '❌ 解析结果未初始化，请先输入捐款名单后重试。\n\n如问题持续请截图反馈。',
          showCancel: false
        });
        return;
      }

      console.log('[generateReport] parseResult 检查通过:', JSON.stringify(parseResult));

      // 允许空数据继续执行（用户可能只输入了其他支持或支出）
      const { items = [], totalAmount: donationsTotal = 0 } = parseResult;

      console.log('[generateReport] 解析数据:', { itemsCount: items.length, donationsTotal });

      // 检查必要字段是否存在
      if (!shopName) {
        wx.showModal({
          title: '数据异常',
          content: '❌ 店铺名称未设置，请在设置中配置店铺名称。',
          showCancel: false
        });
        return;
      }

      if (isManualAdjust) {
        await this.showAdjustReasonModal(systemBalance, parseFloat(yesterdayBalance) || 0, balanceDiff);

        if (!this.data.adjustReason || this.data.adjustReason.trim() === '') {
          wx.showToast({ title: '平账原因不能为空，请如实填写', icon: 'none' });
          return;
        }
      }

      this.isSubmitting = true;
      this.setData({ isSubmitting: true });
      wx.showLoading({ title: '正在生成文本...', mask: true });

      try {
        // ====== 第一步：纯前端生成文本（不依赖云端，绝不阻塞） ======
        const { reportDate, otherDonation, expenses, dailyExpenseText, fixedExpenseText, shopName, mpAccount, adjustReason, receiptImages, reportDateValue, thankText, slogan1, slogan2, materials, volunteerCount, volunteerHours, diningCount, stapleRiceStatus, stapleOilStatus, mergeToReportText, announcement } = this.data;
        const prevBalanceNum = parseFloat(yesterdayBalance) || 0;
        const b4_total = parseFloat(otherDonation) || 0;

        const extractExpenseAmount = (text: string): number => {
          if (!text) return 0;
          let total = 0;
          const lines = text.split('\n');
          lines.forEach(line => {
            const trimmed = line.trim();
            // 防重守卫：跳过含合计/虚线的总结行
            if (
              trimmed.includes('小票合计') ||
              trimmed.includes('合计') ||
              trimmed.includes('总计') ||
              trimmed.includes('----') ||
              trimmed.includes('====') ||
              trimmed.startsWith('----------------')
            ) {
              return;
            }
            const matches = trimmed.match(/[¥￥]\s*(\d+\.?\d*)|(\d+\.?\d*)\s*元/g) || [];
            matches.forEach(m => {
              const numMatch = m.match(/\d+\.?\d*/);
              if (numMatch) {
                total += parseFloat(numMatch[0]);
              }
            });
          });
          return parseFloat(total.toFixed(2));
        };

        const dailyExpenseTotal = extractExpenseAmount(dailyExpenseText);
        const fixedExpenseTotal = extractExpenseAmount(fixedExpenseText);
        const expenseTotal = dailyExpenseTotal + fixedExpenseTotal;

        const todayTotalSum = Math.round((donationsTotal + b4_total) * 100) / 100;
        const newBalanceSum = Math.round((prevBalanceNum + todayTotalSum - expenseTotal) * 100) / 100;

        const dateString = deriveDateString(reportDateValue, reportDate);

        const report = generateReportText({
          shopName: shopName,
          dateString: dateString,
          reportDate: reportDate,
          items: items,
          totalAmount: donationsTotal,
          otherDonation: b4_total,
          yesterdayBalance: prevBalanceNum,
          expenseAmount: expenseTotal,
          dailyExpenseTotal: dailyExpenseTotal,
          fixedExpenseTotal: fixedExpenseTotal,
          todayBalance: newBalanceSum,
          expenses: expenses,
          dailyExpenseText: dailyExpenseText,
          fixedExpenseText: fixedExpenseText,
          mpAccount: mpAccount,
          thankText: thankText,
          slogan1: slogan1,
          slogan2: slogan2,
          materials: materials || [],
          volunteerCount: parseFloat(volunteerCount) || 0,
          volunteerHours: parseFloat(volunteerHours) || 0,
          diningCount: parseFloat(diningCount) || 0,
          stapleRiceStatus: stapleRiceStatus,
          stapleOilStatus: stapleOilStatus,
          noticeTag: announcement?.tag,
          noticeTitle: announcement?.title,
          noticeContent: announcement?.content,
          mergeToReportText: mergeToReportText
        });

        console.log('[generateReport] 文本生成完成，长度:', report.length);

        // 内容安全检测 - 设置超时保护
        let isContentSafe = true;
        try {
          isContentSafe = await Promise.race([
            this.checkContentSafety(report),
            new Promise<boolean>((resolve) => {
              setTimeout(() => {
                console.warn('[checkContentSafety] 检测超时，跳过检测');
                resolve(true);
              }, 3000); // 3秒超时
            })
          ]);
        } catch (safeErr: any) {
          console.warn('[checkContentSafety] 检测异常，跳过检测:', safeErr);
          isContentSafe = true;
        }

        if (!isContentSafe) {
          wx.hideLoading();
          this.isSubmitting = false;
          this.setData({ isSubmitting: false });
          return;
        }

        // ====== 立即显示结果 + 复制到剪贴板（纯前端，不等待保存） ======
        this.setData({
          reportResult: report,
          showResult: true,
          isResultExpanded: true
        });

        wx.setClipboardData({
          data: report,
          success() {
            wx.showToast({ title: '文本已复制', icon: 'success', duration: 1500 });
          },
          fail() {
            console.warn('[generateReport] 自动复制失败，用户可手动复制');
          }
        });

        wx.hideLoading();

        // ====== 第二步：异步保存到数据库（后台静默，失败不影响已生成的文本） ======
        const majorExpenseItems = this.parseExpenseTextToItems(fixedExpenseText, fixedExpenseTotal, dateString);
        const dailyIngredientItems = this.parseExpenseTextToItems(dailyExpenseText, dailyExpenseTotal, dateString);

        const submitData = {
          _id: this.data.editReportId || '',
          dateString: dateString,
          reportDate: reportDate,
          shopName: shopName,
          mpAccount: mpAccount,
          yesterdayBalance: prevBalanceNum,
          otherDonation: b4_total,
          listDonationTotal: donationsTotal,
          expenseAmount: expenseTotal,
          dailyExpenseTotal: dailyExpenseTotal,
          fixedExpenseTotal: fixedExpenseTotal,
          expenses: expenses,
          dailyExpenseText: dailyExpenseText,
          fixedExpenseText: fixedExpenseText,
          majorExpenseItems: majorExpenseItems,
          dailyIngredientItems: dailyIngredientItems,
          todayBalance: newBalanceSum,
          reportText: report,
          donationItems: items,
          receiptImages: receiptImages || [],
          isManualAdjust: isManualAdjust,
          systemBalance: systemBalance,
          adjustedBalance: prevBalanceNum,
          balanceDiff: balanceDiff,
          adjustReason: adjustReason || '',
          materials: materials || [],
          volunteerCount: parseFloat(volunteerCount) || 0,
          volunteerHours: parseFloat(volunteerHours) || 0,
          diningCount: parseFloat(diningCount) || 0,
          stapleRiceStatus: stapleRiceStatus,
          stapleOilStatus: stapleOilStatus
        };

        let guardPassed = true;
        try {
          guardPassed = await this.runGuardrailChecks(submitData);
        } catch (guardErr) {
          console.warn('[runGuardrailChecks] 风控校验异常，已降级放行:', guardErr);
          guardPassed = true;
        }

        if (!guardPassed) {
          wx.hideLoading();
          return;
        }

        await this.saveReportAsync(submitData);

        this.clearDraft();

      } catch (innerError: any) {
        wx.hideLoading();
        const errMsg = innerError instanceof Error ? innerError.message : String(innerError);
        console.error('[generateReport] 生成文本异常:', innerError);
        wx.showModal({
          title: '生成文本失败',
          content: `❌ 错误信息：${errMsg}\n\n请检查输入内容是否正确，或截图反馈给开发者。`,
          showCancel: false,
          confirmText: '我知道了'
        });
      }
    } catch (outerError: any) {
      wx.hideLoading();
      const errMsg = outerError instanceof Error ? outerError.message : String(outerError);
      console.error('[generateReport] 外层异常:', outerError);
      wx.showModal({
        title: '系统异常',
        content: `❌ 外层错误：${errMsg}`,
        showCancel: false
      });
    } finally {
      this.isSubmitting = false;
      this.setData({ isSubmitting: false });
    }
  },

  async saveReportAsync(submitData: any) {
    try {
      // 上传支出凭证图片（已上传的云地址会自动跳过）
      const uploadedReceiptImages = await this.uploadReceiptImages();
      submitData.receiptImages = uploadedReceiptImages;

      const saveResult = await DataService.saveReport(submitData);

      if (!saveResult.success) {
        const errDetail = saveResult.errorDetail || saveResult.message || '未知错误';
        const isCollectionMissing = errDetail.includes('-501000') || errDetail.includes('resource') || errDetail.includes('not exist');
        const isAllZero = errDetail === 'all_zero_skipped';

        if (!isAllZero) {
          wx.showModal({
            title: isCollectionMissing ? '云数据库集合未创建' : '保存到云端失败',
            content: isCollectionMissing
              ? `❌ 错误详情：${errDetail}\n\n💡 请在云开发控制台手动创建 report_logs 集合（权限建议：仅创建者可读写）。\n\n账目已安全暂存本地。`
              : `❌ 错误详情：${errDetail}\n\n账目已安全暂存本地，联网后将自动同步。`,
            showCancel: false,
            confirmText: '我知道了'
          });

          saveToQueue(submitData);
          this.updateOfflineQueueCount();
        } else {
          console.log('[saveReportAsync] 全0无效数据，已自动跳过保存');
        }
      } else {
        console.log('[saveReportAsync] 保存成功:', saveResult.message);
        // 用上传后的云地址更新页面状态，避免重复上传和编辑丢失
        this.setData({ receiptImages: uploadedReceiptImages });
        this.updateOfflineQueueCount();
        
        if (this.data.isEditMode) {
          await this.triggerAtomicCascadeUpdate(submitData);
        } else {
          console.log('🚀 [DEBUG] 保存成功，即将触发级联重算...', {
            shopName: submitData.shopName,
            dateString: submitData.dateString
          });
          await this.triggerCascadeRecalculation(submitData);
          console.log('✅ [DEBUG] 级联重算调用完成');
        }

        wx.showToast({ title: '保存成功', icon: 'success', duration: 1500 });
        recordSuccessfulSubmit(); // 记录提交成功（用于频率限制）

        if (this.data.isEditMode) {
          this.isNavigating = true;
          setTimeout(() => {
            wx.navigateBack({
              delta: 1,
              fail: () => {
                this.isNavigating = false;
              }
            });
          }, 1500);
        }
      }
    } catch (err: any) {
      console.error('[saveReportAsync] 保存异常:', err);
      const errMsg = err.errMsg || err.message || '未知错误';
      const isNetworkError = errMsg.includes('timeout') || errMsg.includes('Network') ||
                           errMsg.includes('网络') || errMsg.includes('fail') ||
                           errMsg.includes('connect') || errMsg.includes('abort');

      if (isNetworkError) {
        saveToQueue(submitData);
        this.updateOfflineQueueCount();
        wx.showToast({ title: '已暂存本地，联网后同步', icon: 'none', duration: 2000 });
      } else {
        wx.showModal({
          title: '保存失败（详细错误）',
          content: `❌ 错误码: ${err.errCode || 'N/A'}\n错误信息: ${errMsg}\n\n账目已暂存本地，请检查云开发环境。`,
          showCancel: false,
          confirmText: '我知道了'
        });
      }
    }
  },

  async runGuardrailChecks(submitData: any): Promise<boolean> {
    try {
      // #11 前置快速频率检查
      const freqCheck = canSubmitNow();
      if (!freqCheck.canSubmit) {
        wx.showModal({
          title: '提交受限',
          content: freqCheck.reason,
          showCancel: false,
          confirmText: '知道了'
        });
        return false;
      }

      const allReports = wx.getStorageSync('local_report_logs') || [];
      const storeName = this.data.shopName || '';
      const storeReports = allReports.filter((r: any) => r.shopName === storeName);

      let avgDailyFoodExpense = 0;
      let avgDailyIncome = 0;
      let avgBalance = 0;
      let lastReportDate = '';
      let lastBalance = 0;

      if (storeReports.length > 0) {
        const sorted = [...storeReports].sort((a: any, b: any) =>
          (a.reportDate || '').localeCompare(b.reportDate || '')
        );

        const recentReports = sorted.slice(-14);

        // 平均食材支出
        const validFoodExpenses = recentReports
          .map((r: any) => parseFloat(r.dailyExpenseTotal || r.dailyExpense || 0))
          .filter((v: number) => v > 0);
        if (validFoodExpenses.length > 0) {
          avgDailyFoodExpense = validFoodExpenses.reduce((sum: number, v: number) => sum + v, 0) / validFoodExpenses.length;
        }

        // 平均收入
        const validIncomes = recentReports
          .map((r: any) => parseFloat(r.listDonationTotal || 0) + parseFloat(r.otherDonation || 0))
          .filter((v: number) => v > 0);
        if (validIncomes.length > 0) {
          avgDailyIncome = validIncomes.reduce((sum: number, v: number) => sum + v, 0) / validIncomes.length;
        }

        // 平均余额
        const validBalances = recentReports
          .map((r: any) => parseFloat(r.todayBalance || 0))
          .filter((v: number) => v > 0);
        if (validBalances.length > 0) {
          avgBalance = validBalances.reduce((sum: number, v: number) => sum + v, 0) / validBalances.length;
        }

        lastReportDate = sorted[sorted.length - 1]?.reportDate || '';
        lastBalance = parseFloat(sorted[sorted.length - 1]?.todayBalance || 0);
      }

      const guardResult: GuardrailResult = validateReportGuardrails(
        {
          yesterdayBalance: parseFloat(submitData.yesterdayBalance || 0),
          todayBalance: parseFloat(submitData.todayBalance || 0),
          income: parseFloat(submitData.listDonationTotal || 0) + parseFloat(submitData.otherDonation || 0),
          dailyExpense: parseFloat(submitData.dailyExpenseTotal || 0),
          totalDiners: parseFloat(submitData.diningCount || 0) + parseFloat(submitData.volunteerCount || 0),
          volunteerCount: parseFloat(submitData.volunteerCount || 0),
          volunteerHours: parseFloat(submitData.volunteerHours || 0),
          reportDate: submitData.reportDate || ''
        },
        {
          avgDailyFoodExpense,
          avgDailyIncome,
          avgBalance,
          lastReportDate,
          lastBalance
        }
      );

      if (!guardResult.canSubmit) {
        wx.showModal({
          title: '无法提交',
          content: guardResult.blockReason,
          showCancel: false,
          confirmText: '返回修改'
        });
        return false;
      }

      if (guardResult.hasWarning) {
        return new Promise<boolean>((resolve) => {
          wx.showModal({
            title: '数据异常提醒',
            content: guardResult.warningMessage,
            confirmText: '确认无误',
            cancelText: '重新检查',
            success: (res) => {
              if (res.confirm) {
                recordWarningConfirmed(); // 记录警告确认
              }
              resolve(res.confirm || false);
            }
          });
        });
      }

      // #12 gapDaysNotice 改为阻塞 modal，等待用户确认后再继续
      if (guardResult.gapDaysNotice) {
        return new Promise<boolean>((resolve) => {
          wx.showModal({
            title: '日期提醒',
            content: guardResult.gapDaysNotice,
            showCancel: false,
            confirmText: '继续提交',
            success: (res) => {
              resolve(res.confirm || false);
            }
          });
        });
      }

      return true;
    } catch (e) {
      // 风控校验异常时平滑降级放行，不阻塞用户正常使用
      console.warn('[runGuardrailChecks] 风控校验异常，已降级放行:', e);
      return true;
    }
  },

  async triggerCascadeRecalculation(submitData: any) {
    try {
      const shopName = submitData.shopName || this.data.shopName || '';
      const fromDate = submitData.dateString || '';

      if (!shopName || !fromDate) {
        console.log('[triggerCascadeRecalculation] 参数不足，跳过级联重算');
        return;
      }

      console.log('🚀 [DEBUG] 正在触发级联重算云函数...', { shopName, fromDate });

      const res = await wx.cloud.callFunction({
        name: 'recalculateLedgerChain',
        data: {
          shopName,
          fromDate
        }
      });

      console.log('✅ [DEBUG] 云函数重算返回结果:', res.result);

      const result = res.result as any;
      if (result && result.success && result.updatedCount && result.updatedCount > 0) {
        wx.showModal({
          title: '级联校正完成',
          content: `已为您自动重算并修正了 ${result.updatedCount} 条账目余额！`,
          showCancel: false,
          confirmText: '我知道了'
        });
      }
    } catch (err) {
      console.error('[triggerCascadeRecalculation] 级联重算失败:', err);
    }
  },

  async triggerAtomicCascadeUpdate(submitData: any) {
    try {
      const shopName = submitData.shopName || this.data.shopName || '';
      const fromDate = submitData.dateString || '';

      if (!fromDate) {
        console.log('[triggerAtomicCascadeUpdate] 参数不足，回退到普通级联重算');
        await this.triggerCascadeRecalculation(submitData);
        return;
      }

      console.log('🚀 [DEBUG] 正在触发原子化级联更新...', { shopName, fromDate });

      const res = await wx.cloud.callFunction({
        name: 'recalculateLedgerChain',
        data: {
          shopName,
          fromDate
        }
      });

      console.log('✅ [DEBUG] 原子化级联更新返回结果:', res.result);

      const result = res.result as any;
      if (result && result.success && result.updatedCount && result.updatedCount > 0) {
        wx.showModal({
          title: '级联校正完成',
          content: `已为您自动重算并修正了 ${result.updatedCount} 条账目余额！`,
          showCancel: false,
          confirmText: '我知道了'
        });
      }
    } catch (err) {
      console.error('[triggerAtomicCascadeUpdate] 原子化级联更新失败，回退到普通级联重算:', err);
      await this.triggerCascadeRecalculation(submitData);
    }
  },

  resetFormSilently() {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');

    this.setData({
      allDonations: '',
      otherDonation: '',
      expenses: '',
      dailyExpenseText: '',
      fixedExpenseText: '',
      reportResult: '',
      showResult: false,
      reportDate: `${yyyy}年${mm}月${dd}日`,
      reportDateValue: `${yyyy}-${mm}-${dd}`,
      hasDraft: false,
      materials: [],
      materialsInput: '',
      volunteerCount: '',
      volunteerHours: ''
    });
    this.clearDraft();
    console.log('[resetFormSilently] 保存成功，表单已重置');
  },

  copyText() {
    wx.setClipboardData({
      data: this.data.reportResult,
      success() {
        wx.showToast({ title: '复制成功', icon: 'success' });
      }
    });
  },

  onToggleResultExpand() {
    this.setData({
      isResultExpanded: !this.data.isResultExpanded
    });
  },

  updateOfflineQueueCount() {
    const count = getQueueCount();
    this.setData({ offlineQueueCount: count });
  },

  onShow() {
    // 重置路由防重锁
    this.isNavigating = false;

    // #11 清理过期的频率记录和警告确认记录
    cleanExpiredFrequencyRecords();

    // 任务C：如果有待执行的锚点滚动，则在 onShow 中触发
    // （需等待 onShow 完成 setData 后再执行，确保 DOM 已渲染）
    if (this._pendingScrollTarget) {
      const target = this._pendingScrollTarget;
      // 清除暂存，避免下次 onShow 重复触发
      this._pendingScrollTarget = '';
      // 延迟 300ms 等待页面 setData 与 DOM 渲染完成
      setTimeout(() => {
        this.scrollToAnchorAndHighlight(target);
      }, 300);
    } else {
      // 兼容 navigateBack 场景：通过 globalData 传递的待滚动目标
      try {
        const app = getApp() as any;
        if (app.globalData && app.globalData.pendingScrollTarget) {
          const target = app.globalData.pendingScrollTarget;
          app.globalData.pendingScrollTarget = '';
          setTimeout(() => {
            this.scrollToAnchorAndHighlight(target);
          }, 300);
        }
      } catch (e) {
        /* ignore */
      }
    }

    this.refreshUserRoleView();

    const activeStore = getSelectedStore();
    if (activeStore && activeStore.storeName !== this.data.shopName) {
      this.setData({
        shopName: activeStore.storeName
      });
      if (typeof this.autoFetchPreviousBalance === 'function') {
        this.autoFetchPreviousBalance(this.data.reportDateRaw);
      }
    }

    this.loadSettings();
    this.loadLastBalance();
    if (typeof (this as any).loadVolunteerStats === 'function') {
      (this as any).loadVolunteerStats();
    }
    DataService.syncLocalDataToCloud();
    this.updateOfflineQueueCount();
    this.autoSyncOfflineQueue();

    const app = getApp();
    app.globalData.onNetworkReconnected = () => {
      this.autoSyncOfflineQueue();
    };

    this.loadEditReportData();

    // 切后台回来后重新获取编辑锁
    const storeId = this.data.currentStoreId || '';
    const reportDate = this.data.reportDateRaw || '';
    if (storeId && reportDate && this.data.permissions?.canEditBalance) {
      this.checkAndAcquireLock(storeId, reportDate);
    }
  },

  /**
   * 任务C：锚点聚焦 + 高亮动画
   * 通过 wx.createSelectorQuery 计算目标元素位置，使用 wx.pageScrollTo 平滑滚动到屏幕中央，
   * 然后为目标元素添加 .highlight-pulse 动画类，2秒后自动移除。
   */
  scrollToAnchorAndHighlight(targetSelector: string) {
    const selector = `#${targetSelector}`;
    const query = wx.createSelectorQuery().in(this);
    query.select(selector).boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec((res) => {
      if (!res || !res[0] || !res[1]) {
        console.warn('[Index] 锚点元素未找到:', selector);
        return;
      }
      const rect: any = res[0];
      const scrollOffset: any = res[1];

      // 计算让目标元素居中所需的滚动距离
      // 屏幕高度通过 getSafeSystemInfo 获取
      let windowHeight = 667;
      try {
        windowHeight = getSafeSystemInfo().windowHeight;
      } catch (e) {
        /* ignore */
      }

      const targetScrollTop = scrollOffset.scrollTop + rect.top - windowHeight / 2 + rect.height / 2;

      // 平滑滚动到目标位置（duration 400ms 自然顺滑）
      wx.pageScrollTo({
        scrollTop: Math.max(0, targetScrollTop),
        duration: 400,
        complete: () => {
          // 滚动完成后触发高亮动画
          this.triggerHighlightPulse();
        }
      });
    });
  },

  /**
   * 触发 .highlight-pulse 高亮动画，2秒后自动移除
   */
  triggerHighlightPulse() {
    // 清理上一次的定时器，避免重复
    if (this._highlightTimer) {
      clearTimeout(this._highlightTimer);
    }

    this.setData({ highlightCheckInCard: true });

    this._highlightTimer = setTimeout(() => {
      this.setData({ highlightCheckInCard: false });
      this._highlightTimer = null;
    }, 2000);
  },

  refreshUserRoleView() {
    const role = wx.getStorageSync('current_user_role') || 'VOLUNTEER';
    const storeName = wx.getStorageSync('current_store_name') || this.data.shopName || '海沧区雨花斋';
    const storeId = wx.getStorageSync('current_store_id') || '';

    const rawRole = role.toUpperCase();
    const isVolunteer = rawRole === 'VOLUNTEER';
    const isManager = ['MANAGER', 'STORE_MANAGER', 'ADMIN', 'SUPER_ADMIN'].includes(rawRole);
    const isFinance = ['FINANCE', 'ADMIN', 'SUPER_ADMIN'].includes(rawRole);
    const isSuperAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(rawRole);

    this.setData({
      currentUserRole: role,
      currentRole: rawRole,
      currentStoreName: storeName,
      currentStoreId: storeId,
      isVolunteer: isVolunteer,
      isManager: isManager,
      isFinance: isFinance,
      isSuperAdmin: isSuperAdmin,
      permissions: getPermissionFlags({ role })
    });

    console.log(`🎯 [主页视图精细化分流成功]: 当前身份为 ${role}, isManager=${isManager}, isFinance=${isFinance}, isSuperAdmin=${isSuperAdmin}`);
  },

  loadEditReportData() {
    try {
      const editData = wx.getStorageSync('editReportData');
      if (!editData) return;

      const report = JSON.parse(editData);
      this.populateFormWithReportData(report);
      wx.removeStorageSync('editReportData');

      wx.showToast({
        title: '已加载历史记录，可重新编辑',
        icon: 'none',
        duration: 2000
      });
    } catch (error) {
      console.error('[loadEditReportData] 加载编辑数据失败:', error);
      wx.removeStorageSync('editReportData');
    }
  },

  populateFormWithReportData(report: any) {
    const dateString = report.dateString || report.reportDateValue;
    let reportDate = report.reportDate;
    let reportDateValue = dateString;

    if (!reportDate && dateString) {
      const parts = dateString.split('-');
      if (parts.length === 3) {
        reportDate = `${parts[0]}年${parts[1]}月${parts[2]}日`;
      }
    }

    const allDonations = this.formatDonationItemsToText(report.donationItems || report.items || []);
    const materialsInput = this.formatMaterialsToText(report.materials || []);

    this.setData({
      reportDate: reportDate || this.data.reportDate,
      reportDateValue: reportDateValue || this.data.reportDateValue,
      yesterdayBalance: formatMoney(report.yesterdayBalance),
      prevBalance: formatMoney(report.yesterdayBalance),
      systemBalance: parseFloat(report.yesterdayBalance) || 0,
      isManualAdjust: false,
      isEditMode: true,
      balanceDiff: 0,
      adjustReason: '',
      allDonations: allDonations,
      otherDonation: formatMoney(report.otherDonation),
      expenses: report.expenses || '',
      materialsInput: materialsInput,
      materials: report.materials || [],
      volunteerCount: report.volunteerCount ? String(report.volunteerCount) : '',
      volunteerHours: report.volunteerHours ? String(report.volunteerHours) : '',
      diningCount: report.diningCount ? String(report.diningCount) : '',
      stapleRiceStatus: report.stapleRiceStatus || 'normal',
      stapleOilStatus: report.stapleOilStatus || 'sufficient',
      shopName: report.shopName || this.data.shopName,
      mpAccount: report.mpAccount || this.data.mpAccount,
      receiptImages: report.receiptImages || [],
      showResult: false,
      reportResult: '',
      hasDraft: true,
      editReportId: report._id || ''
    });

    if (allDonations) {
      this.updateParseResult(allDonations);
    }
  },

  formatDonationItemsToText(items: any[]): string {
    if (!items || !Array.isArray(items) || items.length === 0) {
      return '';
    }
    return items.map(item => {
      const name = item.name || item.donor || '';
      const amount = item.amount || item.value || 0;
      return `${name} ${amount}`;
    }).join('\n');
  },

  formatMaterialsToText(materials: any[]): string {
    if (!materials || !Array.isArray(materials) || materials.length === 0) {
      return '';
    }
    return materials.map(m => {
      const donor = m.donor || '匿名爱心人士';
      const item = m.item || '';
      const quantity = m.quantity || '';
      const unit = m.unit || '';
      return `${donor}：${item}${quantity}${unit}`;
    }).join('；');
  },

  onUnload() {
    this.releaseDraftLock();
  },

  onHide() {
    // 页面隐藏时解开路由锁，防止影响后续返回后的操作
    this.isNavigating = false;

    const app = getApp();
    app.globalData.onNetworkReconnected = null;
    this.releaseDraftLock();
  },

  async autoSyncOfflineQueue() {
    const queue = getQueue();
    if (queue.length === 0) {
      return;
    }

    const networkInfo = wx.getNetworkTypeSync();
    if (networkInfo.networkType === 'none') {
      return;
    }

    let successCount = 0;
    for (const item of queue) {
      try {
        const uploadResults: string[] = [];
        
        for (let i = 0; i < item.receiptImages.length; i++) {
          const tempFilePath = item.receiptImages[i];
          const now = new Date();
          const dateFolder = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
          const fileName = `${Date.now()}_${i}.jpg`;
          const cloudPath = `expenses/${dateFolder}/${fileName}`;
          
          const uploadResult = await wx.cloud.uploadFile({
            cloudPath: cloudPath,
            filePath: tempFilePath
          });
          uploadResults.push(uploadResult.fileID);
        }

        // 剔除系统保留字段 _openid（任务3修复）
        const { id, timestamp, _openid, ...restItem } = item as any;
        await DataService.saveReport({
          ...restItem,
          receiptImages: uploadResults
        });

        removeFromQueue(item.id);
        successCount++;
      } catch (error) {
        console.error('[autoSyncOfflineQueue] 同步失败:', error);
        break;
      }
    }

    if (successCount > 0) {
      this.updateOfflineQueueCount();
      wx.showToast({ 
        title: `已为您自动同步 ${successCount} 条离线保存的账目汇报！🎉`, 
        icon: 'success',
        duration: 3000
      });
    }
  },

  async syncOfflineQueueManually() {
    const queue = getQueue();
    if (queue.length === 0) {
      wx.showToast({ title: '暂无待同步数据', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在同步...' });
    
    let successCount = 0;
    for (const item of queue) {
      try {
        const uploadResults: string[] = [];
        
        for (let i = 0; i < item.receiptImages.length; i++) {
          const tempFilePath = item.receiptImages[i];
          const now = new Date();
          const dateFolder = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
          const fileName = `${Date.now()}_${i}.jpg`;
          const cloudPath = `expenses/${dateFolder}/${fileName}`;
          
          const uploadResult = await wx.cloud.uploadFile({
            cloudPath: cloudPath,
            filePath: tempFilePath
          });
          uploadResults.push(uploadResult.fileID);
        }

        // 剔除系统保留字段 _openid（任务3修复）
        const { id, timestamp, _openid, ...restItem } = item as any;
        await DataService.saveReport({
          ...restItem,
          receiptImages: uploadResults
        });

        removeFromQueue(item.id);
        successCount++;
      } catch (error) {
        console.error('[syncOfflineQueueManually] 同步失败:', error);
        break;
      }
    }

    wx.hideLoading();
    this.updateOfflineQueueCount();
    
    if (successCount > 0) {
      wx.showToast({ 
        title: `已成功同步 ${successCount} 条账目汇报！🎉`, 
        icon: 'success',
        duration: 3000
      });
    } else {
      wx.showToast({ title: '同步失败，请检查网络', icon: 'none' });
    }
  },

  async onGeneratePoster() {
    console.log('[onGeneratePoster] 函数被调用');

    if (this.data.isGeneratingPoster) {
      console.log('[onGeneratePoster] 正在生成中，拦截重复点击');
      return;
    }

    const isValid = await this.validateBeforeSubmit();
    if (!isValid) {
      return;
    }

    const { parseResult, otherDonation, showResult } = this.data;

    console.log('[onGeneratePoster] data 状态:', {
      isGeneratingPoster: this.data.isGeneratingPoster,
      showResult,
      parseResultExists: !!parseResult,
      itemsCount: parseResult?.items?.length || 0
    });

    // 检查是否已生成文本
    if (!showResult) {
      wx.showModal({
        title: '提示',
        content: '请先点击「⚡ 生成文本」生成日报内容，再生成海报。',
        showCancel: false
      });
      return;
    }

    // 检查 parseResult 是否存在
    if (!parseResult || !parseResult.items) {
      console.error('[onGeneratePoster] parseResult 异常');
      wx.showModal({
        title: '数据异常',
        content: '❌ 数据解析结果异常，请重新生成文本后再试。',
        showCancel: false
      });
      return;
    }

    const itemCount = parseResult.items.length;
    const useTwoColumns = itemCount > 50;
    const itemsPerColumn = useTwoColumns ? Math.ceil(itemCount / 2) : itemCount;
    const listContentHeight = itemsPerColumn * 26;
    const dynamicHeight = Math.max(130 + 180 + 35 + 60 + listContentHeight + 24 + 70 + 20, 667);
    this.setData({ canvasHeight: dynamicHeight });

    wx.showLoading({ title: '正在生成海报...', mask: true });
    this.setData({ isGeneratingPoster: true });

    try {
      const { reportDate, expenses, shopName, mpAccount, yesterdayBalance } = this.data;
      const prevBalanceNum = parseFloat(yesterdayBalance) || 0;
      const b4_total = parseFloat(otherDonation) || 0;
      const { items, totalAmount: donationsTotal, totalCount } = parseResult;

      let expenseTotal = 0;
      let expenseInput = expenses.trim();
      if (expenseInput) {
        expenseInput = expenseInput.replace(/元$/, '');
        const expenseMatches = expenseInput.match(/\d+(\.\d+)?/g) || [];
        expenseTotal = expenseMatches.reduce((sum, val) => sum + Number(val), 0);
      }

      const todayTotalSum = donationsTotal + b4_total;
      const newBalanceSum = Math.round((prevBalanceNum + todayTotalSum - expenseTotal) * 100) / 100;

      const dateString = deriveDateString(this.data.reportDateValue, reportDate);

      const reportText = generateReportText({
        shopName: shopName,
        dateString: dateString,
        reportDate: reportDate,
        items: items,
        totalAmount: donationsTotal,
        otherDonation: b4_total,
        yesterdayBalance: prevBalanceNum,
        expenseAmount: expenseTotal,
        todayBalance: newBalanceSum,
        expenses: expenses,
        mpAccount: mpAccount,
        thankText: this.data.thankText,
        slogan1: this.data.slogan1,
        slogan2: this.data.slogan2,
        materials: this.data.materials,
        volunteerCount: parseFloat(this.data.volunteerCount) || 0,
        volunteerHours: parseFloat(this.data.volunteerHours) || 0,
        diningCount: parseFloat(this.data.diningCount) || 0,
        stapleRiceStatus: this.data.stapleRiceStatus,
        stapleOilStatus: this.data.stapleOilStatus,
        noticeTag: this.data.announcement?.tag,
        noticeTitle: this.data.announcement?.title,
        noticeContent: this.data.announcement?.content,
        mergeToReportText: this.data.mergeToReportText
      });

      // 内容安全检测 - 设置超时保护
      let isContentSafe = true;
      try {
        isContentSafe = await Promise.race([
          this.checkContentSafety(reportText),
          new Promise<boolean>((resolve) => {
            setTimeout(() => {
              console.warn('[onGeneratePoster] 内容安全检测超时，跳过检测');
              resolve(true);
            }, 3000);
          })
        ]);
      } catch (safeErr: any) {
        console.warn('[onGeneratePoster] 内容安全检测异常，跳过检测:', safeErr);
        isContentSafe = true;
      }

      if (!isContentSafe) {
        this.setData({ isGeneratingPoster: false });
        wx.hideLoading();
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 100));

      const posterImagePath = await drawMeritPoster(this, {
        shopName: shopName,
        dateString: dateString,
        reportDate: reportDate,
        items: items,
        totalCount: totalCount,
        totalAmount: donationsTotal,
        otherDonation: b4_total,
        yesterdayBalance: prevBalanceNum,
        expenseAmount: expenseTotal,
        todayBalance: newBalanceSum,
        mpAccount: mpAccount,
        thankText: this.data.thankText,
        slogan1: this.data.slogan1,
        materials: this.data.materials,
        volunteerCount: parseFloat(this.data.volunteerCount) || 0,
        volunteerHours: parseFloat(this.data.volunteerHours) || 0
      });

      this.setData({
        posterImage: posterImagePath,
        showPoster: true,
        showPosterModal: true,
        todayInAmount: todayTotalSum.toFixed(2),
        todayOutAmount: expenseTotal.toFixed(2),
        todayTotalBalance: newBalanceSum.toFixed(2),
        lastBalance: prevBalanceNum.toFixed(2),
        donorCount: (totalCount || 0) + (b4_total > 0 ? 1 : 0),
        riceStatus: this.data.stapleRiceStatus === 'urgent' ? '告急' : (this.data.stapleRiceStatus === 'sufficient' ? '充足' : '一般'),
        oilStatus: this.data.stapleOilStatus === 'urgent' ? '告急' : (this.data.stapleOilStatus === 'sufficient' ? '充足' : '一般')
      });
    } catch (err: any) {
      console.error('海报生成失败原因:', err);
      wx.showToast({
        title: err.message || '海报生成失败',
        icon: 'none',
        duration: 3000
      });
    } finally {
      wx.hideLoading();
      this.setData({ isGeneratingPoster: false });
    }
  },

  closePoster() {
    this.setData({ showPoster: false });
  },

  onClosePosterModal() {
    this.setData({ showPosterModal: false });
  },

  onPreviewQrCode() {
    const url = this.data.qrCodeUrl || '/images/sun_code_default.png';
    wx.previewImage({
      current: url,
      urls: [url]
    });
  },

  onSavePosterToPhotos() {
    const { posterImage } = this.data;
    if (!posterImage) {
      wx.showToast({ title: '海报图片为空', icon: 'none' });
      return;
    }

    wx.saveImageToPhotosAlbum({
      filePath: posterImage,
      success: () => {
        wx.showToast({ title: '保存成功', icon: 'success' });
      },
      fail: (err) => {
        console.error('[onSavePosterToPhotos] 保存失败:', err);
        if (err.errMsg && err.errMsg.indexOf('auth') !== -1) {
          wx.showModal({
            title: '提示',
            content: '请授权允许保存图片到相册',
            confirmText: '去授权',
            success: (res) => {
              if (res.confirm) {
                wx.openSetting();
              }
            }
          });
        } else {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      }
    });
  },

  stopPropagation() {},

  onThankTextInput(e: any) {
    const value = e.detail.value;
    this.setData({ thankText: value });
    this.saveSettings();
    this.debouncedSaveDraft();
  },

  onSlogan1Input(e: any) {
    const value = e.detail.value;
    this.setData({ slogan1: value });
    this.saveSettings();
    this.debouncedSaveDraft();
  },

  onSlogan2Input(e: any) {
    const value = e.detail.value;
    this.setData({ slogan2: value });
    this.saveSettings();
    this.debouncedSaveDraft();
  },

  savePoster() {
    const { posterImage } = this.data;
    if (!posterImage) {
      wx.showToast({ title: '海报图片为空', icon: 'none' });
      return;
    }

    wx.saveImageToPhotosAlbum({
      filePath: posterImage,
      success: () => {
        wx.showToast({ title: '保存成功', icon: 'success' });
        this.closePoster();
      },
      fail: (err) => {
        console.error('[savePoster] 保存失败:', err);
        if (err.errMsg.includes('auth')) {
          wx.showModal({
            title: '提示',
            content: '请授权允许保存图片到相册',
            confirmText: '去授权',
            success: (res) => {
              if (res.confirm) {
                wx.openSetting();
              }
            }
          });
        } else {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      }
    });
  },

  async checkContentSafety(text: string): Promise<boolean> {
    try {
      const result = await wx.cloud.callFunction({
        name: 'msgSecCheck',
        data: { text: text }
      });

      const r = result.result as any;
      if (r && !r.safe) {
        wx.showToast({ title: '所发布内容含违规信息', icon: 'none' });
        return false;
      }
      return true;
    } catch (error) {
      console.warn('[checkContentSafety] 内容安全检测调用失败，跳过检测:', error);
      return true;
    }
  },

  showServiceAgreement() {
    this.setData({ showAgreement: true });
  },

  loadAnnouncement() {
    const cachedNotice = wx.getStorageSync('custom_notice');
    const cachedMerge = wx.getStorageSync('notice_merge_to_report');
    const cachedHidden = wx.getStorageSync('notice_hidden');
    
    let announcement;
    if (cachedNotice && cachedNotice.tag && cachedNotice.content) {
      announcement = {
        id: 'custom_' + Date.now(),
        tag: cachedNotice.tag,
        title: cachedNotice.title || cachedNotice.tag,
        content: cachedNotice.content,
        is_top: true,
        create_time: cachedNotice.create_time || new Date().toISOString().split('T')[0]
      };
    } else {
      const defaultNotice = PRESET_NOTICES.opening;
      announcement = {
        id: 'ann_001',
        tag: defaultNotice.tag,
        title: defaultNotice.title,
        content: defaultNotice.content,
        is_top: true,
        create_time: '2026-07-10'
      };
    }
    
    this.setData({
      announcement: announcement,
      mergeToReportText: cachedMerge === true,
      noticeHidden: cachedHidden === true
    });
  },

  openAnnouncement() {
    this.setData({
      showAnnouncementModal: true
    });
  },

  closeAnnouncement() {
    this.setData({
      showAnnouncementModal: false
    });
  },

  copyAnnouncement() {
    const { announcement } = this.data;
    if (!announcement) return;

    const text = `${announcement.tag || '喜讯通报'}：${announcement.title}\n\n${announcement.content}\n\n发布时间：${announcement.create_time}`;
    
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: '已复制到剪贴板', icon: 'success' });
      },
      fail: () => {
        wx.showToast({ title: '复制失败', icon: 'none' });
      }
    });
  },

  openNoticeEdit() {
    const { announcement, mergeToReportText } = this.data;
    if (!announcement) return;

    this.setData({
      showAnnouncementModal: false,
      showNoticeEditModal: true,
      noticeEditTag: announcement.tag || '喜讯通报',
      noticeEditTitle: announcement.title || '',
      noticeEditContent: announcement.content || '',
      mergeToReportText: mergeToReportText
    });
  },

  closeNoticeEdit() {
    this.setData({
      showNoticeEditModal: false
    });
  },

  onNoticeTitleInput(e: any) {
    this.setData({
      noticeEditTitle: e.detail.value
    });
  },

  onNoticeContentInput(e: any) {
    this.setData({
      noticeEditContent: e.detail.value
    });
  },

  clearNoticeContent() {
    this.setData({
      noticeEditContent: ''
    });
  },

  onToggleMergeToReport(e: any) {
    const checked = e.detail.value;
    this.setData({ mergeToReportText: checked });
    wx.setStorageSync('notice_merge_to_report', checked);
  },

  onToggleNoticeHidden() {
    const newHidden = !this.data.noticeHidden;
    this.setData({ noticeHidden: newHidden });
    wx.setStorageSync('notice_hidden', newHidden);
    wx.showToast({
      title: newHidden ? '通报栏已隐藏' : '通报栏已显示',
      icon: 'none',
      duration: 1500
    });
  },

  onApplyPreset(e: any) {
    const key = e.currentTarget.dataset.key;
    const preset = PRESET_NOTICES[key as keyof typeof PRESET_NOTICES];
    
    if (preset) {
      this.setData({
        noticeEditTag: preset.tag,
        noticeEditTitle: preset.title,
        noticeEditContent: preset.content
      });
      wx.showToast({
        title: '已导入预设文案',
        icon: 'success',
        duration: 1500
      });
    }
  },

  onSaveNotice() {
    const { noticeEditTag, noticeEditTitle, noticeEditContent } = this.data;
    
    if (!noticeEditContent.trim()) {
      wx.showToast({
        title: '请输入通报内容',
        icon: 'none'
      });
      return;
    }

    const newAnnouncement = {
      id: 'custom_' + Date.now(),
      tag: noticeEditTag,
      title: noticeEditTitle || noticeEditTag,
      content: noticeEditContent,
      is_top: true,
      create_time: new Date().toISOString().split('T')[0]
    };

    wx.setStorageSync('custom_notice', {
      tag: noticeEditTag,
      title: noticeEditTitle || noticeEditTag,
      content: noticeEditContent,
      create_time: newAnnouncement.create_time
    });

    this.setData({
      announcement: newAnnouncement,
      showNoticeEditModal: false,
      noticeHidden: false
    });

    wx.setStorageSync('notice_hidden', false);

    wx.showToast({
      title: '通报内容已更新',
      icon: 'success'
    });
  },

  closeAgreement() {
    this.setData({ showAgreement: false });
  },

  goToHistory() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/history/history',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  goToStatistics() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: `/pages/statistics/statistics?shopName=${encodeURIComponent(this.data.shopName)}`,
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  onVolunteerCheckIn() {
    this.refreshTodayShiftStatus();
    this.setData({ showShiftSelectModal: true });
  },

  refreshTodayShiftStatus() {
    const todayStr = new Date().toISOString().split('T')[0];
    const logs = wx.getStorageSync('my_checkin_logs') || [];

    const todayLogs = logs.filter((log: any) => log.date === todayStr);
    const completedShiftKeys = new Set(todayLogs.map((log: any) => log.shiftKey));
    const todayHours = todayLogs.reduce((sum: number, log: any) => sum + (parseFloat(log.hours) || 0), 0);

    let firstAvailableShift = '';
    const updatedShifts = this.data.shiftDefinitions.map((item: any) => {
      const isCompleted = completedShiftKeys.has(item.shiftKey);
      if (!isCompleted && !firstAvailableShift) {
        firstAvailableShift = item.shiftKey;
      }
      return {
        ...item,
        isCompleted: isCompleted
      };
    });

    const allCompleted = updatedShifts.every((item: any) => item.isCompleted);

    this.setData({
      todayLogs: todayLogs,
      todayAccumulatedHours: parseFloat(todayHours.toFixed(1)),
      availableShifts: updatedShifts,
      allShiftsCompleted: allCompleted,
      selectedShift: firstAvailableShift || 'LUNCH',
      selectedShiftHours: firstAvailableShift
        ? (updatedShifts.find((s: any) => s.shiftKey === firstAvailableShift)?.hours || 3.0)
        : 0
    });
  },

  onCloseShiftModal() {
    this.setData({
      showShiftSelectModal: false
    });
  },

  onSelectShift(e: any) {
    const { shift, hours } = e.currentTarget.dataset;
    this.setData({
      selectedShift: shift,
      selectedShiftHours: parseFloat(hours || '3.0')
    });
  },

  onCustomHoursInput(e: any) {
    const val = e.detail.value;
    this.setData({
      customHoursInput: val,
      selectedShiftHours: parseFloat(val || '0')
    });
  },

  onToggleMealReserve() {
    this.setData({
      willEatLunch: !this.data.willEatLunch
    });
  },

  stopBubble() {},

  onConfirmShiftCheckIn() {
    if (this.data.allShiftsCompleted) {
      wx.showToast({ title: '您今日已完成所有班次护持，感恩您的无私付出！', icon: 'none' });
      return;
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const logs = wx.getStorageSync('my_checkin_logs') || [];

    const isAlreadyChecked = logs.some((l: any) => l.date === todayStr && l.shiftKey === this.data.selectedShift);
    if (isAlreadyChecked) {
      wx.showToast({ title: '⚠️ 您今日已完成该班次打卡，请勿重复刷工时', icon: 'none' });
      return;
    }

    const addHours = this.data.selectedShiftHours || 3.0;
    if (this.data.todayAccumulatedHours + addHours > 12.0) {
      wx.showModal({
        title: '🌸 义工关怀提醒',
        content: `您今日已护持 ${this.data.todayAccumulatedHours} 小时，单日工时已达上限（12小时）。雨花家人请注意劳逸结合！`,
        showCancel: false,
        confirmText: '合十知晓',
        confirmColor: '#8C1D18'
      });
      return;
    }

    const shiftObj = this.data.shiftDefinitions.find((s: any) => s.shiftKey === this.data.selectedShift);
    const shiftLabel = shiftObj ? shiftObj.name : '爱心护持班';

    const hasTodayLog = logs.some((l: any) => l.date === todayStr);
    const currentDays = this.data.myCheckInDays || 13;
    const newDays = hasTodayLog ? currentDays : (currentDays + 1);

    const newCount = (this.data.myCheckInCount || 16) + 1;
    const newHours = parseFloat(((this.data.myServiceHours || 48.0) + addHours).toFixed(1));

    const timestamp = Date.now();
    const newLog = {
      timestamp: timestamp,
      date: todayStr,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      shiftKey: this.data.selectedShift,
      shiftName: shiftLabel,
      hours: addHours,
      storeName: this.data.currentStoreName || '海沧区雨花斋',
      willEatLunch: this.data.willEatLunch
    };
    logs.unshift(newLog);

    wx.setStorageSync('my_checkin_days', newDays);
    wx.setStorageSync('my_checkin_count', newCount);
    wx.setStorageSync('my_service_hours', newHours);
    wx.setStorageSync('my_checkin_logs', logs);

    this.setData({
      myCheckInDays: newDays,
      myCheckInCount: newCount,
      myServiceHours: newHours,
      checkInLogs: logs,
      showShiftSelectModal: false,
      showPosterModal: true
    });

    wx.showToast({ title: `打卡成功！+${addHours}h`, icon: 'success' });
  },

  onRevokeTodayCheckIn(e: any) {
    const { timestamp, hours } = e.currentTarget.dataset;
    const revokeHours = parseFloat(hours || '0');

    wx.showModal({
      title: '↩️ 确认撤销打卡',
      content: `确定要撤销此笔打卡记录吗？将自动扣减 ${revokeHours} 小时贡献工时。`,
      confirmColor: '#D32F2F',
      success: (res) => {
        if (res.confirm) {
          let logs = wx.getStorageSync('my_checkin_logs') || [];
          const todayStr = new Date().toISOString().split('T')[0];

          const ts = typeof timestamp === 'number' ? timestamp : parseInt(timestamp, 10);
          logs = logs.filter((l: any) => l.timestamp !== ts);

          const stillHasTodayLog = logs.some((l: any) => l.date === todayStr);

          const currentDays = this.data.myCheckInDays || 13;
          const newDays = stillHasTodayLog ? currentDays : Math.max(0, currentDays - 1);
          const newCount = Math.max(0, (this.data.myCheckInCount || 16) - 1);
          const newHours = parseFloat(Math.max(0, (this.data.myServiceHours || 48.0) - revokeHours).toFixed(1));

          wx.setStorageSync('my_checkin_days', newDays);
          wx.setStorageSync('my_checkin_count', newCount);
          wx.setStorageSync('my_service_hours', newHours);
          wx.setStorageSync('my_checkin_logs', logs);

          this.setData({
            myCheckInDays: newDays,
            myCheckInCount: newCount,
            myServiceHours: newHours,
            checkInLogs: logs
          });

          this.refreshTodayShiftStatus();
          wx.showToast({ title: '已成功撤销该笔记录', icon: 'none' });
        }
      }
    });
  },

  loadVolunteerStats() {
    try {
      const checkInDays = wx.getStorageSync('my_checkin_days') || 12;
      const checkInCount = wx.getStorageSync('my_checkin_count') || 15;
      const serviceHours = wx.getStorageSync('my_service_hours') || 45;

      this.setData({
        myCheckInDays: checkInDays,
        myCheckInCount: checkInCount,
        myServiceHours: serviceHours
      });
    } catch (err) {
      console.warn('⚠️ 读取护持统计数据失败:', err);
    }
  },

  onOpenMyCheckInHistory() {
    const days = this.data.myCheckInDays || 0;
    const hours = this.data.myServiceHours || 0;
    const count = this.data.myCheckInCount || 0;

    this.setData({
      showArchiveModal: true,
      archiveUserInfo: {
        totalDays: days,
        totalCheckInCount: count,
        totalHours: hours
      }
    });
  },

  onCloseArchiveModal() {
    this.setData({ showArchiveModal: false });
  },

  onViewJourneyFromArchive() {
    this.setData({ showArchiveModal: false });
    // 延迟 200ms 等弹窗关闭动画完成再跳转
    setTimeout(() => {
      wx.navigateTo({
        url: '/pages/journey/journey'
      });
    }, 200);
  },

  onOpenVolunteerAudit() {
    const count = this.data.pendingAuditCount || 0;
    wx.showModal({
      title: '👥 义工到岗审核',
      content: count > 0 ? `当前有 ${count} 位义工提交了到岗打卡请求，是否进入审核？` : '当前暂无待审核的义工打卡记录，门店护持秩序良好！',
      confirmText: '查看列表',
      confirmColor: '#8C1D18',
      showCancel: false
    });
  },

  onExportExcelHistory() {
    const storeName = this.data.currentStoreName || '雨花斋';
    wx.showActionSheet({
      itemList: [`导出【${storeName}】本月收支明细 Excel`, '导出近 90 天阳光账本汇总表', '查看防篡改区块链存证日志'],
      success: (res) => {
        wx.showToast({ title: '导出指令已发送', icon: 'success' });
      }
    });
  },

  onViewPublicLedger() {
    const storeName = this.data.currentStoreName || '海沧区雨花斋';

    wx.showModal({
      title: '📖 阳光公开账本',
      content: `【${storeName}】谨遵雨花斋“阳光透明”原则，所有服务汇入与每日采购开支全量公开，接受社会监督。`,
      confirmText: '查看历史账目',
      cancelText: '关闭',
      confirmColor: '#8C1D18',
      success: (res) => {
        if (res.confirm) {
          this.isNavigating = true;
          setTimeout(() => {
            wx.navigateTo({
              url: '/pages/history/history',
              fail: () => {
                wx.switchTab({
                  url: '/pages/history/history',
                  fail: () => {
                    this.isNavigating = false;
                  }
                });
              }
            });
          }, 100);
        }
      }
    });
  },

  onShareAppMessage() {
    const store = this.data.currentStoreName || this.data.shopName || '雨花斋';
    const date = this.data.reportDate || this.data.reportDateValue || '今日';

    return {
      title: `🌸【${store}】${date}爱心餐报公示，请家人阅览！`,
      path: `/pages/index/index?storeName=${encodeURIComponent(store)}`,
      imageUrl: '/images/share_cover.png'
    };
  },

  onShareTimeline() {
    return {
      title: '用“餐报君”让爱心账目更透明！素食小店日常记账汇报的高效利器。',
      query: 'from=share'
    };
  }
});