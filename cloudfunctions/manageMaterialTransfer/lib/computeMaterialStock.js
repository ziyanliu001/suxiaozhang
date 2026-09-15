'use strict';

// 纯逻辑：四大主料（大米/食用油/面粉/时蔬）的"今日预估结存"计算 + 健康度
// （告急/正常/富余）判定。不做 db I/O——调用方（index.js 的 getStock action）
// 负责把 stores.materialStockBaseline、report_logs.materials[]（捐赠，经
// parseMaterialDonation.js 归类）、material_purchase_logs（采购入库）、
// material_logs（后厨消耗）、material_transfer_logs（跨店调拨）都查好、
// 转成本文件认识的形状后再传进来。
//
// ⚠️ 公式口径（务必先读，这是本模块存在的全部意义）：
//   预估结存 = 初始存量 + Σ捐赠 + Σ采购入库 − Σ消耗 + Σ调入 − Σ调出
// 捐赠/消耗两个数据源在需求文档里的语义描述是反的——report_logs.materials[]
// （自由文本"张三：大米50斤"）实际是捐赠台账，material_logs（riceCount 等）
// 实际是后厨消耗流水，不是反过来；采购入库是本次新增的第三个正向来源，
// 用来避免"买了米吃了米却被算成库存负数"这个此前公式遗漏采购项会必然出现的
// 缺陷。数值明确是估算值（捐赠依赖自由文本解析，天然不精确），不是精确记账。
//
// 健康度阈值（v1 固定常量，不做门店级可配置，是已知简化点）：低于 urgent 告急，
// 达到/超过 surplus 富余，中间正常。
const HEALTH_THRESHOLDS = {
  rice: { urgent: 20, surplus: 100 },
  oil: { urgent: 5, surplus: 30 },
  flour: { urgent: 20, surplus: 80 },
  vegetable: { urgent: 30, surplus: 150 }
};

const CATEGORIES = ['rice', 'oil', 'flour', 'vegetable'];

function deriveStatus(category, jin) {
  const threshold = HEALTH_THRESHOLDS[category];
  if (!threshold) return 'normal';
  if (jin < threshold.urgent) return 'urgent';
  if (jin >= threshold.surplus) return 'surplus';
  return 'normal';
}

/**
 * @param {Object} params
 * @param {{rice?:number, oil?:number, flour?:number, vegetable?:number}} [params.baseline] 初始存量（斤）
 * @param {{category:string, jin:number}[]} [params.donations] 已归类的捐赠明细（parseMaterialDonation.parseMaterialDonationToJin 的结果集合）
 * @param {{item:string, quantityJin:number}[]} [params.purchases] 采购入库明细
 * @param {{riceCount?:number, oilCount?:number, flourCount?:number, vegetableCount?:number}[]} [params.consumptions] 后厨消耗流水（material_logs 原始记录）
 * @param {{item:string, quantityJin:number}[]} [params.transfersIn] 调入明细（material_transfer_logs.toStoreId 命中的记录）
 * @param {{item:string, quantityJin:number}[]} [params.transfersOut] 调出明细（material_transfer_logs.fromStoreId 命中的记录）
 * @returns {{rice:{jin:number,status:string}, oil:{jin:number,status:string}, flour:{jin:number,status:string}, vegetable:{jin:number,status:string}}}
 */
function computeMaterialStock(params) {
  const {
    baseline = {},
    donations = [],
    purchases = [],
    consumptions = [],
    transfersIn = [],
    transfersOut = []
  } = params || {};

  const totals = {};
  CATEGORIES.forEach((c) => { totals[c] = Number(baseline[c]) || 0; });

  donations.forEach((d) => {
    if (d && totals[d.category] !== undefined && Number.isFinite(d.jin)) {
      totals[d.category] += d.jin;
    }
  });

  purchases.forEach((p) => {
    if (p && totals[p.item] !== undefined && Number.isFinite(p.quantityJin)) {
      totals[p.item] += p.quantityJin;
    }
  });

  const CONSUMPTION_FIELD_TO_CATEGORY = {
    riceCount: 'rice',
    oilCount: 'oil',
    flourCount: 'flour',
    vegetableCount: 'vegetable'
  };
  consumptions.forEach((rec) => {
    if (!rec) return;
    Object.keys(CONSUMPTION_FIELD_TO_CATEGORY).forEach((field) => {
      const category = CONSUMPTION_FIELD_TO_CATEGORY[field];
      const v = Number(rec[field]) || 0;
      totals[category] -= v;
    });
  });

  transfersIn.forEach((t) => {
    if (t && totals[t.item] !== undefined && Number.isFinite(t.quantityJin)) {
      totals[t.item] += t.quantityJin;
    }
  });
  transfersOut.forEach((t) => {
    if (t && totals[t.item] !== undefined && Number.isFinite(t.quantityJin)) {
      totals[t.item] -= t.quantityJin;
    }
  });

  const result = {};
  CATEGORIES.forEach((c) => {
    // 🛡️ 估算值允许出现负数（说明消耗记录早于采购/捐赠记录被登记，或某一环
    // 数据缺失），但展示层不应该出现"负库存"这种反直觉数字——钳制到 0，
    // 健康度按钳制前的真实值判定（负数天然满足 urgent 条件，钳制不影响判定）
    const rawJin = Math.round(totals[c] * 100) / 100;
    const status = deriveStatus(c, rawJin);
    result[c] = { jin: Math.max(0, rawJin), status };
  });
  return result;
}

module.exports = { computeMaterialStock, HEALTH_THRESHOLDS };
