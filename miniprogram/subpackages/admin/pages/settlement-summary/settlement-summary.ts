import { callFunctionWithTimeout } from '../../../../utils/withTimeout';
// 页面：对账明细 —— 素食直播产销协同「简易对账看板」
//
// 🚪 入口方式：与 production-fulfillment 同款，通过 wx.navigateTo 传入
// tenantId 查询参数打开；production-fulfillment 页顶部有一个"对账明细 →"
// 入口直接带 tenantId 跳转过来。
//
// 数据来源：getSettlementSummary 云函数——space_owner/space_admin 看全租户，
// producer 只看自己名下商品产生的订单分成（云函数侧已做角色区分，本页不用
// 关心当前角色是谁，拿到什么就展示什么）。
const STATUS_LABEL: Record<string, string> = {
  unsettled: '待结算',
  settled: '已结算',
  settled_then_reversed: '已结算(后续退款冲销)',
  refunded: '已撤销(未产生实际支付)'
};

function yuan(fen: number): string {
  return ((fen || 0) / 100).toFixed(2);
}

interface SettlementBucket {
  count: number;
  payAmount: number;
  producerAmount: number;
  promoterAmount: number;
  platformFee: number;
}

interface OpsStats {
  orderCount: number;
  totalQuantity: number;
  producerAmount: number;
  promoterAmount: number;
  platformFee: number;
}

interface DetailRow {
  settlementId: string;
  orderId: string;
  payAmount: number;
  producerAmount: number;
  promoterAmount: number;
  platformFee: number;
  settlementStatus: string;
  createdAt: string | null;
  settledAt?: string | null;
  reversedAt?: string | null;
  // 展示用派生字段
  statusLabel?: string;
  producerAmountYuan?: string;
  promoterAmountYuan?: string;
  // 🏛️（护城河三 M2）批量确认结算勾选态——预算好的布尔字段，不在 WXML 里
  // 现场调用 selectedOrderIds.indexOf(...)，同 pages/index/index.wxml 的
  // genRoleXxxDisabled 历史修复思路（可靠性/可排查性都更好）
  selected?: boolean;
}

// 🏛️（护城河一 M1）转捐目标门店——manageCharityContribution.listTargetStores
// 返回的原始字段
interface TargetStore {
  storeId: string;
  storeName: string;
  orgType: string;
  city: string;
  province: string;
}

Page({
  data: {
    contentTop: 0,

    tenantId: '',
    loading: true,
    loadError: '',

    unsettled: { count: 0, producerAmountYuan: '0.00', promoterAmountYuan: '0.00' },
    settled: { count: 0, producerAmountYuan: '0.00', promoterAmountYuan: '0.00' },
    voided: { count: 0, producerAmountYuan: '0.00', promoterAmountYuan: '0.00' },

    // 📊 运营简报：opsStats 是服务端一次性算好的 7 天/30 天两份数据，切换
    // 区间只是换一份已经在本地的数据展示，不需要重新请求云函数
    opsRangeDays: 7 as 7 | 30,
    opsStatsRaw: { last7: null as OpsStats | null, last30: null as OpsStats | null },
    opsDisplay: {
      orderCount: 0, totalQuantity: 0,
      producerAmountYuan: '0.00', promoterAmountYuan: '0.00', platformFeeYuan: '0.00'
    },

    details: [] as DetailRow[],

    // 🏛️（护城河三 M2）payment_mode：'direct_wechat' 模式下分账由微信支付自动
    // 划拨，批量确认结算入口不该出现（markSettlementsSettled 云函数本身也会
    // 拒绝，这里是体验层面的提前收敛）
    paymentMode: 'none',

    // 🏛️（护城河三 M2）批量确认结算：仅 settlementStatus==='unsettled' 的
    // 明细可勾选，选中态用 orderId 数组维护，跟随 details 重新加载而清空
    selectedOrderIds: [] as string[],
    markSettling: false,

    // 🏛️（护城河三 M2）对账明细导出：与 statistics.ts 的 exportToExcel 同一套
    // 「核对 → 确认 → 生成 → 下载」安全闭环
    exportPreviewLoading: false,
    showExportPreviewModal: false,
    exportPreviewSummary: {} as Record<string, any>,
    exportPreviewRecords: [] as Array<Record<string, any>>,
    exportSubmitting: false,

    // 🏛️（护城河一 M1）以产养善：累计转捐额度 + 转捐弹窗状态
    charityPledgedTotalYuan: '0.00',
    showPledgeModal: false,
    pledgeTargetOrderId: '',
    pledgeSettlementId: '',
    pledgeMaxAmount: 0, // 分，等于该笔结算的 producerAmount，前端校验上限用
    pledgeMaxAmountYuan: '0.00', // 仅供弹窗展示，不参与校验（校验用上面的分）
    pledgeAmountYuan: '',
    pledgeSubmitting: false,
    pledgeStoresLoading: false,
    pledgeStoresAll: [] as TargetStore[],
    pledgeStoresFiltered: [] as TargetStore[],
    pledgeKeyword: '',
    pledgeSelectedStoreId: '',
    pledgeSelectedStoreName: ''
  },

  onLoad(options: Record<string, string>) {
    const tenantId = (options && options.tenantId) || '';
    if (!tenantId) {
      wx.showToast({ title: '缺少工作空间参数', icon: 'none' });
      setTimeout(() => wx.navigateBack({ delta: 1 }), 1200);
      return;
    }
    this.setData({ tenantId });
    this.loadSummary();
  },

  // 🐛 根因修复：见 store-management.ts 同处修复记录，改用 <navigation-bar>
  // 共享组件
  onNavLayout(e: { detail: { totalHeight: number } }) {
    this.setData({ contentTop: e.detail.totalHeight + 8 });
  },

  onPullDownRefresh() {
    this.loadSummary(() => wx.stopPullDownRefresh());
  },

  formatBucket(bucket: SettlementBucket) {
    return {
      count: bucket.count,
      producerAmountYuan: yuan(bucket.producerAmount),
      promoterAmountYuan: yuan(bucket.promoterAmount)
    };
  },

  formatOpsStats(stats: OpsStats | null) {
    const s = stats || { orderCount: 0, totalQuantity: 0, producerAmount: 0, promoterAmount: 0, platformFee: 0 };
    return {
      orderCount: s.orderCount,
      totalQuantity: s.totalQuantity,
      producerAmountYuan: yuan(s.producerAmount),
      promoterAmountYuan: yuan(s.promoterAmount),
      platformFeeYuan: yuan(s.platformFee)
    };
  },

  onSelectOpsRange(e: any) {
    const days = Number(e.currentTarget.dataset.days);
    if (days !== 7 && days !== 30) return;
    this.setData({
      opsRangeDays: days,
      opsDisplay: this.formatOpsStats(days === 7 ? this.data.opsStatsRaw.last7 : this.data.opsStatsRaw.last30)
    });
  },

  async loadSummary(done?: () => void) {
    this.setData({ loading: true, loadError: '' });

    try {
      const res = await callFunctionWithTimeout({
        name: 'getSettlementSummary',
        data: { tenantId: this.data.tenantId }
      });
      const result = res.result as any;

      if (result && result.success) {
        const details: DetailRow[] = (result.details || []).map((d: DetailRow) => ({
          ...d,
          statusLabel: STATUS_LABEL[d.settlementStatus] || d.settlementStatus,
          producerAmountYuan: yuan(d.producerAmount),
          promoterAmountYuan: yuan(d.promoterAmount),
          selected: false
        }));
        const opsStatsRaw = result.opsStats || { last7: null, last30: null };
        this.setData({
          unsettled: this.formatBucket(result.summary.unsettled),
          settled: this.formatBucket(result.summary.settled),
          voided: this.formatBucket(result.summary.voided),
          details,
          opsStatsRaw,
          opsDisplay: this.formatOpsStats(this.data.opsRangeDays === 7 ? opsStatsRaw.last7 : opsStatsRaw.last30),
          charityPledgedTotalYuan: yuan(result.charityPledgedTotal || 0),
          paymentMode: result.paymentMode || 'none',
          // 🐛 每次重新加载明细都清空勾选——重新拉取后旧的 orderId 选中态
          // 可能已经不在新的"待结算"名单里（比如刚被别人手动结算了）
          selectedOrderIds: [],
          loadError: ''
        });
      } else {
        this.setData({ loadError: (result && result.error) || '加载失败' });
      }
    } catch (err) {
      console.error('[settlement-summary] loadSummary 异常:', err);
      this.setData({ loadError: '加载异常，请重试' });
    } finally {
      this.setData({ loading: false });
      // 🐛 同 production-fulfillment.ts 的修复：重试按钮 bindtap="loadSummary"
      // 会把 tap 事件对象当 done 传进来，必须判类型而不是只判真值
      if (typeof done === 'function') done();
    }
  },

  // ============ 护城河三 M2：批量确认结算 ============

  // 🐛 用 data-index 精确 path 更新 details[index].selected，不做
  // this.setData({ details }) 全量数组替换——见 CLAUDE.md「setData 铁律」
  onToggleSelectOrder(e: any) {
    const orderId = e.currentTarget.dataset.orderId;
    const index = e.currentTarget.dataset.index;
    if (!orderId || index === undefined) return;
    const selected = this.data.selectedOrderIds.slice();
    const idx = selected.indexOf(orderId);
    const nowSelected = idx === -1;
    if (nowSelected) selected.push(orderId);
    else selected.splice(idx, 1);
    this.setData({
      selectedOrderIds: selected,
      [`details[${index}].selected`]: nowSelected
    });
  },

  onSelectAllUnsettled() {
    const allUnsettledIds: string[] = [];
    const updates: Record<string, boolean> = {};
    this.data.details.forEach((d, i) => {
      if (d.settlementStatus === 'unsettled') {
        allUnsettledIds.push(d.orderId);
        updates[`details[${i}].selected`] = true;
      }
    });
    this.setData({ ...updates, selectedOrderIds: allUnsettledIds } as any);
  },

  onClearSelection() {
    const updates: Record<string, boolean> = {};
    this.data.details.forEach((d, i) => {
      if (d.selected) updates[`details[${i}].selected`] = false;
    });
    this.setData({ ...updates, selectedOrderIds: [] } as any);
  },

  async onConfirmMarkSettled() {
    if (this.data.markSettling) return;
    const orderIds = this.data.selectedOrderIds;
    if (orderIds.length === 0) {
      wx.showToast({ title: '请先勾选要确认结算的订单', icon: 'none' });
      return;
    }

    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '确认结算',
        content: `确认已线下打款给制作方/推广员，将 ${orderIds.length} 笔订单标记为「已结算」？此操作不可撤销。`,
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      });
    });
    if (!confirmed) return;

    this.setData({ markSettling: true });
    wx.showLoading({ title: '提交中...', mask: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'markSettlementsSettled',
        data: { tenantId: this.data.tenantId, orderIds }
      });
      const result = res.result as any;
      wx.hideLoading();
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '标记失败，请重试', icon: 'none' });
        return;
      }
      wx.showToast({ title: `已确认结算 ${result.updatedCount} 笔`, icon: 'success' });
      this.loadSummary();
    } catch (err) {
      wx.hideLoading();
      console.error('[settlement-summary] onConfirmMarkSettled 异常:', err);
      wx.showToast({ title: '标记失败，请重试', icon: 'none' });
    } finally {
      this.setData({ markSettling: false });
    }
  },

  // ============ 护城河三 M2：对账明细导出 ============

  async onExportSettlement() {
    if (this.data.exportPreviewLoading) return;
    this.setData({ exportPreviewLoading: true });
    wx.showLoading({ title: '正在核对数据...', mask: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'exportSettlementExcel',
        data: { tenantId: this.data.tenantId, previewOnly: true }
      });
      const result = res.result as any;
      wx.hideLoading();
      if (result && result.success) {
        this.setData({
          showExportPreviewModal: true,
          exportPreviewSummary: result.summary || {},
          exportPreviewRecords: result.records || []
        });
      } else {
        wx.showToast({ title: (result && result.errMsg) || '核对数据加载失败，请重试', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[settlement-summary] onExportSettlement 异常:', err);
      wx.showToast({ title: '核对数据加载失败，请重试', icon: 'none' });
    } finally {
      this.setData({ exportPreviewLoading: false });
    }
  },

  onCloseExportPreviewModal() {
    this.setData({ showExportPreviewModal: false });
  },

  async onExportPreviewConfirm() {
    this.setData({ showExportPreviewModal: false });
    if (this.data.exportSubmitting) return;
    this.setData({ exportSubmitting: true });
    wx.showLoading({ title: '正在生成 Excel 表格...', mask: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'exportSettlementExcel',
        data: { tenantId: this.data.tenantId }
      });
      const result = res.result as any;
      wx.hideLoading();
      if (result && result.success && result.tempFileURL) {
        this.downloadAndOpenExcel(result.tempFileURL, result.fileName || '工坊对账明细.xlsx');
      } else {
        wx.showToast({ title: (result && result.errMsg) || '导出失败，请重试', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[settlement-summary] onExportPreviewConfirm 异常:', err);
      wx.showToast({ title: '导出失败，请重试', icon: 'none' });
    } finally {
      this.setData({ exportSubmitting: false });
    }
  },

  // 🆕【方案 A：下载至本机/微信转发】同 statistics.ts 的 downloadAndOpenExcel
  // 写法（本仓库页面间无共享模块，各页各自维护一份小工具函数）
  downloadAndOpenExcel(tempFileURL: string, fileName: string) {
    wx.showLoading({ title: '正在下载表格...', mask: true });
    wx.downloadFile({
      url: tempFileURL,
      success: (downloadRes) => {
        wx.hideLoading();
        wx.openDocument({
          filePath: downloadRes.tempFilePath,
          fileType: 'xlsx',
          showMenu: true,
          success: () => {
            wx.showToast({ title: '已打开，可点右上角转发', icon: 'none', duration: 2500 });
          },
          fail: () => {
            wx.setClipboardData({
              data: tempFileURL,
              success: () => {
                wx.showModal({
                  title: '提示',
                  content: '文件已生成，下载链接已复制到剪贴板，可粘贴至浏览器下载。',
                  showCancel: false
                });
              }
            });
          }
        });
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '下载失败，请重试', icon: 'none' });
      }
    });
  },

  // ============ 护城河一 M1：转捐给公益厨房 ============

  stopPropagation() {},

  async onOpenPledgeModal(e: any) {
    const orderId = e.currentTarget.dataset.orderId;
    const row = this.data.details.find((d) => d.orderId === orderId);
    if (!row) return;

    this.setData({
      showPledgeModal: true,
      pledgeTargetOrderId: row.orderId,
      pledgeSettlementId: row.settlementId,
      pledgeMaxAmount: row.producerAmount,
      pledgeMaxAmountYuan: yuan(row.producerAmount),
      // 默认全额转捐，用户可以改小——不能改大，见 onPledgeAmountInput 的上限拦截
      pledgeAmountYuan: yuan(row.producerAmount),
      pledgeKeyword: '',
      pledgeSelectedStoreId: '',
      pledgeSelectedStoreName: '',
      pledgeStoresAll: [],
      pledgeStoresFiltered: []
    });
    this.loadTargetStores();
  },

  onClosePledgeModal() {
    if (this.data.pledgeSubmitting) return;
    this.setData({ showPledgeModal: false });
  },

  async loadTargetStores() {
    this.setData({ pledgeStoresLoading: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageCharityContribution',
        data: { action: 'listTargetStores', tenantId: this.data.tenantId }
      });
      const result = res.result as any;
      if (result && result.success) {
        const stores: TargetStore[] = result.stores || [];
        this.setData({ pledgeStoresAll: stores, pledgeStoresFiltered: stores });
      } else {
        wx.showToast({ title: (result && result.error) || '门店列表加载失败', icon: 'none' });
      }
    } catch (err) {
      console.error('[settlement-summary] loadTargetStores 异常:', err);
      wx.showToast({ title: '门店列表加载异常', icon: 'none' });
    } finally {
      this.setData({ pledgeStoresLoading: false });
    }
  },

  onPledgeKeywordInput(e: any) {
    const keyword = String(e.detail.value || '').trim();
    const all = this.data.pledgeStoresAll;
    const filtered = keyword ? all.filter((s) => s.storeName.indexOf(keyword) !== -1) : all;
    this.setData({ pledgeKeyword: keyword, pledgeStoresFiltered: filtered });
  },

  onSelectTargetStore(e: any) {
    const storeId = e.currentTarget.dataset.storeId;
    const store = this.data.pledgeStoresFiltered.find((s) => s.storeId === storeId);
    if (!store) return;
    this.setData({ pledgeSelectedStoreId: store.storeId, pledgeSelectedStoreName: store.storeName });
  },

  onPledgeAmountInput(e: any) {
    this.setData({ pledgeAmountYuan: e.detail.value });
  },

  async onSubmitPledge() {
    if (this.data.pledgeSubmitting) return;
    if (!this.data.pledgeSelectedStoreId) {
      wx.showToast({ title: '请先选择要捐赠的公益厨房', icon: 'none' });
      return;
    }
    const amountYuan = parseFloat(this.data.pledgeAmountYuan);
    if (!(amountYuan > 0)) {
      wx.showToast({ title: '请填写正确的转捐金额', icon: 'none' });
      return;
    }
    const amount = Math.round(amountYuan * 100);
    if (amount > this.data.pledgeMaxAmount) {
      wx.showToast({ title: '转捐金额不能超过该笔订单制作方分成金额', icon: 'none' });
      return;
    }

    this.setData({ pledgeSubmitting: true });
    wx.showLoading({ title: '提交中...', mask: true });
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageCharityContribution',
        data: {
          action: 'pledge',
          tenantId: this.data.tenantId,
          settlementId: this.data.pledgeSettlementId,
          amount,
          targetStoreId: this.data.pledgeSelectedStoreId
        }
      });
      const result = res.result as any;
      wx.hideLoading();
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '提交失败，请重试', icon: 'none' });
        return;
      }
      wx.showToast({ title: '已转捐，感谢您的善心', icon: 'success' });
      this.setData({ showPledgeModal: false });
      this.loadSummary();
    } catch (err) {
      wx.hideLoading();
      console.error('[settlement-summary] onSubmitPledge 异常:', err);
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
    } finally {
      this.setData({ pledgeSubmitting: false });
    }
  }
});
