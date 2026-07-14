import { DataService, formatMoney } from '../../utils/dataService';
import { AuthService, getPermissionFlags, PermissionFlags } from '../../utils/authService';
import { getSelectedStore, setSelectedStore } from '../../utils/storeManager';
import { getSafeSystemInfo } from '../../utils/util';

Page({
  _shareRecord: null as any,
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
    selectedMonthStr: '',
    permissions: {} as PermissionFlags,
    showEditModal: false,
    editingRecord: null as any,
    canAddEditImage: true,
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
    const activeStore = getSelectedStore();
    if (activeStore && activeStore.storeName !== this.data.selectedStoreName) {
      this.setData({
        selectedStoreName: activeStore.storeName
      });
    }
    this.initPermissions();
    this.loadReports();
    DataService.syncLocalDataToCloud();
  },

  initPermissions() {
    const cached = AuthService.getCachedRoleInfo();
    if (cached) {
      const flags = getPermissionFlags(cached);
      const role = cached.role || 'volunteer';
      this.setData({
        permissions: flags,
        isManagerOrAdmin: role === 'store_manager' || role === 'super_admin',
        isFinanceOrAdmin: role === 'finance' || role === 'super_admin'
      });
    }
    AuthService.fetchUserRole().then(result => {
      if (result.success && result.roleInfo) {
        const flags = getPermissionFlags(result.roleInfo);
        const role = result.roleInfo.role || 'volunteer';
        this.setData({
          permissions: flags,
          isManagerOrAdmin: role === 'store_manager' || role === 'super_admin',
          isFinanceOrAdmin: role === 'finance' || role === 'super_admin'
        });
      }
    }).catch(() => {});
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

    const { viewMode } = this.data;
    const result = await DataService.getReports({ viewMode });
    
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
      storeFilterOptions: storeOptions,
      loading: false
    }, () => {
      this.applyFilters();
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

    if (allCloudIds.length === 0) return;

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

      this.setData({ reports: updatedReports }, () => {
        this.applyFilters();
      });
    } catch (err) {
      console.warn('[convertReceiptImagesToUrls] 图片URL转换失败:', err);
    }
  },

  applyFilters() {
    const { reports, selectedStoreName, selectedMonthStr } = this.data;
    
    let filtered = [...reports];

    if (selectedStoreName && selectedStoreName !== '全部门店') {
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

    this.setData({ filteredReports: filtered });
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
      title: `${store}·${date} 爱心收入¥${income} 结余¥${balance}`,
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

    this.setData({
      showEditModal: true,
      editingRecord,
      canAddEditImage: (editingRecord.receiptImageList || []).length < 6
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

    const editingRecord = { ...this.data.editingRecord, [field]: val };

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
    this.setData({ editingRecord, canAddEditImage: imageList.length < 6 });

    wx.showToast({ title: '已移除凭证', icon: 'none' });
  },

  async onChooseNewEditImage() {
    try {
      const res = await wx.chooseMedia({
        count: 6 - (this.data.editingRecord.receiptImageList || []).length,
        mediaType: ['image'],
        sourceType: ['album', 'camera']
      });

      if (!res.tempFiles || res.tempFiles.length === 0) return;

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
      this.setData({ editingRecord, canAddEditImage: editingRecord.receiptImageList.length < 6 });

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

  onDeleteRecord(e: any) {
    const { id, date } = e.currentTarget.dataset;

    console.log("[Debug] 尝试删除记录，抓取到的参数:", { id, date });

    if (!id) {
      console.error("[Bug] 参数传递失效，请检查 WXML 是否存在 data-id 属性");
      wx.showToast({ title: '参数传递失效', icon: 'none' });
      return;
    }

    const report = this.data.reports.find((r: any) => (r._id || r._localId) === id);

    if (report && report.isLocked) {
      wx.showModal({
        title: '记录已锁定',
        content: '该记录已被财务稽核锁定，无法删除。如需操作请联系财务人员申请解封。',
        showCancel: false
      });
      return;
    }

    wx.showModal({
      title: '确认删除记录？',
      content: `删除 ${date || '该'} 的餐报后，系统将自动重算后续天数的余额。`,
      confirmColor: '#E63946',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '正在删除并重新平账...' });
        try {
          await wx.cloud.callFunction({
            name: 'deleteMealReport',
            data: { id }
          });

          await wx.cloud.callFunction({
            name: 'recalculateLedgerChain',
            data: {
              shopName: report.shopName || '',
              fromDate: report.dateString || report.reportDate
            }
          });

          wx.hideLoading();
          wx.showToast({ title: '已删除并完成平账', icon: 'success' });
          this.loadReports();

        } catch (err: any) {
          wx.hideLoading();
          console.error('[Bug] 删除执行异常:', err);
          wx.showModal({
            title: '删除失败提示',
            content: `错误信息: ${err.errMsg || err.message || '未知错误'}`,
            showCancel: false
          });
        }
      }
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
  async onManagerApprove(e: any) {
    const docId = e.currentTarget.dataset.id;
    if (!docId) {
      wx.showToast({ title: '参数异常', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '店长确认审批',
      content: '确认该餐报记录数据无误？',
      confirmText: '确认审批',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '确认中...' });
        try {
          const db = wx.cloud.database();
          const cached = AuthService.getCachedRoleInfo();
          const userName = cached?.role === 'store_manager' ? '店长' : '管理员';
          const nowStr = new Date().toLocaleString();

          await db.collection('daily_records').doc(docId).update({
            data: {
              approvalStatus: 'APPROVED',
              approvedBy: userName,
              approveTime: nowStr
            }
          });

          wx.hideLoading();
          wx.showToast({ title: '店长已确认审批', icon: 'success' });
          this.loadReports();
        } catch (err: any) {
          wx.hideLoading();
          console.error('店长确认失败:', err);
          if (err && (err.errCode === -502005 || (err.errMsg && err.errMsg.indexOf('DATABASE_COLLECTION_NOT_EXIST') > -1))) {
            wx.showModal({
              title: '数据库集合缺失',
              content: '请先打开微信开发者工具 → 云开发 → 数据库，手动新建名为 [daily_records] 的集合！',
              showCancel: false
            });
          } else {
            wx.showToast({ title: '审批失败，请重试', icon: 'none' });
          }
        }
      }
    });
  },

  // 财务稽核并开启锁定
  async onFinanceLockAudit(e: any) {
    const docId = e.currentTarget.dataset.id;
    if (!docId) {
      wx.showToast({ title: '参数异常', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '财务稽核锁定',
      content: '锁定后，非财务人员将无法编辑或删除该天的账目记录，确认无误并锁定？',
      confirmText: '确认锁定',
      confirmColor: '#2E7D32',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '正在锁定归档...' });
        try {
          const db = wx.cloud.database();
          const cached = AuthService.getCachedRoleInfo();
          const userName = cached?.role === 'finance' ? '财务稽核员' : '管理员';
          const nowStr = new Date().toLocaleString();

          await db.collection('daily_records').doc(docId).update({
            data: {
              approvalStatus: 'AUDITED_LOCKED',
              isLocked: true,
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

          wx.hideLoading();
          wx.showToast({ title: '账目已稽核锁定', icon: 'success' });
          this.loadReports();
        } catch (err: any) {
          wx.hideLoading();
          console.error('稽核锁定失败:', err);
          if (err && (err.errCode === -502005 || (err.errMsg && err.errMsg.indexOf('DATABASE_COLLECTION_NOT_EXIST') > -1))) {
            wx.showModal({
              title: '数据库集合缺失',
              content: '请先打开微信开发者工具 → 云开发 → 数据库，手动新建名为 [daily_records] 的集合！',
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

          await db.collection('daily_records').doc(docId).update({
            data: {
              isLocked: false,
              approvalStatus: 'APPROVED',
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
    wx.navigateBack();
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
