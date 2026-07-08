import { AuthService } from './authService';

const STORAGE_KEY = 'local_report_logs';

function getLocalReports(): any[] {
  try {
    const data = wx.getStorageSync(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveLocalReports(reports: any[]): void {
  try {
    wx.setStorageSync(STORAGE_KEY, JSON.stringify(reports));
  } catch (error) {
    console.error('[DataService] 本地缓存写入失败:', error);
  }
}

function formatNumber(value: number): string {
  const num = parseFloat(value) || 0;
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

export const DataService = {
  async saveReport(reportData: any): Promise<{ success: boolean; message: string; data?: any }> {
    const db = wx.cloud.database();
    
    const openid = AuthService.getOpenid();
    const formattedData = {
      dateString: reportData.dateString || '',
      shopName: reportData.shopName || '',
      mpAccount: reportData.mpAccount || '',
      yesterdayBalance: parseNumber(reportData.yesterdayBalance),
      otherDonation: parseNumber(reportData.otherDonation),
      listDonationTotal: parseNumber(reportData.listDonationTotal),
      expenseAmount: parseNumber(reportData.expenseAmount),
      todayBalance: parseNumber(reportData.todayBalance),
      reportText: reportData.reportText || '',
      receiptImages: reportData.receiptImages || [],
      isManualAdjust: reportData.isManualAdjust || false,
      systemBalance: parseNumber(reportData.systemBalance),
      adjustedBalance: parseNumber(reportData.adjustedBalance),
      balanceDiff: parseNumber(reportData.balanceDiff),
      adjustReason: reportData.adjustReason || '',
      createTime: db.serverDate(),
      isSynced: false,
      _openid: openid || ''
    };

    try {
      const cloudResult = await db.collection('report_logs').add({
        data: formattedData
      });

      formattedData.isSynced = true;
      formattedData._id = cloudResult._id;

      const localReports = getLocalReports();
      localReports.unshift(formattedData);
      saveLocalReports(localReports);

      wx.setStorageSync('yuhua_last_balance', formattedData.todayBalance);
      wx.setStorageSync('yuhua_shop_name', formattedData.shopName);
      wx.setStorageSync('yuhua_mp_account', formattedData.mpAccount);

      return {
        success: true,
        message: '云端保存成功',
        data: formattedData
      };
    } catch (error: any) {
      console.warn('[DataService] 云端写入失败，已切换至本地缓存防丢失:', error);

      formattedData.isSynced = false;
      formattedData._localId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
      formattedData.localCreateTime = Date.now();

      const localReports = getLocalReports();
      localReports.unshift(formattedData);
      saveLocalReports(localReports);

      wx.setStorageSync('yuhua_last_balance', formattedData.todayBalance);
      wx.setStorageSync('yuhua_shop_name', formattedData.shopName);
      wx.setStorageSync('yuhua_mp_account', formattedData.mpAccount);

      return {
        success: true,
        message: '已保存到本地缓存，联网后将自动同步',
        data: formattedData
      };
    }
  },

  async getReports(options: {
    startDate?: string;
    endDate?: string;
    shopName?: string;
    limit?: number;
    viewMode?: 'all' | 'personal';
  } = {}): Promise<{ success: boolean; data: any[]; source: 'cloud' | 'local' }> {
    const { startDate, endDate, shopName, limit = 100, viewMode } = options;

    try {
      const result = await wx.cloud.callFunction({
        name: 'getReports',
        data: { startDate, endDate, shopName, limit, viewMode }
      });

      const r = result.result as any;
      if (r && r.success) {
        const cloudData = r.data || [];

        const localReports = getLocalReports();
        const openid = AuthService.getOpenid();
        const unsyncedReports = openid
          ? localReports.filter(r => !r.isSynced && r._openid === openid)
          : localReports.filter(r => !r.isSynced);

        const mergedData = [...cloudData];
        const existingKeys = new Set(cloudData.map(c => `${c.dateString}_${c.shopName}`));
        
        unsyncedReports.forEach(localReport => {
          const key = `${localReport.dateString}_${localReport.shopName}`;
          if (!existingKeys.has(key)) {
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

      throw new Error(r?.error || '云函数调用失败');
    } catch (error: any) {
      console.warn('[DataService] 云端查询失败，使用本地缓存:', error);

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
        localReports = localReports.filter(r => r.shopName === shopName);
      }

      localReports.sort((a, b) => {
        const dateA = new Date(a.dateString || '');
        const dateB = new Date(b.dateString || '');
        return dateB.getTime() - dateA.getTime();
      });

      return {
        success: true,
        data: localReports.slice(0, limit),
        source: 'local'
      };
    }
  },

  async syncLocalDataToCloud(): Promise<{ success: boolean; syncedCount: number; failedCount: number }> {
    const openid = AuthService.getOpenid();
    const localReports = getLocalReports();
    let unsyncedReports = localReports.filter(r => !r.isSynced);
    
    if (openid) {
      unsyncedReports = unsyncedReports.filter(r => r._openid === openid);
    }

    if (unsyncedReports.length === 0) {
      return { success: true, syncedCount: 0, failedCount: 0 };
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
        dataToSync.createTime = db.serverDate();

        const result = await db.collection('report_logs').add({
          data: dataToSync
        });

        const index = localReports.findIndex(r => r._localId === report._localId);
        if (index !== -1) {
          localReports[index].isSynced = true;
          localReports[index]._id = result._id;
          delete localReports[index]._localId;
          delete localReports[index].localCreateTime;
        }

        syncedCount++;
      } catch (error) {
        console.error('[DataService] 同步单条数据失败:', error);
        failedCount++;
      }
    }

    saveLocalReports(localReports);

    if (syncedCount > 0) {
      console.log(`[DataService] 成功同步 ${syncedCount} 条本地数据到云端`);
    }

    return {
      success: failedCount === 0,
      syncedCount,
      failedCount
    };
  },

  async deleteReport(id: string): Promise<{ success: boolean; message: string }> {
    if (!id) {
      return { success: false, message: '缺少记录 ID' };
    }

    let cloudDeleted = false;
    const db = wx.cloud.database();

    try {
      await db.collection('report_logs').doc(id).remove();
      cloudDeleted = true;
      console.log('[DataService] 云端删除成功:', id);
    } catch (cloudErr: any) {
      console.warn('[DataService] 云端删除失败（可能是本地缓存数据或集合不存在）:', cloudErr);
    }

    try {
      const localReports = getLocalReports();
      const beforeLen = localReports.length;
      const filteredReports = localReports.filter(
        (item: any) => item._id !== id && item._localId !== id
      );
      const afterLen = filteredReports.length;

      if (afterLen < beforeLen) {
        saveLocalReports(filteredReports);
        console.log(`[DataService] 本地缓存删除成功，${beforeLen} -> ${afterLen}`);
        return {
          success: true,
          message: cloudDeleted ? '云端与本地均已删除' : '本地缓存已删除'
        };
      } else {
        console.warn('[DataService] 本地缓存中未找到对应记录:', id);
        return {
          success: cloudDeleted,
          message: cloudDeleted ? '云端已删除，本地未找到对应记录' : '未找到对应记录'
        };
      }
    } catch (storageErr: any) {
      console.error('[DataService] 本地缓存删除失败:', storageErr);
      return {
        success: cloudDeleted,
        message: cloudDeleted ? '云端已删除，本地删除失败' : '删除失败'
      };
    }
  },

  async getLatestReport(shopName?: string): Promise<{ success: boolean; data?: any; source: 'cloud' | 'local' }> {
    const result = await this.getReports({ 
      shopName, 
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

  async getStatistics(startDate: string, endDate: string, shopName?: string, viewMode?: 'all' | 'personal'): Promise<{ success: boolean; data?: any; source: 'cloud' | 'local' }> {
    try {
      const result = await wx.cloud.callFunction({
        name: 'getStatistics',
        data: { startDate, endDate, shopName, viewMode }
      });

      const r = result.result as any;
      if (r && r.success) {
        return {
          success: true,
          data: r.data,
          source: 'cloud'
        };
      }

      throw new Error(r?.error || '云函数调用失败');
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
    let statistics = {
      totalIncome: 0,
      totalOtherDonation: 0,
      totalListDonation: 0,
      totalExpense: 0,
      recordCount: records.length,
      netBalance: 0,
      startDate: startDate,
      endDate: endDate,
      dailyRecords: [] as any[]
    };

    records.forEach((item: any) => {
      const otherDonation = parseNumber(item.otherDonation);
      const listDonationTotal = parseNumber(item.listDonationTotal);
      const expenseAmount = parseNumber(item.expenseAmount);

      statistics.totalOtherDonation += otherDonation;
      statistics.totalListDonation += listDonationTotal;
      statistics.totalExpense += expenseAmount;

      statistics.dailyRecords.push({
        date: item.dateString,
        otherDonation: otherDonation,
        listDonation: listDonationTotal,
        expense: expenseAmount,
        income: otherDonation + listDonationTotal,
        balance: parseNumber(item.todayBalance)
      });
    });

    statistics.totalIncome = statistics.totalOtherDonation + statistics.totalListDonation;
    statistics.netBalance = statistics.totalIncome - statistics.totalExpense;

    statistics.totalOtherDonation = Math.round(statistics.totalOtherDonation * 100) / 100;
    statistics.totalListDonation = Math.round(statistics.totalListDonation * 100) / 100;
    statistics.totalExpense = Math.round(statistics.totalExpense * 100) / 100;
    statistics.totalIncome = Math.round(statistics.totalIncome * 100) / 100;
    statistics.netBalance = Math.round(statistics.netBalance * 100) / 100;

    return statistics;
  },

  buildReportText(item: any): string {
    const dateStr = item.dateString || '';
    const shopName = item.shopName || '店铺';
    const yesterdayBalance = formatNumber(item.yesterdayBalance || 0);
    const otherDonation = formatNumber(item.otherDonation || 0);
    const listDonationTotal = formatNumber(item.listDonationTotal || 0);
    const expenseAmount = formatNumber(item.expenseAmount || 0);
    const todayBalance = formatNumber(item.todayBalance || 0);

    let reportText = `📅 ${dateStr} ${shopName}餐报\n\n`;
    reportText += `一、爱心人士供养\n`;
    reportText += `随喜供养：${otherDonation}\n`;
    reportText += `名单供养：${listDonationTotal}\n`;
    reportText += `今日合计：${formatNumber(parseFloat(otherDonation) + parseFloat(listDonationTotal))}\n\n`;
    reportText += `二、店铺支出：${parseFloat(expenseAmount) > 0 ? expenseAmount : '无'}\n\n`;
    reportText += `三、《店铺余额》\n`;
    reportText += `${yesterdayBalance}+${formatNumber(parseFloat(otherDonation) + parseFloat(listDonationTotal))}`;
    if (parseFloat(expenseAmount) > 0) {
      reportText += `-${expenseAmount}`;
    }
    reportText += `=${todayBalance}\n\n`;
    reportText += `如有遗漏、错误请指正！\n\n`;
    reportText += `四、没有杀戮，没有交易，只有感恩~`;

    return reportText;
  },

  getLocalReportsCount(): number {
    return getLocalReports().length;
  },

  getUnsyncedCount(): number {
    return getLocalReports().filter(r => !r.isSynced).length;
  }
};