import { DataService, formatMoney } from '../../utils/dataService';
import { AuthService } from '../../utils/authService';
import { parseDonorText } from '../../utils/parser';
import { generateReportText } from '../../utils/reportGenerator';
import { drawMeritPoster } from '../../utils/posterGenerator';

Page({
  data: {
    reportDate: '',
    prevBalance: '0.00',
    yesterdayBalance: '0.00',
    isBalanceLocked: true,
    allDonations: '',
    otherDonation: '',
    expenses: '',
    reportResult: '',
    showResult: false,
    showSettings: false,
    shopName: '海沧区雨花斋',
    mpAccount: '厦门海沧雨花斋！',
    donationPlaceholder: '可以直接把所有供养名单一次性全部贴在这里。例如：\n黄玉珍 16\n周瑞德 2\n吴建平 3\n邢善积德 2\n',
    headerSafeTop: 85,
    isSubmitting: false,
    parseResult: {
      items: [],
      unrecognizedLines: [],
      totalAmount: 0,
      totalCount: 0
    },
    receiptImages: [] as string[],
    systemBalance: 0,
    isManualAdjust: false,
    balanceDiff: 0,
    adjustReason: '',
    isGeneratingPoster: false,
    showPoster: false,
    posterImage: ''
  },

  async onLoad() {
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

    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    
    this.setData({
      reportDate: `${yy}年${mm}月${dd}日`
    });
    
    this.loadLastBalance();
    DataService.syncLocalDataToCloud();
  },

  onShow() {
    this.loadLastBalance();
    DataService.syncLocalDataToCloud();
  },

  async loadLastBalance() {
    const result = await DataService.getLatestReport(this.data.shopName);
    
    if (result.success && result.data) {
      const balance = this.validateBalance(result.data.todayBalance);
      const systemBalanceNum = parseFloat(result.data.todayBalance) || 0;
      this.setData({
        prevBalance: balance,
        yesterdayBalance: balance,
        systemBalance: systemBalanceNum,
        isManualAdjust: false,
        balanceDiff: 0,
        adjustReason: '',
        shopName: result.data.shopName || this.data.shopName,
        mpAccount: result.data.mpAccount || this.data.mpAccount
      });
    } else {
      this.loadFromLocal();
    }
  },

  loadFromLocal() {
    const cachedBalance = wx.getStorageSync('yuhua_last_balance') || wx.getStorageSync('last_shop_balance');
    const cachedShopName = wx.getStorageSync('yuhua_shop_name');
    const cachedMpAccount = wx.getStorageSync('yuhua_mp_account');
    
    const balance = this.validateBalance(cachedBalance);
    const systemBalanceNum = parseFloat(cachedBalance) || 0;
    this.setData({
      prevBalance: balance,
      yesterdayBalance: balance,
      systemBalance: systemBalanceNum,
      isManualAdjust: false,
      balanceDiff: 0,
      adjustReason: ''
    });
    
    if (cachedShopName) {
      this.setData({ shopName: cachedShopName });
    }
    if (cachedMpAccount) {
      this.setData({ mpAccount: cachedMpAccount });
    }
  },

  validateBalance(value: any): string {
    return formatMoney(value);
  },

  toggleSettings() {
    this.setData({
      showSettings: !this.data.showSettings
    });
  },

  toggleBalanceLock() {
    this.setData({
      isBalanceLocked: !this.data.isBalanceLocked
    });
    if (!this.data.isBalanceLocked) {
      wx.showToast({ title: '已解锁，可手动修正余额', icon: 'none' });
    }
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
  },

  resetForm() {
    wx.showModal({
      title: '提示',
      content: '确定要清空当前输入的名单、随喜金额和支出说明吗？',
      success: (res) => {
        if (res.confirm) {
          const now = new Date();
          const yy = String(now.getFullYear()).slice(-2);
          const mm = String(now.getMonth() + 1).padStart(2, '0');
          const dd = String(now.getDate()).padStart(2, '0');
          
          this.setData({
            allDonations: '',
            otherDonation: '',
            expenses: '',
            reportResult: '',
            showResult: false,
            reportDate: `${yy}年${mm}月${dd}日`
          });
          
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
  },

  updateParseResult(text: string) {
    const result = parseDonorText(text);
    this.setData({ parseResult: result });
  },

  chooseReceiptImages() {
    const remainingCount = 3 - this.data.receiptImages.length;
    if (remainingCount <= 0) {
      wx.showToast({ title: '最多上传3张图片', icon: 'none' });
      return;
    }

    wx.chooseMedia({
      count: remainingCount,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const newImages = res.tempFiles.map(file => file.tempFilePath);
        const updatedImages = [...this.data.receiptImages, ...newImages];
        this.setData({ receiptImages: updatedImages });
      },
      fail: () => {
        wx.showToast({ title: '选择图片失败', icon: 'none' });
      }
    });
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
      wx.showModal({
        title: '⚠️ 平账原因确认',
        editable: true,
        placeholderText: '请输入修改原因（如：补报昨日漏记支出/盘点差额平账）',
        content: `检测到您手动修改了昨日余额
系统默认：¥${systemBalance.toFixed(2)}
现修改为：¥${adjustedBalance.toFixed(2)}
差额：${balanceDiff >= 0 ? '+' : ''}¥${balanceDiff.toFixed(2)}

请输入修改原因：`,
        confirmText: '确认提交',
        cancelText: '取消修改',
        confirmColor: '#e53935',
        success: (res) => {
          if (res.confirm) {
            const reason = res.content || '';
            this.setData({ adjustReason: reason.trim() });
          } else {
            this.setData({ adjustReason: '' });
          }
          resolve();
        },
        fail: () => {
          this.setData({ adjustReason: '' });
          resolve();
        }
      });
    });
  },

  async generateReport() {
    if (this.data.isSubmitting) {
      return;
    }

    const { isManualAdjust, systemBalance, yesterdayBalance, balanceDiff } = this.data;
    
    if (isManualAdjust) {
      await this.showAdjustReasonModal(systemBalance, parseFloat(yesterdayBalance) || 0, balanceDiff);
      
      if (!this.data.adjustReason || this.data.adjustReason.trim() === '') {
        wx.showToast({ title: '平账原因不能为空，请如实填写', icon: 'none' });
        return;
      }
    }

    this.setData({ isSubmitting: true });
    
    try {
      const { reportDate, otherDonation, expenses, shopName, mpAccount, parseResult, adjustReason } = this.data;
      const prevBalanceNum = parseFloat(yesterdayBalance) || 0;
      const b4_total = parseFloat(otherDonation) || 0;
      
      const { items, totalAmount: donationsTotal } = parseResult;
      
      const listTexts = items.map(item => `${item.name} ${item.amount}`);
      
      let expenseTotal = 0;
      let expenseInput = expenses.trim();
      if (expenseInput) {
        expenseInput = expenseInput.replace(/元$/, '');
        let expMatch = expenseInput.match(/(.*?)\s*([\d.]+)\s*$/);
        if (expMatch) {
          expenseTotal = parseFloat(expMatch[2]) || 0;
        }
      }
      
      const donationsStr = formatMoney(donationsTotal);
      const b4Str = formatMoney(b4_total);
      let todayTotalStr = donationsStr;
      if (b4_total > 0) todayTotalStr += `+${b4Str}`;
      const todayTotalSum = Math.round((donationsTotal + b4_total) * 100) / 100;

      const displayPrevBalance = formatMoney(prevBalanceNum);
      let balanceFormula = `${displayPrevBalance}+${todayTotalStr}`;
      if (expenseTotal > 0) {
        balanceFormula += `-${formatMoney(expenseTotal)}`;
      }

      const newBalanceSum = Math.round((prevBalanceNum + todayTotalSum - expenseTotal) * 100) / 100;

      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const dateString = `${year}-${month}-${day}`;

      const report = generateReportText({
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
        mpAccount: mpAccount
      });

      const receiptImages = await this.uploadReceiptImages();

      const saveResult = await DataService.saveReport({
        dateString: dateString,
        reportDate: reportDate,
        shopName: shopName,
        mpAccount: mpAccount,
        yesterdayBalance: prevBalanceNum,
        otherDonation: b4_total,
        listDonationTotal: donationsTotal,
        expenseAmount: expenseTotal,
        todayBalance: newBalanceSum,
        reportText: report,
        donationItems: items,
        receiptImages: receiptImages,
        isManualAdjust: isManualAdjust,
        systemBalance: systemBalance,
        adjustedBalance: prevBalanceNum,
        balanceDiff: balanceDiff,
        adjustReason: adjustReason
      });

      wx.showToast({ 
        title: saveResult.message, 
        icon: 'success',
        duration: 2000
      });

      this.setData({
        reportResult: report,
        showResult: true
      });
    } catch (error) {
      console.error('[generateReport] 异常:', error);
      wx.showToast({ title: '生成失败，请重试', icon: 'none' });
    } finally {
      this.setData({ isSubmitting: false });
    }
  },

  copyText() {
    wx.setClipboardData({
      data: this.data.reportResult,
      success() {
        wx.showToast({ title: '复制成功', icon: 'success' });
      }
    });
  },

  async generatePoster() {
    if (this.data.isGeneratingPoster) {
      return;
    }

    wx.showLoading({ title: '正在生成海报...' });
    this.setData({ isGeneratingPoster: true });

    try {
      const { reportDate, otherDonation, expenses, shopName, mpAccount, parseResult, yesterdayBalance } = this.data;
      const prevBalanceNum = parseFloat(yesterdayBalance) || 0;
      const b4_total = parseFloat(otherDonation) || 0;
      const { items, totalAmount: donationsTotal, totalCount } = parseResult;

      let expenseTotal = 0;
      let expenseInput = expenses.trim();
      if (expenseInput) {
        expenseInput = expenseInput.replace(/元$/, '');
        let expMatch = expenseInput.match(/(.*?)\s*([\d.]+)\s*$/);
        if (expMatch) {
          expenseTotal = parseFloat(expMatch[2]) || 0;
        }
      }

      const todayTotalSum = donationsTotal + b4_total;
      const newBalanceSum = Math.round((prevBalanceNum + todayTotalSum - expenseTotal) * 100) / 100;

      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const dateString = `${year}-${month}-${day}`;

      const posterImage = await drawMeritPoster('meritPoster', {
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
        mpAccount: mpAccount
      });

      this.setData({
        posterImage: posterImage,
        showPoster: true
      });
    } catch (error) {
      console.error('[generatePoster] 异常:', error);
      wx.showToast({ title: '生成海报失败，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ isGeneratingPoster: false });
    }
  },

  closePoster() {
    this.setData({ showPoster: false });
  },

  stopPropagation() {},

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

  goToHistory() {
    wx.navigateTo({
      url: '/pages/history/history'
    });
  },

  goToStatistics() {
    wx.navigateTo({
      url: `/pages/statistics/statistics?shopName=${encodeURIComponent(this.data.shopName)}`
    });
  },

  onShareAppMessage() {
    return {
      title: '✨ 账目清晰，信任传递！推荐使用【素食小账本助手】，10秒生成群汇报。',
      path: '/pages/index/index',
      imageUrl: ''
    };
  },

  onShareTimeline() {
    return {
      title: '用“餐报君”让爱心账目更透明！素食小店日常记账汇报的高效利器。',
      query: 'from=share'
    };
  }
});