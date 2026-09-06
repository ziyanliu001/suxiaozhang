// 🏛️（主包瘦身）本页从 pages/index/index.ts 的 onOpenFinanceLockModal/
// onConfirmFinanceLock/handleUnlockMonth/onOpenRiskAlertsModal/fetchRiskAlerts
// 等一整簇方法搬迁而来，业务逻辑（云函数调用/校验/确认文案）原样保留，
// 只是不再依赖首页 initMinePage 里已经解析好的角色/门店 this.data，改为
// onLoad 时自己独立解析——与 subpackages/admin 下其余管理页
// （daily-menu.ts/activity-log.ts）同一套 applyRolePermissions 写法。
//
// 🐛 首页原有的两处显式"操作后刷新首页摘要卡片数字"调用
// （fetchFinanceLedgerStatus()/riskAlertCount setData）在本页删除，不是
// 遗漏——首页 loadHomeDynamicData() 本就在每次 onShow 时无条件重新拉取这两个
// 数字（见 index.ts:8503-8507），用户从本页操作完毕导航返回首页时，首页会
// 自然重新刷新，不需要跨页面手动同步
import { AuthService } from '../../../../utils/authService';
import { getCurrentActiveStore, getSelectedStore } from '../../../../utils/storeManager';
import { isCloudAvailable } from '../../../../utils/cloudGuard';
import { callFunctionWithTimeout } from '../../../../utils/withTimeout';
import { safeNavigateTo } from '../../../../utils/navHelper';
import { createNavGuard, NavGuardInstance } from '../../../../utils/navGuard';
import { recordRecentVisit } from '../../utils/recentPages';
import { playReportSealed } from '../../../../utils/audioService';

// 🐛 与 pages/index/index.ts isNationalOverviewSelected() 同一份哨兵值拷贝
// （各页面独立维护，本仓库一贯做法，见 daily-menu.ts NATIONAL_STORE_ID_SENTINELS
// 同类注释）
const NATIONAL_STORE_IDS = ['national_overview', 'ALL_STORES', 'all'];

Page({
  data: {
    roleReady: false,
    hasAccess: false,
    isNationalOverview: false,
    isFinance: false,
    isSuperAdmin: false,
    isPatriarch: false,
    currentStoreId: '',
    currentStoreName: '',

    navContentTop: 0,
    navContentHeight: 0,
    navRightGap: 0,
    contentTop: 0,

    // 稽核与封账
    financeLockStartDate: '',
    financeLockEndDate: '',
    lockStatusText: '',
    financeLockRangeLocked: false,
    financeLockHasApprovedRecords: false,
    financeLockInFlight: false,
    financeUnlockInFlight: false,
    financeLockStatusLoading: false,

    // 风控预警日志
    riskAlertsLoading: false,
    riskAlertsList: [] as any[],
    riskAlertsFilteredList: [] as any[],
    riskAlertsSummary: { voidCount: 0, missingReceiptCount: 0, balanceAnomalyCount: 0 },
    riskAlertsHasAnomaly: false,
    riskAlertsRangeLabel: '',
    riskAlertsFilterType: ''
  },

  _navGuard: null as NavGuardInstance | null,

  async onLoad() {
    recordRecentVisit('/subpackages/admin/pages/finance-audit/finance-audit', '财务稽核台');
    await this.applyRolePermissions();

    if (this.data.hasAccess && !this.data.isNationalOverview) {
      this.initFinanceLockDefaults();
      this.checkRangeLockStatus();
      this.setData({ riskAlertsLoading: true });
      this.fetchRiskAlerts();
    }

    this._navGuard = createNavGuard({
      homePath: '/pages/index/index',
      alertMessage: '即将退出财务稽核台，是否返回首页？'
    });
    this._navGuard.setupOnLoad();
  },

  onUnload() {
    if (this._navGuard) {
      this._navGuard.teardown();
      this._navGuard = null;
    }
  },

  onNavLayout(e: { detail: { totalHeight: number; contentTop: number; contentHeight: number; rightGap: number } }) {
    this.setData({
      contentTop: e.detail.totalHeight + 8,
      navContentTop: e.detail.contentTop,
      navContentHeight: e.detail.contentHeight,
      navRightGap: e.detail.rightGap
    });
  },

  // 🐛 与 daily-menu.ts applyRolePermissions 同一套解析顺序（roleInfo → 当前
  // 活跃门店 → 兜底），改用 getCurrentActiveStore()（canonical，与本 session
  // 其余修复口径一致）而不是 daily-menu.ts 用的 legacy getSelectedStore()——
  // 两者都能兜底，优先用更权威的那个
  async applyRolePermissions() {
    let roleInfo = AuthService.getCachedRoleInfo();
    if (!roleInfo) {
      const result = await AuthService.fetchUserRole();
      roleInfo = result.roleInfo || null;
    }

    const effectiveRole = AuthService.resolveEffectiveRole(roleInfo ? roleInfo.role : 'volunteer');
    const isSuperAdmin = effectiveRole === 'super_admin';
    const isFinance = effectiveRole === 'finance';
    const isPatriarch = effectiveRole === 'store_patriarch';
    const hasAccess = isFinance || isSuperAdmin || isPatriarch;

    let storeId = getCurrentActiveStore().storeId || (roleInfo && roleInfo.storeId) || '';
    let storeName = getCurrentActiveStore().storeName || (roleInfo && roleInfo.storeName) || '';
    if (!storeId || !storeName) {
      const legacy = getSelectedStore();
      storeId = storeId || legacy.storeId || '';
      storeName = storeName || legacy.storeName || '';
    }

    const isNationalOverview = !storeId || NATIONAL_STORE_IDS.includes(storeId);

    this.setData({
      roleReady: true,
      hasAccess,
      isNationalOverview,
      isSuperAdmin,
      isFinance,
      isPatriarch,
      currentStoreId: isNationalOverview ? '' : storeId,
      currentStoreName: isNationalOverview ? '全国总览' : storeName
    });
  },

  // ───────────────────── 稽核与封账（原 onOpenFinanceLockModal 起） ─────────────────────

  initFinanceLockDefaults() {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const defaultEndDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const defaultStartDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    this.setData({
      financeLockStartDate: this.data.financeLockStartDate || defaultStartDate,
      financeLockEndDate: this.data.financeLockEndDate || defaultEndDate
    });
  },

  onFinanceLockStartDateChange(e: any) {
    this.setData({ financeLockStartDate: e.detail.value }, () => {
      this.checkRangeLockStatus();
    });
  },

  onFinanceLockEndDateChange(e: any) {
    this.setData({ financeLockEndDate: e.detail.value }, () => {
      this.checkRangeLockStatus();
    });
  },

  async checkRangeLockStatus() {
    const { financeLockStartDate: startDate, financeLockEndDate: endDate, currentStoreId: storeId } = this.data;
    if (!startDate || !endDate || !storeId) return;
    if (startDate > endDate) {
      this.setData({ lockStatusText: '⚠️ 开始日期不能晚于结束日期', financeLockRangeLocked: false, financeLockHasApprovedRecords: false });
      return;
    }

    this.setData({ financeLockStatusLoading: true, lockStatusText: '查询区间状态中...', financeLockHasApprovedRecords: false });
    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const result = await callFunctionWithTimeout({
        name: 'manageFinanceLock',
        data: { action: 'checkRangeStatus', storeId, startDate, endDate }
      });
      const res = result.result as any;
      if (res && res.success) {
        let tip = '';
        if (res.isLocked) {
          tip = `🔒 该区间已封账（共 ${res.lockedCount} 条${res.lockedBy ? `，由 ${res.lockedBy}` : ''}${res.lockedAt ? ` 于 ${res.lockedAt}` : ''}）`;
        } else if (res.pendingCount > 0) {
          tip = `⚠️ 区间内还有 ${res.pendingCount} 笔待审核，需全部审核或作废后才能封账`;
        } else if (res.approvedCount > 0) {
          tip = `已审核待封账 ${res.approvedCount} 笔`;
        } else {
          tip = '该区间暂无可封账的记录';
        }
        this.setData({
          lockStatusText: tip,
          financeLockRangeLocked: !!res.isLocked,
          financeLockHasApprovedRecords: !res.isLocked && res.approvedCount > 0
        });
      } else {
        this.setData({ lockStatusText: (res && res.errMsg) || '查询区间状态失败', financeLockRangeLocked: false });
      }
    } catch (err) {
      console.error('[checkRangeLockStatus] 异常:', err);
      this.setData({ lockStatusText: '查询区间状态失败，请检查网络', financeLockRangeLocked: false });
    } finally {
      this.setData({ financeLockStatusLoading: false });
    }
  },

  async onConfirmFinanceLock() {
    if (this.data.financeLockInFlight) return;
    if (!this.data.financeLockHasApprovedRecords) {
      wx.showToast({ title: this.data.lockStatusText || '该区间暂无可封账的记录', icon: 'none' });
      return;
    }
    const { financeLockStartDate: startDate, financeLockEndDate: endDate } = this.data;
    if (!startDate || !endDate) {
      wx.showToast({ title: '请先选择要封账的起止日期', icon: 'none' });
      return;
    }
    if (startDate > endDate) {
      wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' });
      return;
    }
    const storeId = this.data.currentStoreId;
    const storeLabel = this.data.currentStoreName || storeId;

    wx.showModal({
      title: '🔒 确认稽核封账？',
      content: `确定要封账【${storeLabel}】${startDate} 至 ${endDate} 的账目吗？锁定后店长将无法修改，系统将为本次封账生成数字指纹 Hash 作为完整性凭证。`,
      confirmText: '确认封账',
      confirmColor: '#D32F2F',
      cancelText: '我再想想',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ financeLockInFlight: true });
        wx.showLoading({ title: '安全封账中...', mask: true });
        try {
          if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
          const result = await callFunctionWithTimeout({
            name: 'manageFinanceLock',
            data: { action: 'lockRange', storeId, startDate, endDate }
          });
          const res2 = result.result as any;
          wx.hideLoading();
          if (res2 && res2.success) {
            // 🔊 后厨语音与音效无感反馈：封账是本页面口径最接近"日结签名存证"
            // 的动作（manageFinanceLock 会生成数字指纹 Hash 作为完整性凭证，
            // 见下方 wx.showModal 确认文案），厚重下行音效 + 重震动区别于
            // 打卡/识票两个更轻量的操作反馈（原样从 index.ts 迁移）
            playReportSealed();
            const fingerprintTip = res2.lockFingerprint ? `\n数字指纹：${res2.lockFingerprint}` : '';
            wx.showModal({
              title: '封账完成',
              content: (res2.message || `已成功封账 ${res2.lockedCount || 0} 条记录`) + fingerprintTip,
              showCancel: false
            });
            this.checkRangeLockStatus();
          } else if (res2 && res2.error === 'SELECTED_RANGE_HAS_PENDING_REPORTS') {
            wx.showModal({ title: '无法封账', content: res2.message || '选中区间内存在待审核数据，请全部审核或作废后再封账！', showCancel: false });
          } else {
            wx.showModal({ title: '封账失败', content: (res2 && (res2.message || res2.errMsg)) || '云函数未返回正确结果', showCancel: false });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[onConfirmFinanceLock] 异常:', err);
          wx.showModal({ title: '调用失败', content: '未成功触发封账，请确认 manageFinanceLock 云函数已右键【上传并部署】', showCancel: false });
        } finally {
          this.setData({ financeLockInFlight: false });
        }
      }
    });
  },

  handleUnlockMonth() {
    if (this.data.financeUnlockInFlight) return;
    if (!this.data.isPatriarch && !this.data.isSuperAdmin) {
      wx.showToast({ title: '仅大家长与超级管理员可执行解封', icon: 'none' });
      return;
    }
    const { financeLockStartDate: startDate, financeLockEndDate: endDate, currentStoreId: storeId } = this.data;
    if (!startDate || !endDate) {
      wx.showToast({ title: '请先选择要解封的起止日期', icon: 'none' });
      return;
    }
    const storeLabel = this.data.currentStoreName || storeId;

    wx.showModal({
      title: '⚠️ 确认解除封账？',
      content: `仅限大家长权限操作，确定要解除【${storeLabel}】${startDate} 至 ${endDate} 的账目锁定吗？`,
      confirmText: '确认解封',
      confirmColor: '#E65100',
      cancelText: '我再想想',
      success: (res) => {
        if (!res.confirm) return;
        wx.showModal({
          title: '请填写解封核验理由',
          editable: true,
          placeholderText: '请如实填写解封核验理由（如：发现某笔记录金额录入有误，需重新核对）',
          confirmText: '提交解封',
          confirmColor: '#E65100',
          success: async (reasonRes) => {
            if (!reasonRes.confirm) return;
            const reason = String(reasonRes.content || '').trim();
            if (!reason) {
              wx.showToast({ title: '请填写解封核验理由后再提交', icon: 'none' });
              return;
            }

            this.setData({ financeUnlockInFlight: true });
            wx.showLoading({ title: '解封处理中...', mask: true });
            try {
              if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
              const result = await callFunctionWithTimeout({
                name: 'manageFinanceLock',
                data: { action: 'unlockRange', storeId, startDate, endDate, reason }
              });
              const res2 = result.result as any;
              wx.hideLoading();
              if (res2 && res2.success) {
                wx.showModal({
                  title: '解封完成',
                  content: res2.message || `已成功解封 ${res2.unlockedCount || 0} 条记录`,
                  showCancel: false
                });
                this.checkRangeLockStatus();
              } else {
                wx.showModal({ title: '解封失败', content: (res2 && (res2.message || res2.errMsg)) || '云函数未返回正确结果', showCancel: false });
              }
            } catch (err) {
              wx.hideLoading();
              console.error('[handleUnlockMonth] 异常:', err);
              wx.showModal({ title: '调用失败', content: '未成功触发解封，请确认 manageFinanceLock 云函数已右键【上传并部署】', showCancel: false });
            } finally {
              this.setData({ financeUnlockInFlight: false });
            }
          }
        });
      }
    });
  },

  // ───────────────────── 风控预警日志（原 onOpenRiskAlertsModal 起） ─────────────────────

  buildRiskAlertsRangeLabel(scanRangeDays: number): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - scanRangeDays);
    return `近 ${scanRangeDays} 天：${fmt(start)} 至 ${fmt(end)}`;
  },

  computeFilteredRiskAlerts(list: any[], filterType: string): any[] {
    if (!filterType) return list;
    if (filterType === 'balance') {
      return list.filter((item) => item.type === 'balance_break' || item.type === 'balance_jump');
    }
    return list.filter((item) => item.type === filterType);
  },

  onRiskCardTap(e: any) {
    const type = e.currentTarget.dataset.type as string;
    if (!type) return;
    const nextFilterType = this.data.riskAlertsFilterType === type ? '' : type;
    this.setData({
      riskAlertsFilterType: nextFilterType,
      riskAlertsFilteredList: this.computeFilteredRiskAlerts(this.data.riskAlertsList, nextFilterType)
    });
  },

  onGoToHistoryAnomalyDetail() {
    const type = this.data.riskAlertsFilterType;
    if (!type) return;
    safeNavigateTo({ url: `/subpackages/reports/pages/history/history?anomalyType=${type}` });
  },

  onRefreshRiskAlerts() {
    if (this.data.riskAlertsLoading) return;
    this.setData({ riskAlertsLoading: true });
    this.fetchRiskAlerts();
  },

  async fetchRiskAlerts() {
    const storeId = this.data.currentStoreId;
    if (!storeId) {
      this.setData({ riskAlertsLoading: false });
      return;
    }
    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const result = await callFunctionWithTimeout({
        name: 'getRiskAlerts',
        data: { storeId }
      });
      const res = result.result as any;
      if (res && res.success) {
        const alerts = res.alerts || [];
        const summary = res.summary || { voidCount: 0, missingReceiptCount: 0, balanceAnomalyCount: 0 };
        const filterType = this.data.riskAlertsFilterType;
        this.setData({
          riskAlertsList: alerts,
          riskAlertsFilteredList: this.computeFilteredRiskAlerts(alerts, filterType),
          riskAlertsSummary: summary,
          riskAlertsHasAnomaly: (summary.voidCount + summary.missingReceiptCount + summary.balanceAnomalyCount) > 0,
          riskAlertsRangeLabel: this.buildRiskAlertsRangeLabel(res.scanRangeDays || 60)
        });
      } else {
        console.warn('[fetchRiskAlerts] 云函数返回失败:', res);
      }
    } catch (err) {
      console.error('[fetchRiskAlerts] 异常:', err);
    } finally {
      this.setData({ riskAlertsLoading: false });
    }
  }
});
