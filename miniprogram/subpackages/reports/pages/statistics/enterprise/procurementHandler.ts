// 🏛️ Open-Core 架构拆分 · 终局阶段：爱心粮油集采直通车（Enterprise）
//
// 见 ./nationalDashboardService.ts 头部注释——本文件同样是被 spread 进
// statistics.ts Page({...}) 的方法集合，不是独立运行的模块。
//
// PLATFORM_SUPPORT_CONTACT 从 nationalDashboardService.ts 里 export 出来的
// 同一份拷贝导入，onConsultUpgrade（套餐升级咨询）与本文件（供应链集采
// 合作咨询）语义场景不同，但复用同一份平台联系方式常量，不各自重复维护
//
// 🛡️ 注意：本文件不反向 import nationalDashboardService.ts 的任何符号——
// 那边会调用本文件导出的 computeProcurementPoolTiers()，若这里再 import
// 回去就会形成两个兄弟文件互相 import 的真循环依赖。nationalDashboardService.ts
// 改用 this.computeProcurementPoolTiers(...) 调用（procurementHandlers 已经
// spread 进同一个 Page 实例，见 ./index.ts 头部注释），不需要静态 import。
import { PLATFORM_SUPPORT_CONTACT } from './nationalDashboardService';

// 🌾（2026-08-31 集采进阶：阶梯拼单池引擎）三档拼单阶梯——门槛与折扣均为
// 产品原型阶段的经验性设定，尚未对接任何真实供应商合同价格，前端展示措辞
// 必须是"预计/预估"而不是"保证"，与 procurementSummary 其余字段（
// estimatedSavingsYuan/partnerFarmCount）同一套"诚实占位"口径，见
// cloudfunctions/getNationalDashboard procurementSummary 计算处注释
const PROCUREMENT_TIERS = [
  { level: 1, thresholdTon: 5, discountFactor: 0.95, discountLabel: '95折' },
  { level: 2, thresholdTon: 10, discountFactor: 0.90, discountLabel: '9折' },
  { level: 3, thresholdTon: 20, discountFactor: 0.85, discountLabel: '85折' }
];

// 🛡️ 三种物资各自的"示例市场基准价"（元/kg）——只用于换算"预计单斤直降"这
// 一个直观数字，与 getNationalDashboard 里 estimatedSavingsYuan 用的
// RICE/FLOUR/OIL_SAVINGS_PER_KG（那是"统谈统采相对零散采购的经验性溢价
// 空间"）是两套不同口径的常量，不要混用：那边回答"合并采购能省多少钱"，
// 这里回答"按当前已解锁的阶梯折扣，市面上一斤大概能便宜多少钱"，后者需要
// 一个可比的零售基准价才能算出绝对金额，同样是产品原型阶段的经验性设定，
// 不构成真实报价
const BASELINE_PRICE_PER_KG = { rice: 4.0, flour: 3.0, oil: 12.0 };

export const procurementHandlers = {
  // 🌾（2026-08-31 集采进阶）按月度汇聚总量（大米/面粉/食用油，公斤）算出
  // 当前达成的拼单阶梯等级、距下一档的进度与差距、以及按当前折扣换算出的
  // "预计单斤直降"金额，供全国大屏「爱心粮油源头集采直通车」卡片渲染动态
  // 进度条与阶梯徽章。纯函数（不读写 this.data），由 nationalDashboardService.ts
  // 的 loadNationalDashboard() 在拿到 procurementSummary 原始数据后调用
  computeProcurementPoolTiers(monthlyRiceEstimateKg: number, monthlyFlourEstimateKg: number, monthlyOilEstimateKg: number) {
    const riceKg = monthlyRiceEstimateKg || 0;
    const flourKg = monthlyFlourEstimateKg || 0;
    const oilKg = monthlyOilEstimateKg || 0;
    const totalWeightKg = riceKg + flourKg + oilKg;
    const totalWeightTon = totalWeightKg / 1000;

    // 找出已达成的最高档位（未达任何门槛时 currentTier 为 null，档位 0）
    let currentTier: typeof PROCUREMENT_TIERS[number] | null = null;
    for (const tier of PROCUREMENT_TIERS) {
      if (totalWeightTon >= tier.thresholdTon) {
        currentTier = tier;
      }
    }
    const currentTierLevel = currentTier ? currentTier.level : 0;
    const currentDiscountLabel = currentTier ? currentTier.discountLabel : '暂未解锁';
    const currentDiscountFactor = currentTier ? currentTier.discountFactor : 1;

    // 下一档：已达最高档时为 null，poolProgressPercent 恒为 100、
    // nextTierGapTon 恒为 0，卡片文案改展示"已解锁最高档位"
    const nextTier = PROCUREMENT_TIERS.find((t) => t.level === currentTierLevel + 1) || null;
    const prevThresholdTon = currentTier ? currentTier.thresholdTon : 0;

    let poolProgressPercent = 100;
    let nextTierGapTon = 0;
    // 🌾 卡片文案「全网已汇聚 X 吨 / 目标 Y 吨」里的 Y：未达最高档时是下一档
    // 的门槛，已达最高档时展示最高档门槛本身（进度条恒满格）
    let poolTargetTon = PROCUREMENT_TIERS[PROCUREMENT_TIERS.length - 1].thresholdTon;
    if (nextTier) {
      const span = nextTier.thresholdTon - prevThresholdTon;
      poolProgressPercent = span > 0
        ? Math.round(Math.max(0, Math.min(1, (totalWeightTon - prevThresholdTon) / span)) * 100)
        : 0;
      nextTierGapTon = Math.max(0, Math.round((nextTier.thresholdTon - totalWeightTon) * 10) / 10);
      poolTargetTon = nextTier.thresholdTon;
    }

    // 按三种物资各自的重量占比加权算出一个混合基准价，乘以（1-当前档位折扣）
    // 换算成"每斤"（0.5kg）视角下的直降金额；totalWeightKg 为 0（全网尚无
    // 任何消耗数据）时直接返回 0，不编造一个虚假基准
    const blendedBaselinePricePerKg = totalWeightKg > 0
      ? (riceKg * BASELINE_PRICE_PER_KG.rice + flourKg * BASELINE_PRICE_PER_KG.flour + oilKg * BASELINE_PRICE_PER_KG.oil) / totalWeightKg
      : 0;
    const estimatedPerJinDiscount = Number((blendedBaselinePricePerKg * 0.5 * (1 - currentDiscountFactor)).toFixed(2));

    return {
      totalWeightTon: Number(totalWeightTon.toFixed(1)),
      currentTierLevel,
      currentDiscountLabel,
      poolProgressPercent,
      nextTierGapTon,
      poolTargetTon,
      estimatedPerJinDiscount
    };
  },

  // 🌾（2026-08-31 商业化生态延伸）爱心粮油源头集采直通车：卡片「提报集采
  // 意向 / 基地合作」按钮，弹出说明弹窗——不挂 isAdmin/isPatriarch 权限
  // 判断，任何能看到全国大屏的角色都能了解集采说明并登记意向，与
  // procurementSummary 本身"全角色可见、不挂订阅套餐"的口径保持一致
  onOpenProcurementModal() {
    if (!this.data.nationalData || !this.data.nationalData.procurementSummary) return;
    this.setData({ showProcurementModal: true });
  },

  onCloseProcurementModal() {
    this.setData({ showProcurementModal: false });
  },

  // 「登记合作意向」：产品原型阶段的轻量转化路径——复制集采对接联系方式，
  // 真正的意向表单/CRM 对接系统是独立的后续项目，本次不做，与
  // onConsultUpgrade 复用同一个平台联系方式常量，但语义场景不同（那是
  // "套餐升级咨询"，这是"供应链集采合作咨询"），不合并成同一个方法
  onRegisterProcurementIntent() {
    this.setData({ showProcurementModal: false });
    wx.setClipboardData({
      data: PLATFORM_SUPPORT_CONTACT.wechat,
      success: () => wx.showToast({ title: `已复制集采对接微信号：${PLATFORM_SUPPORT_CONTACT.wechat}，请添加好友沟通合作意向`, icon: 'none', duration: 3000 })
    });
  }
};
