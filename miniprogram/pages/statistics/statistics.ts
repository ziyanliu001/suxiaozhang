import { DataService, formatMoney } from '../../utils/dataService';
import { AuthService, ROLE_LABELS } from '../../utils/authService';
import { getSelectedStore, setSelectedStore } from '../../utils/storeManager';
import { formatGratitudeReportText, GratitudeReportData } from '../../utils/reportFormatter';
import { calculateEmaRunway, RunwayResult } from '../../utils/calculateRunway';
import { createNavGuard, NavGuardInstance } from '../../utils/navGuard';

function parseDate(dateStr: string): Date {
  return new Date(String(dateStr).replace(/-/g, '/'));
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeStoreName(str: string): string {
  return (str || '').replace(/[区市省店\s]/g, '').trim();
}

function isStoreNameFuzzyMatch(recordStore: string, filterStore: string): boolean {
  if (!recordStore || !filterStore) return false;
  const cleanRecord = normalizeStoreName(recordStore);
  const cleanFilter = normalizeStoreName(filterStore);
  return cleanRecord.includes(cleanFilter) || cleanFilter.includes(cleanRecord);
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

function isAllStoresMode(storeName: string): boolean {
  const cleanStr = (s: string) => String(s || '').replace(/\s+/g, '').trim();
  const clean = cleanStr(storeName);
  return !storeName || storeName === 'ALL' || clean === '全部门店';
}

function deepExtractDate(item: any): any {
  if (!item) return null;
  
  const fieldCandidates = [
    'reportDate', 'date', 'report_date', 'createTime', 'time',
    'dateString', 'created_at', 'updated_at', 'report_time',
    'day', 'reportDay'
  ];
  
  for (const field of fieldCandidates) {
    if (item[field]) return item[field];
  }
  
  if (item.formData && typeof item.formData === 'object') {
    for (const field of fieldCandidates) {
      if (item.formData[field]) return item.formData[field];
    }
  }
  
  if (item.data && typeof item.data === 'object') {
    for (const field of fieldCandidates) {
      if (item.data[field]) return item.data[field];
    }
  }
  
  return null;
}

function deepExtractStoreName(item: any): string {
  if (!item) return '';
  
  const fieldCandidates = ['shopName', 'storeName', 'store', 'shop', 'store_name', 'shop_name'];
  
  for (const field of fieldCandidates) {
    if (item[field]) return String(item[field]);
  }
  
  if (item.formData && typeof item.formData === 'object') {
    for (const field of fieldCandidates) {
      if (item.formData[field]) return String(item.formData[field]);
    }
  }
  
  return '';
}

function extractDateMeta(rawDate: any): { y: number; m: number; d: number; isoStr: string } | null {
  if (!rawDate) return null;

  let str = String(rawDate).trim();

  if (/^\d{10,13}$/.test(str)) {
    const d = new Date(parseInt(str, 10));
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const isoStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { y, m, d: day, isoStr };
  }

  if (/^\d{2}年/.test(str)) {
    str = '20' + str;
  }

  const match = str.match(/(\d{4})[\-\/年\.](\d{1,2})[\-\/月\.](\d{1,2})/);
  if (match) {
    const y = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const d = parseInt(match[3], 10);
    const isoStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return { y, m, d, isoStr };
  }

  const matchChinese = str.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (matchChinese) {
    const y = parseInt(matchChinese[1], 10);
    const m = parseInt(matchChinese[2], 10);
    const d = parseInt(matchChinese[3], 10);
    const isoStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return { y, m, d, isoStr };
  }

  try {
    const dateObj = new Date(str);
    if (!isNaN(dateObj.getTime())) {
      const y = dateObj.getFullYear();
      const m = dateObj.getMonth() + 1;
      const day = dateObj.getDate();
      const isoStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { y, m, d: day, isoStr };
    }
  } catch (e) {
    console.warn('[Statistics] Date parse fallback failed:', str, e);
  }

  return null;
}

function filterRecordsByPeriodAndStore(
  records: any[],
  startIso: string,
  endIso: string,
  targetStore: string
): any[] {
  if (!Array.isArray(records) || records.length === 0) return [];

  const cleanStore = (s: string) => String(s || '').replace(/[区市省店\s]/g, '').trim();
  const targetStoreClean = cleanStore(targetStore);
  const isAll = isAllStoresMode(targetStore);

  const startMeta = extractDateMeta(startIso);
  const endMeta = extractDateMeta(endIso);
  if (!startMeta || !endMeta) return [];

  const isDateInRange = (meta: { y: number; m: number; d: number }) => {
    if (meta.y < startMeta.y || meta.y > endMeta.y) return false;
    if (meta.y === startMeta.y && meta.y === endMeta.y) {
      if (meta.m < startMeta.m || meta.m > endMeta.m) return false;
      if (meta.m === startMeta.m && meta.m === endMeta.m) {
        return meta.d >= startMeta.d && meta.d <= endMeta.d;
      }
      if (meta.m === startMeta.m) return meta.d >= startMeta.d;
      if (meta.m === endMeta.m) return meta.d <= endMeta.d;
      return true;
    }
    if (meta.y === startMeta.y) {
      if (meta.m < startMeta.m) return false;
      if (meta.m > startMeta.m) return true;
      return meta.d >= startMeta.d;
    }
    if (meta.y === endMeta.y) {
      if (meta.m > endMeta.m) return false;
      if (meta.m < endMeta.m) return true;
      return meta.d <= endMeta.d;
    }
    return true;
  };

  let parseSuccessCount = 0;
  let storeMatchCount = 0;

  const filtered = records.filter((item, idx) => {
    if (!isAll) {
      const itemStoreRaw = deepExtractStoreName(item);
      const itemStoreClean = cleanStore(itemStoreRaw);
      const matchStore = itemStoreClean.includes(targetStoreClean) || targetStoreClean.includes(itemStoreClean);
      if (!matchStore) return false;
      storeMatchCount++;
    }

    const itemDateRaw = deepExtractDate(item);
    const meta = extractDateMeta(itemDateRaw);
    
    console.log(`[统计调试 #${idx}] 原始日期值: ${itemDateRaw}, 解析结果:`, meta, ', 门店:', deepExtractStoreName(item));
    
    if (!meta) return false;
    parseSuccessCount++;

    return isDateInRange(meta);
  });

  console.log('=== [统计分析调试汇总] ===');
  console.log('原始记录总数:', records.length);
  console.log('成功解析日期数:', parseSuccessCount);
  if (!isAll) console.log('门店匹配数:', storeMatchCount);
  console.log('最终匹配数:', filtered.length);

  (filtered as any).totalRawCount = records.length;
  (filtered as any).parseSuccessCount = parseSuccessCount;

  return filtered;
}

Page({
  _navGuard: null as NavGuardInstance | null,

  data: {
    currentTab: 'week',
    shopName: '全部门店',
    shopList: [] as string[],
    selectedShopIndex: 0,
    selectedYear: new Date().getFullYear(),
    selectedMonth: new Date().getMonth() + 1,
    customStartDate: '',
    customEndDate: '',
    statistics: null,
    navTop: 0,
    contentTop: 0,
    isAdmin: false,
    canViewNationalDashboard: false,
    canViewCrossStoreCost: false,
    canViewAllStoresDropdown: false,
    viewMode: 'all' as 'all' | 'personal',
    isAllStoresMode: true,
    hasOtherStoreData: false,
    showAllStoresOption: false,
    currentStoreTotalCount: 0,
    totalRawCount: 0,
    parseSuccessCount: 0,
    showBatchDinerModal: false,
    missingDinerRecords: [] as any[],
    showPosterModal: false,
    posterTempFilePath: '',
    showEditMajorModal: false,
    editingTargetRecord: null as any,
    editingInputText: '',
    currentUserRole: '' as string,
    currentUserStoreName: '',
    roleLabelMap: ROLE_LABELS,
    allStoresList: [] as any[],
    nationalData: {} as any,
    nationalMatrixList: [] as any[],
    showNationalDashboard: false,
    showGratitudeModal: false,
    gratitudeTempFilePath: '',
    gratitudeReportData: {} as GratitudeReportData,
    gratitudeIncomeStr: '0.00',
    gratitudeExpenseStr: '0.00',
    gratitudeBalanceStr: '0.00',
    isPreparingPhase: false,
    gratitudeReportText: '',
    yearsList: ['2024', '2025', '2026'],
    monthsList: ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'],
    statsData: {} as any,
    monthlyAggregatedList: [] as any[],
    expandedMonthSet: {} as Record<string, boolean>
  },

  onLoad(options: any) {
    if (options && options.shopName) {
      this.setData({ shopName: options.shopName });
    }

    this.sanitizeDateVariables();
    this.calculateNavBarHeight();
    this.initCustomDates();
    this.initUserRole();
    this.reloadShopListAndStats();

    // 注入物理返回键兜底拦截
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

  onShow() {
    // navGuard 状态刷新
    if (this._navGuard) {
      this._navGuard.setupOnShow();
    }

    const activeStore = getSelectedStore();
    if (activeStore && activeStore.storeName !== this.data.shopName && !this.data.canViewAllStoresDropdown) {
      this.setData({
        shopName: activeStore.storeName
      });
    }
    this.sanitizeDateVariables();
    DataService.syncLocalDataToCloud();
    this.reloadShopListAndStats();
  },

  sanitizeDateVariables() {
    const now = new Date();
    let { selectedYear, selectedMonth } = this.data;

    selectedYear = parseInt(selectedYear as any, 10);
    if (isNaN(selectedYear) || selectedYear < 2020 || selectedYear > 2030) {
      selectedYear = now.getFullYear();
    }

    let m = parseInt(selectedMonth as any, 10);
    if (isNaN(m) || m < 1 || m > 12) {
      m = now.getMonth() + 1;
    }

    if (selectedYear !== this.data.selectedYear || m !== this.data.selectedMonth) {
      this.setData({
        selectedYear,
        selectedMonth: m
      });
    }
  },

  async initUserRole() {
    const cachedRole = AuthService.getCachedRoleInfo();
    if (cachedRole) {
      this.applyRolePermissions(cachedRole.role, cachedRole.storeName);
    }

    const result = await AuthService.fetchUserRole();
    if (result.success && result.roleInfo) {
      const info = result.roleInfo;
      this.applyRolePermissions(info.role, info.storeName);
    }
  },

  // 🛡️ 三级角色权限卡口：单店财务 / 总部财务 / 超级管理员
  applyRolePermissions(role: string, storeName: string) {
    const isSuperAdmin = role === 'super_admin';
    const isHQFinance = role === 'hq_finance' || role === 'regional_finance';
    // 权限 A：只有超管和总部财务才能看"全国大屏"与"跨店成本比对"
    const canViewNationalDashboard = isSuperAdmin || isHQFinance;
    const canViewCrossStoreCost = isSuperAdmin || isHQFinance;
    const canViewAllStoresDropdown = isSuperAdmin || isHQFinance;

    this.setData({
      isAdmin: isSuperAdmin,
      currentUserRole: role,
      currentUserStoreName: storeName,
      canViewNationalDashboard,
      canViewCrossStoreCost,
      canViewAllStoresDropdown
    });

    // 非总部级角色：锁定到本门店
    if (!canViewAllStoresDropdown && storeName) {
      this.setData({
        shopName: storeName,
        isAllStoresMode: false
      });
    } else if (canViewAllStoresDropdown) {
      this.loadNationalDashboard();
    }
  },

  async loadNationalDashboard() {
    if (!this.data.canViewNationalDashboard) return;
    if (!this.data.isAllStoresMode) return;

    this.setData({ showNationalDashboard: true });

    try {
      const result = await wx.cloud.callFunction({
        name: 'getNationalDashboard'
      });

      const r = result.result as any;
      if (r && r.success) {
        const cleanedMatrix = this.formatNationalMatrixData(r.storeMatrix || []);
        this.setData({
          nationalData: r.nationalSummary,
          nationalMatrixList: cleanedMatrix
        });
      }
    } catch (err) {
      console.error('[loadNationalDashboard] 加载失败:', err);
    }
  },

  formatNationalMatrixData(rawStores: any[]): any[] {
    return rawStores.map((store: any) => {
      const balance = parseFloat(store.balance || store.latestBalance || 0);
      const diners = parseInt(store.totalDiners || store.diningCount || 0);
      const foodExpense = parseFloat(store.foodExpense || store.dailyExpenseTotal || 0);
      const days = parseInt(store.openDays || store.days || 0);

      let costPerMealStr = '';
      let isCostValid = false;

      if (diners > 0 && foodExpense > 0) {
        costPerMealStr = `¥${(foodExpense / diners).toFixed(2)}/餐`;
        isCostValid = true;
      } else if (foodExpense === 0) {
        costPerMealStr = '无日常开销';
      } else {
        costPerMealStr = '筹备中';
      }

      let dailyCostEstimate = foodExpense > 0 && days > 0 ? (foodExpense / days) : 100;
      if (dailyCostEstimate < 50) dailyCostEstimate = 100;

      const estimatedDays = Math.floor(balance / dailyCostEstimate);

      let statusLevel = 'urgent' as 'ample' | 'warning' | 'urgent';
      let statusText = '';

      if (estimatedDays >= 10) {
        statusLevel = 'ample';
        statusText = `🟢 充足(${estimatedDays}天)`;
      } else if (estimatedDays >= 5) {
        statusLevel = 'warning';
        statusText = `🟡 注意(${estimatedDays}天)`;
      } else {
        statusLevel = 'urgent';
        statusText = `🔴 告急(${estimatedDays}天)`;
      }

      return {
        ...store,
        costPerMealStr,
        isCostValid,
        statusLevel,
        statusText
      };
    });
  },

  switchViewMode(e: any) {
    const mode = e.currentTarget.dataset.mode as 'all' | 'personal';
    this.setData({ viewMode: mode });
    this.calculateStats();
  },

  calculateNavBarHeight() {
    const menuButton = wx.getMenuButtonBoundingClientRect();
    if (!menuButton) {
      this.setData({
        navTop: 44,
        contentTop: 88
      });
      return;
    }

    const navTop = menuButton.top;
    const contentTop = menuButton.top + menuButton.height + 20;

    this.setData({
      navTop: navTop,
      contentTop: contentTop
    });
  },

  async loadShopList() {
    try {
      let allRecords: any[] = [];
      
      try {
        const result = await DataService.getReports({ limit: 1000 });
        if (result.success && result.data && result.data.length > 0) {
          allRecords = result.data;
        }
      } catch (cloudError) {
        console.warn('[Statistics] 云端查询门店列表失败:', cloudError);
      }
      
      if (allRecords.length === 0) {
        try {
          const localData = wx.getStorageSync('local_report_logs');
          if (localData && Array.isArray(localData)) {
            allRecords = localData;
          }
        } catch (localError) {
          console.warn('[Statistics] 本地缓存读取失败:', localError);
        }
      }
      
      if (allRecords.length > 0) {
        const shopCountMap = new Map<string, number>();
        allRecords.forEach((item: any) => {
          if (item.shopName && item.shopName.trim()) {
            const name = item.shopName.trim();
            shopCountMap.set(name, (shopCountMap.get(name) || 0) + 1);
          }
        });
        
        let shopList = Array.from(shopCountMap.keys()).map(name => {
          const count = shopCountMap.get(name) || 0;
          return `${name} (${count}条记录)`;
        });
        
        if (shopList.length > 0) {
          shopList.unshift('全部门店');

          // 同时构建 allStoresList（用于超级管理员 picker）
          const allStoresList = [{ storeName: '全部门店' }, ...Array.from(shopCountMap.keys()).map(name => ({
            storeName: name,
            recordCount: shopCountMap.get(name) || 0
          }))];

          const currentShopName = this.data.shopName;
          let selectedIndex = 0;
          if (currentShopName) {
            const exactIdx = shopList.findIndex(shop => {
              const cleanName = shop.replace(/\s*\(\d+条记录\)$/, '');
              return cleanName === currentShopName;
            });
            if (exactIdx !== -1) {
              selectedIndex = exactIdx;
            } else {
              const fuzzyIdx = shopList.findIndex(shop => 
                shop !== '全部门店' && isStoreNameFuzzyMatch(shop.replace(/\s*\(\d+条记录\)$/, ''), currentShopName)
              );
              if (fuzzyIdx !== -1) selectedIndex = fuzzyIdx;
            }
          }
          this.setData({
            shopList,
            selectedShopIndex: selectedIndex,
            shopName: selectedIndex === 0 ? '全部门店' : shopList[selectedIndex].replace(/\s*\(\d+条记录\)$/, ''),
            showAllStoresOption: shopList.length > 1,
            allStoresList
          });
        }
      }
    } catch (error) {
      console.warn('[Statistics] 加载门店列表失败:', error);
    }
  },

  async reloadShopListAndStats() {
    await this.loadShopList();
    this.calculateStats();
  },

  onShopChange(e: any) {
    const index = parseInt(e.detail.value);
    const shopList = this.data.shopList;
    if (shopList && shopList.length > 0 && index >= 0 && index < shopList.length) {
      let displayShopName = shopList[index];
      const cleanShopName = displayShopName.replace(/\s*\(\d+条记录\)$/, '');
      const isAll = index === 0 || isAllStoresMode(cleanShopName);
      
      this.setData({
        selectedShopIndex: index,
        shopName: isAll ? '全部门店' : cleanShopName,
        isAllStoresMode: isAll,
        hasOtherStoreData: false,
        statistics: null
      });
      
      if (!isAll && cleanShopName) {
        setSelectedStore({ storeId: '', storeName: cleanShopName });
      }
      
      this.calculateStats();
    }
  },

  onSuperAdminSelectStore(e: any) {
    const index = parseInt(e.detail.value);
    const allStoresList = this.data.allStoresList;
    if (!allStoresList || allStoresList.length === 0) return;

    const selected = allStoresList[index];
    if (!selected) return;

    const isAll = !selected.storeName || selected.storeName === '全部门店';

    this.setData({
      shopName: isAll ? '全部门店' : selected.storeName,
      isAllStoresMode: isAll,
      hasOtherStoreData: false,
      statistics: null,
      showNationalDashboard: isAll && this.data.canViewNationalDashboard
    });

    if (!isAll && selected.storeName) {
      setSelectedStore({ storeId: selected.storeId || '', storeName: selected.storeName });
    }

    if (isAll && this.data.canViewNationalDashboard) {
      this.loadNationalDashboard();
    } else {
      this.calculateStats();
    }
  },

  switchTab(e: any) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({
      currentTab: tab,
      statistics: null
    });
    this.calculateStats();
    this.fetchStatistics();
  },

  // 拉取后端真实过滤数据（严格按时间区间隔离）
  async fetchStatistics() {
    if (this.data.isAllStoresMode) return;

    const { currentTab, shopName, selectedYear, selectedMonth, customStartDate, customEndDate } = this.data;
    const tabMap: Record<string, string> = { week: 'week', month: 'month', year: 'year', custom: 'custom' };
    const tabType = tabMap[currentTab] || 'week';

    try {
      const res = await wx.cloud.callFunction({
        name: 'getStatisticsData',
        data: {
          shopName: shopName || 'default',
          tabType,
          selectedYear: String(selectedYear),
          selectedMonth: String(selectedMonth).padStart(2, '0'),
          startDate: customStartDate,
          endDate: customEndDate
        }
      });

      const result = (res.result || {}) as any;
      if (result.success) {
        this.setData({ statsData: result });
      } else {
        console.warn('[fetchStatistics] 云函数返回失败:', result.errMsg);
      }
    } catch (err) {
      console.error('[fetchStatistics] 调用失败:', err);
    }
  },

  initCustomDates() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    
    this.setData({
      customEndDate: `${year}-${month}-${day}`,
      customStartDate: `${year}-${month}-01`
    });
  },

  onCustomStartDateChange(e: any) {
    this.setData({
      customStartDate: e.detail.value,
      statistics: null
    });
  },

  onCustomEndDateChange(e: any) {
    this.setData({
      customEndDate: e.detail.value,
      statistics: null
    });
  },

  loadCustomStatistics() {
    const { customStartDate, customEndDate } = this.data;
    if (!customStartDate || !customEndDate) {
      wx.showToast({ title: '请选择起止日期', icon: 'none' });
      return;
    }
    this.loadStatistics(customStartDate, customEndDate);
  },

  getWeekRange() {
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const startDate = new Date(now.setDate(diff));
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);

    return {
      startDate: formatDate(startDate),
      endDate: formatDate(endDate)
    };
  },

  getMonthRange() {
    const { selectedYear, selectedMonth } = this.data;
    const startDate = new Date(selectedYear, selectedMonth - 1, 1);
    const endDate = new Date(selectedYear, selectedMonth, 0);
    
    return {
      startDate: formatDate(startDate),
      endDate: formatDate(endDate)
    };
  },

  getYearRange() {
    const { selectedYear } = this.data;
    const startDate = new Date(selectedYear, 0, 1);
    const endDate = new Date(selectedYear, 11, 31);
    
    return {
      startDate: formatDate(startDate),
      endDate: formatDate(endDate)
    };
  },

  onYearChange(e: any) {
    let yearVal = parseInt(e.detail.value);
    if (isNaN(yearVal) || yearVal < 2020 || yearVal > 2030) {
      yearVal = new Date().getFullYear();
    }
    this.setData({
      selectedYear: yearVal,
      statistics: null
    });
    if (this.data.currentTab === 'year') {
      this.calculateStats();
      this.fetchStatistics();
    }
  },

  onMonthChange(e: any) {
    const rawValue = e.detail.value || '';
    let yearVal = this.data.selectedYear;
    let monthVal: number;

    if (rawValue.includes('-')) {
      const parts = rawValue.split('-');
      yearVal = parseInt(parts[0], 10);
      monthVal = parseInt(parts[1], 10);
    } else {
      monthVal = parseInt(rawValue, 10);
    }

    if (isNaN(monthVal) || monthVal < 1 || monthVal > 12) {
      monthVal = new Date().getMonth() + 1;
    }

    this.setData({
      selectedYear: yearVal,
      selectedMonth: monthVal,
      statistics: null
    });
    if (this.data.currentTab === 'month') {
      this.calculateStats();
      this.fetchStatistics();
    }
  },

  loadWeekStatistics() {
    const range = this.getWeekRange();
    this.loadStatistics(range.startDate, range.endDate);
  },

  loadMonthStatistics() {
    const range = this.getMonthRange();
    this.loadStatistics(range.startDate, range.endDate);
  },

  loadYearStatistics() {
    const range = this.getYearRange();
    this.loadStatistics(range.startDate, range.endDate);
  },

  calculateStats() {
    switch (this.data.currentTab) {
      case 'week':
        this.loadWeekStatistics();
        break;
      case 'month':
        this.loadMonthStatistics();
        break;
      case 'year':
        this.loadYearStatistics();
        break;
      case 'custom':
        this.initCustomDates();
        break;
    }
    // 同步拉取云函数严格过滤数据
    this.fetchStatistics();
  },

  async loadStatistics(startDate: string, endDate: string) {
    wx.showLoading({ title: '加载中...' });

    const { shopName, viewMode } = this.data;
    const isAll = isAllStoresMode(shopName);

    console.log('=== [Statistics] loadStatistics 开始 ===');
    console.log('日期范围:', startDate, '~', endDate);
    console.log('门店:', shopName, ', isAll:', isAll);
    console.log('viewMode:', viewMode);

    try {
      let allRecords: any[] = [];

      try {
        const allResult = await DataService.getReports({
          viewMode,
          limit: 1000
        });
        
        allRecords = allResult.success && allResult.data ? allResult.data : [];
        console.log('[Statistics] 云端查询结果:', allRecords.length, '条');
      } catch (cloudError) {
        console.warn('[Statistics] 云端查询失败:', cloudError);
      }

      if (allRecords.length === 0) {
        try {
          const localData = wx.getStorageSync('local_report_logs');
          if (localData) {
            if (Array.isArray(localData)) {
              allRecords = localData;
            } else if (typeof localData === 'string') {
              allRecords = JSON.parse(localData);
            }
          }
          console.log('[Statistics] 本地缓存读取结果:', allRecords.length, '条');
        } catch (localError) {
          console.warn('[Statistics] 本地缓存读取失败:', localError);
        }
      }

      const cleanStore = (s: string) => String(s || '').replace(/[区市省店\s]/g, '').trim();
      const targetStoreClean = cleanStore(shopName);
      console.log('[Statistics] 门店匹配:', '目标:', shopName, '->', targetStoreClean);
      
      const storeAllRecords = isAll 
        ? allRecords 
        : allRecords.filter(item => {
            const itemStoreClean = cleanStore(item.shopName || item.store || item.storeName || '');
            const match = itemStoreClean.includes(targetStoreClean) || targetStoreClean.includes(itemStoreClean);
            if (!match) {
              console.log('[Statistics] 门店不匹配:', item.shopName || item.store || item.storeName, '->', itemStoreClean);
            }
            return match;
          });
      
      const currentStoreTotalCount = storeAllRecords.length;
      console.log('[Statistics] 门店过滤后:', currentStoreTotalCount, '条');
      
      const filteredData = filterRecordsByPeriodAndStore(allRecords, startDate, endDate, shopName);
      const totalRawCount = (filteredData as any).totalRawCount || allRecords.length;
      const parseSuccessCount = (filteredData as any).parseSuccessCount || 0;
      
      let hasOtherStoreData = false;
      if (!isAll && filteredData.length === 0) {
        const allStoreFiltered = filterRecordsByPeriodAndStore(allRecords, startDate, endDate, '全部门店');
        hasOtherStoreData = allStoreFiltered.length > 0;
      }
      
      wx.hideLoading();
      
      if (filteredData.length > 0) {
        const statistics = this.calculateStatistics(filteredData, startDate, endDate);
        
        const netAccumulation = statistics.netAccumulation;
        const netAccumulationStr = (netAccumulation >= 0 ? '+' : '-') + formatMoney(Math.abs(netAccumulation));
        
        const totalExpenseForPercent = statistics.dailyExpenseTotal + statistics.largeExpenseTotal;
        const dailyExpensePercent = totalExpenseForPercent > 0 
          ? Math.round((statistics.dailyExpenseTotal / totalExpenseForPercent) * 100) 
          : 100;
        const largeExpensePercent = totalExpenseForPercent > 0 
          ? Math.round((statistics.largeExpenseTotal / totalExpenseForPercent) * 100) 
          : 0;

        const riceStatusMap: Record<string, { text: string; color: string; icon: string; className: string }> = {
          sufficient: { text: '充足', color: '#4CAF50', icon: '🟢', className: 'success' },
          normal: { text: '一般', color: '#FF9800', icon: '🟡', className: 'warning' },
          urgent: { text: '告急', color: '#E53935', icon: '🔴', className: 'danger' }
        };
        const oilStatusMap: Record<string, { text: string; color: string; icon: string; className: string }> = {
          sufficient: { text: '充足', color: '#4CAF50', icon: '🟢', className: 'success' },
          normal: { text: '一般', color: '#FF9800', icon: '🟡', className: 'warning' },
          urgent: { text: '告急', color: '#E53935', icon: '🔴', className: 'danger' }
        };

        const riceStatus = riceStatusMap[statistics.latestRiceStatus] || riceStatusMap.sufficient;
        const oilStatus = oilStatusMap[statistics.latestOilStatus] || oilStatusMap.sufficient;

        let healthGradientFrom = '#4CAF50';
        let healthGradientTo = '#66BB6A';
        if (statistics.healthStatus === 'fundUrgent') {
          healthGradientFrom = '#E53935';
          healthGradientTo = '#EF5350';
        } else if (statistics.healthStatus === 'materialWarning') {
          healthGradientFrom = '#FF9800';
          healthGradientTo = '#FFB74D';
        } else if (statistics.healthStatus === 'preparing' || statistics.healthStatus === 'largeExpenseInfo') {
          healthGradientFrom = '#F5A623';
          healthGradientTo = '#FFCC33';
        }

        const formattedStats = {
          ...statistics,
          totalIncomeStr: formatMoney(statistics.totalIncome),
          totalExpenseStr: formatMoney(statistics.totalExpense),
          totalListDonationStr: formatMoney(statistics.totalListDonation),
          totalOtherDonationStr: formatMoney(statistics.totalOtherDonation),
          dailyExpenseTotalStr: formatMoney(statistics.dailyExpenseTotal),
          largeExpenseTotalStr: formatMoney(statistics.largeExpenseTotal),
          netAccumulationStr,
          netAccumulationClass: netAccumulation >= 0 ? 'text-success' : 'text-danger',
          showLargeExpenseTip: netAccumulation < 0 && statistics.largeExpenseTotal > 0,
          largeExpenseTotalForTip: statistics.largeExpenseTotal,
          avgDailyExpenseStr: formatMoney(statistics.avgDailyExpense),
          avgDailyExpenseMA14Str: formatMoney(statistics.avgDailyExpenseMA14),
          perMealCostStr: statistics.perMealCost < 0.5 && statistics.perMealCost > 0 
            ? `${formatMoney(statistics.perMealCost)} (含物资)` 
            : formatMoney(statistics.perMealCost),
          showPerMealCost: (statistics.totalDiningCount + statistics.totalVolunteerCount) > 0 && statistics.dailyExpenseTotal > 0,
          latestBalanceStr: formatMoney(statistics.latestBalance),
          runwayDaysStr: statistics.runwayDaysRange,
          dailyExpensePercent,
          largeExpensePercent,
          riceStatusText: riceStatus.text,
          riceStatusColor: riceStatus.color,
          riceStatusIcon: riceStatus.icon,
          riceStatusClass: riceStatus.className,
          oilStatusText: oilStatus.text,
          oilStatusColor: oilStatus.color,
          oilStatusIcon: oilStatus.icon,
          oilStatusClass: oilStatus.className,
          healthGradientFrom,
          healthGradientTo,
          donationDays: statistics.donationDays,
          missingCount: statistics.missingCount,
          dailyRecords: statistics.dailyRecords.map((item: any) => ({
            ...item,
            _id: item._id,
            _localId: item._localId,
            incomeStr: formatMoney(item.income),
            expenseStr: formatMoney(item.expense),
            balanceStr: formatMoney(item.balance),
            balanceClass: item.balance <= 0 ? 'text-danger' : '',
            dailyExpenseStr: formatMoney(item.dailyExpense),
            largeExpenseStr: formatMoney(item.largeExpense),
            hasLargeExpense: item.largeExpense > 0,
            perMealCostStr: item.perMealCost < 0.5 && item.perMealCost > 0
              ? `${formatMoney(item.perMealCost)} (含物资)`
              : formatMoney(item.perMealCost),
            showPerMeal: (item.diningCount + (item.volunteerCount || 0)) > 0 && item.dailyExpense > 0,
            diningCount: item.diningCount || 0,
            volunteerCount: item.volunteerCount || 0,
            netChange: item.netChange,
            netChangeStr: formatMoney(Math.abs(item.netChange)),
            netChangeClass: item.netChange >= 0 ? 'plus' : 'minus',
            hasMaterials: item.hasMaterials,
            materialsSummary: item.materialsSummary,
            statusTag: item.statusTag,
            statusLabel: item.statusLabel
          }))
        };
        const monthlyAggregated = this.aggregateMonthlyStats(statistics.dailyRecords || [], this.data.selectedYear);

        this.setData({
          statistics: formattedStats,
          isAllStoresMode: isAll,
          hasOtherStoreData: hasOtherStoreData,
          currentStoreTotalCount,
          totalRawCount: totalRawCount,
          parseSuccessCount: parseSuccessCount,
          monthlyAggregatedList: monthlyAggregated
        });
      } else {
        this.setData({
          statistics: null,
          isAllStoresMode: isAll,
          hasOtherStoreData: hasOtherStoreData,
          currentStoreTotalCount,
          totalRawCount,
          parseSuccessCount
        });
      }
    } catch (error) {
      wx.hideLoading();
      console.error('[Statistics] 加载统计数据失败:', error);
      this.setData({
        statistics: null,
        isAllStoresMode: isAllStoresMode(shopName),
        hasOtherStoreData: false,
        currentStoreTotalCount: 0
      });
    }
  },

  aggregateMonthlyStats(dailyRecords: any[], year: number): any[] {
    const monthMap: Record<string, {
      month: string;
      monthName: string;
      income: number;
      foodExpense: number;
      majorExpense: number;
      totalExpense: number;
      diners: number;
      volunteers: number;
      volunteerHours: number;
      recordCount: number;
      days: any[];
    }> = {};

    for (let m = 1; m <= 12; m++) {
      const monthStr = String(m).padStart(2, '0');
      monthMap[monthStr] = {
        month: monthStr,
        monthName: `${year}年${m}月`,
        income: 0,
        foodExpense: 0,
        majorExpense: 0,
        totalExpense: 0,
        diners: 0,
        volunteers: 0,
        volunteerHours: 0,
        recordCount: 0,
        days: []
      };
    }

    dailyRecords.forEach((item: any) => {
      const dateStr = item.date || item.dateString || '';
      const match = String(dateStr).match(/^(\d{4})-(\d{2})/);
      if (!match) return;
      const itemYear = match[1];
      const monthStr = match[2];
      if (String(itemYear) !== String(year)) return;

      const m = monthMap[monthStr];
      if (!m) return;

      const income = parseFloat(item.income || 0);
      const foodExp = parseFloat(item.dailyExpense || 0);
      const majorExp = parseFloat(item.largeExpense || 0);
      const totalExp = parseFloat(item.expense || 0);

      m.income += income;
      m.foodExpense += foodExp;
      m.majorExpense += majorExp;
      m.totalExpense += totalExp;
      m.diners += parseFloat(item.diningCount || 0);
      m.volunteers += parseFloat(item.volunteerCount || 0);
      m.volunteerHours += parseFloat(item.volunteerHours || 0);
      m.recordCount += 1;
      m.days.push(item);
    });

    const result: any[] = [];
    for (let m = 12; m >= 1; m--) {
      const monthStr = String(m).padStart(2, '0');
      const data = monthMap[monthStr];
      if (data && data.recordCount > 0) {
        result.push({
          ...data,
          incomeStr: formatMoney(data.income),
          foodExpenseStr: formatMoney(data.foodExpense),
          majorExpenseStr: formatMoney(data.majorExpense),
          totalExpenseStr: formatMoney(data.totalExpense),
          netStr: formatMoney(data.income - data.totalExpense),
          netClass: (data.income - data.totalExpense) >= 0 ? 'text-success' : 'text-danger'
        });
      }
    }

    return result;
  },

  toggleMonthExpand(e: any) {
    const month = e.currentTarget.dataset.month;
    if (!month) return;
    const expanded = { ...this.data.expandedMonthSet };
    expanded[month] = !expanded[month];
    this.setData({ expandedMonthSet: expanded });
  },

  onSwitchToAllStores() {
    const shopList = this.data.shopList;
    const allIndex = shopList.indexOf('全部门店');
    if (allIndex !== -1) {
      this.setData({
        selectedShopIndex: allIndex,
        shopName: '全部门店',
        isAllStoresMode: true,
        hasOtherStoreData: false,
        currentStoreTotalCount: 0
      });
      this.calculateStats();
    }
  },

  onShowAllStoreRecords() {
    const { shopName } = this.data;
    
    const now = new Date();
    const startDate = `1970-01-01`;
    const endDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    
    this.loadStatistics(startDate, endDate);
  },

  parseAmountFromText(textStr: string): number {
    if (!textStr) return 0;
    const matches = String(textStr).match(/\d+(\.\d+)?/g);
    if (!matches) return 0;
    return matches.reduce((sum, num) => sum + parseFloat(num), 0);
  },

  parseSubExpenseItems(textStr: string, fallbackAmount: number, dateStr: string): any[] {
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
      const match = line.match(/^([\u4e00-\u9fa5a-zA-Z0-9\(\)\（\）\s]+?)[\s:：等于=]*(\d+(?:\.\d+)?)\s*元?$/);

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

  calculateStatistics(records: any[], startDate: string, endDate: string): any {
    const FIXED_EXPENSE_KEYWORDS = ['租金', '房租', '服装', '义工服', '设备', '装修', '采购', '大件', '空调', '冰箱', '冰柜', '桌椅', '改造', '维修', '购置', '大额', '专项'];

    const uniqueMap = new Map();
    records.forEach((item: any) => {
      const dateStr = item.dateString || item.reportDate || item.date || '';
      const storeStr = item.shopName || item.storeName || item.store || 'ALL';
      const key = `${storeStr}_${dateStr}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, item);
      }
    });
    const dedupedRecords = Array.from(uniqueMap.values());

    let statistics = {
      totalIncome: 0,
      totalOtherDonation: 0,
      totalListDonation: 0,
      totalExpense: 0,
      dailyExpenseTotal: 0,
      largeExpenseTotal: 0,
      recordCount: dedupedRecords.length,
      openDays: 0,
      donationDays: 0,
      missingCount: 0,
      netAccumulation: 0,
      avgDailyExpense: 0,
      avgDailyExpenseMA14: 0,
      latestBalance: 0,
      runwayDays: 0,
      runwayDaysRange: '',
      emaDailyCost: '0.00',
      runwayStatusLevel: 'ample' as 'ample' | 'warning' | 'urgent',
      healthStatus: '' as 'healthy' | 'materialWarning' | 'fundUrgent',
      healthStatusText: '',
      healthStatusColor: '',
      healthIcon: '',
      perMealCost: 0,
      totalDiningCount: 0,
      totalVolunteerCount: 0,
      totalVolunteerHours: 0,
      totalDonorCount: 0,
      startDate: startDate,
      endDate: endDate,
      dailyRecords: [] as any[],
      materialsSummary: [] as any[],
      latestRiceStatus: 'normal' as string,
      latestOilStatus: 'sufficient' as string,
      majorExpenseList: [] as any[]
    };

    const validOpenDaysSet = new Set<string>();
    const validDonationDaysSet = new Set<string>();
    const missingCountSet = new Set<string>();

    const materialsMap = new Map<string, { item: string; unit: string; totalQty: number }>();

    const sortedRecords = [...dedupedRecords].sort((a, b) =>
      parseDate(a.dateString).getTime() - parseDate(b.dateString).getTime()
    );

    // 修复"显示全部记录"时的 1970-01-01 问题：动态替换为实际最早记录日期
    if (startDate === '1970-01-01' && sortedRecords.length > 0) {
      const earliest = sortedRecords[0];
      const earliestDateRaw = earliest.dateString || earliest.reportDate || earliest.date || '';
      if (earliestDateRaw) {
        const standardized = toStandardIsoDate(earliestDateRaw);
        if (standardized) {
          statistics.startDate = standardized;
        }
      }
    }

    sortedRecords.forEach((item: any) => {
      const otherDonation = parseFloat(item.otherDonation) || 0;
      const listDonationTotal = parseFloat(item.listDonationTotal) || 0;
      const expenseAmount = parseFloat(item.expenseAmount) || 0;
      const expensesText = item.expenses || '';
      let dailyExpenseText = item.dailyExpenseText || item.dailyIngredientText || '';
      let fixedExpenseText = item.fixedExpenseText || item.fixedMajorText || item.remark || '';

      if (item.reportText) {
        if (!dailyExpenseText) {
          const dailyMatch = item.reportText.match(/开餐支出（食材）：([^\n]+)/);
          if (dailyMatch && dailyMatch[1]) {
            dailyExpenseText = dailyMatch[1].replace(/元$/, '').trim();
          }
        }
        if (!fixedExpenseText) {
          const fixedMatch = item.reportText.match(/专项支出（房租\/设备）：([^\n]+)/);
          if (fixedMatch && fixedMatch[1]) {
            fixedExpenseText = fixedMatch[1].replace(/元$/, '').trim();
          }
        }
      }
      const donorCount = (item.donationItems && Array.isArray(item.donationItems)) ? item.donationItems.length : 0;
      const diningCount = parseFloat(item.diningCount) || 0;

      const volunteerCount = parseFloat(item.volunteerCount) || 0;
      const totalMeals = diningCount + volunteerCount;
      statistics.totalVolunteerHours += parseFloat(item.volunteerHours) || 0;
      statistics.totalDiningCount += diningCount;
      statistics.totalVolunteerCount += volunteerCount;

      const dailyIncome = otherDonation + listDonationTotal;
      const hasIncome = dailyIncome > 0;
      const hasExpense = expenseAmount > 0;
      const hasDiners = diningCount > 0;

      if (hasDiners && item.dateString) {
        validOpenDaysSet.add(item.dateString);
      } else if (hasIncome && !hasDiners && item.dateString) {
        validDonationDaysSet.add(item.dateString);
        missingCountSet.add(item.dateString);
      } else if (hasExpense && !hasDiners && item.dateString) {
        validOpenDaysSet.add(item.dateString);
      }

      if (item.materials && Array.isArray(item.materials) && item.materials.length > 0) {
        item.materials.forEach((m: any) => {
          const key = `${m.item}_${m.unit || ''}`;
          const qty = parseFloat(m.quantity) || 0;
          if (materialsMap.has(key)) {
            const existing = materialsMap.get(key)!;
            existing.totalQty += qty;
          } else {
            materialsMap.set(key, {
              item: m.item || '未知物资',
              unit: m.unit || '',
              totalQty: qty
            });
          }
        });
      }

      let dailyExpense = parseFloat(item.dailyExpenseTotal) || 0;
      let fixedExpense = parseFloat(item.fixedExpenseTotal) || 0;

      if (dailyExpense === 0 && dailyExpenseText) {
        dailyExpense = this.parseAmountFromText(dailyExpenseText);
      }

      if (fixedExpense === 0 && fixedExpenseText) {
        fixedExpense = this.parseAmountFromText(fixedExpenseText);
      }

      const totalItemExpense = expenseAmount;
      if (dailyExpense === 0 && fixedExpense === 0 && totalItemExpense > 0) {
        const textContext = fixedExpenseText || expensesText || item.remark || '';
        const hasFixedKeyword = FIXED_EXPENSE_KEYWORDS.some(kw => textContext.includes(kw));
        if (hasFixedKeyword) {
          fixedExpense = totalItemExpense;
        } else {
          dailyExpense = totalItemExpense;
        }
      }

      statistics.totalOtherDonation += otherDonation;
      statistics.totalListDonation += listDonationTotal;
      statistics.totalExpense += expenseAmount;
      statistics.dailyExpenseTotal += dailyExpense;
      statistics.largeExpenseTotal += fixedExpense;
      statistics.totalDonorCount += donorCount;

      if (fixedExpense > 0 || (fixedExpenseText && fixedExpenseText.trim() !== '') || (item.majorExpenseItems && item.majorExpenseItems.length > 0)) {
        const fallbackAmt = fixedExpense > 0 ? fixedExpense : totalItemExpense;
        let subItems: any[] = [];

        const recordId = item._id || item.id;
        const dateStr = item.dateString || '近期';

        if (item.majorExpenseItems && item.majorExpenseItems.length > 0) {
          subItems = item.majorExpenseItems.map((mi: any) => ({
            recordId: recordId,
            date: mi.date || dateStr,
            title: mi.title || mi.name || mi.detailText || '专项大额开支',
            amount: mi.amount ? String(mi.amount) : '0.00',
            isMissingRemark: false
          }));
        } else {
          const genericTexts = ['专项大额开支', '大额支出', '专项支出'];
          const isGeneric = fixedExpenseText && genericTexts.includes(fixedExpenseText.trim());

          if (!fixedExpenseText || fixedExpenseText.trim() === '' || isGeneric) {
            subItems.push({
              recordId: recordId,
              date: dateStr,
              title: '专项大额开支',
              amount: fallbackAmt.toFixed(2),
              isMissingRemark: true
            });
          } else {
            subItems = this.parseSubExpenseItems(fixedExpenseText || '', fallbackAmt, dateStr);
            subItems.forEach(s => {
              s.recordId = recordId;
              s.isMissingRemark = false;
            });
          }
        }

        subItems.forEach((sub: any) => {
          statistics.majorExpenseList.push({
            recordId: sub.recordId,
            date: sub.date,
            storeName: item.shopName || '',
            detailText: sub.title,
            amount: sub.amount,
            isMissingRemark: sub.isMissingRemark || false
          });
        });
      }

      const todayBalance = parseFloat(item.todayBalance) || 0;
      statistics.latestBalance = todayBalance;

      if (item.stapleRiceStatus) {
        statistics.latestRiceStatus = item.stapleRiceStatus;
      }
      if (item.stapleOilStatus) {
        statistics.latestOilStatus = item.stapleOilStatus;
      }

      const netChange = dailyIncome - expenseAmount;
      
      const materials = item.materials || [];
      const hasMaterials = Array.isArray(materials) && materials.length > 0;
      const materialsSummary = hasMaterials 
        ? materials.map((m: any) => `${m.item || '物资'} ${m.quantity || ''}${m.unit || ''}`).join('、')
        : '';

      let statusTag = 'donation';
      let statusLabel = '服务汇入';

      if (hasDiners || (hasExpense && !hasIncome)) {
        statusTag = 'meal';
        statusLabel = '正常开餐';
      } else if (hasIncome && !hasDiners) {
        statusTag = 'donation';
        statusLabel = '服务汇入';
      }

      statistics.dailyRecords.push({
        _id: item._id,
        _localId: item._localId,
        date: item.dateString,
        shopName: item.shopName,
        otherDonation: otherDonation,
        listDonation: listDonationTotal,
        expense: expenseAmount,
        dailyExpense: dailyExpense,
        largeExpense: fixedExpense,
        income: dailyIncome,
        balance: todayBalance,
        donorCount: donorCount,
        diningCount: diningCount,
        volunteerCount: volunteerCount,
        perMealCost: (totalMeals > 0 && dailyExpense > 0)
          ? Math.round((dailyExpense / totalMeals) * 100) / 100
          : 0,
        netChange: netChange,
        hasMaterials: hasMaterials,
        materialsSummary: materialsSummary,
        statusTag,
        statusLabel
      });
    });

    statistics.totalIncome = statistics.totalOtherDonation + statistics.totalListDonation;
    statistics.netAccumulation = statistics.totalIncome - statistics.totalExpense;
    statistics.openDays = validOpenDaysSet.size;
    statistics.donationDays = validDonationDaysSet.size;
    statistics.missingCount = missingCountSet.size;

    const days = records.length > 0 ? records.length : 1;
    statistics.avgDailyExpense = Math.round((statistics.dailyExpenseTotal / days) * 100) / 100;

    const endDateObj = parseDate(endDate);
    const ma14Start = new Date(endDateObj);
    ma14Start.setDate(endDateObj.getDate() - 13);
    const ma14StartStr = formatDate(ma14Start);

    const last14DaysRecords = sortedRecords.filter(r => r.dateString >= ma14StartStr && r.dateString <= endDate);
    const ma14Days = last14DaysRecords.length;
    if (ma14Days > 0) {
      const ma14ExpenseTotal = last14DaysRecords.reduce((sum: number, r: any) => {
        let daily = parseFloat(r.dailyExpenseTotal) || 0;
        if (daily === 0 && r.dailyExpenseText) {
          daily = this.parseAmountFromText(r.dailyExpenseText);
        }
        return sum + daily;
      }, 0);
      statistics.avgDailyExpenseMA14 = Math.round((ma14ExpenseTotal / ma14Days) * 100) / 100;
    } else {
      statistics.avgDailyExpenseMA14 = statistics.avgDailyExpense;
    }

    const runwayResult: RunwayResult = calculateEmaRunway(sortedRecords, statistics.latestBalance);
    statistics.runwayDays = runwayResult.runwayDays;
    statistics.emaDailyCost = runwayResult.emaDailyCost;
    statistics.runwayStatusLevel = runwayResult.statusLevel;

    if (runwayResult.runwayDays >= 999) {
      statistics.runwayDaysRange = '资金充裕，持续开餐';
    } else {
      statistics.runwayDaysRange = runwayResult.statusText.replace(/^[🟢🟡🔴]\s/, '').replace(/^资金/, '').replace(/^预警：/, '').replace(/^告急：/, '');
    }

    const totalMeals = statistics.totalDiningCount + statistics.totalVolunteerCount;
    if (totalMeals > 0 && statistics.dailyExpenseTotal > 0) {
      statistics.perMealCost = Math.round((statistics.dailyExpenseTotal / totalMeals) * 100) / 100;
    } else {
      statistics.perMealCost = 0;
    }

    const isRiceUrgent = statistics.latestRiceStatus === 'urgent';
    const isOilUrgent = statistics.latestOilStatus === 'urgent';
    const isNetNegative = statistics.netAccumulation < 0;

    if (runwayResult.statusLevel === 'urgent' && statistics.runwayDays < 999) {
      statistics.healthStatus = 'fundUrgent';
      statistics.healthStatusText = runwayResult.statusText;
      statistics.healthStatusColor = '#E53935';
      statistics.healthIcon = '🔴';
    } else if (runwayResult.statusLevel === 'warning' && statistics.runwayDays < 999) {
      statistics.healthStatus = 'fundWarning';
      statistics.healthStatusText = runwayResult.statusText;
      statistics.healthStatusColor = '#F59E0B';
      statistics.healthIcon = '🟡';
    } else if (statistics.dailyExpenseTotal === 0 && statistics.largeExpenseTotal > 0 && statistics.netAccumulation < 0) {
      // 筹备期/休餐期：仅有固定资产或房租投入，无日常开餐食材支出
      statistics.healthStatus = 'preparing';
      statistics.healthStatusText = `💡 本期包含筹备/固定资产投入 ¥${formatMoney(statistics.largeExpenseTotal)}，当前结余 ¥${formatMoney(statistics.latestBalance)}，运转正常`;
      statistics.healthStatusColor = '#F5A623';
      statistics.healthIcon = '💡';
    } else if (isNetNegative) {
      // 真实运营赤字：余额较低才警告，大额房租但余额充足时降级
      if (statistics.latestBalance < 500) {
        statistics.healthStatus = 'fundUrgent';
        statistics.healthStatusText = `⚠️ 账户结余较低 (¥${formatMoney(statistics.latestBalance)})，请留意后续服务资金筹备`;
        statistics.healthStatusColor = '#E53935';
        statistics.healthIcon = '🔴';
      } else if (statistics.largeExpenseTotal > 0) {
        statistics.healthStatus = 'largeExpenseInfo';
        statistics.healthStatusText = `💡 本期包含房租/专项大额支出 ¥${formatMoney(statistics.largeExpenseTotal)}，账户结余仍可支撑`;
        statistics.healthStatusColor = '#F5A623';
        statistics.healthIcon = '💡';
      } else {
        statistics.healthStatus = 'fundUrgent';
        statistics.healthStatusText = '⚠️ 本期支出大于服务汇入，请留意资金筹备';
        statistics.healthStatusColor = '#E53935';
        statistics.healthIcon = '🔴';
      }
    } else if (isRiceUrgent || isOilUrgent) {
      const urgentItems = [];
      if (isRiceUrgent) urgentItems.push('大米');
      if (isOilUrgent) urgentItems.push('食用油');
      statistics.healthStatus = 'materialWarning';
      statistics.healthStatusText = `资金充裕，但${urgentItems.join('/')}储备告急，期待物资接力`;
      statistics.healthStatusColor = '#FF9800';
      statistics.healthIcon = '🟡';
    } else {
      statistics.healthStatus = 'healthy';
      statistics.healthStatusText = '服务资金与物资充足，平稳运行中';
      statistics.healthStatusColor = '#4CAF50';
      statistics.healthIcon = '🟢';
    }

    statistics.materialsSummary = Array.from(materialsMap.values()).map(m => ({
      item: m.item,
      unit: m.unit,
      totalQty: Number.isInteger(m.totalQty) ? m.totalQty : Math.round(m.totalQty * 10) / 10
    }));

    statistics.dailyRecords.sort((a, b) => {
      return parseDate(b.date).getTime() - parseDate(a.date).getTime();
    });

    return statistics;
  },

  async exportToExcel() {
    const { statistics, shopName, selectedYear, selectedMonth, currentTab, customStartDate, customEndDate } = this.data;

    if (!statistics || !statistics.dailyRecords || statistics.dailyRecords.length === 0) {
      wx.showToast({ title: '当前周期无明细可导出', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在生成 Excel 表格...', mask: true });

    try {
      // 优先使用云函数生成带样式的 xlsx
      const res = await wx.cloud.callFunction({
        name: 'exportAccountExcel',
        data: {
          shopName: shopName || 'default',
          tabType: currentTab,
          selectedYear: String(selectedYear),
          selectedMonth: String(selectedMonth).padStart(2, '0'),
          startDate: customStartDate,
          endDate: customEndDate
        }
      });

      const result = (res.result || {}) as any;

      if (result.success && result.tempFileURL) {
        wx.hideLoading();
        this.downloadAndOpenExcel(result.tempFileURL, result.fileName || '收支明细.xlsx');
      } else {
        throw new Error(result.errMsg || '云函数导出失败');
      }
    } catch (cloudErr: any) {
      console.warn('[Export] 云函数导出失败，降级为本地 CSV:', cloudErr.errMsg || cloudErr.message);
      // 降级：本地生成 CSV
      this.exportLocalCSV();
    }
  },

  downloadAndOpenExcel(tempFileURL: string, fileName: string) {
    wx.showLoading({ title: '正在下载表格...', mask: true });

    wx.downloadFile({
      url: tempFileURL,
      success: (downloadRes) => {
        wx.hideLoading();
        const filePath = downloadRes.tempFilePath;

        // 优先使用 shareFileMessage 发送给文件
        if (wx.shareFileMessage) {
          wx.shareFileMessage({
            filePath: filePath,
            fileName: fileName,
            success: () => {
              wx.showToast({ title: '表格已导出成功', icon: 'success' });
            },
            fail: (shareErr) => {
              if (!shareErr.errMsg || !shareErr.errMsg.includes('cancel')) {
                wx.openDocument({
                  filePath: filePath,
                  fileType: 'xlsx',
                  showMenu: true,
                  fail: () => {
                    wx.showModal({
                      title: '已生成表格文件',
                      content: '请重新点击"导出表格"，在微信列表中选择【文件传输助手】保存到手机即可查看！',
                      showCancel: false
                    });
                  }
                });
              }
            }
          });
        } else {
          wx.openDocument({
            filePath: filePath,
            fileType: 'xlsx',
            showMenu: true,
            fail: () => {
              wx.showToast({ title: '打开失败，请重试', icon: 'none' });
            }
          });
        }
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '下载失败，请重试', icon: 'none' });
      }
    });
  },

  exportLocalCSV() {
    const { statistics, shopName, selectedYear, selectedMonth, currentTab } = this.data;
    if (!statistics) return;

    wx.showLoading({ title: '正在生成表格...', mask: true });

    try {
      const csvContent = '\ufeff' + this.buildCSV(statistics.dailyRecords, shopName || '全部门店');
      const fs = wx.getFileSystemManager();

      let periodLabel = '';
      if (currentTab === 'week') {
        periodLabel = `${selectedYear}年${selectedMonth}月周报`;
      } else if (currentTab === 'month') {
        periodLabel = `${selectedYear}年${selectedMonth}月`;
      } else if (currentTab === 'year') {
        periodLabel = `${selectedYear}年度`;
      } else {
        periodLabel = '自定义周期';
      }

      const safeStoreName = String(shopName || '全部门店').replace(/[\\/:*?"<>|]/g, '');
      const fileName = `${safeStoreName}_收支明细_${periodLabel}.csv`;
      const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`;

      fs.writeFileSync(filePath, csvContent, 'utf8');
      wx.hideLoading();

      if (wx.shareFileMessage) {
        wx.shareFileMessage({
          filePath: filePath,
          fileName: fileName,
          success: () => {
            wx.showToast({ title: '表格已成功导出并发送！', icon: 'success' });
          },
          fail: (err) => {
            if (!err.errMsg || !err.errMsg.includes('cancel')) {
              this.tryOpenDocumentFallback(filePath);
            }
          }
        });
      } else {
        this.tryOpenDocumentFallback(filePath);
      }
    } catch (error) {
      wx.hideLoading();
      console.error('[Export] CSV 导出失败:', error);
      wx.showToast({ title: '导出失败，请重试', icon: 'none' });
    }
  },

  // 降级预览方案（当 shareFileMessage 不可用时回退）
  tryOpenDocumentFallback(filePath: string) {
    wx.openDocument({
      filePath: filePath,
      fileType: 'csv',
      showMenu: true,
      fail: () => {
        wx.showModal({
          title: '已准备好表格文件',
          content: '请重新点击"导出表格"，并在弹出的微信列表中选择【文件传输助手】即可保存到手机！',
          showCancel: false
        });
      }
    });
  },

  fallbackCopyToClipboard(csvText: string) {
    wx.setClipboardData({
      data: csvText,
      success: () => {
        wx.showModal({
          title: '已复制表格文本',
          content: '手机端无法直接写本地文件，已将 CSV 表格内容复制到剪贴板，您可以直接粘贴到微信聊天框或 Excel 中！',
          showCancel: false
        });
      }
    });
  },

  async onGenerateGratitudeReport() {
    const { statistics, shopName, selectedYear, selectedMonth, currentTab } = this.data;
    if (!statistics) {
      wx.showToast({ title: '暂无数据', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在生成汇报卡片...', mask: true });

    let periodText = '';
    if (currentTab === 'week') {
      periodText = `${selectedYear}年${selectedMonth}月 第${Math.ceil(new Date().getDate() / 7)}周`;
    } else if (currentTab === 'month') {
      periodText = `${selectedYear}年${selectedMonth}月`;
    } else if (currentTab === 'year') {
      periodText = `${selectedYear}年度`;
    } else {
      periodText = `${statistics.startDate} ~ ${statistics.endDate}`;
    }

    const statsData: GratitudeReportData = {
      periodTitle: periodText,
      storeName: shopName || '海沧区雨花斋',
      diningDays: statistics.openDays || 0,
      incomeDays: statistics.donationDays || 0,
      totalDiners: statistics.totalDiningCount || 0,
      volunteerCount: statistics.totalVolunteerCount || 0,
      volunteerHours: statistics.totalVolunteerHours || 0,
      totalIncome: parseFloat(statistics.totalIncomeStr) || 0,
      totalExpense: parseFloat(statistics.totalExpenseStr) || 0,
      dailyFoodExpense: parseFloat(statistics.dailyExpenseTotalStr) || 0,
      totalBalance: parseFloat(statistics.latestBalanceStr) || 0,
      estimatedDays: statistics.runwayDaysStr || '—',
      riceStatus: statistics.riceStatusText || '一般',
      oilStatus: statistics.oilStatusText || '充足'
    };

    const reportText = formatGratitudeReportText(statsData);
    const isPreparing = statsData.diningDays === 0 && statsData.totalIncome > 0;

    const incomeStr = (statsData.totalIncome || 0).toFixed(2);
    const expenseStr = (statsData.totalExpense || 0).toFixed(2);
    const balanceStr = (statsData.totalBalance || 0).toFixed(2);

    this.setData({ 
      gratitudeReportText: reportText, 
      showGratitudeModal: true,
      gratitudeReportData: statsData,
      gratitudeIncomeStr: incomeStr,
      gratitudeExpenseStr: expenseStr,
      gratitudeBalanceStr: balanceStr,
      gratitudeTempFilePath: '',
      isPreparingPhase: isPreparing
    });

    wx.hideLoading();

    // 同时复制纯文本到剪贴板，方便直接粘贴到微信群
    wx.setClipboardData({
      data: reportText,
      success: () => {
        wx.showToast({ title: '汇报文案已复制', icon: 'success' });
      },
      fail: () => {
        console.warn('[onGenerateGratitudeReport] 剪贴板复制失败');
      }
    });

    setTimeout(() => {
      this.drawGratitudeCanvasCard(statsData);
    }, 300);
  },

  onCopyGratitudeText() {
    const reportText = this.data.gratitudeReportText;
    if (!reportText) return;
    wx.setClipboardData({
      data: reportText,
      success: () => {
        wx.showToast({ title: '文案已复制', icon: 'success' });
      }
    });
  },

  drawGratitudeCanvasCard(data: GratitudeReportData) {
    const query = wx.createSelectorQuery();
    query.select('#gratitudeReportCanvas')
      .fields({ node: true, size: true })
      .exec((res: any) => {
        if (!res[0] || !res[0].node) {
          console.warn('Canvas 节点未找到');
          return;
        }

        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2;

        const w = 320;
        const h = 580;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);

        const drawRoundRect = (x: number, y: number, rw: number, rh: number, r: number, fill: boolean, stroke: boolean) => {
          ctx.beginPath();
          ctx.moveTo(x + r, y);
          ctx.lineTo(x + rw - r, y);
          ctx.arc(x + rw - r, y + r, r, -Math.PI / 2, 0);
          ctx.lineTo(x + rw, y + rh - r);
          ctx.arc(x + rw - r, y + rh - r, r, 0, Math.PI / 2);
          ctx.lineTo(x + r, y + rh);
          ctx.arc(x + r, y + rh - r, r, Math.PI / 2, Math.PI);
          ctx.lineTo(x, y + r);
          ctx.arc(x + r, y + r, r, Math.PI, -Math.PI / 2);
          ctx.closePath();
          if (fill) ctx.fill();
          if (stroke) ctx.stroke();
        };

        ctx.fillStyle = '#FBF9F5';
        ctx.fillRect(0, 0, w, h);

        ctx.fillStyle = '#8C1D18';
        ctx.fillRect(0, 0, w, 70);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 18px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('❤️ 雨花斋感恩汇报', w / 2, 42);

        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#F0E6D2';
        ctx.lineWidth = 2;
        drawRoundRect(16, 86, w - 32, h - 102, 16, true, true);

        ctx.fillStyle = '#8C1D18';
        ctx.font = 'bold 18px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('吃素一日 健康一天', w / 2, 125);

        ctx.fillStyle = '#8C7355';
        ctx.font = '12px sans-serif';
        ctx.fillText(`📍 ${data.storeName} · ${data.periodTitle}`, w / 2, 148);

        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#E8DCC4';
        ctx.lineWidth = 1;
        ctx.moveTo(32, 165);
        ctx.lineTo(w - 32, 165);
        ctx.stroke();
        ctx.setLineDash([]);

        const isPreparing = data.diningDays === 0 && data.totalIncome > 0;
        let badgeY = 180;
        if (isPreparing) {
          ctx.fillStyle = '#FFF8EE';
          ctx.strokeStyle = '#FFE0B2';
          ctx.lineWidth = 1;
          drawRoundRect(32, badgeY, w - 64, 36, 18, true, true);
          ctx.fillStyle = '#D32F2F';
          ctx.font = 'bold 12px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('🌱 试运营统筹阶段 · 资金与场地筹备中', w / 2, badgeY + 23);
        } else {
          ctx.fillStyle = '#E8F5E9';
          ctx.strokeStyle = '#C8E6C9';
          ctx.lineWidth = 1;
          drawRoundRect(32, badgeY, w - 64, 36, 18, true, true);
          ctx.fillStyle = '#2E7D32';
          ctx.font = 'bold 12px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('✨ 顺利开餐运营中 · 温暖爱心传递', w / 2, badgeY + 23);
        }

        const sectionStartY = badgeY + 50;
        ctx.fillStyle = '#8C1D18';
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('🧡 爱心护持成果', 32, sectionStartY);

        const gridStartY = sectionStartY + 20;
        const gridW = (w - 64) / 2 - 4;
        const gridH = 60;
        const gridGap = 8;

        const drawGridItem = (x: number, y: number, label: string, value: string, highlight: boolean = false) => {
          ctx.fillStyle = '#FFFDF8';
          ctx.strokeStyle = '#F2E9D8';
          ctx.lineWidth = 1;
          drawRoundRect(x, y, gridW, gridH, 8, true, true);

          ctx.fillStyle = '#888888';
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(label, x + gridW / 2, y + 18);

          ctx.fillStyle = highlight ? '#8C1D18' : '#333333';
          ctx.font = 'bold 14px sans-serif';
          ctx.fillText(value, x + gridW / 2, y + 42);
        };

        const diningDaysText = data.diningDays > 0 ? data.diningDays + ' 天' : '筹备期';
        drawGridItem(32, gridStartY, '累计开餐', diningDaysText);
        drawGridItem(32 + gridW + gridGap, gridStartY, '服务用餐', data.totalDiners + ' 人次', true);
        drawGridItem(32, gridStartY + gridH + gridGap, '义工护持', data.volunteerCount + ' 人次');
        drawGridItem(32 + gridW + gridGap, gridStartY + gridH + gridGap, '无偿工时', data.volunteerHours + ' 小时');

        const financeStartY = gridStartY + gridH * 2 + gridGap * 3;
        ctx.fillStyle = '#8C1D18';
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('💰 收支透明账本', 32, financeStartY);

        const financeBoxY = financeStartY + 16;
        ctx.fillStyle = '#FFFDF8';
        ctx.strokeStyle = '#F2E9D8';
        ctx.lineWidth = 1;
        drawRoundRect(32, financeBoxY, w - 64, 90, 10, true, true);

        ctx.font = '12px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#666666';
        ctx.fillText('服务汇入：', 48, financeBoxY + 24);
        ctx.fillStyle = '#2E7D32';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('+¥' + (data.totalIncome || 0).toFixed(2), w - 48, financeBoxY + 24);

        ctx.fillStyle = '#666666';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('运营支出：', 48, financeBoxY + 48);
        ctx.fillStyle = '#C62828';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('-¥' + (data.totalExpense || 0).toFixed(2), w - 48, financeBoxY + 48);

        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#E0D5C1';
        ctx.lineWidth = 1;
        ctx.moveTo(48, financeBoxY + 62);
        ctx.lineTo(w - 48, financeBoxY + 62);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#333333';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('账户实时总结余：', 48, financeBoxY + 82);
        ctx.fillStyle = '#8C1D18';
        ctx.font = 'bold 16px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('¥' + (data.totalBalance || 0).toFixed(2), w - 48, financeBoxY + 82);

        const materialStartY = financeBoxY + 110;
        ctx.fillStyle = '#FFFDF8';
        drawRoundRect(32, materialStartY, w - 64, 36, 8, true, false);
        ctx.fillStyle = '#666666';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('📦 主食物资：', 44, materialStartY + 24);

        const drawTag = (x: number, text: string, urgent: boolean) => {
          const tagW = ctx.measureText(text).width + 24;
          ctx.fillStyle = urgent ? '#FFEBEE' : '#F5F5F5';
          drawRoundRect(x, materialStartY + 6, tagW, 24, 12, true, false);
          ctx.fillStyle = urgent ? '#C62828' : '#666666';
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(text, x + tagW / 2, materialStartY + 21);
          return x + tagW + 8;
        };

        let tagX = 110;
        tagX = drawTag(tagX, '大米 [' + data.riceStatus + ']', data.riceStatus === '告急');
        drawTag(tagX, '食用油 [' + data.oilStatus + ']', data.oilStatus === '告急');

        const footerStartY = materialStartY + 50;
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#E8DCC4';
        ctx.lineWidth = 1;
        ctx.moveTo(32, footerStartY);
        ctx.lineTo(w - 32, footerStartY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#8C7355';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('感恩各位爱心人士护持与义工团队无私付出！', w / 2, footerStartY + 28);

        ctx.fillStyle = '#ADB5BD';
        ctx.font = '10px sans-serif';
        ctx.fillText('透明账本 · 实时可查', w / 2, footerStartY + 46);

        wx.canvasToTempFilePath({
          canvas,
          success: (res: any) => {
            this.setData({ gratitudeTempFilePath: res.tempFilePath });
          },
          fail: () => {
            console.warn('Canvas 导出图片失败');
          }
        });
      });
  },

  onSaveGratitudeCardToAlbum() {
    const path = this.data.gratitudeTempFilePath;
    if (!path) {
      wx.showLoading({ title: '卡片生成中...', mask: true });
      this.drawGratitudeCanvasCard(this.data.gratitudeReportData);
      setTimeout(() => {
        wx.hideLoading();
        if (this.data.gratitudeTempFilePath) {
          this.onSaveGratitudeCardToAlbum();
        } else {
          wx.showToast({ title: '卡片生成失败，请重试', icon: 'none' });
        }
      }, 1500);
      return;
    }

    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: () => {
        wx.showToast({ title: '感恩卡片已保存至相册！', icon: 'success' });
        this.setData({ showGratitudeModal: false });
      },
      fail: (err: any) => {
        if (err.errMsg && err.errMsg.includes('auth deny')) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中允许小程序保存图片到相册',
            success: (r: any) => { if (r.confirm) wx.openSetting(); }
          });
        }
      }
    });
  },

  onForwardGratitudeToWeChat() {
    const path = this.data.gratitudeTempFilePath;
    const reportText = this.data.gratitudeReportText;
    const storeName = this.data.shopName || '雨花斋';

    if (!path) {
      wx.showLoading({ title: '卡片生成中...', mask: true });
      this.drawGratitudeCanvasCard(this.data.gratitudeReportData);
      setTimeout(() => {
        wx.hideLoading();
        if (this.data.gratitudeTempFilePath) {
          this.onForwardGratitudeToWeChat();
        } else {
          wx.showToast({ title: '卡片生成失败，请重试', icon: 'none' });
        }
      }, 1500);
      return;
    }

    if (wx.showShareImageMenu) {
      wx.showShareImageMenu({
        path: path,
        fail: () => {
          wx.previewImage({ current: path, urls: [path] });
        }
      });
    } else if (wx.shareFileMessage) {
      wx.shareFileMessage({
        filePath: path,
        fileName: `${storeName}_感恩汇报.png`,
        success: () => {
          wx.showToast({ title: '分享成功！', icon: 'success' });
        }
      });
    } else {
      wx.setClipboardData({
        data: reportText,
        success: () => {
          wx.showToast({ title: '汇报文案已复制，可直接发群', icon: 'none' });
        }
      });
    }
  },

  onCloseGratitudeModal() {
    this.setData({ showGratitudeModal: false });
  },

  onGeneratePoster() {
    const { statistics, shopName, selectedYear, selectedMonth, currentTab } = this.data;
    if (!statistics) {
      wx.showToast({ title: '暂无数据', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在合成公示海报...', mask: true });

    try {
      const query = wx.createSelectorQuery();
      query.select('#posterCanvas')
        .fields({ node: true, size: true })
        .exec((res: any) => {
          if (!res[0] || !res[0].node) {
            wx.hideLoading();
            wx.showToast({ title: 'Canvas 初始化失败', icon: 'none' });
            return;
          }

          const canvas = res[0].node;
          const ctx = canvas.getContext('2d');
          const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2) || 2;

          const W = 600;
          const H = 1000;
          canvas.width = W * dpr;
          canvas.height = H * dpr;
          ctx.scale(dpr, dpr);

          ctx.fillStyle = '#FAF6F0';
          ctx.fillRect(0, 0, W, H);

          ctx.fillStyle = '#8C1D18';
          ctx.fillRect(0, 0, W, 140);

          ctx.fillStyle = '#FFFFFF';
          ctx.font = 'bold 28px "PingFang SC", sans-serif';
          ctx.fillText(`${shopName || '雨花斋'} · 收支公示海报`, 40, 60);

          ctx.font = '18px sans-serif';
          let periodText = '';
          if (currentTab === 'week') {
            periodText = `${selectedYear}年${selectedMonth}月 周报`;
          } else if (currentTab === 'month') {
            periodText = `${selectedYear}年${selectedMonth}月 月报`;
          } else if (currentTab === 'year') {
            periodText = `${selectedYear}年度 年报`;
          } else {
            periodText = `${statistics.startDate} ~ ${statistics.endDate}`;
          }
          ctx.fillText(`统计周期: ${periodText}`, 40, 100);

          ctx.fillStyle = '#FFFFFF';
          ctx.shadowColor = 'rgba(0, 0, 0, 0.05)';
          ctx.shadowBlur = 10;
          ctx.fillRect(30, 160, 540, 780);
          ctx.shadowBlur = 0;

          ctx.fillStyle = '#212529';
          ctx.font = 'bold 22px sans-serif';
          ctx.fillText(`服务汇入总额: +¥${statistics.totalIncomeStr}`, 60, 220);
          ctx.fillText(`开餐支出总额: -¥${statistics.totalExpenseStr}`, 60, 270);
          ctx.fillText(`本期服务积累: ${statistics.netAccumulationStr}`, 60, 320);

          ctx.fillStyle = '#495057';
          ctx.font = '18px sans-serif';
          ctx.fillText(`• 日常食材支出: ¥${statistics.dailyExpenseTotalStr}`, 80, 370);
          ctx.fillText(`• 房租/专项固定: ¥${statistics.largeExpenseTotalStr}`, 80, 405);

          // 绘制 2x2 数据卡片矩阵
          const cardStartY = 440;
          const cardW = (W - 100) / 2;
          const cardH = 75;
          const cardGapX = 20;
          const cardGapY = 15;

          const dataCards = [
            { label: '累计开餐天数', value: `${statistics.openDays} 天`, color: '#8C1D18' },
            { label: '服务用餐人次', value: `${statistics.totalDiningCount} 人`, color: '#8C1D18' },
            { label: '义工服务工时', value: `${statistics.totalVolunteerHours} 小时`, color: '#8C1D18' },
            { label: '每餐服务投入', value: statistics.showPerMealCost ? `¥${statistics.perMealCostStr}` : '-', color: '#2E7D32' }
          ];

          dataCards.forEach((card, index) => {
            const col = index % 2;
            const row = Math.floor(index / 2);
            const x = 40 + col * (cardW + cardGapX);
            const y = cardStartY + row * (cardH + cardGapY);

            ctx.fillStyle = '#FFF8EE';
            this.roundRect(ctx, x, y, cardW, cardH, 10, true);

            ctx.fillStyle = '#8C7355';
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(card.label, x + cardW / 2, y + 25);

            ctx.fillStyle = card.color;
            ctx.font = 'bold 18px sans-serif';
            ctx.fillText(card.value, x + cardW / 2, y + 55);
          });
          ctx.textAlign = 'left';

          const coreStartY = cardStartY + 2 * (cardH + cardGapY) + 20;
          ctx.fillStyle = '#FFFDF8';
          this.roundRect(ctx, 40, coreStartY, W - 80, 70, 10, true);

          ctx.fillStyle = '#8C1D18';
          ctx.font = 'bold 18px sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(`🍲 本期累计恭敬结缘开餐：${statistics.totalDiningCount} 人次`, 60, coreStartY + 30);

          ctx.fillStyle = '#495057';
          ctx.font = '15px sans-serif';
          ctx.fillText(`每餐爱心食材折算：${statistics.showPerMealCost ? `¥${statistics.perMealCostStr} / 人` : '数据计算中'}`, 60, coreStartY + 58);

          ctx.fillStyle = '#868E96';
          ctx.font = '16px sans-serif';

          const balanceNum = Number(statistics.latestBalance || 0);
          const avgExpense = Number(statistics.avgDailyExpenseMA14 || statistics.avgDailyExpense || 0);
          const isPrep = Number(statistics.dailyExpenseTotal || 0) === 0;
          const daysStatusText = this.getPosterDaysText(balanceNum, avgExpense, isPrep);
          const posterFooterText = `账户结余: ¥${balanceNum.toFixed(2)} (${daysStatusText})`;

          ctx.fillText(posterFooterText, 60, coreStartY + 110);
          ctx.fillText(`核心物资: 大米[${statistics.riceStatusText}] / 食用油[${statistics.oilStatusText}]`, 60, coreStartY + 145);

          const netAccumulation = parseFloat(statistics.netAccumulation) || 0;
          let statusBannerBg = '#FAB005';
          let statusBannerText = '服务资金与物资充足，平稳运行中';
          if (netAccumulation < 0) {
            statusBannerBg = '#E03131';
            statusBannerText = '⚠️ 本期资金支出大于汇入，呼吁善士护持';
          }

          ctx.fillStyle = statusBannerBg;
          ctx.fillRect(30, H - 100, 540, 50);
          ctx.fillStyle = '#FFFFFF';
          ctx.font = 'bold 20px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(statusBannerText, W / 2, H - 65);
          ctx.textAlign = 'left';

          ctx.fillStyle = '#868E96';
          ctx.font = '12px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('扫码查看透明账本', W / 2, H - 25);
          ctx.textAlign = 'left';

          wx.canvasToTempFilePath({
            canvas: canvas,
            success: (tempRes: any) => {
              wx.hideLoading();
              this.setData({
                posterTempFilePath: tempRes.tempFilePath,
                showPosterModal: true
              });
            },
            fail: () => {
              wx.hideLoading();
              wx.showToast({ title: '海报生成失败', icon: 'none' });
            }
          });
        });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '海报生成异常', icon: 'none' });
    }
  },

  roundRect(ctx: any, x: number, y: number, w: number, h: number, r: number, fill: boolean) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    ctx.lineTo(x + w, y + h - r);
    ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    ctx.lineTo(x + r, y + h);
    ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    ctx.lineTo(x, y + r);
    ctx.arc(x + r, y + r, r, Math.PI, -Math.PI / 2);
    ctx.closePath();
    if (fill) ctx.fill();
  },

  // 智能格式化海报天数/状态文案，避免“预计可支撑”与状态文本硬拼接产生语病
  getPosterDaysText(totalBalance: number, avgDailyExpense: number, isPreparingPeriod: boolean) {
    if (totalBalance <= 0) {
      return '资金紧缺，呼吁善士护持';
    }

    // 休餐/筹备期（食材支出为 0）
    if (isPreparingPeriod || avgDailyExpense <= 0) {
      const estimatedDays = Math.floor(totalBalance / 150);
      if (estimatedDays > 99) {
        return '预计可平稳开餐 99+ 天';
      }
      return `预计可平稳开餐约 ${estimatedDays} 天`;
    }

    // 正常运营期：用实际结余 ÷ 实际日均食材费
    const realDays = Math.floor(totalBalance / avgDailyExpense);
    if (realDays > 99) {
      return '预计可平稳开餐 99+ 天';
    } else if (realDays > 0) {
      return `预计可平稳开餐约 ${realDays} 天`;
    } else {
      return '资金即刻告急，亟需补充';
    }
  },

  onClosePosterModal() {
    this.setData({ showPosterModal: false });
  },

  onOpenEditMajorModal(e: any) {
    const item = e.currentTarget.dataset.item;
    this.setData({
      editingTargetRecord: item,
      editingInputText: '',
      showEditMajorModal: true
    });
  },

  onCloseEditMajorModal() {
    this.setData({ showEditMajorModal: false });
  },

  onMajorInputBlur(e: any) {
    this.setData({ editingInputText: e.detail.value });
  },

  async onSubmitPatchMajorText() {
    const { editingTargetRecord, editingInputText } = this.data;

    if (!editingInputText || !editingInputText.trim()) {
      wx.showToast({ title: '请输入具体事由和金额', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在更新账目...', mask: true });

    const targetId = editingTargetRecord.recordId;
    const patchText = editingInputText.trim();

    try {
      if (targetId) {
        const result = await wx.cloud.callFunction({
          name: 'updateReportLog',
          data: {
            recordId: targetId,
            updateData: {
              fixedMajorText: patchText,
              fixedExpenseText: patchText,
              remark: patchText
            }
          }
        });
        const res = result.result as any;
        if (!res?.success) {
          console.warn('[PatchMajor] 云函数更新失败:', res?.error);
        }
      }

      const localRecords = wx.getStorageSync('local_report_logs') || [];
      const targetLocal = localRecords.find((r: any) => (r._id === targetId || r.reportDate === editingTargetRecord.date));
      if (targetLocal) {
        targetLocal.fixedMajorText = patchText;
        targetLocal.fixedExpenseText = patchText;
        targetLocal.remark = patchText;
        wx.setStorageSync('local_report_logs', localRecords);
      }

      wx.hideLoading();
      wx.showToast({ title: '明细已成功拆解！', icon: 'success' });

      this.setData({ showEditMajorModal: false });
      this.reloadShopListAndStats();

    } catch (err: any) {
      wx.hideLoading();
      console.error('Patch error:', err);
      wx.showToast({ title: '更新失败，请重试', icon: 'none' });
    }
  },

  onSharePosterToWeChat() {
    const filePath = this.data.posterTempFilePath;
    if (!filePath) {
      wx.showToast({ title: '海报生成中，请稍后', icon: 'none' });
      return;
    }

    if (wx.showShareImageMenu) {
      wx.showShareImageMenu({
        path: filePath,
        success: () => {
          console.log('✅ 唤起微信分享菜单成功');
        },
        fail: (err: any) => {
          console.warn('唤起分享菜单失败，降级为预览模式:', err);
          wx.previewImage({ current: filePath, urls: [filePath] });
        }
      });
    } else {
      wx.previewImage({ current: filePath, urls: [filePath] });
    }
  },

  async onSavePosterToAlbum() {
    const filePath = this.data.posterTempFilePath;
    if (!filePath) {
      wx.showToast({ title: '海报尚未生成', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中...', mask: true });

    try {
      await wx.saveImageToPhotosAlbum({ filePath });
      wx.hideLoading();
      wx.showToast({
        title: '🎉 已保存到相册',
        icon: 'success',
        duration: 2000
      });
    } catch (err: any) {
      wx.hideLoading();
      if (err.errMsg && (err.errMsg.includes('auth deny') || err.errMsg.includes('auth denied') || err.errMsg.includes('not authorized'))) {
        wx.showModal({
          title: '提示',
          content: '需要允许保存图片到相册权限，请在设置中开启',
          confirmText: '去设置',
          success: (res: any) => {
            if (res.confirm) {
              wx.openSetting();
            }
          }
        });
      } else {
        wx.showToast({ title: '保存失败，可长按海报保存', icon: 'none' });
      }
    }
  },

  buildCSV(data: any[], storeName: string): string {
    let csv = '日期,门店名称,服务收入(元),日常食材开销(元),房租专项大额(元),总支出(元),净盈亏(元),用餐人次,到岗义工(人),大额备注/说明\n';

    data.forEach(item => {
      const date = item.date || '';
      const store = storeName || '雨花斋';
      const income = parseFloat(item.income || 0).toFixed(2);
      const dailyExp = parseFloat(item.dailyExpense || 0).toFixed(2);
      const largeExp = parseFloat(item.largeExpense || 0).toFixed(2);
      const totalExp = parseFloat(item.expense || 0).toFixed(2);
      const net = (parseFloat(income) - parseFloat(totalExp)).toFixed(2);
      const diners = item.diningCount || 0;
      const volunteers = item.volunteerCount || 0;
      const remark = String(item.materialsSummary || '').replace(/[\r\n,]/g, ' ');

      csv += `"${date}","${store}",${income},${dailyExp},${largeExp},${totalExp},${net},${diners},${volunteers},"${remark}"\n`;
    });

    return csv;
  },

  onRefreshData() {
    wx.showLoading({ title: '刷新中...' });
    DataService.syncLocalDataToCloud().then(() => {
      this.loadShopList();
      this.calculateStats();
      wx.hideLoading();
      wx.showToast({ title: '数据已刷新', icon: 'success' });
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '刷新失败', icon: 'none' });
    });
  },

  onQuickEditDiners(e: any) {
    const idx = e.currentTarget.dataset.index;
    const records = this.data.statistics.dailyRecords;
    const item = records[idx];
    if (!item) return;

    wx.showModal({
      title: `补录【${item.date}】用餐人数`,
      editable: true,
      placeholderText: '请输入实际用餐人次（如：120）',
      success: async (res: any) => {
        if (res.confirm && res.content) {
          const count = parseInt(res.content, 10);
          if (!isNaN(count) && count >= 0) {
            wx.showLoading({ title: '更新中...', mask: true });
            try {
              if (item._id) {
                const result = await wx.cloud.callFunction({
                  name: 'updateReportLog',
                  data: {
                    recordId: item._id,
                    updateData: { diningCount: count }
                  }
                });
                const res = result.result as any;
                if (!res?.success) {
                  console.warn('[DinerUpdate] 云函数更新失败:', res?.error);
                }
              } else if (item._localId) {
                const localReports = wx.getStorageSync('local_report_logs') || [];
                const localIdx = localReports.findIndex((r: any) => r._localId === item._localId);
                if (localIdx >= 0) {
                  localReports[localIdx].diningCount = count;
                  wx.setStorageSync('local_report_logs', localReports);
                }
              }
              wx.hideLoading();
              wx.showToast({ title: '更新成功', icon: 'success' });
              this.calculateStats();
            } catch (err) {
              wx.hideLoading();
              wx.showToast({ title: '更新失败', icon: 'none' });
            }
          }
        }
      }
    });
  },

  onOpenBatchDinerModal() {
    const { statistics } = this.data;
    if (!statistics || !statistics.dailyRecords || statistics.dailyRecords.length === 0) {
      wx.showToast({ title: '暂无记录', icon: 'none' });
      return;
    }

    const missing = statistics.dailyRecords
      .filter((item: any) => !item.diningCount || item.diningCount === 0)
      .map((item: any) => ({ ...item, tempDiners: '' }));

    if (missing.length === 0) {
      wx.showToast({ title: '所有记录用餐人数均已填妥', icon: 'none' });
      return;
    }

    this.setData({
      missingDinerRecords: missing,
      showBatchDinerModal: true
    });
  },

  onCloseBatchDinerModal() {
    this.setData({ showBatchDinerModal: false });
  },

  onBatchDinerInput(e: any) {
    const idx = e.currentTarget.dataset.index;
    const val = e.detail.value;
    const missing = this.data.missingDinerRecords;
    missing[idx].tempDiners = val;
    this.setData({ missingDinerRecords: missing });
  },

  async onSubmitBatchDiners() {
    const { missingDinerRecords } = this.data;
    wx.showLoading({ title: '正在更新记录...', mask: true });

    try {
      let updatedCount = 0;
      const db = wx.cloud.database();

      for (const item of missingDinerRecords) {
        if (item.tempDiners && parseInt(item.tempDiners, 10) > 0) {
          const dinersVal = parseInt(item.tempDiners, 10);
          const recordId = item._id;
          
          if (recordId) {
            try {
              const result = await wx.cloud.callFunction({
                name: 'updateReportLog',
                data: {
                  recordId,
                  updateData: { diningCount: dinersVal }
                }
              });
              const res = result.result as any;
              if (res?.success) {
                updatedCount++;
              } else if (res?.error && res.error.includes('doc not found')) {
                const localReports = wx.getStorageSync('local_report_logs') || [];
                const idx = localReports.findIndex((r: any) => r._localId === item._localId || r._id === recordId);
                if (idx >= 0) {
                  localReports[idx].diningCount = dinersVal;
                  wx.setStorageSync('local_report_logs', localReports);
                  updatedCount++;
                }
              } else {
                console.warn('[BatchDiner] 云端更新失败:', res?.error);
              }
            } catch (callErr) {
              console.warn('[BatchDiner] 云函数调用失败:', callErr);
            }
          } else if (item._localId) {
            const localReports = wx.getStorageSync('local_report_logs') || [];
            const idx = localReports.findIndex((r: any) => r._localId === item._localId);
            if (idx >= 0) {
              localReports[idx].diningCount = dinersVal;
              wx.setStorageSync('local_report_logs', localReports);
              updatedCount++;
            }
          }
        }
      }

      wx.hideLoading();

      if (updatedCount > 0) {
        wx.showToast({
          title: `已成功补录 ${updatedCount} 笔数据`,
          icon: 'success'
        });
      } else {
        wx.showToast({ title: '未填写有效人数', icon: 'none' });
      }

      this.setData({ showBatchDinerModal: false });
      this.calculateStats();
    } catch (err) {
      wx.hideLoading();
      console.error('[BatchDiner] 批量更新异常:', err);
      wx.showToast({ title: '更新失败，请重试', icon: 'none' });
    }
  },

  goBackHome() {
    // 优先使用 navGuard 的智能跳转（自动判断栈深度 + 栈中是否已有首页）
    if (this._navGuard) {
      this._navGuard.goHome();
      return;
    }
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.reLaunch({
        url: '/pages/index/index'
      });
    }
  }
});
