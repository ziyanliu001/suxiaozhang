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
    
    this.setData({
      reportDate: `${yy}年${mm}月${dd}日`
    });
    
    this.loadFromCloud();
  },

  onShow() {
    this.loadFromCloud();
  },

  loadFromCloud() {
    const db = wx.cloud.database();
    
    db.collection('meal_reports')
      .orderBy('createTime', 'desc')
      .limit(1)
      .get({
        success: (res) => {
          if (res.data && res.data.length > 0) {
            const lastReport = res.data[0];
            this.setData({
              prevBalance: String(lastReport.newBalance),
              shopName: lastReport.shopName || this.data.shopName,
              mpAccount: lastReport.mpAccount || this.data.mpAccount
            });
          } else {
            this.loadFromLocal();
          }
        },
        fail: (error) => {
          if (error.errCode === -502005) {
            console.log('云数据库集合尚未创建，使用本地缓存');
          } else {
            console.error('云数据库读取失败:', error);
          }
          this.loadFromLocal();
        }
      });
  },

  loadFromLocal() {
    const cachedBalance = wx.getStorageSync('yuhua_last_balance') || wx.getStorageSync('last_shop_balance');
    const cachedShopName = wx.getStorageSync('yuhua_shop_name');
    const cachedMpAccount = wx.getStorageSync('yuhua_mp_account');
    
    if (cachedBalance !== '' && cachedBalance !== null && cachedBalance !== undefined) {
      this.setData({
        prevBalance: String(cachedBalance)
      });
    }
    if (cachedShopName) {
      this.setData({ shopName: cachedShopName });
    }
    if (cachedMpAccount) {
      this.setData({ mpAccount: cachedMpAccount });
    }
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

    // 6. 本地缓存作为降级方案
    wx.setStorageSync('yuhua_last_balance', newBalanceSum);
    wx.setStorageSync('yuhua_shop_name', shopName);
    wx.setStorageSync('yuhua_mp_account', mpAccount);
    wx.setStorageSync('last_shop_balance', newBalanceSum);

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

公众号：${mpAccount}

—— 本报告由【素食餐报助手】智能生成。微信小程序搜索“素食餐报助手”，10秒轻松搞定日常餐报汇总！`;

    // 5. 保存数据到云数据库
    const db = wx.cloud.database();
    db.collection('meal_reports').add({
      data: {
        reportDate,
        prevBalance: prevBalanceNum,
        allDonations,
        batch4: b4_total,
        expenses,
        expensesAmount: expenseTotal,
        shopName,
        mpAccount,
        donationsTotal,
        todayTotalSum,
        newBalance: newBalanceSum,
        reportText: report,
        createTime: db.serverDate()
      },
      success: (res) => {
        console.log('云数据库保存成功:', res);
        wx.showToast({ title: '保存成功', icon: 'success' });
      },
      fail: (error) => {
        if (error.errCode === -502005) {
          console.log('云数据库集合尚未创建，请在云开发控制台手动创建 meal_reports 集合');
          wx.showToast({ title: '餐报生成成功', icon: 'success' });
        } else {
          console.error('云数据库保存失败:', error);
          wx.showToast({ title: '云保存失败，已保存到本地', icon: 'none' });
        }
      }
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

  onShareAppMessage() {
    return {
      title: '✨ 账目清晰，信任传递！推荐使用【素食餐报助手】，10秒生成群汇报。',
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