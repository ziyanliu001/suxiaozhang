import { AuthService } from './authService';
import { generateReportText } from './reportGenerator';
import { isStoreNameFuzzyMatch } from './constants';
import { getPrevDayIsoString, formatDateToCnShort, isValidIsoDate } from './dateUtils';

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

function parseAnyDateFormat(dateStr: string): { year: number; month: number; day: number } | null {
  if (!dateStr) return null;
  let str = String(dateStr).trim();

  if (/^\d{2}年/.test(str)) {
    str = '20' + str;
  }

  const matches = str.match(/(\d{4})[\-\/年\.](\d{1,2})[\-\/月\.](\d{1,2})/);
  if (matches) {
    return {
      year: parseInt(matches[1], 10),
      month: parseInt(matches[2], 10),
      day: parseInt(matches[3], 10)
    };
  }
  return null;
}

function formatDateToISO(dateObj: { year: number; month: number; day: number }): string {
  const mm = String(dateObj.month).padStart(2, '0');
  const dd = String(dateObj.day).padStart(2, '0');
  return `${dateObj.year}-${mm}-${dd}`;
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
  async saveReport(reportData: any): Promise<{ success: boolean; message: string; data?: any; errorDetail?: string }> {
    const db = wx.cloud.database();

    const openid = AuthService.getOpenid();
    const formattedData = {
      dateString: reportData.dateString || '',
      reportDate: reportData.reportDate || '',
      shopName: reportData.shopName || '',
      mpAccount: reportData.mpAccount || '',
      yesterdayBalance: parseNumber(reportData.yesterdayBalance),
      otherDonation: parseNumber(reportData.otherDonation),
      listDonationTotal: parseNumber(reportData.listDonationTotal),
      expenseAmount: parseNumber(reportData.expenseAmount),
      expenses: reportData.expenses || '',
      dailyExpenseText: reportData.dailyExpenseText || '',
      fixedExpenseText: reportData.fixedExpenseText || '',
      dailyExpenseTotal: parseNumber(reportData.dailyExpenseTotal),
      fixedExpenseTotal: parseNumber(reportData.fixedExpenseTotal),
      majorExpenseItems: reportData.majorExpenseItems || [],
      dailyIngredientItems: reportData.dailyIngredientItems || [],
      donationItems: reportData.donationItems || [],
      todayBalance: parseNumber(reportData.todayBalance),
      reportText: reportData.reportText || '',
      receiptImages: reportData.receiptImages || [],
      isManualAdjust: reportData.isManualAdjust || false,
      systemBalance: parseNumber(reportData.systemBalance),
      adjustedBalance: parseNumber(reportData.adjustedBalance),
      balanceDiff: parseNumber(reportData.balanceDiff),
      adjustReason: reportData.adjustReason || '',
      materials: reportData.materials || [],
      volunteerCount: parseFloat(reportData.volunteerCount) || 0,
      volunteerHours: parseFloat(reportData.volunteerHours) || 0,
      diningCount: parseFloat(reportData.diningCount) || 0,
      stapleRiceStatus: reportData.stapleRiceStatus || 'normal',
      stapleOilStatus: reportData.stapleOilStatus || 'sufficient',
      updateTime: db.serverDate(),
      isSynced: false
    };

    try {
      // 前置校验：阻止全 0 且无物资的无效数据（防止并发产生脏数据）
      const allZero =
        formattedData.yesterdayBalance === 0 &&
        formattedData.otherDonation === 0 &&
        formattedData.listDonationTotal === 0 &&
        formattedData.expenseAmount === 0 &&
        formattedData.todayBalance === 0 &&
        (!formattedData.materials || formattedData.materials.length === 0);

      if (allZero) {
        console.warn('[DataService] 检测到全0无效数据，已阻止提交');
        return {
          success: false,
          message: '账目各项均为0且无物资赞助，已自动跳过保存',
          errorDetail: 'all_zero_skipped'
        };
      }

      // 步骤 1: 查询同日期同门店是否已有记录（Upsert 查重）
      const existingQuery = await db.collection('report_logs')
        .where({
          dateString: formattedData.dateString,
          shopName: formattedData.shopName,
          _openid: openid || ''
        })
        .limit(1)
        .get();

      let cloudResult: any;
      let operationType = '';

      if (existingQuery.data && existingQuery.data.length > 0) {
        // 步骤 2a: 已存在 - 提取 _id，调用 doc().update() 覆盖
        const existingId = existingQuery.data[0]._id;
        await db.collection('report_logs').doc(existingId).update({
          data: {
            reportDate: formattedData.reportDate,
            mpAccount: formattedData.mpAccount,
            yesterdayBalance: formattedData.yesterdayBalance,
            otherDonation: formattedData.otherDonation,
            listDonationTotal: formattedData.listDonationTotal,
            expenseAmount: formattedData.expenseAmount,
            expenses: formattedData.expenses,
            dailyExpenseText: formattedData.dailyExpenseText,
            fixedExpenseText: formattedData.fixedExpenseText,
            dailyExpenseTotal: formattedData.dailyExpenseTotal,
            fixedExpenseTotal: formattedData.fixedExpenseTotal,
            majorExpenseItems: formattedData.majorExpenseItems,
            dailyIngredientItems: formattedData.dailyIngredientItems,
            todayBalance: formattedData.todayBalance,
            reportText: formattedData.reportText,
            donationItems: formattedData.donationItems,
            receiptImages: formattedData.receiptImages,
            isManualAdjust: formattedData.isManualAdjust,
            systemBalance: formattedData.systemBalance,
            adjustedBalance: formattedData.adjustedBalance,
            balanceDiff: formattedData.balanceDiff,
            adjustReason: formattedData.adjustReason,
            materials: formattedData.materials,
            volunteerCount: formattedData.volunteerCount,
            volunteerHours: formattedData.volunteerHours,
            updateTime: db.serverDate()
          }
        });
        cloudResult = { _id: existingId };
        operationType = '已覆盖更新';
        console.log('[DataService] Upsert: 已覆盖更新同日记录:', existingId);
      } else {
        // 步骤 2b: 不存在 - 新增
        formattedData.createTime = db.serverDate();
        cloudResult = await db.collection('report_logs').add({
          data: formattedData
        });
        operationType = '已新增';
        console.log('[DataService] Upsert: 新增记录:', cloudResult._id);
      }

      // 步骤 3: 同步本地缓存
      formattedData.isSynced = true;
      formattedData._id = cloudResult._id;

      const localReports = getLocalReports();
      const localIdx = localReports.findIndex(r =>
        r.dateString === formattedData.dateString && r.shopName === formattedData.shopName
      );
      if (localIdx !== -1) {
        localReports[localIdx] = { ...localReports[localIdx], ...formattedData };
      } else {
        localReports.unshift(formattedData);
      }
      saveLocalReports(localReports);

      try {
        wx.setStorageSync('yuhua_last_balance', formattedData.todayBalance);
        wx.setStorageSync('yuhua_shop_name', formattedData.shopName);
        wx.setStorageSync('yuhua_mp_account', formattedData.mpAccount);
      } catch (storageErr) {
        console.warn('[DataService] 同步全局缓存失败（不影响主流程）:', storageErr);
      }

      return {
        success: true,
        message: `${operationType}记录（${formattedData.dateString}）`,
        data: formattedData
      };
    } catch (error: any) {
      // 强力捕获并暴露真实错误
      const errCode = error.errCode || error.code || 'N/A';
      const errMsg = error.errMsg || error.message || '未知错误';
      console.error('[DataService] 云端写入失败:', error);

      // 尝试本地兜底
      try {
        formattedData.isSynced = false;
        formattedData._localId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
        formattedData.localCreateTime = Date.now();

        const localReports = getLocalReports();
        const localIdx = localReports.findIndex(r =>
          r.dateString === formattedData.dateString && r.shopName === formattedData.shopName
        );
        if (localIdx !== -1) {
          localReports[localIdx] = { ...localReports[localIdx], ...formattedData };
        } else {
          localReports.unshift(formattedData);
        }
        saveLocalReports(localReports);
      } catch (localErr) {
        console.error('[DataService] 本地兜底写入也失败:', localErr);
      }

      // 返回 success: false，让前端能弹窗展示真实错误
      return {
        success: false,
        message: `保存失败: ${errMsg}`,
        data: formattedData,
        errorDetail: `错误码: ${errCode}\n错误信息: ${errMsg}`
      };
    }
  },

  async getReports(options: {
    startDate?: string;
    endDate?: string;
    shopName?: string;
    mpAccount?: string;
    limit?: number;
    viewMode?: 'all' | 'personal';
  } = {}): Promise<{ success: boolean; data: any[]; source: 'cloud' | 'local' }> {
    const { startDate, endDate, shopName, mpAccount, limit = 100, viewMode } = options;

    try {
      // 云端查询不传 shopName，由前端进行模糊匹配，避免历史数据因少字漏匹配
      const result = await wx.cloud.callFunction({
        name: 'getReports',
        data: { startDate, endDate, mpAccount, limit, viewMode }
      });

      const r = result.result as any;
      if (r && r.success) {
        let cloudData = r.data || [];

        // 前端模糊匹配门店名称
        if (shopName) {
          cloudData = cloudData.filter((item: any) =>
            isStoreNameFuzzyMatch(item.shopName, shopName)
          );
        }

        const localReports = getLocalReports();
        const openid = AuthService.getOpenid();
        let unsyncedReports = openid
          ? localReports.filter(r => !r.isSynced && r._openid === openid)
          : localReports.filter(r => !r.isSynced);

        if (shopName) {
          unsyncedReports = unsyncedReports.filter(r =>
            isStoreNameFuzzyMatch(r.shopName, shopName)
          );
        }

        const mergedData = [...cloudData];
        const existingKeys = new Set(cloudData.map(c => `${c.dateString}_${c.shopName}`));

        unsyncedReports.forEach(localReport => {
          const key = `${localReport.dateString}_${localReport.shopName}`;
          const cloudIdx = mergedData.findIndex(m => `${m.dateString}_${m.shopName}` === key);
          if (cloudIdx !== -1) {
            mergedData[cloudIdx] = { ...mergedData[cloudIdx], ...localReport };
          } else if (!existingKeys.has(key)) {
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
        localReports = localReports.filter(r => isStoreNameFuzzyMatch(r.shopName, shopName));
      }

      if (mpAccount) {
        localReports = localReports.filter(r => r.mpAccount === mpAccount);
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

    unsyncedReports = unsyncedReports.filter(report => {
      const yesterdayBalance = parseFloat(report.yesterdayBalance) || 0;
      const otherDonation = parseFloat(report.otherDonation) || 0;
      const listDonationTotal = parseFloat(report.listDonationTotal) || 0;
      const expenseAmount = parseFloat(report.expenseAmount) || 0;
      const todayBalance = parseFloat(report.todayBalance) || 0;
      const hasMaterials = report.materials && report.materials.length > 0;
      const hasItems = report.items && report.items.length > 0;
      return !(yesterdayBalance === 0 && otherDonation === 0 && listDonationTotal === 0 && expenseAmount === 0 && todayBalance === 0 && !hasMaterials && !hasItems);
    });

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
        dataToSync.updateTime = db.serverDate();

        const existingQuery = await db.collection('report_logs')
          .where({
            dateString: dataToSync.dateString,
            shopName: dataToSync.shopName,
            _openid: openid || ''
          })
          .limit(1)
          .get();

        let cloudId: string;

        if (existingQuery.data && existingQuery.data.length > 0) {
          const existingId = existingQuery.data[0]._id;
          await db.collection('report_logs').doc(existingId).update({
            data: dataToSync
          });
          cloudId = existingId;
        } else {
          dataToSync.createTime = db.serverDate();
          const result = await db.collection('report_logs').add({
            data: dataToSync
          });
          cloudId = result._id;
        }

        const index = localReports.findIndex(r => r._localId === report._localId);
        if (index !== -1) {
          localReports[index].isSynced = true;
          localReports[index]._id = cloudId;
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

  async deleteReport(id: string, reportData?: any): Promise<{ success: boolean; message: string }> {
    if (!id) {
      return { success: false, message: '缺少记录 ID' };
    }

    const isCloudRecord = !id.startsWith('local_');
    let cloudDeleted = false;
    let cloudError = '';

    if (isCloudRecord) {
      try {
        const cloudResult = await wx.cloud.callFunction({
          name: 'deleteMealReport',
          data: { id }
        });
        const r = cloudResult.result as any;
        
        if (r && r.success) {
          cloudDeleted = true;
          console.log('[DataService] 云函数删除成功:', id);
        } else {
          cloudError = r?.error || '云端删除失败';
          console.warn('[DataService] 云函数删除失败:', cloudError);
        }
      } catch (cloudErr: any) {
        cloudError = cloudErr.message || '云函数调用异常';
        console.warn('[DataService] 云函数调用异常:', cloudErr);
      }
    }

    try {
      const localReports = getLocalReports();
      const beforeLen = localReports.length;
      
      const filteredReports = localReports.filter((item: any) => {
        const itemId = item._id || item._localId;
        if (itemId === id) {
          return false;
        }
        
        if (reportData && reportData.dateString && reportData.shopName) {
          if (item.dateString === reportData.dateString && 
              item.shopName === reportData.shopName) {
            return false;
          }
        }
        
        return true;
      });
      
      const afterLen = filteredReports.length;

      if (afterLen < beforeLen) {
        saveLocalReports(filteredReports);
        console.log(`[DataService] 本地缓存删除成功，${beforeLen} -> ${afterLen}`);
      }

      if (isCloudRecord) {
        if (cloudDeleted) {
          return {
            success: true,
            message: '云端与本地均已删除'
          };
        } else {
          const localDeleted = afterLen < beforeLen;
          return {
            success: localDeleted,
            message: localDeleted 
              ? `本地已删除（云端删除失败：${cloudError}）`
              : `删除失败：${cloudError}`
          };
        }
      } else {
        const localDeleted = afterLen < beforeLen;
        return {
          success: localDeleted,
          message: localDeleted ? '本地记录已删除' : '未找到该记录'
        };
      }
    } catch (storageErr: any) {
      console.error('[DataService] 本地缓存删除失败:', storageErr);
      return {
        success: isCloudRecord && cloudDeleted,
        message: isCloudRecord && cloudDeleted 
          ? '云端已删除，本地缓存清理失败' 
          : '本地删除失败'
      };
    }
  },

  async clearDirtyReports(): Promise<{ success: boolean; removedCount: number; message: string }> {
    const isRecordValid = (item: any): boolean => {
      const otherDonation = parseNumber(item.otherDonation);
      const listDonationTotal = parseNumber(item.listDonationTotal);
      const expenseAmount = parseNumber(item.expenseAmount);
      const todayBalance = parseNumber(item.todayBalance);
      const diningCount = parseNumber(item.diningCount);
      const volunteerCount = parseNumber(item.volunteerCount);
      const volunteerHours = parseNumber(item.volunteerHours);
      
      const hasAmount = otherDonation > 0 || listDonationTotal > 0 || expenseAmount > 0 || todayBalance !== 0;
      const hasDining = diningCount > 0;
      const hasVolunteer = volunteerCount > 0 || volunteerHours > 0;
      const hasMaterials = item.materials && Array.isArray(item.materials) && item.materials.length > 0;
      const hasDonationItems = item.donationItems && Array.isArray(item.donationItems) && item.donationItems.length > 0;
      
      return hasAmount || hasDining || hasVolunteer || hasMaterials || hasDonationItems;
    };

    try {
      const cloudResult = await wx.cloud.callFunction({
        name: 'clearMealReports',
        data: { mode: 'dirty' }
      });
      const r = cloudResult.result as any;

      const localReports = getLocalReports();
      const cleanedReports = localReports.filter(isRecordValid);
      
      const localRemovedCount = localReports.length - cleanedReports.length;
      saveLocalReports(cleanedReports);

      if (r && r.success) {
        return {
          success: true,
          removedCount: (r.removedCount || 0) + localRemovedCount,
          message: `清理完成，共移除 ${(r.removedCount || 0) + localRemovedCount} 条无效数据`
        };
      }

      return {
        success: localRemovedCount > 0,
        removedCount: localRemovedCount,
        message: localRemovedCount > 0 ? `本地清理完成，移除 ${localRemovedCount} 条无效数据` : '清理失败'
      };
    } catch (err: any) {
      console.error('[DataService] 清理脏数据失败:', err);
      
      const localReports = getLocalReports();
      const cleanedReports = localReports.filter(isRecordValid);
      
      const localRemovedCount = localReports.length - cleanedReports.length;
      saveLocalReports(cleanedReports);

      return {
        success: localRemovedCount > 0,
        removedCount: localRemovedCount,
        message: localRemovedCount > 0 ? `本地清理完成，移除 ${localRemovedCount} 条无效数据` : '清理失败，请检查网络后重试'
      };
    }
  },

  async getLatestReport(shopName?: string, mpAccount?: string): Promise<{ success: boolean; data?: any; source: 'cloud' | 'local' }> {
    const result = await this.getReports({ 
      shopName,
      mpAccount,
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

  async getPreviousBalance(shopName: string, mpAccount: string, targetDateString: string): Promise<{ success: boolean; data?: any }> {
    if (!shopName || !targetDateString) {
      return { success: false };
    }

    if (!isValidIsoDate(targetDateString)) {
      return { success: false };
    }

    const targetPrevIso = getPrevDayIsoString(targetDateString);
    const targetPrevCnShort = `${targetPrevIso.substring(2, 4)}年${targetPrevIso.substring(5, 7)}月${targetPrevIso.substring(8, 10)}日`;
    const targetPrevCnFull = `${targetPrevIso.substring(0, 4)}年${targetPrevIso.substring(5, 7)}月${targetPrevIso.substring(8, 10)}日`;

    try {
      const result = await wx.cloud.callFunction({
        name: 'getPreviousBalance',
        data: { shopName, mpAccount, targetDateString }
      });

      const r = result.result as any;
      if (r && r.success) {
        console.log('[getPreviousBalance] 云函数返回的上期结余数据:', r.data);
        return {
          success: true,
          data: r.data
        };
      }

      return {
        success: false,
        data: null
      };
    } catch (error) {
      console.error('[getPreviousBalance] 查询失败，降级到本地查询:', error);

      const localReports = getLocalReports();
      const matchedReports = localReports.filter(r => {
        if (!isStoreNameFuzzyMatch(r.shopName, shopName)) return false;
        
        let recordDateStr = '';
        const dateObj = parseAnyDateFormat(r.dateString);
        if (dateObj) {
          recordDateStr = formatDateToISO(dateObj);
        } else if (r.dateString) {
          recordDateStr = String(r.dateString);
        }
        
        return recordDateStr && recordDateStr < targetDateString;
      }).sort((a, b) => {
        let dateA = '';
        let dateB = '';
        const objA = parseAnyDateFormat(a.dateString);
        const objB = parseAnyDateFormat(b.dateString);
        if (objA) dateA = formatDateToISO(objA);
        else if (a.dateString) dateA = String(a.dateString);
        if (objB) dateB = formatDateToISO(objB);
        else if (b.dateString) dateB = String(b.dateString);
        return dateB.localeCompare(dateA);
      });

      if (matchedReports.length > 0) {
        const record = matchedReports[0];
        
        console.log('[getPreviousBalance] 本地降级查询到的上期原始记录:', {
          dateString: record.dateString,
          shopName: record.shopName,
          yesterdayBalance: record.yesterdayBalance,
          todayBalance: record.todayBalance,
          adjustedBalance: record.adjustedBalance
        });

        const balance = record.todayBalance != null && record.todayBalance !== ''
          ? record.todayBalance
          : (record.adjustedBalance != null ? record.adjustedBalance : null);

        console.log('[getPreviousBalance] 本地降级最终选取的余额值:', balance);

        return {
          success: true,
          data: {
            balance: balance,
            dateString: record.dateString,
            shopName: record.shopName,
            mpAccount: record.mpAccount
          }
        };
      }

      console.log('[getPreviousBalance] 本地降级未找到匹配记录');
      return { success: false, data: null };
    }
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
    const LARGE_EXPENSE_KEYWORDS = ['房租', '装修', '设备', '大件', '空调', '冰箱', '冰柜', '桌椅', '改造', '维修', '购置'];
    const LARGE_EXPENSE_THRESHOLD = 1000;

    let statistics = {
      totalIncome: 0,
      totalOtherDonation: 0,
      totalListDonation: 0,
      totalExpense: 0,
      dailyExpenseTotal: 0,
      largeExpenseTotal: 0,
      recordCount: records.length,
      netBalance: 0,
      dailyNetCashFlow: 0,
      avgDailyExpense: 0,
      avgPerCapitaCost: 0,
      startDate: startDate,
      endDate: endDate,
      dailyRecords: [] as any[]
    };

    let totalDonorCount = 0;

    records.forEach((item: any) => {
      const otherDonation = parseNumber(item.otherDonation);
      const listDonationTotal = parseNumber(item.listDonationTotal);
      const expenseAmount = parseNumber(item.expenseAmount);
      const expensesText = item.expenses || '';
      const donorCount = (item.donationItems && Array.isArray(item.donationItems)) ? item.donationItems.length : 0;
      totalDonorCount += donorCount;

      const isLargeExpense = LARGE_EXPENSE_KEYWORDS.some(kw => expensesText.includes(kw)) || expenseAmount >= LARGE_EXPENSE_THRESHOLD;
      const dailyExpense = isLargeExpense ? 0 : expenseAmount;
      const largeExpense = isLargeExpense ? expenseAmount : 0;

      statistics.totalOtherDonation += otherDonation;
      statistics.totalListDonation += listDonationTotal;
      statistics.totalExpense += expenseAmount;
      statistics.dailyExpenseTotal += dailyExpense;
      statistics.largeExpenseTotal += largeExpense;

      statistics.dailyRecords.push({
        date: item.dateString,
        otherDonation: otherDonation,
        listDonation: listDonationTotal,
        expense: expenseAmount,
        dailyExpense: dailyExpense,
        largeExpense: largeExpense,
        income: otherDonation + listDonationTotal,
        balance: parseNumber(item.todayBalance),
        donorCount: donorCount,
        perCapitaCost: donorCount > 0 ? Math.round((dailyExpense / donorCount) * 100) / 100 : 0
      });
    });

    statistics.totalIncome = statistics.totalOtherDonation + statistics.totalListDonation;
    statistics.netBalance = statistics.totalIncome - statistics.totalExpense;
    statistics.dailyNetCashFlow = statistics.totalIncome - statistics.dailyExpenseTotal;

    const days = records.length > 0 ? records.length : 1;
    statistics.avgDailyExpense = Math.round((statistics.dailyExpenseTotal / days) * 100) / 100;
    statistics.avgPerCapitaCost = totalDonorCount > 0
      ? Math.round((statistics.dailyExpenseTotal / totalDonorCount) * 100) / 100
      : 0;

    statistics.totalOtherDonation = Math.round(statistics.totalOtherDonation * 100) / 100;
    statistics.totalListDonation = Math.round(statistics.totalListDonation * 100) / 100;
    statistics.totalExpense = Math.round(statistics.totalExpense * 100) / 100;
    statistics.dailyExpenseTotal = Math.round(statistics.dailyExpenseTotal * 100) / 100;
    statistics.largeExpenseTotal = Math.round(statistics.largeExpenseTotal * 100) / 100;
    statistics.totalIncome = Math.round(statistics.totalIncome * 100) / 100;
    statistics.netBalance = Math.round(statistics.netBalance * 100) / 100;
    statistics.dailyNetCashFlow = Math.round(statistics.dailyNetCashFlow * 100) / 100;

    return statistics;
  },

  buildReportText(item: any): string {
    const items = (item.donationItems || item.items || []).map((d: any) => ({
      name: d.name || d.donor || '',
      amount: parseFloat(d.amount) || 0
    }));

    const materials = (item.materials || []).map((m: any) => ({
      donor: m.donor || '匿名爱心人士',
      item: m.item || '',
      quantity: m.quantity || '',
      unit: m.unit || ''
    }));

    const reportData = {
      shopName: item.shopName || '店铺',
      dateString: item.dateString || '',
      reportDate: item.reportDate || '',
      items: items,
      totalAmount: parseFloat(item.listDonationTotal) || 0,
      otherDonation: parseFloat(item.otherDonation) || 0,
      yesterdayBalance: parseFloat(item.yesterdayBalance) || 0,
      expenseAmount: parseFloat(item.expenseAmount) || 0,
      todayBalance: parseFloat(item.todayBalance) || 0,
      expenses: item.expenses || '',
      mpAccount: item.mpAccount || '',
      thankText: item.thankText || '',
      slogan1: item.slogan1 || '',
      slogan2: item.slogan2 || '',
      materials: materials,
      volunteerCount: parseFloat(item.volunteerCount) || 0,
      volunteerHours: parseFloat(item.volunteerHours) || 0,
      diningCount: parseFloat(item.diningCount) || 0,
      stapleRiceStatus: item.stapleRiceStatus || 'normal',
      stapleOilStatus: item.stapleOilStatus || 'sufficient'
    };

    return generateReportText(reportData);
  },

  getLocalReportsCount(): number {
    return getLocalReports().length;
  },

  getUnsyncedCount(): number {
    return getLocalReports().filter(r => !r.isSynced).length;
  }
};