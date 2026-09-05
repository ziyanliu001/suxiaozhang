// 🏛️ Open-Core 架构拆分 · 终局阶段：全国大屏矩阵行点击下钻单店（Enterprise）
//
// 见 ./nationalDashboardService.ts 头部注释——本文件同样是被 spread 进
// statistics.ts Page({...}) 的方法集合，不是独立运行的模块。
//
// onDrillDownStore 内部调用的 this.calculateStats()/this.fetchStatistics()/
// this.fetchStoreProfile() 是 Core 方法（留在 statistics.ts），
// onReturnToNationalDashboard 调用的 this._triggerPatriarchNationalView()
// 定义在 ./nationalDashboardService.ts——三者运行时合并到同一个页面实例，
// 互相调用不受物理文件边界影响。
import { setSelectedStore } from '../../../utils/storeManager';

export const drillDownHandlers = {
  // 🆕（2026-08-31）大屏门店矩阵行点击下钻单店明细：只对大家长/超管生效——
  // 其余角色（含 hq_finance/regional_finance）即使能看到全国矩阵表格，点进
  // 某一具体门店也没有意义：getReports/getStatisticsData 等单店数据云函数
  // 服务端仍会把非租户级角色强制收敛回自己绑定的门店（"总部财务只看汇总
  // 数字，不看单店流水明细"的既有口径），点了也只会看到自己的店，不是点的
  // 那家，容易造成"点了没反应/点错店"的困惑，所以这里直接不响应
  onDrillDownStore(e: any) {
    if (!this.data.isAdmin && !this.data.isPatriarch) return;

    const storeId = e.currentTarget.dataset.storeid || '';
    const storeName = e.currentTarget.dataset.storename || '';
    if (!storeName) return;

    // 与 onSuperAdminSelectStore 选中具体门店时完全同一套状态切换（shopName/
    // currentUserStoreName/currentUserStoreId/isAllStoresMode/showNationalDashboard
    // 等），只是触发源从"顶部下拉选择器"换成"矩阵表格行点击"，额外多记一个
    // drilledDownFromNational 标记驱动"‹ 返回全国大屏"胶囊显示
    this.setData({
      shopName: storeName,
      currentUserStoreName: storeName,
      currentUserStoreId: storeId,
      isAllStoresMode: false,
      nationalFilterMode: 'national',
      hasOtherStoreData: false,
      statistics: null,
      showNationalDashboard: false,
      drilledDownFromNational: true
    });

    setSelectedStore({ storeId, storeName });

    this.calculateStats();
    this.fetchStatistics();
    this.fetchStoreProfile();
  },

  // 「‹ 返回全国大屏」：与 _triggerPatriarchNationalView() 完全同一套动作
  // （该方法内部不做角色判断，安全边界在 loadNationalDashboard() 的
  // canViewNationalDashboard 守卫），大家长/超管共用同一个返回入口，不需要
  // 用户记住"超管用顶部下拉选择器切回、大家长用另一个按钮切回"这两条不同路径
  onReturnToNationalDashboard() {
    if (!this.data.isAdmin && !this.data.isPatriarch) return;
    this.setData({ drilledDownFromNational: false });
    this._triggerPatriarchNationalView();
  }
};
