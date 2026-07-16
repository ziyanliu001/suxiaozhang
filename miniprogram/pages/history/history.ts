import { DataService, formatMoney } from '../../utils/dataService';
import { AuthService, getPermissionFlags, PermissionFlags } from '../../utils/authService';
import { getSelectedStore, setSelectedStore } from '../../utils/storeManager';
import { getSafeSystemInfo } from '../../utils/util';
import { createNavGuard, NavGuardInstance } from '../../utils/navGuard';

Page({
  _shareRecord: null as any,
  isNavigating: false,
  _navGuard: null as NavGuardInstance | null,

  data: {
    reports: [],
    filteredReports: [],
    loading: true,
    statusBarHeight: 20,
    navBarHeight: 44,
    totalHeaderHeight: 150,
    isAdmin: false,
    viewMode: 'all' as 'all' | 'personal',
    storeFilterOptions: ['全部门店'],
    storeFilterIndex: 0,
    selectedStoreName: '',
    currentStoreId: '',
    isAllStoresView: false,
    selectedMonthStr: '',
    permissions: {} as PermissionFlags,
    showEditModal: false,
    editingRecord: null as any,
    canAddEditImage: true,
    receiptImgCount: 0,
    isManagerOrAdmin: false,
    isFinanceOrAdmin: false,
    shareRecord: null as any
  },

  onLoad() {
    this.calculateNavBarHeight();
    this.checkAdminStatus();
    this.initPermissions();
    this.loadReports();
    this.initShareMenu();

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

    const activeStore = getSelectedStore();
    const currentStoreId = wx.getStorageSync('current_store_id') || '';
    const currentStoreName = wx.getStorageSync('current_store_name') || '';

    if (activeStore && activeStore.storeName !== this.data.selectedStoreName) {
      this.setData({
        selectedStoreName: activeStore.storeName,
        currentStoreId: currentStoreId || activeStore.storeId || ''
      });
    } else if (currentStoreName && currentStoreName !== this.data.selectedStoreName) {
      this.setData({
        selectedStoreName: currentStoreName,
        currentStoreId: currentStoreId
      });
    }
    this.initPermissions();
    this.loadReports();
    DataService.syncLocalDataToCloud();
  },

  // 🌟 切店全局响应：store-picker 触发 storechange 时同步刷新历史记录
  onStoreChange(e: any) {
    const { storeId, storeName } = e.detail || {};
    console.log('🔄 [history onStoreChange] 切店事件:', { storeId, storeName });

    // 持久化当前门店
    wx.setStorageSync('current_store_id', storeId || '');
    wx.setStorageSync('current_store_name', storeName || '');

    const isAllStores = storeId === 'national_overview' || storeId === 'ALL_STORES';

    this.setData({
      selectedStoreName: storeName || '',
      currentStoreId: storeId || '',
      isAllStoresView: isAllStores
    });

    // 重新拉取新门店的历史餐报列表
    this.loadReports();
  },

  // store-picker 组件绑定的事件
  onStorePickerChange(e: any) {
    this.onStoreChange(e);
  },

  // 🌟 高危功能：一键链式校准全线结余流水
  async onRecalibrateAllBalances() {
    if (!this.data.isManagerRole && !this.data.isFinanceRole && !this.data.isSuperAdmin) {
      wx.showToast({ title: '仅店长与财务拥有校准权限', icon: 'none' });
      return;
    }

    const storeId = this.data.currentStoreId;
    if (!storeId || storeId === 'ALL_STORES' || storeId === 'national_overview') {
      wx.showToast({ title: '请先选择具体门店再进行校准', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '🔄 确定校准流水结余？',
      content: '系统将按照日期由远及近，自动将前一天的“今日结余”校准为后一天的“昨日余额”，并重新计算每一天的结余，用于修复因补单或改账造成的账目差错。',
      confirmText: '开始校准',
      confirmColor: '#E65100',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '全线账目重算中...' });

        try {
          const db = wx.cloud.database();
          const _ = db.command;

          // A. 拉取该门店所有非作废历史账单（按日期升序，由远及近重算）
          const reportRes = await db.collection('report_logs')
            .where({
              storeId: storeId,
              isVoid: _.neq(true)
            })
            .orderBy('dateString', 'asc')
            .get();

          const list = reportRes.data || [];
          if (list.length < 2) {
            wx.hideLoading();
            wx.showToast({ title: '无需校准（记录不足2条）', icon: 'none' });
            return;
          }

          // B. 链式滚雪球计算
          let lastDayBalance = parseFloat(list[0].todayBalance || list[0].calculatedTodayBalance || '0');
          const batchPromises = [];

          for (let i = 1; i < list.length; i++) {
            const currentItem = list[i];
            const otherDonation = parseFloat(currentItem.otherDonation || '0');
            const listDonationTotal = parseFloat(currentItem.listDonationTotal || '0');
            const expenseAmount = parseFloat(currentItem.expenseAmount || '0');
            const inAmt = otherDonation + listDonationTotal;

            // 强制对齐：昨日余额 = 前一天的今日结余
            const newYesterdayBalance = parseFloat(lastDayBalance.toFixed(2));
            // 重新推算今日结余
            const newTodayBalance = parseFloat((newYesterdayBalance + inAmt - expenseAmount).toFixed(2));

            batchPromises.push(
              db.collection('report_logs').doc(currentItem._id).update({
                data: {
                  yesterdayBalance: newYesterdayBalance,
                  todayBalance: newTodayBalance,
                  calculatedTodayBalance: newTodayBalance.toFixed(2),
                  calibratedAt: db.serverDate()
                }
              })
            );

            // 滚雪球传递
            lastDayBalance = newTodayBalance;
          }

          // C. 批量提交云端更新
          await Promise.all(batchPromises);

          wx.hideLoading();
          wx.showToast({ title: '🔄 流水全线校准成功', icon: 'success' });
          this.loadReports();

        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: '校准重算失败', icon: 'none' });
          console.error('校准失败详情:', err);
        }
      }
    });
  },

  async initPermissions() {
    console.log('🛡️ [history] 开始安全核验权限...');

    const applyRoleFlags = (roleSource: string) => {
      const normalizedRole = (roleSource || 'volunteer').toLowerCase();
      const isSuperAdmin = normalizedRole === 'super_admin';
      const isManagerRole = normalizedRole === 'store_manager' || isSuperAdmin;
      const isFinanceRole = normalizedRole === 'finance' || isSuperAdmin;
      const flags = getPermissionFlags({ role: normalizedRole });
      this.setData({
        permissions: flags,
        isManagerOrAdmin: isManagerRole,
        isFinanceOrAdmin: isFinanceRole,
        isManagerRole: isManagerRole,
        isFinanceRole: isFinanceRole,
        isSuperAdmin: isSuperAdmin
      });
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
        console.log('✅ [history] 云端最新角色权限为:', result.roleInfo.role);
        applyRoleFlags(result.roleInfo.role);
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

  switchViewMode(e: any) {
    const mode = e.currentTarget.dataset.mode as 'all' | 'personal';
    this.setData({ viewMode: mode });
    this.loadReports();
  },

  calculateNavBarHeight() {
    try {
      const sysInfo = getSafeSystemInfo();
      const statusBarHeight = sysInfo.statusBarHeight || 20;

      const menuButton = wx.getMenuButtonBoundingClientRect();
      let navBarHeight = 44;
      if (menuButton) {
        navBarHeight = (menuButton.top - statusBarHeight) * 2 + menuButton.height;
      }

      this.setData({
        statusBarHeight,
        navBarHeight: navBarHeight || 44
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
    this.setData({ totalHeaderHeight });
  },

  async loadReports() {
    this.setData({ loading: true });

    const { viewMode, currentStoreId, selectedStoreName } = this.data;
    // 🔑 数据隔离：将 storeId 传给 DataService 做云端强隔离
    // 超管全国总览时 storeId 为 'national_overview' / 'ALL_STORES' 则传空，不限制门店
    const isAllStoresView = !currentStoreId || currentStoreId === 'national_overview' || currentStoreId === 'ALL_STORES';
    const effectiveStoreId = isAllStoresView ? '' : currentStoreId;
    // 🌟 Bug 修复：全国总览时 shopName 也设为空，避免按 '全国总览' 过滤导致无数据
    const effectiveShopName = (!isAllStoresView && selectedStoreName && selectedStoreName !== '全部门店')
      ? selectedStoreName
      : '';
    const result = await DataService.getReports({
      viewMode,
      storeId: effectiveStoreId,
      shopName: effectiveShopName
    });
    
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
        approvalStatus: item.approvalStatus || 'PENDING_APPROVAL',
        isLocked: item.isLocked || false,
        approvedBy: item.approvedBy || '',
        approveTime: item.approveTime || '',
        auditedBy: item.auditedBy || '',
        auditTime: item.auditTime || ''
      };
    });

    const storeSet = new Set<string>();
    formattedReports.forEach((item: any) => {
      if (item.shopName) storeSet.add(item.shopName);
    });
    const storeOptions = ['全部门店', ...Array.from(storeSet)];

    this.setData({
      reports: formattedReports,
      storeFilterOptions: storeOptions
    }, () => {
      this.convertReceiptImagesToUrls();
    });
  },

  async convertReceiptImagesToUrls() {
    const { reports } = this.data;
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

      this.setData({ reports: updatedReports, loading: false }, () => {
        this.applyFilters();
      });
    } catch (err) {
      console.warn('[convertReceiptImagesToUrls] 图片URL转换失败:', err);
      this.setData({ loading: false });
      this.applyFilters();
    }
  },

  applyFilters() {
    const { reports, selectedStoreName, selectedMonthStr } = this.data;
    
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

    filtered.sort((a: any, b: any) => {
      const dateA = a.dateString || a.reportDate || '';
      const dateB = b.dateString || b.reportDate || '';
      return dateB.localeCompare(dateA);
    });

    this.setData({ filteredReports: this.processReportListAudit(filtered) });
  },

  onStoreFilterChange(e: any) {
    const index = e.detail.value;
    const storeName = this.data.storeFilterOptions[index];
    this.setData({
      storeFilterIndex: index,
      selectedStoreName: index === 0 ? '' : storeName
    }, () => {
      this.applyFilters();
    });

    if (index !== 0 && storeName) {
      setSelectedStore({ storeId: '', storeName });
    }
  },

  onMonthFilterChange(e: any) {
    const monthStr = e.detail.value;
    this.setData({
      selectedMonthStr: monthStr
    }, () => {
      this.applyFilters();
    });
  },

  onClearMonthFilter() {
    this.setData({ selectedMonthStr: '' });
    this.applyFilters();
    wx.showToast({ title: '已展示全部月份', icon: 'none' });
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
    console.log('[Share] 点击分享按钮, id:', id, ', date:', date);

    if (!id) {
      wx.showToast({ title: '数据异常', icon: 'none' });
      return;
    }

    const report = this.data.reports.find((r: any) => (r._id || r._localId) === id);

    if (!report) {
      const filteredReport = this.data.filteredReports.find((r: any) => (r._id || r._localId) === id);
      if (filteredReport) {
        this._shareRecord = filteredReport;
        this.setData({ shareRecord: filteredReport });
        console.log('[Share] 从filteredReports找到记录:', filteredReport.dateString);
      } else {
        wx.showToast({ title: '未找到记录', icon: 'none' });
        return;
      }
    } else {
      this._shareRecord = report;
      this.setData({ shareRecord: report });
      console.log('[Share] 从reports找到记录:', report.dateString);
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
    console.log('[Share] onShareAppMessage 被调用, from:', options?.from);
    const record = this._shareRecord || this.data.shareRecord;

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

    console.log('[Share] 分享标题:', `${store}·${date}餐报`);

    return {
      title: `${store}·${date}餐报`,
      path: '/pages/index/index',
      imageUrl: '',
      success: (res: any) => {
        console.log('[Share] 分享成功:', res);
        wx.showToast({ title: '分享成功', icon: 'success' });
      },
      fail: (err: any) => {
        console.warn('[Share] 分享取消/失败:', err);
      }
    };
  },

  onShareTimeline() {
    console.log('[Share] onShareTimeline 被调用');
    const record = this._shareRecord || this.data.shareRecord;

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

    if (!this.data.isManagerOrAdmin && !this.data.isSuperAdmin) {
      wx.showToast({ title: '仅店长与超管拥有编辑权限', icon: 'none' });
      return;
    }

    if (report.isLocked) {
      wx.showModal({
        title: '记录已锁定',
        content: '该记录已被财务稽核锁定，如需修改请联系财务人员申请解封。',
        showCancel: false
      });
      return;
    }

    const yesterdayBalance = parseFloat(report.yesterdayBalance || 0);
    const totalIncome = parseFloat(report.totalIncomeStr || report.listDonationTotal || report.income || report.loveIncome || 0);
    const expenseAmount = parseFloat(report.expenseAmountStr || report.dailyExpenseTotal || report.expense || report.todayExpense || 0);
    const calculatedTodayBalance = (yesterdayBalance + totalIncome - expenseAmount).toFixed(2);

    const editingRecord = {
      ...JSON.parse(JSON.stringify(report)),
      yesterdayBalance: yesterdayBalance.toString(),
      totalIncome: totalIncome.toString(),
      expenseAmount: expenseAmount.toString(),
      calculatedTodayBalance,
      diningPeople: (report.diningPeople || report.diningCount || '0').toString(),
      volunteers: (report.volunteers || report.volunteerCount || '0').toString(),
      receiptImageList: report.receiptImageList || report.receiptImages || [],
      deletedImageIds: [],
      modifyReason: ''
    };

    const imgCount = (editingRecord.receiptImageList || []).length;
    this.setData({
      showEditModal: true,
      editingRecord,
      canAddEditImage: imgCount < 9,
      receiptImgCount: imgCount
    });
  },

  onPreviewHistoryCardImg(e: any) {
    const { current, urls } = e.currentTarget.dataset;
    wx.previewImage({
      current: current,
      urls: urls || [current]
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

    const yest = parseFloat(editingRecord.yesterdayBalance || '0') || 0;
    const inc = parseFloat(editingRecord.totalIncome || '0') || 0;
    const exp = parseFloat(editingRecord.expenseAmount || '0') || 0;
    editingRecord.calculatedTodayBalance = (yest + inc - exp).toFixed(2);

    this.setData({ editingRecord });
  },

  onPreviewEditImage(e: any) {
    const current = e.currentTarget.dataset.src;
    const urls = this.data.editingRecord.receiptImageList || [];
    wx.previewImage({ current, urls });
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
      canAddEditImage: imageList.length < 9,
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
          const checkRes = await wx.cloud.callFunction({
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
        canAddEditImage: newCount < 9,
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

    const yesterdayBalance = parseFloat(editForm.yesterdayBalance || 0);
    const income = parseFloat(editForm.totalIncome || 0);
    const expense = parseFloat(editForm.expenseAmount || 0);

    console.log('🚀 [History] 用户点击了保存并重算，提交数据:', {
      docId: editForm._id,
      storeId: editForm.storeId,
      reportDate: editForm.dateString || editForm.reportDate,
      yesterdayBalance,
      income,
      expense
    });

    wx.showLoading({ title: '正在保存并级联重算...', mask: true });

    try {
      if (editForm.deletedImageIds && editForm.deletedImageIds.length > 0) {
        try {
          await wx.cloud.deleteFile({ fileList: editForm.deletedImageIds });
          console.log('🗑️ 旧凭证图片已从云存储清理:', editForm.deletedImageIds);
        } catch (delErr) {
          console.warn('清理旧图文件警告:', delErr);
        }
      }

      const res = await wx.cloud.callFunction({
        name: 'updateAndRecalculateCascade',
        data: {
          docId: editForm._id,
          shopName: editForm.shopName || '',
          storeId: editForm.storeId || '',
          reportDate: editForm.dateString || editForm.reportDate,
          yesterdayBalance: yesterdayBalance,
          income: income,
          expense: expense,
          diningPeople: Number(editForm.diningPeople || 0),
          volunteers: Number(editForm.volunteers || 0),
          receiptImageList: editForm.receiptImageList || [],
          receiptImages: editForm.receiptImageList || [],
          modifyReason: editForm.modifyReason || ''
        }
      });

      console.log('✅ [History] 云函数 updateAndRecalculateCascade 返回结果:', res.result);

      wx.hideLoading();

      if (res.result && res.result.success) {
        this.setData({ 
          showEditModal: false,
          editingRecord: null
        });

        wx.showToast({
          title: `已成功校正 ${res.result.updatedCount || 1} 天账目`,
          icon: 'success',
          duration: 2000
        });

        this.loadReports();
      } else {
        wx.showModal({
          title: '重算失败',
          content: res.result ? res.result.errMsg : '云函数未返回正确结果',
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

  async onSaveHistoryRecordDirect(e: any) {
    const { item } = e.currentTarget.dataset;
    if (!item || !item._id) {
      wx.showToast({ title: '未找到编辑记录 ID', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在级联更新...', mask: true });

    console.log('🚀 [前端发包] 准备调用 cascadeRecalculator，参数:', {
      docId: item._id,
      shopName: item.shopName || this.data.selectedStoreName,
      dateString: item.dateString || item.reportDate,
      yesterdayBalance: item.yesterdayBalance,
      listDonationTotal: item.listDonationTotal || item.income || item.loveIncome,
      otherDonation: item.otherDonation || 0,
      dailyExpenseTotal: item.dailyExpenseTotal || item.expense || item.todayExpense,
      fixedExpenseTotal: item.fixedExpenseTotal || 0
    });

    try {
      const res = await wx.cloud.callFunction({
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

      console.log('✅ [云函数返回结果]:', res.result);

      wx.hideLoading();

      if (res.result && res.result.success) {
        wx.showToast({
          title: `已成功校正 ${res.result.updatedCount || 1} 天数据`,
          icon: 'success',
          duration: 2000
        });

        this.loadReports();
      } else {
        wx.showModal({
          title: '云函数返回错误',
          content: res.result ? res.result.errMsg : '未知错误',
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

    wx.showModal({
      title: '⚠️ 确认红字作废此餐报？',
      content: `确定要作废【${date}】的餐报记录吗？作废后该记录将打上"红字冲销"印章并保留在日志中供审计调阅，不可直接删除。`,
      confirmText: '确认作废',
      confirmColor: '#D32F2F',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '安全冲销中...' });

          try {
            const db = wx.cloud.database();
            if (id && id.length > 5) {
              await db.collection('report_logs').doc(id).update({
                data: {
                  isVoid: true,
                  voidedAt: db.serverDate(),
                  voidedBy: wx.getStorageSync('my_openid') || 'ADMIN'
                }
              });
            }

            const updated = this.data.reports.map((r: any) => {
              if ((r._id || r._localId) === id) return { ...r, isVoid: true };
              return r;
            });

            wx.hideLoading();
            this.setData({
              reports: updated,
              filteredReports: this.processReportListAudit(updated)
            });

            wx.showToast({ title: '已成功执行红字冲销', icon: 'success' });

          } catch (err) {
            wx.hideLoading();
            wx.showToast({ title: '冲销提交失败', icon: 'none' });
          }
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
    return list.map((item: any) => {
      if (item.receiptImages && Array.isArray(item.receiptImages)) {
        item.receiptImages = item.receiptImages.map((img: string) => this.cleanImagePath(img));
      }
      
      if (item.receiptImageList && Array.isArray(item.receiptImageList)) {
        item.receiptImageList = item.receiptImageList.map((img: string) => this.cleanImagePath(img));
      }

      const last = parseFloat(item.lastBalance || item.yesterdayBalance || '0');
      const inAmt = parseFloat(item.todayIn || item.totalIncome || '0');
      const outAmt = parseFloat(item.todayOut || item.expenseAmount || '0');
      const expectedBalance = (last + inAmt - outAmt).toFixed(2);
      const actualBalance = parseFloat(item.todayBalance || item.calculatedTodayBalance || '0').toFixed(2);

      const isMismatch = expectedBalance !== actualBalance;

      return {
        ...item,
        isAmountMismatch: isMismatch
      };
    });
  },

  async triggerCascadeRecalculation(report: any) {
    try {
      const shopName = report.shopName || this.data.selectedStoreName || '';
      const storeId = report.storeId || '';
      const modifiedDate = report.dateString || '';

      if ((!shopName && !storeId) || !modifiedDate) {
        console.log('[triggerCascadeRecalculation] 参数不足，跳过级联重算');
        return;
      }

      console.log('🚀 [DEBUG] 历史页触发级联重算...', { shopName, storeId, modifiedDate });

      wx.showLoading({ title: '正在级联校正后续账目...', mask: true });

      const res = await wx.cloud.callFunction({
        name: 'cascadeRecalculator',
        data: {
          action: 'recalculate_after_delete',
          storeId,
          shopName,
          dateString: modifiedDate
        }
      });

      wx.hideLoading();

      console.log('✅ [DEBUG] 云函数重算返回结果:', res.result);

      const result = res.result as any;
      if (result && result.success && result.updatedCount && result.updatedCount > 0) {
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
        console.log('用户取消举报');
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
            this.setData({ reports: [], filteredReports: [] });
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

  async onManualRecalculateLedger() {
    let shopName = this.data.selectedStoreName;

    if (!shopName) {
      if (this.data.storeFilterOptions.length === 2) {
        shopName = this.data.storeFilterOptions[1];
      } else {
        wx.showToast({ title: '请先选择要校准的门店', icon: 'none' });
        return;
      }
    }

    wx.showLoading({ title: '正在校准全线账本...', mask: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'recalculateLedgerChain',
        data: { shopName }
      });

      wx.hideLoading();

      const result = res.result as any;
      if (result && result.success) {
        wx.showModal({
          title: '校准完成',
          content: `已按时间顺序校准“${shopName}”的流水结余，共修正 ${result.updatedCount || 0} 条记录。`,
          showCancel: false,
          confirmText: '我知道了'
        });
        this.loadReports();
      } else {
        wx.showModal({
          title: '校准失败',
          content: result ? result.errMsg : '云函数未返回正确结果',
          showCancel: false
        });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('❌ [History] 一键校准异常:', err);
      wx.showModal({
        title: '调用失败',
        content: '未成功触发校准，请确认 recalculateLedgerChain 云函数已右键【上传并部署】',
        showCancel: false
      });
    }
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

    if (item && item.approvalStatus === 'APPROVED') {
      wx.showToast({ title: '店长已完成该餐报的核对确认', icon: 'none' });
      return;
    }

    if (item && item.approvalStatus === 'AUDITED_LOCKED') {
      wx.showToast({ title: '该账本已封账，无法操作', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '👑 店长核对确认',
      content: `确认【${item?.dateString || '该餐报'}】的菜品供应与记账小票核对无误，并提交财务做最终稽核吗？`,
      confirmText: '确认提交',
      confirmColor: '#E65100',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '提交中...' });
        try {
          const db = wx.cloud.database();
          const cached = AuthService.getCachedRoleInfo();
          const userName = cached?.role === 'store_manager' ? '店长' : '管理员';
          const nowStr = new Date().toLocaleString();

          await db.collection('report_logs').doc(docId).update({
            data: {
              isManagerConfirmed: true,
              managerConfirmedAt: db.serverDate(),
              managerConfirmedBy: userName,
              approvalStatus: 'APPROVED',
              approvedBy: userName,
              approveTime: nowStr
            }
          });

          const updatedList = this.data.filteredReports.map((r: any) => {
            if (r._id === docId) {
              return { 
                ...r, 
                isManagerConfirmed: true, 
                approvalStatus: 'APPROVED',
                approvedBy: userName,
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
          if (err && (err.errCode === -502005 || (err.errMsg && err.errMsg.indexOf('DATABASE_COLLECTION_NOT_EXIST') > -1))) {
            wx.showModal({
              title: '数据库集合缺失',
              content: '请先打开微信开发者工具 → 云开发 → 数据库，手动新建名为 [report_logs] 的集合！',
              showCancel: false
            });
          } else {
            wx.showToast({ title: '审批失败，请重试', icon: 'none' });
          }
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
      content: warningMsg + `您正在对【${item?.dateString || '该餐报'}】的餐报进行终审。封账后，该记录将永久归档，任何人（包括店长与财务）将无法再修改其中数据。`,
      confirmText: '确认封账',
      confirmColor: '#2E7D32',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '安全封账中...' });
        try {
          const db = wx.cloud.database();
          const cached = AuthService.getCachedRoleInfo();
          const userName = cached?.role === 'finance' ? '财务稽核员' : '管理员';
          const nowStr = new Date().toLocaleString();

          await db.collection('report_logs').doc(docId).update({
            data: {
              isFinanceAudited: true,
              financeAuditedAt: db.serverDate(),
              financeAuditedBy: userName,
              isLocked: true,
              approvalStatus: 'AUDITED_LOCKED',
              auditedBy: userName,
              auditTime: nowStr,
              auditLogs: db.command.push({
                operator: userName,
                action: 'AUDIT_LOCK',
                timestamp: nowStr,
                reason: '财务完成核对并打上稽核锁定章'
              })
            }
          });

          const updatedList = this.data.filteredReports.map((r: any) => {
            if (r._id === docId) {
              return { 
                ...r, 
                isFinanceAudited: true, 
                isLocked: true,
                approvalStatus: 'AUDITED_LOCKED',
                auditedBy: userName,
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
          if (err && (err.errCode === -502005 || (err.errMsg && err.errMsg.indexOf('DATABASE_COLLECTION_NOT_EXIST') > -1))) {
            wx.showModal({
              title: '数据库集合缺失',
              content: '请先打开微信开发者工具 → 云开发 → 数据库，手动新建名为 [report_logs] 的集合！',
              showCancel: false
            });
          } else {
            wx.showToast({ title: '锁定失败，请重试', icon: 'none' });
          }
        }
      }
    });
  },

  // 财务解锁已锁定记录
  onUnlockRecord(e: any) {
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
          const db = wx.cloud.database();
          const cached = AuthService.getCachedRoleInfo();
          const userName = cached?.role === 'finance' ? '财务管理员' : '管理员';
          const nowStr = new Date().toLocaleString();

          await db.collection('report_logs').doc(docId).update({
            data: {
              isLocked: false,
              approvalStatus: 'APPROVED',
              isFinanceAudited: false,
              auditLogs: db.command.push({
                operator: userName,
                action: 'UNLOCK',
                timestamp: nowStr,
                reason: res.content.trim()
              })
            }
          });

          wx.hideLoading();
          wx.showToast({ title: '已解封，可重新编辑', icon: 'success' });
          this.loadReports();
        } catch (err: any) {
          wx.hideLoading();
          console.error('解封失败:', err);
          if (err && (err.errCode === -502005 || (err.errMsg && err.errMsg.indexOf('DATABASE_COLLECTION_NOT_EXIST') > -1))) {
            wx.showModal({
              title: '数据库集合缺失',
              content: '请先打开微信开发者工具 → 云开发 → 数据库，手动新建名为 [daily_records] 的集合！',
              showCancel: false
            });
          } else {
            wx.showToast({ title: '解封失败，请重试', icon: 'none' });
          }
        }
      }
    });
  },

  goBack() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    // 分享直入场景：栈深度=1 时直接走 navGuard 的回首页逻辑
    if (this._navGuard && this._navGuard.isDeepLinkEntry()) {
      this._navGuard.goHome();
      this.isNavigating = false;
      return;
    }

    wx.navigateBack({
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  previewReceipt(e: any) {
    const images = e.currentTarget.dataset.images;
    const index = e.currentTarget.dataset.index;

    if (!images || !Array.isArray(images) || images.length === 0) {
      wx.showToast({ title: '图片数据异常', icon: 'none' });
      return;
    }

    wx.previewImage({
      current: images[index],
      urls: images
    });
  },

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
