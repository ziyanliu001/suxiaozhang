Page({
  data: {
    reportDate: '',
    prevBalance: '1263.64', 
    allDonations: '',       
    batch4: '5',           
    expenses: '',
    reportResult: '',
    showResult: false,
    showSettings: false,
    shopName: '海沧区雨花斋',
    mpAccount: '厦门海沧雨花斋！'
  },

  onLoad() {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    
    const cachedBalance = wx.getStorageSync('yuhua_last_balance');
    const cachedShopName = wx.getStorageSync('yuhua_shop_name');
    const cachedMpAccount = wx.getStorageSync('yuhua_mp_account');
    
    this.setData({
      reportDate: `${yy}年${mm}月${dd}日`,
      prevBalance: cachedBalance ? String(cachedBalance) : this.data.prevBalance,
      shopName: cachedShopName || this.data.shopName,
      mpAccount: cachedMpAccount || this.data.mpAccount
    });
  },

  toggleSettings() {
    this.setData({
      showSettings: !this.data.showSettings
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

  generateReport() {
    const { reportDate, prevBalance, allDonations, batch4, expenses, shopName, mpAccount } = this.data;
    const prevBalanceNum = parseFloat(prevBalance) || 0;
    const b4_total = parseFloat(batch4) || 0;
    
    // 1. 解析所有名单
    const allList = this.parseAllDonations(allDonations);
    
    let listTexts = [];
    let donationsTotal = 0;
    
    allList.forEach(item => {
      listTexts.push(item.text);
      donationsTotal += item.amount;
    });
    
    donationsTotal = Math.round(donationsTotal * 100) / 100;
    
    // 2. 智能解析店铺支出
    let expenseTotal = 0;
    let expenseInput = expenses.trim();
    if (expenseInput) {
      expenseInput = expenseInput.replace(/元$/, ''); 
      let expMatch = expenseInput.match(/(.*?)\s*([\d.]+)\s*$/); 
      if (expMatch) {
        expenseTotal = parseFloat(expMatch[2]) || 0;
      }
    }
    
    // 3. 动态组装今日收入合计公式
    let todayTotalStr = `${donationsTotal}`;
    if (b4_total > 0) todayTotalStr += `+${b4_total}`;
    const todayTotalSum = Math.round((donationsTotal + b4_total) * 100) / 100;

    // 4. 组装结余公式
    let balanceFormula = `${prevBalanceNum}+${todayTotalStr}`;
    if (expenseTotal > 0) {
      balanceFormula += `-${expenseTotal}`; 
    }

    const newBalanceSum = Math.round((prevBalanceNum + todayTotalSum - expenseTotal) * 100) / 100;

    // 5. 缓存最新数据
    wx.setStorageSync('yuhua_last_balance', newBalanceSum);
    wx.setStorageSync('yuhua_shop_name', shopName);
    wx.setStorageSync('yuhua_mp_account', mpAccount);

    const report = `亲爱的家人们大家好[玫瑰]

【${shopName}】用餐汇报
${reportDate}

一、爱心人士供养
${listTexts.length ? listTexts.join('\n') : '暂无'}

今日合计：${todayTotalStr}=${todayTotalSum}

二、店铺支出：${expenses || '无'}

三、《店铺余额》
${balanceFormula}=${newBalanceSum}

如有遗漏、错误请指正！

四、没有杀戮，没有交易，只有感恩~为核心
吃了就好，够了就好，做了就好，舍了就好，了了就好~五了精神

五、弘扬中华传统文化，做有道德的中国人

如果您有空欢迎回家看看，
回家吃素和家人聊聊天，我们真诚等您回家！

吃 素 一 日   健 康 一 天
吃 素 一 日   环 保 一 天

公众号：${mpAccount}`;

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
  }
});