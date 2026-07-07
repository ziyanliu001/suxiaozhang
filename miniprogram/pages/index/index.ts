import { DataService, formatMoney } from '../../utils/dataService';
import { AuthService } from '../../utils/authService';

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
    headerSafeTop: 85
  },

  async onLoad() {
    // 严格等待静默登录完成后再加载数据
    const loginRes = await AuthService.ensureLogin();
    if (!loginRes.success) {
      wx.showModal({
        title: '登录失败',
        content: loginRes.error || '请检查网络后重启小程序',
        showCancel: false,
        confirmText: '我知道了'
      });
      return;
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
      this.setData({
        prevBalance: balance,
        yesterdayBalance: balance,
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
    this.setData({
      prevBalance: balance,
      yesterdayBalance: balance
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
    this.setData({
      yesterdayBalance: value
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
    this.setData({ [field]: e.detail.value });
  },

  parseAllDonations(text: string) {
    let allList = [];
    if (!text) return allList;
    
    let lines = text.split('\n');
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      
      if (line.includes('爱心人士供养') || line.includes('用餐汇报') || line.includes('今日合计') || line.includes('店铺余额')) {
        continue;
      }
      
      line = line.replace(/元$/, '');
      let match = line.match(/(.*?)\s*([\d.]+)\s*$/);
      if (match) {
        let name = match[1].trim();
        let amount = parseFloat(match[2]);
        if (!isNaN(amount)) {
          allList.push({
            text: `${name}${amount}元`,
            amount: amount
          });
        }
      }
    }
    return allList;
  },

  async generateReport() {
    const { reportDate, yesterdayBalance, allDonations, otherDonation, expenses, shopName, mpAccount } = this.data;
    const prevBalanceNum = parseFloat(yesterdayBalance) || 0;
    const b4_total = parseFloat(otherDonation) || 0;
    
    const allList = this.parseAllDonations(allDonations);
    
    let listTexts = [];
    let donationsTotal = 0;
    
    allList.forEach(item => {
      listTexts.push(item.text);
      donationsTotal += item.amount;
    });
    
    donationsTotal = Math.round(donationsTotal * 100) / 100;
    
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

    const report = `亲爱的家人们大家好[玫瑰]

【${shopName}】用餐汇报
${reportDate}

一、爱心人士供养
${listTexts.length ? listTexts.join('\n') : '暂无'}

今日合计：${todayTotalStr}=${formatMoney(todayTotalSum)}

二、店铺支出：${expenses || '无'}

三、《店铺余额》
${balanceFormula}=${formatMoney(newBalanceSum)}

如有遗漏、错误请指正！

四、没有杀戮，没有交易，只有感恩~为核心
吃了就好，够了就好，做了就好，舍了就好，了了就好~五了精神

五、弘扬中华传统文化，做有道德的中国人

如果您有空欢迎回家看看，
回家吃素和家人聊聊天，我们真诚等您回家！

吃 素 一 日   健 康 一 天
吃 素 一 日   环 保 一 天

公众号：${mpAccount}

—— 本报告由【素食小账本助手】智能生成。微信小程序搜索“素食小账本助手”，10秒轻松搞定日常餐报汇总！`;

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
      reportText: report
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
  },

  copyText() {
    wx.setClipboardData({
      data: this.data.reportResult,
      success() {
        wx.showToast({ title: '复制成功', icon: 'success' });
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