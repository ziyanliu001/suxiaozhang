// 🤝（2026-09-19）爱心物资流转历史/明细列表页——雨花斋/助老食堂"调拨记录"+
// "采购入库记录"的独立查询页，只读展示，不提供编辑/撤销入口。
//
// ⚠️ 重要澄清（与用户确认过，见对话记录）：本仓库的物资调拨/采购记录设计上
// 是"创建即生效"的单一状态模型——material_transfer_logs/material_purchase_logs
// 都是不可变流水集合，从未有过"待接收/已驳回"这类需要对方确认才算数的审批
// 状态字段（云函数侧同样没有 status 字段）。用户最初的诉求描述了一套"待接收/
// 已完成/已驳回"三态配色，但那套状态在真实数据里不存在——如果编出假状态会
// 误导志工核对库存。这里把"状态配色"诚实地重新诠释成"记录类型/方向"配色：
// 调出支援＝琥珀色、调入接收＝柔和绿、采购入库＝中性灰，均反映记录的真实
// 属性（方向/类型），不是虚构的审批进度。
import { AuthService } from '../../../../utils/authService';
import { createNavGuard, NavGuardInstance } from '../../utils/navGuard';
import { callFunctionWithTimeout } from '../../../../utils/withTimeout';
import { getCurrentActiveStore } from '../../../../utils/storeManager';
import {
  TRANSFER_ITEM_FILTER_OPTIONS,
  PURCHASE_ITEM_FILTER_OPTIONS,
  DATE_RANGE_OPTIONS,
  applyMaterialHistoryFilters
} from './lib/materialHistoryFilters';

const CHARITY_ORG_TYPES = ['yuhuazhai', 'elderly_canteen'];

function formatCreateTime(value: any): string {
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

Page({
  _navGuard: null as NavGuardInstance | null,

  data: {
    contentTop: 0,
    checkedAccess: false,
    hasAccess: false,
    deniedReason: '',

    storeId: '',
    storeName: '',

    activeTab: 'transfer' as 'transfer' | 'purchase',

    loading: false,
    // 🌟 云函数一次性拉回上限 200 条（HISTORY_MAX_LIMIT），日期范围/物资类目
    // 筛选完全在客户端这批数据上现算（见 lib/materialHistoryFilters.js 头部
    // 注释），切换筛选条件不重新发云调用
    rawTransferRecords: [] as any[],
    rawPurchaseRecords: [] as any[],
    displayList: [] as any[],

    dateRangeOptions: DATE_RANGE_OPTIONS,
    dateRangeFilter: 'all',
    transferItemOptions: TRANSFER_ITEM_FILTER_OPTIONS,
    purchaseItemOptions: PURCHASE_ITEM_FILTER_OPTIONS,
    itemFilter: ''
  },

  onLoad() {
    this.checkAccessAndLoad();

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

  onNavLayout(e: { detail: { totalHeight: number } }) {
    this.setData({ contentTop: e.detail.totalHeight + 8 });
  },

  goBack() {
    wx.navigateBack();
  },

  // 🐛 与 inventory-management.ts checkAccessAndLoad 同款写法，多加一条
  // volunteer 只读放行——见 cloudfunctions/manageMaterialTransfer 新增的
  // resolveAccessTarget(caller, storeId, {allowVolunteer:true})
  async checkAccessAndLoad() {
    let cached = AuthService.getCachedRoleInfo();
    if (!cached) {
      const result = await AuthService.fetchUserRole();
      cached = result.roleInfo || null;
    }
    const role = cached ? AuthService.resolveEffectiveRole(cached.role) : '';
    const isManager = role === 'store_manager' || role === 'store_patriarch';
    const isSuperAdmin = role === 'super_admin';
    const isVolunteer = role === 'volunteer';

    if (!isManager && !isSuperAdmin && !isVolunteer) {
      this.setData({ checkedAccess: true, hasAccess: false, deniedReason: '仅店长、大家长、义工或超级管理员可查看物资流转记录' });
      return;
    }

    const storeId = isSuperAdmin ? (getCurrentActiveStore().storeId || '') : (cached && cached.storeId) || '';
    const storeName = isSuperAdmin ? (getCurrentActiveStore().storeName || '') : (cached && cached.storeName) || '';
    const orgType = isSuperAdmin ? '' : (cached && cached.orgType) || '';

    if (!storeId) {
      this.setData({
        checkedAccess: true,
        hasAccess: false,
        deniedReason: isSuperAdmin ? '请先在首页选择一家具体门店，再查看物资流转记录' : '您尚未绑定门店，无法查看物资流转记录'
      });
      return;
    }

    // 🏛️ super_admin 未知当前门店 orgType（getCurrentActiveStore 不带这个
    // 字段），交给服务端 resolveAccessTarget 兜底校验；非 super_admin 前端
    // 提前拦截非公益专区门店，与云函数侧的 CHARITY_ORG_TYPES 拦截保持一致
    if (!isSuperAdmin && orgType && !CHARITY_ORG_TYPES.includes(orgType)) {
      this.setData({ checkedAccess: true, hasAccess: false, deniedReason: '该功能仅服务雨花斋/助老食堂等公益专区' });
      return;
    }

    this.setData({ checkedAccess: true, hasAccess: true, storeId, storeName });
    this.fetchHistory();
  },

  async fetchHistory() {
    if (!this.data.storeId) return;
    this.setData({ loading: true });
    try {
      const [transferRes, purchaseRes]: any[] = await Promise.all([
        callFunctionWithTimeout({
          name: 'manageMaterialTransfer',
          data: { action: 'listTransferHistory', storeId: this.data.storeId }
        }),
        callFunctionWithTimeout({
          name: 'manageMaterialTransfer',
          data: { action: 'listPurchaseHistory', storeId: this.data.storeId }
        })
      ]);

      const transferResult = transferRes && transferRes.result;
      const purchaseResult = purchaseRes && purchaseRes.result;

      if (!transferResult || !transferResult.success) {
        this.setData({ hasAccess: false, deniedReason: (transferResult && transferResult.error) || '加载调拨记录失败' });
        return;
      }
      if (!purchaseResult || !purchaseResult.success) {
        this.setData({ hasAccess: false, deniedReason: (purchaseResult && purchaseResult.error) || '加载采购记录失败' });
        return;
      }

      this.setData({
        rawTransferRecords: transferResult.data || [],
        rawPurchaseRecords: purchaseResult.data || []
      });
      this.applyFilters();
    } catch (err) {
      console.error('[material-history] fetchHistory 异常:', err);
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onPullDownRefresh() {
    this.fetchHistory().finally(() => wx.stopPullDownRefresh());
  },

  onSwitchTab(e: any) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.activeTab) return;
    // 🐛 切换 Tab 时物资类目筛选清空——调拨/采购两个类目选项集不完全一致
    // （调拨没有时蔬），残留选中值容易让人误以为筛出了空列表
    this.setData({ activeTab: tab, itemFilter: '' });
    this.applyFilters();
  },

  onSwitchDateRange(e: any) {
    const value = e.currentTarget.dataset.value;
    if (value === this.data.dateRangeFilter) return;
    this.setData({ dateRangeFilter: value });
    this.applyFilters();
  },

  onSwitchItemFilter(e: any) {
    const value = e.currentTarget.dataset.value;
    if (value === this.data.itemFilter) return;
    this.setData({ itemFilter: value });
    this.applyFilters();
  },

  applyFilters() {
    const { activeTab, rawTransferRecords, rawPurchaseRecords, dateRangeFilter, itemFilter, storeId } = this.data;
    const source = activeTab === 'transfer' ? rawTransferRecords : rawPurchaseRecords;
    const filtered = applyMaterialHistoryFilters(source, { dateRange: dateRangeFilter, item: itemFilter }, new Date());

    const displayList = filtered.map((record: any) => {
      if (activeTab === 'transfer') {
        const isOutbound = record.fromStoreId === storeId;
        return {
          ...record,
          createTimeText: formatCreateTime(record.createTime),
          directionText: isOutbound ? '调出支援' : '调入接收',
          directionClass: isOutbound ? 'badge-out' : 'badge-in'
        };
      }
      return {
        ...record,
        createTimeText: formatCreateTime(record.createTime),
        directionText: '采购入库',
        directionClass: 'badge-purchase'
      };
    });

    this.setData({ displayList });
  }
});
