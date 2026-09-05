// 商业进销存 Phase 1：物料档案与基础库存 UI Scaffold。
//
// 🏛️ 业态边界：只服务于商业专区（orgType !== 'yuhuazhai'）。云函数
// manageInventoryItem 已经在服务端硬拒绝雨花斋门店的读写，这里的前端校验是
// UX 层面的"提前告知"，不是唯一防线——即便绕开这层直接调云函数，服务端同样
// 会拒绝，与 EXCEL_EXPORT/MULTI_STORE_DASHBOARD 现有的双层拦截模式一致。
//
// 权限范围：store_manager/finance/store_patriarch（本店）或 super_admin
// （本机构任意门店，Phase 1 先按其当前选中/绑定的门店操作，不在本阶段引入
// 独立的多店切换器——那属于后续迭代范围，不在本次"数据模型与 UI Scaffold"
// 交付里）。
import { AuthService } from '../../../../utils/authService';
import { createNavGuard, NavGuardInstance } from '../../../../utils/navGuard';
import { callFunctionWithTimeout } from '../../../../utils/withTimeout';
import { getCurrentActiveStore } from '../../../../utils/storeManager';

const CATEGORY_OPTIONS = [
  { value: 'grain_oil', label: '粮油调味' },
  { value: 'fresh_produce', label: '生鲜蔬果' },
  { value: 'mushroom_dried', label: '菌菇干货' },
  { value: 'plant_protein', label: '植物蛋白' },
  { value: 'packaging', label: '包材耗材' }
];

const UNIT_OPTIONS = [
  { value: 'kg', label: 'kg' },
  { value: 'bag', label: '包' },
  { value: 'bucket', label: '桶' },
  { value: 'box', label: '箱' },
  { value: 'piece', label: '个' }
];

function categoryLabel(value: string): string {
  const opt = CATEGORY_OPTIONS.find((o) => o.value === value);
  return opt ? opt.label : value;
}

function unitLabel(value: string): string {
  const opt = UNIT_OPTIONS.find((o) => o.value === value);
  return opt ? opt.label : value;
}

const EMPTY_FORM = {
  id: '',
  itemCode: '',
  name: '',
  category: '',
  unit: '',
  conversionUnit: '',
  conversionRatio: '',
  costPrice: '',
  currentStock: '',
  safetyStockMin: '',
  safetyStockMax: '',
  shelfLifeDays: '',
  expiryAlertDays: ''
};

Page({
  _navGuard: null as NavGuardInstance | null,

  data: {
    contentTop: 0,
    checkedAccess: false,
    hasAccess: false,
    deniedReason: '',

    storeId: '',
    storeName: '',

    loading: false,
    list: [] as any[],
    // 🆕 分类筛选 Tab：'all' + 5 个物料分类，纯本地过滤 wx:if，数据已在 list
    // 里（单店物料量级小，免费版上限才 30 条），不重新发起云调用——与
    // store-management.ts 的 storeMatrixFilter 同一种"一键快筛"写法
    filteredList: [] as any[],
    categoryFilter: 'all',
    categoryTabs: [{ value: 'all', label: '全部' }, ...CATEGORY_OPTIONS],
    categoryOptions: CATEGORY_OPTIONS,
    unitOptions: UNIT_OPTIONS,

    showFormModal: false,
    formMode: 'create' as 'create' | 'edit',
    form: { ...EMPTY_FORM },
    categoryPickerIndex: -1,
    unitPickerIndex: -1,
    submitting: false
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

  // 🐛 与 store-management.ts checkAccess 同款写法：优先用本地缓存角色，
  // 缺失时现查一次，避免每次进页都强制打一次云函数
  async checkAccessAndLoad() {
    let cached = AuthService.getCachedRoleInfo();
    if (!cached) {
      const result = await AuthService.fetchUserRole();
      cached = result.roleInfo || null;
    }
    const role = cached ? AuthService.resolveEffectiveRole(cached.role) : '';
    const isManager = role === 'store_manager' || role === 'finance' || role === 'store_patriarch';
    const isSuperAdmin = role === 'super_admin';

    if (!isManager && !isSuperAdmin) {
      this.setData({ checkedAccess: true, hasAccess: false, deniedReason: '仅店长、财务、大家长或超级管理员可使用进销存' });
      return;
    }

    // 🏛️ 超管取当前选中/巡检门店（getCurrentActiveStore，与全站"当前生效门店"
    // 同一个唯一真源）；店长/财务/大家长取自己绑定的门店
    const storeId = isSuperAdmin ? (getCurrentActiveStore().storeId || '') : (cached && cached.storeId) || '';
    const storeName = isSuperAdmin ? (getCurrentActiveStore().storeName || '') : (cached && cached.storeName) || '';

    if (!storeId) {
      this.setData({
        checkedAccess: true,
        hasAccess: false,
        deniedReason: isSuperAdmin ? '请先在首页选择一家具体门店，再进入进销存' : '您尚未绑定门店，无法使用进销存'
      });
      return;
    }

    this.setData({ checkedAccess: true, hasAccess: true, storeId, storeName });
    this.fetchList();
  },

  async fetchList() {
    if (!this.data.storeId) return;
    this.setData({ loading: true });
    try {
      const res: any = await callFunctionWithTimeout({
        name: 'manageInventoryItem',
        data: { action: 'list', storeId: this.data.storeId }
      });
      const result = res && res.result;
      if (result && result.success) {
        const list = (result.data || []).map((item: any) => ({
          ...item,
          categoryText: categoryLabel(item.category),
          unitText: unitLabel(item.unit)
        }));
        this.setData({ list });
        this.applyCategoryFilter();
      } else {
        // 🌸 服务端对雨花斋门店会返回 success:false + 明确文案，这里原样透传
        // 展示，不当成普通网络错误吞掉
        this.setData({ hasAccess: false, deniedReason: (result && result.error) || '加载失败' });
      }
    } catch (err) {
      console.error('[inventory-management] fetchList 异常:', err);
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onPullDownRefresh() {
    this.fetchList().finally(() => wx.stopPullDownRefresh());
  },

  onSwitchCategoryFilter(e: any) {
    const value = e.currentTarget.dataset.value;
    if (value === this.data.categoryFilter) return;
    this.setData({ categoryFilter: value });
    this.applyCategoryFilter();
  },

  applyCategoryFilter() {
    const { list, categoryFilter } = this.data;
    const filteredList = categoryFilter === 'all' ? list : list.filter((item: any) => item.category === categoryFilter);
    this.setData({ filteredList });
  },

  onOpenCreateModal() {
    this.setData({
      showFormModal: true,
      formMode: 'create',
      form: { ...EMPTY_FORM },
      categoryPickerIndex: -1,
      unitPickerIndex: -1
    });
  },

  onOpenEditModal(e: any) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.list.find((it: any) => it._id === id);
    if (!item) return;
    this.setData({
      showFormModal: true,
      formMode: 'edit',
      form: {
        id: item._id,
        itemCode: item.itemCode || '',
        name: item.name || '',
        category: item.category || '',
        unit: item.unit || '',
        conversionUnit: item.conversionUnit || '',
        conversionRatio: item.conversionRatio != null ? String(item.conversionRatio) : '',
        costPrice: item.costPrice != null ? String(item.costPrice) : '',
        currentStock: item.currentStock != null ? String(item.currentStock) : '',
        safetyStockMin: item.safetyStockMin != null ? String(item.safetyStockMin) : '',
        safetyStockMax: item.safetyStockMax != null ? String(item.safetyStockMax) : '',
        shelfLifeDays: item.shelfLifeDays != null ? String(item.shelfLifeDays) : '',
        expiryAlertDays: item.expiryAlertDays != null ? String(item.expiryAlertDays) : ''
      },
      categoryPickerIndex: CATEGORY_OPTIONS.findIndex((o) => o.value === item.category),
      unitPickerIndex: UNIT_OPTIONS.findIndex((o) => o.value === item.unit)
    });
  },

  onCloseFormModal() {
    this.setData({ showFormModal: false });
  },

  stopPropagation() {},

  onFormFieldInput(e: any) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onCategoryPickerChange(e: any) {
    const index = parseInt(e.detail.value, 10);
    const opt = CATEGORY_OPTIONS[index];
    if (!opt) return;
    this.setData({ categoryPickerIndex: index, 'form.category': opt.value });
  },

  onUnitPickerChange(e: any) {
    const index = parseInt(e.detail.value, 10);
    const opt = UNIT_OPTIONS[index];
    if (!opt) return;
    this.setData({ unitPickerIndex: index, 'form.unit': opt.value });
  },

  async onSubmitForm() {
    if (this.data.submitting) return;
    const { form, formMode, storeId } = this.data;

    if (!form.name || !form.name.trim()) {
      wx.showToast({ title: '请输入物料名称', icon: 'none' });
      return;
    }
    if (!form.category) {
      wx.showToast({ title: '请选择物料分类', icon: 'none' });
      return;
    }
    if (!form.unit) {
      wx.showToast({ title: '请选择计量单位', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: formMode === 'create' ? '创建中...' : '保存中...', mask: true });

    const payload: any = {
      itemCode: form.itemCode,
      name: form.name,
      category: form.category,
      unit: form.unit,
      conversionUnit: form.conversionUnit,
      conversionRatio: form.conversionRatio,
      costPrice: form.costPrice,
      currentStock: form.currentStock,
      safetyStockMin: form.safetyStockMin,
      safetyStockMax: form.safetyStockMax,
      shelfLifeDays: form.shelfLifeDays,
      expiryAlertDays: form.expiryAlertDays
    };
    if (formMode === 'create') {
      payload.storeId = storeId;
    } else {
      payload.id = form.id;
    }

    try {
      const res: any = await callFunctionWithTimeout({
        name: 'manageInventoryItem',
        data: { action: formMode === 'create' ? 'create' : 'update', ...payload }
      });
      const result = res && res.result;
      wx.hideLoading();

      if (result && result.success) {
        this.setData({ showFormModal: false });
        wx.showToast({ title: result.message || '操作成功', icon: 'success' });
        this.fetchList();
        return;
      }

      // 🔐 免费版数量配额拦截：与 statistics.ts onOpenPlanUpgradeModal 同款
      // 升级引导交互，不是把这个错误码当成普通吐司文案糊弄过去
      if (result && result.errorCode === 'INVENTORY_LIMIT_REACHED') {
        wx.showModal({
          title: '物料已达免费版上限',
          content: `${result.error || ''}\n\n是否现在前往个人中心开通/升级套餐？`,
          confirmText: '去升级',
          success: (modalRes) => {
            if (modalRes.confirm) {
              wx.switchTab({ url: '/pages/profile/profile' });
            }
          }
        });
        return;
      }

      wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
    } catch (err) {
      wx.hideLoading();
      console.error('[inventory-management] onSubmitForm 异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  onDisableItem(e: any) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    wx.showModal({
      title: '停用物料',
      content: `确认停用「${name}」？停用后不再计入免费版数量配额，历史记录不受影响。`,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中...', mask: true });
        try {
          const cloudRes: any = await callFunctionWithTimeout({
            name: 'manageInventoryItem',
            data: { action: 'disable', id }
          });
          wx.hideLoading();
          const result = cloudRes && cloudRes.result;
          if (result && result.success) {
            wx.showToast({ title: '已停用', icon: 'success' });
            this.fetchList();
          } else {
            wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[inventory-management] onDisableItem 异常:', err);
          wx.showToast({ title: '网络异常，请重试', icon: 'none' });
        }
      }
    });
  }
});
